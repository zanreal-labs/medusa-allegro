import type { MedusaContainer } from "@medusajs/framework/types";
import {
  createStep,
  createWorkflow,
  StepResponse,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk";
import { AllegroAuthError } from "../lib/allegro/auth-error";
import { AllegroApiError } from "../lib/allegro/errors";
import {
  clearFailureKey,
  isEmptyFailureState,
  readFailureState,
  standingHealthLine,
} from "../lib/sync/failure-state";
import { drainOrderEvents, emptyOrdersSyncSummary } from "../lib/sync/order-events";
import type { OrdersSyncSummary } from "../lib/sync/order-events";
import { ALLEGRO_SYNC_PROVIDERS } from "../modules/allegro/service";
import { applyCheckoutForm } from "./lib/order-upsert";
import { runUnderSyncClaim } from "./lib/run";

/**
 * The orders sync: drain `GET /order/events` and apply every order it names.
 *
 * The decisions all live in `lib/sync/order-events` (cursor discipline, the split
 * refresh budget, the quarantine escape, the systemic-failure gate) and the
 * per-form application in `lib/order-upsert`. What is here is the wiring: the
 * claim, the cursor and failure state, and the operator entry points.
 *
 * Runs per minute, because a `BOUGHT` event that has not been applied is an order
 * nobody has been told about.
 */

export interface OrdersSyncResult extends OrdersSyncSummary {
  /** Orders created in Medusa this run. */
  created: number;
  /** Orders with at least one line that matched no Medusa variant. */
  withLineConflicts: number;
  /** Orders whose Medusa total disagrees with what Allegro says the buyer paid. */
  withTotalMismatch: number;
}

export const emptyOrdersSyncResult = (): OrdersSyncResult => ({
  ...emptyOrdersSyncSummary(),
  created: 0,
  withLineConflicts: 0,
  withTotalMismatch: 0,
});

/** The `last_error` line for the admin, or null when the run was clean. */
const buildOrdersError = (result: OrdersSyncResult): string | null => {
  const parts: string[] = [];
  if (result.systemicFailure) {
    // Distinct from a per-order failure on purpose: nothing was quarantined and
    // nothing skipped, so the operator should be looking at Allegro or the database,
    // not at an order.
    parts.push(
      `ALLEGRO_UNREACHABLE: all ${result.failed} order refresh(es) failed this run; treated as an outage, so nothing was quarantined and the event cursor held. The next tick retries.`,
    );
  } else if (result.failed > 0) {
    parts.push(`${result.failed} order refresh(es) failed`);
  }
  if (result.quarantined.length > 0) {
    // Named, not counted: the whole point of quarantine is that the sync moves on, so
    // this string is the only thing between a skipped order and nobody noticing.
    parts.push(
      `${result.quarantined.length} order(s) quarantined after repeated failures and skipped by the event cursor: ${result.quarantined.join(", ")}. Repair them from the Allegro orders admin.`,
    );
  }
  if (result.withTotalMismatch > 0) {
    // Reported, never blocking. The order exists and the sale is real; what needs a human is
    // the disagreement about how much it was for.
    parts.push(
      `${result.withTotalMismatch} order(s) have a Medusa total that disagrees with the amount Allegro says the buyer paid; the conflict is recorded on each row for review`,
    );
  }
  if (result.withLineConflicts > 0) {
    parts.push(
      `${result.withLineConflicts} order(s) have a line whose sygnatura matches no Medusa variant; they were created with custom line items, so those lines carry no inventory or cost linkage`,
    );
  }
  return parts.length > 0 ? parts.join("; ") : null;
};

/** Drain the journal once. */
export const drainAllegroOrders = async (container: MedusaContainer): Promise<OrdersSyncResult> => {
  const result = emptyOrdersSyncResult();

  const run = await runUnderSyncClaim(
    container,
    ALLEGRO_SYNC_PROVIDERS.ORDERS,
    async ({ allegro, client, heartbeat, logger, state }) => {
      const options = await allegro.getSyncOptions();
      const priorFailures = readFailureState(state.failures);
      let created = 0;
      let withLineConflicts = 0;
      let withTotalMismatch = 0;

      const drain = await drainOrderEvents(
        state.cursor,
        {
          applyForm: async (formId) => {
            const form = await client.getCheckoutForm(formId);
            const applied = await applyCheckoutForm(container, allegro, logger, options, form);
            if (applied.created) {
              created += 1;
            }
            if (applied.conflicts.length > 0) {
              withLineConflicts += 1;
            }
            if (applied.totalMismatch) {
              withTotalMismatch += 1;
            }
            return applied.statusChanged;
          },
          // Per form: a drain can refresh up to 100 forms sequentially, each a
          // `getCheckoutForm` plus a multi-step order write, which comfortably exceeds the
          // staleness window on a slow Allegro.
          heartbeat,
          // The client's own classification, so the drain does not re-implement it: a 429, a
          // 5xx, a 401 without a usable refresh token, or a transport failure is about
          // Allegro rather than about this order.
          isSystemicError: (error) =>
            error instanceof AllegroAuthError ||
            (error instanceof AllegroApiError && error.isSystemic()),
          latestEventId: async () => (await client.getOrderEventStats()).latestEvent?.id,
          listEvents: async (from, limit) =>
            (await client.listOrderEvents({ from, limit })).events ?? [],
          log: (level, message) => {
            if (level === "error") {
              logger.error(`[allegro-orders] ${message}`);
            } else {
              logger.warn(`[allegro-orders] ${message}`);
            }
          },
        },
        priorFailures,
      );

      result.bootstrapped = drain.bootstrapped;
      result.created = created;
      result.eventsRead = drain.eventsRead;
      result.failed = drain.failed;
      result.quarantined = drain.quarantined;
      result.refreshed = drain.refreshed;
      result.statusChanged = drain.statusChanged;
      result.systemicFailure = drain.systemicFailure;
      result.truncated = drain.truncated;
      result.withLineConflicts = withLineConflicts;
      result.withTotalMismatch = withTotalMismatch;

      if (drain.bootstrapped) {
        logger.warn(
          `[allegro-orders] event cursor bootstrapped at ${drain.cursor ?? "(no events)"}; earlier events are not replayed. Use the import-window action to bring in history.`,
        );
      }

      const errorLine = buildOrdersError(result);
      result.error = errorLine ?? undefined;
      return {
        outcome: {
          counts: { ...result },
          // Persisted from the drain's own decision, so a held cursor stays held.
          cursor: drain.cursor,
          failures: isEmptyFailureState(drain.failures) ? null : drain.failures,
          lastError: errorLine,
          status: errorLine ? ("error" as const) : ("ok" as const),
        },
        value: undefined,
      };
    },
    {
      disabled: (allegro) => allegro.isOrdersSyncDisabled(),
      reason:
        "orders sync is disabled (the `ordersSyncDisabled` option, or ALLEGRO_ORDERS_SYNC_DISABLED). The event journal was not consumed, so the cursor holds and nothing was imported.",
    },
  );

  if (!run.ran) {
    result.skipped = run.skip.reason;
    result.disabled = run.skip.kind === "disabled";
    result.connected = run.skip.kind !== "not-connected";
  }
  return result;
};

export interface RepairOrderResult {
  ok: boolean;
  statusChanged?: boolean;
  created?: boolean;
  error?: string;
}

/**
 * Re-read one Allegro order by checkout-form id and apply it.
 *
 * The remedy for a quarantined order: the drain gives up on a form after five
 * consecutive failures so the cursor can move on, and this is how an operator
 * retries that one form once the underlying cause is fixed. A success clears the
 * form from both failure maps, so it stops being reported and does not resume a
 * stale streak.
 *
 * Deliberately NOT called from any schedule, and it takes the same claim the drain
 * does - applying a form is a multi-step write, and two passes interleaving on one
 * order is exactly what the claim exists to prevent.
 */
export const repairAllegroOrder = async (
  container: MedusaContainer,
  checkoutFormId: string,
): Promise<RepairOrderResult> => {
  let result: RepairOrderResult = { error: "the repair did not complete", ok: false };

  const run = await runUnderSyncClaim(
    container,
    ALLEGRO_SYNC_PROVIDERS.ORDERS,
    async ({ allegro, client, logger, state }) => {
      const options = await allegro.getSyncOptions();
      const priorFailures = readFailureState(state.failures);

      try {
        const form = await client.getCheckoutForm(checkoutFormId);
        const applied = await applyCheckoutForm(container, allegro, logger, options, form);
        const { cleared, failures } = clearFailureKey(priorFailures, checkoutFormId);
        // Recomputed rather than nulled, so repairing one order never wipes every
        // OTHER quarantined order off the admin.
        const line = standingHealthLine(failures, "order");
        result = { created: applied.created, ok: true, statusChanged: applied.statusChanged };
        return {
          outcome: {
            ...(cleared ? { failures: isEmptyFailureState(failures) ? null : failures } : {}),
            lastError: line,
            status: line ? ("error" as const) : ("ok" as const),
          },
          value: undefined,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result = { error: message, ok: false };
        // The failure state is deliberately untouched: a failed repair is not another
        // consecutive drain failure, and letting a retried repair drive the streak
        // would quarantine a form an operator is actively working on.
        return {
          outcome: {
            lastError: `repair of ${checkoutFormId} failed: ${message}`,
            status: "error" as const,
          },
          value: undefined,
        };
      }
    },
    // No kill switch: repair is an explicit operator action on one order, and the
    // switch exists to stop the SCHEDULE. An operator who has disabled the drain to
    // stop a runaway still needs to be able to fix the order that caused it.
  );

  if (!run.ran) {
    return { error: run.skip.reason, ok: false };
  }
  return result;
};

const drainAllegroOrdersStep = createStep(
  "drain-allegro-orders",
  async (_input: void, { container }: { container: MedusaContainer }) =>
    new StepResponse(await drainAllegroOrders(container)),
);

/**
 * The drain as a workflow, for the admin "sync now" action.
 *
 * Deliberately NOT compensated. The upsert is idempotent and the cursor only
 * advances over work that landed, so the repair for a partial run is another run -
 * and "undoing" it would mean deleting orders that really were placed.
 */
export const drainAllegroOrdersWorkflow = createWorkflow(
  "drain-allegro-orders",
  () => new WorkflowResponse(drainAllegroOrdersStep()),
);
