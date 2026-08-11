# Review-fix handoff

Wave 2-4 sync engine, two adversarial review sets. All 13 of review 1 are fixed. Most of
review 2 is fixed; the remainder is listed below with what is left to do.

**Base:** `main`, pushed to `origin/main`. Working tree clean.

## Gate status

All five gates run and green at every pushed commit, including the last:

| Gate           | Command                                   | Result                                |
| -------------- | ----------------------------------------- | ------------------------------------- |
| Unit suite     | `npm run test:unit`                       | 729 passed / 30 suites (baseline 642) |
| Lint           | `npm run lint` (`medusa lint`)            | no issues, no warnings                |
| Types (server) | `tsc --noEmit -p tsconfig.spec.json`      | clean                                 |
| Types (admin)  | `tsc --noEmit -p src/admin/tsconfig.json` | clean                                 |
| Build          | `npm run build` (`medusa plugin:build`)   | plugin + admin extensions succeed     |

## Review 1: all 13 fixed

Every one was verified to reproduce first. None was rejected.

| #   | Area                                                         | Commit    |
| --- | ------------------------------------------------------------ | --------- |
| 1   | Timed-out price command recorded as confirmed success        | `277b1af` |
| 2   | `promoted` could never be "unresolved"                       | `57cea6b` |
| 3   | `derived_status` advanced when the Medusa action failed      | `dd05d85` |
| 4   | Crash between order create and link write duplicated orders  | `dd05d85` |
| 5   | Zero stock locations pushed zero across the catalogue        | `970e992` |
| 6   | Sync claim had no heartbeat                                  | `be3d026` |
| 7   | Pre-claim `writeSyncState` released another run's claim      | `be3d026` |
| 8   | Two offers resolving to one variant both claimed the SKU row | `612c224` |
| 9   | `stock-plan` EAN fallback looked the EAN up in the SKU map   | `970e992` |
| 10  | Stock plan re-derived pairing from the live listing          | `970e992` |
| 11  | Failed manual push settled the provider row as `ok`          | `612c224` |
| 12  | Unparseable price became 0, missing quantity became 1        | `dd05d85` |
| 13  | Task confirmation read a single page                         | `277b1af` |

Three migrations were written by hand, in the style of the existing generated ones
(`medusa db:generate` needs a live database, which is not available here):

- `Migration20260811160000` - `promoted` nullable, default dropped, existing rows nulled.
- `Migration20260811170000` - `sku-mismatch` added to the `conflict` CHECK.
- `Migration20260811180000` - `claim_token` and `claim_heartbeat_at` on the sync state.

## Review 2

| #   | Area                                                      | Status                           |
| --- | --------------------------------------------------------- | -------------------------------- |
| B1  | Price-list SRP ignored currency                           | fixed, `a0ce617`                 |
| B2  | Per-variant unreadable quantity refused the whole plan    | fixed, `970e992`                 |
| I3  | No claim fence before each command batch                  | fixed, `be3d026`                 |
| I4  | Orders drain inferred systemic only from all-failed       | fixed, `a0ce617`                 |
| I5  | `isSystemic` excluded transport failure, 408, 401         | fixed, `a0ce617`                 |
| I6  | Fulfillment subscriber has no kill switch                 | **rejected as designed** (below) |
| I7  | Quantities read before the slow listing                   | fixed, `970e992`                 |
| I8  | Nothing reconciles `totalToPay` against the created order | **not done**                     |
| I9  | `changes[0]?.desired ?? 0` trusted unasserted grouping    | fixed, `277b1af`                 |
| I10 | One SKU in both `upserts` and `conflicts`                 | fixed, `612c224`                 |
| I11 | Bounds scan: no id tiebreak, unbounded                    | fixed, `7510460`                 |
| I12 | No blast-radius cap on the manual per-SKU push            | **not done, needs detail**       |

Minor set: chunk-stride guard and `completedAt`-without-`taskCount` both fixed
(`277b1af`); monitor `promoted ?? false` fixed with finding 2. **Not done:** strict
parsing in `money.ts` and the category-rates route, `$ilike` escaping in the offers
route, README "additive and nullable" wording, and the admin sync route running a full
catalogue pass in-request.

### I6: rejected, with evidence

Not a gap, a documented decision. `src/subscribers/allegro-fulfillment-push.ts:19` states
that `ordersSyncDisabled` deliberately does not gate the write-back, and the README says
so twice more (the "Fulfillment write-back" section and "Stopping the writers, now"), with
the rationale: that switch stops the drain from CONSUMING the journal, and a store that
has shipped an order still wants the buyer to see it shipped.

The reviewer's underlying concern is real, though, so it is now written down rather than
left implicit: there is no switch that stops this one write while leaving order import
running, and disconnecting stops everything. The README section records that trade-off and
the procedure for the case where you do need to stop it.

### I8 and I12: what is left

**I8** - reconcile `totalToPay` against the created Medusa order's total. Groundwork is in
place: finding 12 means every line now carries a real parsed price and quantity, and
`CheckoutFormFacts.totalToPayAmount` carries Allegro's figure verbatim, so the comparison
has trustworthy inputs on both sides. Remaining decision: what a mismatch should DO.
Refusing the order loses a real sale, so the likely answer is to record it on
`allegro_order.last_error` and count it, in the spirit of `line_conflicts`. Note the
totals will legitimately differ when a line is unmatched and carried as a custom item, so
the check needs a tolerance or an exemption for orders with line conflicts.

**I12** - needs the original review text. The manual push already pushes exactly one
offer, so `changeCap` does not apply to it and "blast radius" is ambiguous. Do not guess:
ask the reviewer what the intended cap is.

## Landmines

1. **The lint autofix rewrites value imports to `import type`.** It reverted
   `import { AllegroClient }` in `sync-allegro-prices.ts` when the only usages were type
   positions. The static call added afterwards threw `AllegroClient is not defined` at
   runtime, `runCommand` caught it as a per-offer failure, and 12 passing tests failed
   with "every healthy push looks broken". There is a comment on that import saying so.
   Add the value usage and the import together, and re-check after any lint pass.
2. **`sed`/`grep` via Bash does not satisfy the Edit tool's read requirement.** Use Read
   before editing, or edits fail as stale.
3. **The fakes now honour selectors.** `fakeAllegroService` mints claim tokens and enforces
   them on `touchSyncClaim` / `writeSyncState` / `writeSyncStateIfUnclaimed`, and
   `listAllegroOffers` accepts an array `sku`. Keep it that way: a fake that stubs those
   true makes the whole claim spec pass vacuously, and one that omitted the token made
   every run report the claim as held.
4. **`78ed1d6` is a mixed-authorship WIP commit** from a concurrent-agent collision. Its
   `scope-warnings.ts` and README kill-switch content is complete and was kept.
5. **`submitCommands`' chunk-uniformity assertion is untested** - the function is not
   exported, so the invariant is unreachable from the public path. The
   `buildStockCommandChunks` stride guard beside it IS tested.
