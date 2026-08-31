import { randomUUID } from "node:crypto";
import type { Logger, MedusaContainer } from "@medusajs/framework/types";
import { MedusaError } from "@medusajs/framework/utils";
import {
  createStep,
  createWorkflow,
  StepResponse,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk";
import { AllegroAuthError } from "../lib/allegro/auth-error";
import { AllegroClient } from "../lib/allegro/client";
import { AllegroApiError, describeError } from "../lib/allegro/errors";
import type { OfferQuantityTask } from "../lib/allegro/types";
import {
  buildStockCommandChunks,
  isStockCoverageComplete,
  isStockPlanSafe,
  planStockSync,
  STOCK_POLL_CONCURRENCY,
  STOCK_TASK_MAX_PAGES,
  STOCK_TASK_PAGE_SIZE,
} from "../lib/sync/stock-plan";
import type {
  StockChange,
  StockConflictRecord,
  StockSyncSummary,
} from "../lib/sync/stock-plan";
import { ALLEGRO_SYNC_PROVIDERS } from "../modules/allegro/service";
import type AllegroModuleService from "../modules/allegro/service";
import { listEligibleVariants, readAvailableQuantities } from "./lib/catalog";
import { listAllOffers, listOffersByIds } from "./lib/offers";
import type { OfferListing } from "./lib/offers";
import { runUnderSyncClaim } from "./lib/run";
import { warnOnUnscopedCatalogue } from "./lib/scope-warnings";

/**
 * The quantity push: make Allegro's available quantity match Medusa's.
 *
 * ## Medusa inventory is the source of truth, and keeping it honest is not this
 * plugin's job
 *
 * This loop reads `retrieveAvailableQuantity` (stocked minus reserved) and pushes
 * it. It does NOT decide whether that number is trustworthy. In this stack a
 * separate inventory plugin owns the supplier snapshot and the arming gate that
 * refuses to propagate an untrustworthy one into Medusa inventory - so
 * the guard against "publish stale stock after a supplier outage" lives THERE, one
 * layer up, where the supplier response is actually visible.
 *
 * Putting a second such gate here would be worse than redundant: this loop cannot
 * see a supplier at all, so any guard it invented would be a guess about data it
 * has no source for. What it CAN see, and does refuse on, is its own uncertainty -
 * see the plan-safety rule below.
 *
 * ## Why an unsafe plan refuses the whole run
 *
 * An ambiguous match or an unreadable quantity means the plan does not know the
 * whole truth about the catalogue. A partial quantity push is worse than none: some
 * offers get a fresh figure while others keep a stale one, with nothing recording
 * which is which - so the next run cannot tell either. The run is refused as a
 * whole and the reason is reported.
 *
 * Quantities are grouped by target value because the API forces it - one command
 * sets ONE fixed value across up to 1,000 offers - which also makes a full
 * catalogue reconciliation cheap, since most offers share a handful of quantities.
 */

export interface StockSyncResult extends StockSyncSummary {
  /** Set when the run did nothing. */
  skipped?: string;
  /**
   * Conditions worth reporting on a run that otherwise did its job: offers held out
   * by a mapping conflict, variants no offer claims, writes still pending.
   *
   * SEPARATE from `error`, and that separation is load-bearing rather than tidy.
   * These two used to be flattened into `error` by a `combineReport` helper, which
   * made a field named "error" carry things that are not errors - and the first
   * consumer to treat it as one (the immediate push's alert) escalated a normal
   * state to a CRITICAL page. In this store Allegro auctions are created by hand, so
   * a variant with no offer is a deliberate, permanent condition; paging on it would
   * fire on every stock movement of every unlisted product and bury the alert that
   * matters. The state row always kept the two apart (`last_error` vs
   * `last_finding`); only the returned result conflated them.
   */
  finding?: string;
}

export const emptyStockSyncResult = (): StockSyncResult => ({
  alreadyInSync: 0,
  ambiguous: 0,
  commands: 0,
  complete: false,
  conflicted: 0,
  eligible: 0,
  failed: 0,
  mismatched: 0,
  pending: 0,
  skippedInactive: 0,
  skippedNoInventory: 0,
  skippedNoListingStock: 0,
  skippedUnlinked: 0,
  skippedUnmatched: 0,
  synced: 0,
  unresolved: 0,
});

/** Run `fn` over `values` with at most `concurrency` in flight. */
const mapWithConcurrency = async <T, R>(
  values: readonly T[],
  concurrency: number,
  fn: (value: T) => Promise<R>,
): Promise<R[]> => {
  const results = new Array<R>(values.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < values.length) {
      const index = next;
      next += 1;
      results[index] = await fn(values[index] as T);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, worker),
  );
  return results;
};

interface SubmittedCommand {
  commandId: string;
  changes: StockChange[];
}

/**
 * Submit one command per quantity group, stopping at the first systemic failure.
 *
 * Sequential submission with an early break, not a fan-out: on a 429 or a 5xx there
 * is nothing to gain from firing the remaining commands, and a fan-out would have
 * already sent them by the time the first failure came back.
 */
const submitCommands = async (
  client: AllegroClient,
  chunks: readonly StockChange[][],
  mayContinue: () => Promise<boolean>,
): Promise<{
  submitted: SubmittedCommand[];
  error?: string;
  stopped?: boolean;
}> => {
  const submitted: SubmittedCommand[] = [];
  for (const changes of chunks) {
    // Between chunks, checking BOTH the claim and the kill switch. A catalogue-wide
    // reconciliation can be many commands: a claim taken over mid-submission means two runs
    // setting quantities on the same offers, and a kill switch flipped mid-submission is an
    // operator stopping a runaway - which was being ignored until the run finished.
    if (!(await mayContinue())) {
      return {
        error:
          "the run was stopped mid-flight (the sync claim was taken over, or the kill switch was flipped), so the remaining quantity commands were abandoned",
        stopped: true,
        submitted,
      };
    }
    const commandId = randomUUID();
    // The command sets ONE fixed value across every offer it names, so the chunk's
    // uniformity is a correctness precondition, not a formality - and it was being
    // taken on trust from `buildStockCommandChunks` via `changes[0]?.desired ?? 0`.
    // A future grouping change that let two quantities share a chunk would silently
    // write the first offer's quantity onto up to 1,000 others, and an empty chunk
    // would DELIST them all via the `?? 0`. Both are asserted instead of assumed.
    const value = changes[0]?.desired;
    if (
      value === undefined ||
      changes.some((change) => change.desired !== value)
    ) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `medusa-allegro: refusing to submit a quantity command whose chunk is empty or mixes target quantities (${[
          ...new Set(changes.map((change) => change.desired)),
        ].join(
          ", ",
        )}). One command sets one fixed value across every offer it names.`,
      );
    }
    try {
      await client.changeOfferQuantity({
        commandId,
        offerIds: changes.map((change) => change.offerId),
        value,
      });
      submitted.push({ changes, commandId });
    } catch (error) {
      if (error instanceof AllegroApiError && error.isForbidden()) {
        return {
          error:
            "WRITE_SCOPE_MISSING: the stored Allegro token cannot write offer quantities. Reconnect Allegro with the offer write scope.",
          submitted,
        };
      }
      const message =
        error instanceof AllegroAuthError
          ? `auth error: ${error.message}`
          : describeError(error);
      return { error: message, submitted };
    }
  }
  return { submitted };
};

/**
 * Read EVERY task page of one quantity command.
 *
 * A command naming up to 1,000 offers can emit more than 1,000 tasks: the `field`
 * discriminator exists precisely because Allegro reports tasks for fields other than
 * `quantity`. Reading one page of 1,000 and classifying every offer that did not
 * appear in it as `failed` therefore reported a completely healthy push as broken -
 * on every subsequent run, because the next run re-derives the same mismatch, pushes
 * again, and truncates again.
 *
 * `truncated` is the honest answer when the page cap is hit: the caller must NOT
 * classify the offers it never saw, because "absent from a report we did not finish
 * reading" is not evidence of anything.
 */
const readAllQuantityTasks = async (
  client: AllegroClient,
  commandId: string,
): Promise<{ tasks: OfferQuantityTask[]; truncated: boolean }> => {
  const tasks: OfferQuantityTask[] = [];
  for (let page = 0; page < STOCK_TASK_MAX_PAGES; page += 1) {
    // Offset pagination over one command's tasks; each page depends on the previous.
    const report = await client.getOfferQuantityCommandTasks(commandId, {
      limit: STOCK_TASK_PAGE_SIZE,
      offset: page * STOCK_TASK_PAGE_SIZE,
    });
    const batch = report.tasks ?? [];
    tasks.push(...batch);
    // Allegro's own total wins when present; a short page is the fallback signal, so
    // the loop terminates correctly whether or not the counts are populated.
    const total = report.totalCount;
    if (
      batch.length < STOCK_TASK_PAGE_SIZE ||
      (typeof total === "number" && tasks.length >= total)
    ) {
      return { tasks, truncated: false };
    }
  }
  return { tasks, truncated: true };
};

/**
 * Poll each submitted command to terminal and count what Allegro confirmed.
 *
 * Confirmation is per OFFER, from the task report, not per command: a command can
 * report itself complete while individual offers inside it failed, and counting the
 * command as a success would claim quantities that never landed. An offer with no
 * SUCCESS task is `failed`, not silently synced - but only once the whole task report
 * has actually been read (see `readAllQuantityTasks`).
 */
const collectOutcomes = async (
  client: AllegroClient,
  submitted: readonly SubmittedCommand[],
  heartbeat: () => Promise<boolean>,
): Promise<{
  synced: number;
  pending: number;
  failed: number;
  /** Offers Allegro confirmed at the new quantity, per offer and not per command. */
  confirmed: string[];
  error?: string;
}> => {
  let firstError: string | undefined;

  const outcomes = await mapWithConcurrency(
    submitted,
    STOCK_POLL_CONCURRENCY,
    async (submission) => {
      try {
        const report = await client.pollOfferQuantityCommand(
          submission.commandId,
          {
            timeoutMs: 120_000,
          },
        );
        // The SHARED terminality test, not a local copy. This inline duplicate was
        // the correct one of the two and the price loop's was weaker; collapsing both
        // onto `AllegroClient.isCommandTerminal` is what stops them drifting again.
        if (!AllegroClient.isCommandTerminal(report)) {
          // Submitted but unconfirmed. `pending`, not `failed`: the quantities may
          // well have landed, and reporting them as failures would make the next run
          // treat a working push as a broken one.
          return {
            confirmed: [],
            failed: 0,
            pending: submission.changes.length,
            synced: 0,
          };
        }

        // After the poll, which is where the time goes: each command is polled for up to
        // 120 seconds, so a run with several chunks can otherwise outlive its claim.
        await heartbeat();
        const { tasks, truncated } = await readAllQuantityTasks(
          client,
          submission.commandId,
        );
        const confirmedOfferIds = new Set<string>();
        for (const task of tasks) {
          const offerId = task.offer?.id;
          // `field === "quantity"` matters: a command report can carry tasks for
          // other fields, and counting one of those as a quantity confirmation would
          // report a quantity that was never set.
          if (
            task.status === "SUCCESS" &&
            task.field === "quantity" &&
            offerId
          ) {
            confirmedOfferIds.add(offerId);
          }
        }
        const confirmed = submission.changes
          .map((change) => change.offerId)
          .filter((offerId) => confirmedOfferIds.has(offerId));
        if (truncated) {
          // The task report did not fit the page cap, so the offers that did not
          // appear are UNKNOWN rather than failed. They count as pending - the next
          // run re-checks their quantity - and the cap is reported loudly, because a
          // command whose report needs more than this many pages means the assumption
          // behind the cap is wrong.
          firstError ??=
            `the task report for quantity command ${submission.commandId} exceeded ${STOCK_TASK_MAX_PAGES} page(s) of ${STOCK_TASK_PAGE_SIZE}; ` +
            `${submission.changes.length - confirmed.length} offer(s) could not be classified and are reported as pending rather than failed`;
          return {
            confirmed,
            failed: 0,
            pending: submission.changes.length - confirmed.length,
            synced: confirmed.length,
          };
        }
        return {
          confirmed,
          // An offer with no SUCCESS task inside a TERMINAL command whose report was
          // read to exhaustion is `failed`, not silently synced: a command can report
          // itself complete while individual offers inside it were rejected.
          failed: submission.changes.length - confirmed.length,
          pending: 0,
          synced: confirmed.length,
        };
      } catch (error) {
        firstError ??= describeError(error);
        return {
          confirmed: [],
          failed: 0,
          pending: submission.changes.length,
          synced: 0,
        };
      }
    },
  );

  const confirmed: string[] = [];
  let synced = 0;
  let pending = 0;
  let failed = 0;
  for (const outcome of outcomes) {
    synced += outcome.synced;
    pending += outcome.pending;
    failed += outcome.failed;
    confirmed.push(...outcome.confirmed);
  }
  return { confirmed, error: firstError, failed, pending, synced };
};

/** The `last_error` line for the admin, or null when the run was clean. */
const buildStockError = (
  result: StockSyncResult,
  firstError?: string,
): { error: string | null; finding: string | null } => {
  const errors: string[] = [];
  const findings: string[] = [];
  if (firstError) {
    errors.push(firstError);
  }
  // A plan refused outright IS the run failing: nothing was published, and the
  // reason is a data contradiction someone has to resolve.
  if (result.ambiguous > 0) {
    errors.push(
      `${result.ambiguous} offer(s) match more than one variant, so the whole plan was refused rather than partially applied`,
    );
  }
  if (result.unresolved > 0) {
    errors.push(
      `${result.unresolved} offer(s) have an unreadable quantity on one side, so the whole plan was refused rather than partially applied`,
    );
  }
  if (result.failed > 0) {
    errors.push(
      `${result.failed} offer quantity write(s) were not confirmed by Allegro`,
    );
  }
  if (result.pending > 0) {
    findings.push(
      `${result.pending} offer quantity write(s) were submitted but not confirmed within the poll budget; the next run re-checks them`,
    );
  }
  // The bounded exclusions. None of them refuses the run, and that is exactly why each has
  // to be reported: an offer in one of these buckets has its quantity published NOWHERE,
  // and a run that reported only `synced` would look clean while part of the catalogue sat
  // permanently stale on Allegro.
  if (result.conflicted > 0) {
    findings.push(
      `${result.conflicted} offer(s) contradict their mapping row (the live sygnatura or EAN no longer matches the mapped SKU) and were skipped with a recorded conflict; resolve them in the Allegro admin`,
    );
  }
  if (result.skippedUnmatched > 0) {
    findings.push(
      `${result.skippedUnmatched} mapped offer(s) could not be paired with an eligible variant (absent from the Allegro listing, or their SKU is not in the sales channel), so their quantity was not written`,
    );
  }
  if (result.skippedNoInventory > 0) {
    findings.push(
      `${result.skippedNoInventory} offer(s) map to a variant that does not manage inventory, so Medusa has no quantity to publish for them`,
    );
  }
  if (result.skippedNoListingStock > 0) {
    findings.push(
      `${result.skippedNoListingStock} offer(s) were skipped because their Allegro listing carried no usable available quantity, so the difference could not be computed`,
    );
  }
  if (result.skippedUnlinked > 0) {
    findings.push(
      `${result.skippedUnlinked} eligible variant(s) are claimed by no mapped Allegro offer, so their quantity is published nowhere`,
    );
  }
  return {
    error: errors.length > 0 ? errors.join("; ") : null,
    finding: findings.length > 0 ? findings.join("; ") : null,
  };
};

/**
 * Copy the report onto the result, keeping the two halves apart.
 *
 * There is deliberately no "both halves as one line" helper any more. The one that
 * existed produced a single string for `result.error`, and every caller that wanted
 * to know "did this run FAIL?" then had to answer it from prose. The immediate
 * push's alert got that wrong in the only way that matters - it paged on a finding.
 */
const applyReport = (
  result: StockSyncResult,
  report: { error: string | null; finding: string | null },
): void => {
  result.error = report.error ?? undefined;
  result.finding = report.finding ?? undefined;
};

/** Stamp `stock_synced_at` on the offers whose quantity Allegro confirmed. */
const stampSyncedOffers = async (
  allegro: AllegroModuleService,
  offerIds: readonly string[],
): Promise<void> => {
  if (offerIds.length === 0) {
    return;
  }
  const rows = (await allegro.listAllegroOffers({
    offer_id: [...offerIds],
  })) as unknown as {
    id: string;
  }[];
  if (rows.length === 0) {
    return;
  }
  await allegro.updateAllegroOffers(
    rows.map((row) => ({ id: row.id, stock_synced_at: new Date() })) as never,
  );
};

/**
 * Mark the mapping rows whose live offer contradicts them.
 *
 * Best-effort: the conflict is a report, and failing to record it must not turn a run that
 * correctly wrote nothing into a crash. It is logged loudly either way, because the offer
 * is not being synced until somebody acts.
 */
const recordStockConflicts = async (
  allegro: AllegroModuleService,
  logger: Logger,
  conflicts: readonly StockConflictRecord[],
  mayContinue: () => Promise<boolean>,
): Promise<void> => {
  if (conflicts.length === 0) {
    return;
  }
  // Ownership re-checked before writing to the mapping table. This runs before any Allegro
  // command, but it is still a WRITE, and a run whose claim was taken over must not touch
  // shared rows the successor is also reconciling. The conflicts are logged either way, so the
  // signal is never lost by declining to persist it.
  if (!(await mayContinue())) {
    for (const conflict of conflicts) {
      logger.warn(`[allegro-stock] ${conflict.conflict_detail}`);
    }
    logger.warn(
      `[allegro-stock] not recording ${conflicts.length} sku-mismatch conflict(s) on their mapping rows: the run was stopped mid-flight and must make no further writes.`,
    );
    return;
  }
  for (const conflict of conflicts) {
    logger.warn(`[allegro-stock] ${conflict.conflict_detail}`);
  }
  const skus = conflicts.map((conflict) => conflict.sku);
  try {
    const rows = (await allegro.listAllegroOffers({
      sku: skus,
    })) as unknown as {
      id: string;
      sku: string;
    }[];
    const byId = new Map(rows.map((row) => [row.sku, row.id]));
    const updates = conflicts
      .map((conflict) => {
        const id = byId.get(conflict.sku);
        return id
          ? {
              conflict: conflict.conflict,
              conflict_detail: conflict.conflict_detail,
              id,
              // Cleared for the same reason discovery clears it on a conflict: this column
              // is what every write path builds its commands from.
              offer_id: null,
            }
          : undefined;
      })
      .filter(
        (update): update is NonNullable<typeof update> => update !== undefined,
      );
    if (updates.length > 0) {
      await allegro.updateAllegroOffers(updates as never);
    }
  } catch (error) {
    logger.error(
      `[allegro-stock] could not record ${conflicts.length} sku-mismatch conflict(s) on their mapping rows: ${describeError(error)}. The offers were still skipped and nothing was written to Allegro.`,
    );
  }
};

/**
 * What one run is allowed to touch.
 *
 * The scheduled loop takes the whole catalogue. The event-driven push takes a set of
 * SKUs, and the narrowing is the ONLY difference between the two - everything after
 * the plan (safety refusal, conflict recording, command grouping, per-offer
 * confirmation, the `stock_synced_at` stamp) is shared code running unchanged. That
 * matters more than the saved requests: two implementations of "how a quantity is
 * written to Allegro" would drift, and the one that drifted would be the one nobody
 * watches.
 */
interface StockPushScope {
  /**
   * SKUs this run may touch. Undefined means the whole eligible catalogue.
   *
   * An EMPTY set is not the same as undefined and never widens to it: it means the
   * caller asked for nothing, and answering that with a catalogue-wide push is how a
   * narrow path becomes a wide write.
   */
  only?: ReadonlySet<string>;
  /** A catalogue listing the caller already fetched. Full-catalogue runs only. */
  listing?: OfferListing;
}

/** Run one quantity push, over the whole catalogue or over a named set of SKUs. */
const runStockPush = async (
  container: MedusaContainer,
  scope: StockPushScope,
): Promise<StockSyncResult> => {
  let result = emptyStockSyncResult();
  const { only } = scope;

  const run = await runUnderSyncClaim(
    container,
    ALLEGRO_SYNC_PROVIDERS.STOCK,
    async ({ allegro, client, heartbeat, logger, mayContinue }) => {
      const options = await allegro.getSyncOptions();
      warnOnUnscopedCatalogue(logger, options, "stock");
      // Narrowed in memory rather than at the query. The catalogue read is a local
      // database page, not an Allegro request, so filtering it here costs a scan and
      // keeps `listEligibleVariants` - which four loops share - with one behaviour.
      const allVariants = await listEligibleVariants(container, options);
      const variants = only
        ? allVariants.filter((variant) => only.has(variant.sku))
        : allVariants;

      // Only mapped, unconflicted rows authorise a write, and the row also supplies the
      // PAIRING. Re-deriving the pairing from the live listing is what let a sygnatura
      // edited between discovery and now push one variant's quantity onto another
      // product's offer.
      //
      // Read BEFORE the offers on a targeted run, because it is what says which offers
      // to read at all.
      const rows = (await allegro.listAllegroOffers(
        only ? { sku: [...only] } : {},
      )) as unknown as {
        sku: string;
        offer_id?: string | null;
        conflict?: string | null;
      }[];
      const authorized = rows
        .filter((row) => !row.conflict && row.offer_id)
        .map((row) => ({ offerId: row.offer_id as string, sku: row.sku }));

      // The LISTING first, quantities second, and the order is deliberate. Paging a full
      // catalogue is by far the slowest step here, so reading quantities before it left
      // every figure ageing across the whole pagination window before it was compared and
      // written. Reading them after means the numbers pushed are the freshest available at
      // write time, which for stock is the difference between an oversell and a sale.
      //
      // A targeted run reads only the offers it was authorised to touch, which is the
      // whole point: a sale must not cost a catalogue pass.
      const offers = only
        ? await listOffersByIds(
            client,
            authorized.map((row) => row.offerId),
          )
        : (scope.listing ?? (await listAllOffers(client))).offers;
      const quantities = await readAvailableQuantities(
        container,
        variants,
        options.stockLocationIds,
      );

      const plan = planStockSync(
        variants.map((variant) => {
          const read = quantities.get(variant.sku);
          return {
            ean: variant.ean,
            sku: variant.sku,
            ...(read && "quantity" in read ? { quantity: read.quantity } : {}),
            ...(read && "absent" in read ? { absent: read.absent } : {}),
          };
        }),
        offers,
        authorized,
      );
      const { changes, conflicts, ...summary } = plan;
      result = { ...summary };

      // Recorded on the mapping row, not just counted. A conflict that lives only in a run
      // summary is gone by the next tick; on the row it is visible in the admin, it holds
      // the offer out of the PRICE path too, and discovery clears it on the next healthy
      // upsert.
      await recordStockConflicts(allegro, logger, conflicts, mayContinue);

      if (!isStockPlanSafe(plan)) {
        // Refused as a whole. See the class comment: a partial push leaves some
        // offers fresh and others stale with no record of which.
        result.complete = false;
        result.failed = changes.length;
        const report = buildStockError(result);
        applyReport(result, report);
        logger.warn(
          `[allegro-stock] plan refused: ambiguous=${plan.ambiguous} unresolved=${plan.unresolved}. No quantity was written.`,
        );
        return {
          outcome: {
            counts: { ...result },
            finding: report.finding,
            lastError: report.error,
            status: "error" as const,
          },
          value: undefined,
        };
      }

      if (changes.length === 0) {
        result.complete = isStockCoverageComplete(plan);
        const report = buildStockError(result);
        applyReport(result, report);
        return {
          outcome: {
            counts: { ...result },
            finding: report.finding,
            lastError: report.error,
            status: report.error ? ("error" as const) : ("ok" as const),
          },
          value: undefined,
        };
      }

      const chunks = buildStockCommandChunks(changes);
      const {
        error: submitError,
        stopped,
        submitted,
      } = await submitCommands(client, chunks, mayContinue);
      result.commands = submitted.length;

      const submittedCount = submitted.reduce(
        (sum, item) => sum + item.changes.length,
        0,
      );
      // Everything in a chunk that was never submitted counts as failed: those
      // offers keep a stale quantity and nothing else records that.
      const notSubmitted = changes.length - submittedCount;

      const outcomes = await collectOutcomes(client, submitted, heartbeat);
      result.synced = outcomes.synced;
      result.pending = outcomes.pending;
      result.failed = outcomes.failed + notSubmitted;
      result.complete =
        result.synced === plan.mismatched &&
        result.pending === 0 &&
        result.failed === 0 &&
        isStockCoverageComplete(plan);

      // Stamped per confirmed offer, not per run: on a partly-confirmed run the
      // offers that landed are exactly the ones whose `stock_synced_at` should move,
      // and stamping the rest would claim a push that did not happen.
      //
      // Skipped entirely when the run was stopped mid-flight: a taken-over claim means this
      // row belongs to the successor, and a flipped kill switch means the operator asked for
      // no further writes. The quantities that did land are re-derived as already-in-sync next
      // run, so nothing is lost.
      if (stopped) {
        logger.warn(
          `[allegro-stock] not stamping stock_synced_at for ${outcomes.confirmed.length} confirmed offer(s): the run was stopped mid-flight and must make no further writes.`,
        );
      } else {
        await stampSyncedOffers(allegro, outcomes.confirmed);
      }

      const firstError = submitError ?? outcomes.error;
      const report = buildStockError(result, firstError);
      applyReport(result, report);
      return {
        outcome: {
          counts: { ...result },
          finding: report.finding,
          lastError: report.error,
          status: report.error ? ("error" as const) : ("ok" as const),
          // A 403 on the quantity command is the same write-scope gap the price loop
          // detects, and the same reconnect fixes both, so it raises the same banner.
          ...(submitError?.startsWith("WRITE_SCOPE_MISSING")
            ? { writeScopeMissing: true }
            : {}),
        },
        value: undefined,
      };
    },
    {
      disabled: (allegro) => allegro.isStockSyncDisabled(),
      reason:
        "stock sync is disabled (the `stockSyncDisabled` option, or ALLEGRO_STOCK_SYNC_DISABLED). No quantity was written to Allegro.",
    },
  );

  if (!run.ran) {
    result.skipped = run.skip.reason;
  }
  return result;
};

/**
 * Run one full-catalogue quantity-push tick.
 *
 * `listing` may be supplied by a caller that already fetched the catalogue.
 */
export const pushAllegroStock = async (
  container: MedusaContainer,
  listing?: OfferListing,
): Promise<StockSyncResult> => await runStockPush(container, { listing });

/**
 * Push the quantity for a named set of SKUs, now.
 *
 * The event path's write. It exists because the 15-minute reconciliation is also a
 * 15-minute window in which something that just sold is still purchasable on Allegro
 * at its old quantity, and that window is an oversell.
 *
 * It is ADDITIVE, never a replacement. The scheduled reconciliation still reads the
 * whole catalogue and repairs anything this missed - a dropped event, a process that
 * restarted with SKUs still buffered, an offer whose read failed - so the guarantee
 * never gets weaker than it was before this path existed, only faster in the common
 * case.
 *
 * Every safety property of the scheduled loop is inherited rather than reimplemented,
 * because this is the same function underneath:
 *
 * - The same STOCK single-flight claim, so it cannot interleave with a reconciliation
 *   pass that is mid-flight - two runs setting quantities on one offer is exactly what
 *   the claim exists to prevent, and an event-driven push firing at an arbitrary
 *   moment makes that collision likely rather than theoretical.
 * - The same kill switch, re-read per command, so an operator stopping a runaway stops
 *   this too.
 * - The same plan-safety refusal: an ambiguous match or an unreadable quantity refuses
 *   the WHOLE run rather than pushing the offers it happens to be sure about.
 * - The same per-offer confirmation and `stock_synced_at` stamp, so a partly-confirmed
 *   targeted push is recorded exactly as a partly-confirmed sweep is.
 *
 * An empty `skus` is a no-op that takes no claim: there is nothing to push, and taking
 * the claim to discover that would block a reconciliation for no reason.
 */
export const pushTargetedAllegroStock = async (
  container: MedusaContainer,
  skus: readonly string[],
): Promise<StockSyncResult> => {
  const only = new Set(skus.map((sku) => sku.trim()).filter(Boolean));
  if (only.size === 0) {
    return { ...emptyStockSyncResult(), skipped: "no SKUs to push" };
  }
  return await runStockPush(container, { only });
};

const pushAllegroStockStep = createStep(
  "push-allegro-stock",
  async (_input: void, { container }: { container: MedusaContainer }) =>
    new StepResponse(await pushAllegroStock(container)),
);

/**
 * The quantity push as a workflow, for the admin "run now" action.
 *
 * Deliberately NOT compensated. A quantity is absolute state that Allegro owns and
 * Medusa is the source of, so the repair for a bad push is another push from a
 * corrected inventory - "undoing" it would mean restoring a quantity that was
 * wrong.
 */
export const pushAllegroStockWorkflow = createWorkflow(
  "push-allegro-stock",
  () => new WorkflowResponse(pushAllegroStockStep()),
);
