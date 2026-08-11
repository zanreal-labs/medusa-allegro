# Review-fix handoff

Wave 2-4 sync engine, two adversarial review sets. Written at the end of a session
that was cut short; this is what the next session needs to resume without redoing the
analysis.

**Base:** `277b1af` on `main`, pushed to `origin/main`. Working tree clean.

## Gate status

All five gates run and green at `277b1af`:

| Gate           | Command                                   | Result at 277b1af                         |
| -------------- | ----------------------------------------- | ----------------------------------------- |
| Unit suite     | `npm run test:unit`                       | 653 passed / 29 suites (baseline was 642) |
| Lint           | `npm run lint` (`medusa lint`)            | no issues, no warnings                    |
| Types (server) | `tsc --noEmit -p tsconfig.spec.json`      | clean                                     |
| Types (admin)  | `tsc --noEmit -p src/admin/tsconfig.json` | clean                                     |
| Build          | `npm run build` (`medusa plugin:build`)   | plugin + admin extensions succeed         |

Baseline for comparison: 642 tests at `78ed1d6`. Note that `78ed1d6`'s own commit
message says its gates were NOT re-run; they were re-run at the start of this session
and were green, so 642 is a real baseline, not an assumed one.

## What landed

One commit, `277b1af`, covering review-1 findings **1** and **13** plus three cheap
items from review 2. Everything else below is untouched code.

## Review 1 (13 findings)

Every one of the 13 was verified to reproduce against the code. **None was rejected.**

| #   | Area                                                              | Status                            |
| --- | ----------------------------------------------------------------- | --------------------------------- |
| 1   | Timed-out price command recorded as confirmed success             | **fixed + tested** (`277b1af`)    |
| 2   | `promoted` can never be "unresolved"                              | not started, design below         |
| 3   | `derived_status` advances when the Medusa action failed           | not started, design below         |
| 4   | Crash between order create and link write duplicates orders       | not started, design below         |
| 5   | Zero stock locations yields a full-catalogue zero push            | not started, root cause confirmed |
| 6   | Sync claim has no heartbeat                                       | not started, design below         |
| 7   | Pre-claim `writeSyncState` releases another run's claim           | not started, design below         |
| 8   | Two offers resolving to one variant both claim the SKU row        | not started, design below         |
| 9   | `stock-plan` EAN fallback looks the EAN up in the SKU map         | not started, design below         |
| 10  | Stock plan re-derives offer/variant pairing from the live listing | not started, design below         |
| 11  | Failed manual push settles the provider row as `ok`               | not started, design below         |
| 12  | Unparseable price becomes 0, missing quantity becomes 1           | not started, design below         |
| 13  | Task confirmation reads a single page                             | **fixed + tested** (`277b1af`)    |

### Verification notes worth not repeating

- **F1** confirmed by construction: the local test was
  `completedAt || taskCount.total > 0`; `AllegroClient.isCommandTerminal` is
  `total > 0 && success + failed >= total`. `total: 1, success: 0, failed: 0` passes the
  first and fails the second, so an in-progress command at the poll budget reached
  `finalize({result: "success"})`. The pending branch was dead code for that shape.
- **F2** confirmed: `allegro-offer.ts:101` is `model.boolean().default(false)` and the
  migration column is `not null default false`, so `row.promoted` is always a boolean
  and `evaluateSyncEligibility`'s `promotion-unresolved` gate is unreachable.
- **F5** confirmed in `node_modules`:
  `@medusajs/inventory/dist/services/inventory-module.js` `retrieveAvailableQuantity`
  opens with `if (locationIds.length === 0) return new BigNumber(0)`. So a store with
  no stock locations and none configured gets quantity 0 for every variant,
  `isStockPlanSafe` returns true, and the run reports clean.
- **F9** confirmed, and the existing test at
  `stock-plan.unit.spec.ts` "falls back to the EAN when the offer carries no sygnatura"
  only passes because the fixture's variant SKU _is_ the EAN string. It encodes the bug.
- **F13** confirmed: `OfferQuantityTaskReport` is paginated and the read was
  `limit: 1000, offset: 0`.

## Review 2 (folded in mid-task)

Not independently verified against the code yet, except where noted.

| #   | Area                                                              | Status                                             |
| --- | ----------------------------------------------------------------- | -------------------------------------------------- |
| B1  | Price-list SRP ignores currency                                   | not started, **not yet verified**                  |
| B2  | Per-variant unreadable quantity refuses the whole plan            | not started, reconciliation with F5 agreed (below) |
| I3  | No claim / kill-switch fence before each command batch            | not started, composes with F6                      |
| I4  | Orders drain computes systemic only from all-failed               | not started                                        |
| I5  | `errors.ts` `isSystemic` excludes 0, 401, 408                     | not started                                        |
| I6  | Fulfillment subscriber has no kill switch                         | not started                                        |
| I7  | Quantities read before the slow listing, so stalest at write time | not started                                        |
| I8  | Nothing reconciles `totalToPay` against the created order total   | not started                                        |
| I9  | `changes[0]?.desired ?? 0` trusts unasserted grouping             | **fixed, untested** (see landmine 3)               |
| I10 | One SKU in both `plan.upserts` and `plan.conflicts`               | not started, complements F8                        |
| I11 | Bounds-memory scan: no id tiebreak, O(all history) per tick       | not started                                        |
| I12 | No blast-radius cap on the manual per-SKU push                    | not started                                        |

Minor set: `buildStockCommandChunks(changes, 0)` infinite loop **fixed + tested**;
"success recorded when `completedAt` set but no `taskCount`" **fixed + tested** (it now
settles as pending). The rest of the minor set is not started: strict parsing in
`money.ts` and the category-rates route, README "additive and nullable" wording,
`$ilike` escaping, monitor `promoted ?? false` (do it with F2), admin sync route
running the full catalogue in-request.

Test-honesty gaps: all still open except the stock loop's two scope-warning tests,
which `277b1af` adds (they were missing from `78ed1d6`).

## Designs already settled (do not re-litigate)

**F2 promoted nullable.** Make `promoted` `model.boolean().nullable()` with no default;
migration drops the default and the NOT NULL, then `update allegro_offer set promoted
= null` so the next sweep repopulates. Null means unresolved everywhere. `planOffer`
passes `undefined` for null so the eligibility ladder's `promotion-unresolved` gate
becomes reachable. Discovery already writes `promoted` only from a resolved sweep
(`applyPlan` omits the key when `promotion.promoted === undefined`), so removing the DB
default is what actually fixes newly created rows. The unlink path should write `null`,
not `false`. `promotionStateLabel` must accept `boolean | null` and treat null as
"unknown". The monitor (`run-price-automation-monitor.ts:184`) uses
`promoted: row.promoted ?? false` for drift: with null semantics, drift is not
judgeable, so it must be false plus a counted `promotionUnresolved` surfaced in the
error line, not a silent default. Update the fixture that omits the key to pass null
explicitly.

**F3 derived_status gating.** Gate the `derived_status` write on `!lastError`, not just
on `!actionError`. `!lastError` is a strict superset and is needed: if the order CREATE
failed, no action ran, so `actionError` is undefined, and advancing `derived_status`
would suppress the `complete`/`cancel` action on the next pass that does create the
order. Same gate as `synced_at`, which keeps the two consistent. The retry is bounded
by the existing quarantine machinery, which is the designed behaviour.

**F4 order adoption.** Before creating, look for an existing Medusa order whose
`metadata.allegro_checkout_form_id` matches. `buildWhere` in
`@medusajs/utils/dist/modules-sdk/build-query.js` recurses into plain objects, so
`filters: { metadata: { allegro_checkout_form_id: id } }` reaches Mikro-ORM 6 as a JSON
property query. **Always re-verify the match in memory before adopting**, which makes a
silently-ignored filter safe rather than dangerous. Fall back to a bounded newest-first
scan (5 pages of 100, `created_at` DESC) with a loud warning if the filter throws. Keep
the link write immediately after create and wrap it in try/catch that logs the order id
for manual adoption.

**F5 + B2 reconciliation** (the two findings pull in opposite directions; this is the
agreed resolution): an EMPTY resolved stock-location list aborts the run loudly (status
error, no plan, no writes) because it is a configuration fault affecting everything; a
PER-VARIANT unreadable quantity drops that variant into a new counted
`skippedUnreadable` bucket and does NOT refuse the run. Whole-plan refusal stays for
`ambiguous > 0`. Also `catalog.ts:241`: a null/undefined per-item availability must mark
the variant unresolved rather than contributing 0 to the sum.

**F6 + F7 + I3 claim ownership.** Add `claim_token` (text) and `claim_heartbeat_at`
(timestamptz) to `allegro_sync_state`. `claimSyncRun` generates a token and writes it
in the same conditional update that sets `status: "running"`, so the CAS on `updated_at`
is unchanged. `touchSyncClaim(provider, token)` updates
`{ claim_heartbeat_at: new Date() }` selected on `{ provider, claim_token: token }`;
zero affected rows means the claim was lost. Write a genuinely changed value, because
an update whose fields all match may not flush and so would not bump `updated_at` (the
whole claim rests on the ORM's `onUpdate` bumping it). Expose `heartbeat()` on
`SyncRunContext`, throttled internally to about 60s so callers can call it per item;
call it per command (prices), per chunk submit and per completed poll (stock), per form
(orders drain and import window), and in the `discoverCategories` loop. A lost claim
aborts remaining writes and the `finally` must then skip the state write entirely,
because the row belongs to whoever took over. `STALE_CLAIM_MS` stays at 6 minutes.
For F7, pre-claim early exits must not clobber the shared row: the damage is real, since
`writeSyncState(provider, {status: "idle"})` while another run holds the claim lets the
next tick acquire it and run concurrently. Use a guarded write that skips when the row
is `running` and not stale. Post-claim exits release via the token. I3 adds a re-check
of claim ownership plus the kill switch before each command batch on both write loops.

**F8 + I10 discovery collisions.** Restructure the group loop to resolve each group to a
candidate first, collecting `resolvedBySku: Map<sku, claimants[]>`, then emit upserts
only for single-claimant SKUs and `duplicate-sku` conflicts (naming the offer ids) for
the rest. `ownedBy` is set only for single claimants. Emit these before
`alreadyConflicted` is computed. For I10, conflict wins: drop any upsert whose resolved
SKU appears in `conflicts`. Then add a fail-closed check in `applyPlan` that no row id
is queued twice and no two creates share a SKU, thrown before any write (the plan is
fully computed before writing, so nothing is half-applied).

**F9 + F10 stock pairing.** These interact. F10 changes `planStockSync` to take
authorized pairs (`{ offerId, sku }`) from the mapping rows and pair from the ROW's sku,
using the live listing only to verify agreement. That subsumes F9's primary symptom:
an EAN-linked offer gets its quantity from the row, so no SKU-map lookup of an EAN is
involved. F9's remaining requirement is the bucket contract, so add offer-side buckets
so every authorized offer lands in exactly one: `alreadyInSync`, `mismatched`,
`ambiguous`, `skippedInactive`, `unresolved`, plus new `skippedUnmatched` (absent from
the listing, or no eligible variant for the row's sku) and `conflicted` (live listing
disagrees). Verification: live `external.id` present and different from `row.sku` is a
conflict; absent sygnatura with an EAN checks against the variant's barcode, so
`VariantStock` gains `ean?`; no key at all is unverifiable and also a conflict. Record
these on the mapping row as a new `sku-mismatch` value in the `conflict` enum so the
admin shows them and every write path holds them out, and discovery clears them on the
next healthy upsert. Skip and count rather than refusing the whole run, and exclude
from `isStockCoverageComplete`. Add `skippedUnlinked` to `buildStockError` when nonzero.
Changing the signature means updating roughly 15 existing `planStockSync` tests; add a
spec helper that derives the authorized list from `external.id` so the healthy cases
stay one-liners and the disagreement cases are explicit.

**F11 standing health lines.** In `pushSingleAllegroOffer`, `settle` must never
downgrade to `ok` when the outcome failed: compose an explicit failure line for the
failed-command and no-mapping exits, and build the standing line from BOTH the failure
state and the prior `write_scope_missing` flag so the reconnect banner text does not
vanish. `importAllegroOrdersWindow` must recompute `standingHealthLine(priorFailures,
"order")` and fold it into its error line, exactly as `repairAllegroOrder` does; it
needs `state` in its destructure.

**F12 malformed forms.** Turn `readCheckoutForm` into a discriminated union:
`{ ok: true, view } | { ok: false, problems, facts }`, where `facts` carries only the
bookkeeping fields. Problems: missing form currency, and per line an unparseable price,
a non-positive-integer quantity, or a missing currency. `applyCheckoutForm` writes or
refreshes the bookkeeping row from `facts` with `last_error` set, no `synced_at`, no
`derived_status`, no Medusa order, then throws so the streak/quarantine machinery sees
it. `readCheckoutForm` has one caller (`order-upsert.ts`).

### Migrations needed

Three, hand-written in the style of the existing two (they were generated but committed,
and `medusa db:generate` needs a live database that is not available here):

1. `promoted`: drop default, drop NOT NULL, `set promoted = null`.
2. `allegro_sync_state`: add `claim_token text null`, `claim_heartbeat_at timestamptz null`.
3. `allegro_offer.conflict`: drop and re-add the check constraint
   (`allegro_offer_conflict_check`) with `sku-mismatch` added.

## Landmines

1. **The lint autofix rewrites value imports to `import type`.** It reverted
   `import { AllegroClient }` to `import type { AllegroClient }` in
   `sync-allegro-prices.ts` at a moment when the only usages were type positions. The
   static call added afterwards then threw `AllegroClient is not defined` at runtime,
   `runCommand` caught it as a per-offer failure, and 12 previously-passing tests failed
   with "every healthy push looks broken". Add the value usage and the import together,
   and re-check the import line after any lint/format pass. There is a comment on that
   import saying so.
2. **`sed`/`grep` via Bash does not satisfy the Edit tool's read requirement.** Use the
   Read tool before editing, or edits fail with a stale-file error.
3. **I9's chunk-uniformity assertion is untested.** `submitCommands` is not exported, so
   the invariant is unreachable from the public path. Either export it for a test or
   accept it as a defensive assertion; the `buildStockCommandChunks` stride guard beside
   it IS tested.
4. **`78ed1d6` is a mixed-authorship WIP commit.** Two agents were editing this tree
   concurrently; that commit preserves both sets of changes and its message explains
   which is which. Its own gates were not re-run, though they were verified green at the
   start of this session. `src/workflows/lib/scope-warnings.ts` and the README
   kill-switch section come from there and are complete and compatible.
5. **No partially applied refactors.** `277b1af` is self-contained and every gate passed
   before it was pushed. Nothing is half-migrated, and no schema change has been made
   yet, so the three migrations above are all still to write.

## Suggested order for the next session

F2 (unblocks the monitor null alignment and a real eligibility gate), then F3/F4/F12 as
one orders chunk, then F5+B2, then F9+F10 as one stock chunk, then F6+F7+I3 as one claim
chunk, then F8+I10, then F11, then B1, then the remaining review-2 importants. Commit and
push per chunk with all five gates green.
