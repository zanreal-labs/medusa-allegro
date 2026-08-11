/**
 * Per-item consecutive-failure bookkeeping, shared by every retrying loop.
 *
 * Two loops need it and need it identically: price sync retries an Allegro offer
 * id, the orders drain retries a checkout-form id. Both must answer the same
 * three questions, so the answers live here once rather than in two copies that
 * drift.
 *
 * ## Why quarantine exists
 *
 * Both loops refuse to give up on an item after one failure, which is what makes
 * a transient fault (a 500 from Allegro, a lock timeout) replay instead of being
 * lost. Applied without limit that same rule turns one permanently broken item
 * into a hard stop: price sync burns its whole per-run budget on it every tick,
 * and the orders drain pins its event cursor at that item's event forever, so
 * eventually no order imports at all. After `QUARANTINE_AFTER_FAILURES`
 * consecutive failures the item is set aside, and the loop moves on.
 *
 * Quarantine is a visible trade, never a silent one. The item stays in this
 * state, it is named in `last_error`, it is listed in the admin, and a per-item
 * repair action is the remedy.
 *
 * ## Why an outage must not quarantine anything
 *
 * Quarantine is only ever safe on the evidence that the rest of the pipeline
 * works, so it is gated on a success in the same tick. When Allegro is down every
 * item fails together; without that gate every active item's streak would climb
 * in lockstep, the whole working set would cross the threshold on the same tick,
 * and all of it would be set aside - turning a five-minute outage into bulk
 * silently skipped work, each piece needing manual repair. A tick where every
 * attempt failed and none succeeded is therefore SYSTEMIC: no streak grows,
 * nothing is quarantined, and the next tick retries. Stuck-and-self-healing beats
 * skipped.
 *
 * ## Why the two maps are separate
 *
 * A quarantined item is never retried automatically, so its entry lives until an
 * operator repairs it. Sharing one capped map with the live streaks meant those
 * permanent entries - the highest counts, therefore the last evicted - would fill
 * the cap and evict every fresh streak at count 1. A newly broken item could then
 * never reach its own quarantine, which pins the loop again by a longer route.
 * Separate caps, and separate age limits, keep a fresh item's escape open no
 * matter how much unrepaired backlog has piled up.
 */

/** One item's live consecutive-failure record, below the quarantine threshold. */
export interface FailureStreak {
  count: number;
  error: string;
  /** ISO timestamp of the FIRST failure in the current streak. */
  since: string;
}

/** An item the loop has given up on. No count: it is past the threshold. */
export interface QuarantinedItem {
  error: string;
  /** ISO timestamp of the first failure of the streak that led here. */
  since: string;
}

/** The shape persisted on `allegro_sync_state.failures`. */
export interface FailureState {
  /** Live consecutive-failure counts, below the quarantine threshold. */
  streaks: Record<string, FailureStreak>;
  /** Items given up on, so the loop could make progress past them. */
  quarantined: Record<string, QuarantinedItem>;
}

/** Consecutive failures of one item before the loop stops auto-retrying it. */
export const QUARANTINE_AFTER_FAILURES = 5;

/**
 * Cap on remembered sub-threshold streaks, so a systemic outage that fails
 * hundreds of items cannot grow the state row without bound. Evicts the LOWEST
 * count first, longest-standing among equals, so the entries nearest their escape
 * are the last to go - evicting the oldest instead would starve a genuine poison
 * item of the quarantine that unblocks the loop.
 */
export const MAX_TRACKED_STREAKS = 200;

/**
 * Cap on remembered quarantined items. Evicts the oldest `since` first, which is
 * safe: the loop has already moved past a quarantined item, so its entry carries
 * only the operator's to-do, not any sync state. Dropping it loses the warning,
 * never correctness, and a later failure starts a fresh streak.
 */
export const MAX_TRACKED_QUARANTINES = 200;

/**
 * Age at which a sub-threshold streak is forgotten.
 *
 * `since` is the streak's FIRST failure, and anything still failing crosses the
 * threshold within five ticks, so a streak this old belongs to an item that
 * simply stopped coming up. Keeping it would only consume a slot.
 */
export const STREAK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Age at which a quarantined item is forgotten.
 *
 * Much longer than `STREAK_TTL_MS`, because the entry is a standing instruction
 * to an operator. Measured from `since`, which the quarantine transition carries
 * over from the streak, so the clock starts at the item's FIRST failure rather
 * than when the loop gave up on it. That is deliberate - what matters is how long
 * the item has been unreachable, not when this code stopped trying - but it means
 * the effective life is 30 days minus however long the streak ran. `STREAK_TTL_MS`
 * bounds that gap, so the floor is 23 days.
 */
export const QUARANTINE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const emptyFailureState = (): FailureState => ({ quarantined: {}, streaks: {} });

/** Normalize whatever the json column holds into a full `FailureState`. */
export const readFailureState = (raw: unknown): FailureState => {
  if (!raw || typeof raw !== "object") {
    return emptyFailureState();
  }
  const value = raw as Partial<FailureState>;
  return { quarantined: value.quarantined ?? {}, streaks: value.streaks ?? {} };
};

/** True when the state carries nothing worth persisting (write null instead). */
export const isEmptyFailureState = (state: FailureState): boolean =>
  Object.keys(state.streaks).length === 0 && Object.keys(state.quarantined).length === 0;

/** Drop entries older than `ttlMs`, then cap what remains by `order` (kept = first). */
export const pruneEntries = <T extends { since: string }>(
  entries: [string, T][],
  ttlMs: number,
  cap: number,
  order: (a: T, b: T) => number,
  now: number = Date.now(),
): Record<string, T> => {
  const cutoff = now - ttlMs;
  const live = entries.filter(([, entry]) => {
    const since = Date.parse(entry.since);
    // An unparseable `since` is kept rather than dropped: it is corrupt
    // bookkeeping, and silently discarding it would silently un-quarantine an
    // item the loop had given up on.
    return !Number.isFinite(since) || since >= cutoff;
  });
  const kept =
    live.length > cap ? live.toSorted(([, a], [, b]) => order(a, b)).slice(0, cap) : live;
  return Object.fromEntries(kept);
};

/** What one run did to the items it attempted. */
export interface FailureOutcome {
  /** Item key -> failure message, for everything that failed this run. */
  failed: Map<string, string>;
  /** Item keys that succeeded this run. */
  succeeded: ReadonlySet<string>;
}

/**
 * Did this tick fail in a way that says "the pipeline is down" rather than "this
 * item is bad"?
 *
 * The discriminator is a success in the same tick. See the module comment for why
 * anything weaker turns an outage into bulk skipped work.
 */
export const isSystemicFailure = (outcome: FailureOutcome): boolean =>
  outcome.failed.size > 0 && outcome.succeeded.size === 0;

/**
 * Fold one run's outcomes into the persisted failure state.
 *
 * A success clears the item from BOTH maps, so only consecutive failures count
 * toward quarantine, a recovered item starts from zero, and a quarantined item
 * that a later pass fixes stops being reported. A systemic tick changes nothing
 * at all: no streak grows, so an outage can never quarantine anything.
 *
 * `systemic` is passed in rather than recomputed because the caller may already
 * know it from a stronger signal than "everything failed" - a 429, a 5xx, an auth
 * error, or the 403 write-scope gap are each systemic on their own, even on a tick
 * that also had successes.
 */
export const updateFailureState = (
  previous: FailureState,
  outcome: FailureOutcome & { systemic: boolean },
  now: Date = new Date(),
): { failures: FailureState; quarantined: string[] } => {
  if (outcome.systemic) {
    return { failures: previous, quarantined: Object.keys(previous.quarantined) };
  }

  const timestamp = now.toISOString();
  const streaks: [string, FailureStreak][] = [];
  const quarantined: [string, QuarantinedItem][] = [];

  // Carry forward everything this run did not resolve.
  for (const [key, entry] of Object.entries(previous.quarantined)) {
    if (!outcome.succeeded.has(key)) {
      quarantined.push([key, entry]);
    }
  }
  for (const [key, entry] of Object.entries(previous.streaks)) {
    if (!(outcome.succeeded.has(key) || outcome.failed.has(key))) {
      streaks.push([key, entry]);
    }
  }

  for (const [key, error] of outcome.failed) {
    // An already-quarantined item that failed again stays quarantined; its entry
    // is refreshed so the reported error is the current one, and `since` is
    // preserved so the TTL still measures from the first failure.
    const standing = previous.quarantined[key];
    if (standing) {
      const index = quarantined.findIndex(([id]) => id === key);
      const entry: [string, QuarantinedItem] = [key, { error, since: standing.since }];
      if (index === -1) {
        quarantined.push(entry);
      } else {
        quarantined[index] = entry;
      }
      continue;
    }
    const prior = previous.streaks[key];
    const count = (prior?.count ?? 0) + 1;
    const since = prior?.since ?? timestamp;
    if (count >= QUARANTINE_AFTER_FAILURES) {
      quarantined.push([key, { error, since }]);
    } else {
      streaks.push([key, { count, error, since }]);
    }
  }

  const keptQuarantined = pruneEntries(
    quarantined,
    QUARANTINE_TTL_MS,
    MAX_TRACKED_QUARANTINES,
    // Newest first, so the oldest standing to-dos are the ones dropped.
    (a, b) => b.since.localeCompare(a.since),
    now.getTime(),
  );
  const keptStreaks = pruneEntries(
    streaks,
    STREAK_TTL_MS,
    MAX_TRACKED_STREAKS,
    // Highest count first, longest-standing among equals, so the entries nearest
    // their quarantine are the last to be evicted.
    (a, b) => b.count - a.count || a.since.localeCompare(b.since),
    now.getTime(),
  );

  return {
    failures: { quarantined: keptQuarantined, streaks: keptStreaks },
    quarantined: Object.keys(keptQuarantined),
  };
};

/** One quarantined item, flattened for the admin. */
export interface QuarantineEntry {
  key: string;
  error: string;
  since: string;
}

/**
 * The quarantined items in a persisted payload, oldest streak first.
 *
 * Pure, and exported for the admin. Without it a quarantine was only visible in
 * the one-line summary of a manual run - so an operator had to trigger a sync to
 * discover that something had been skipped, and the reason vanished on the next
 * render. The column is the durable record; this is how the UI reads it.
 */
export const listQuarantined = (raw: unknown): QuarantineEntry[] => {
  const { quarantined } = readFailureState(raw);
  return Object.entries(quarantined)
    .map(([key, entry]) => ({ error: entry.error, key, since: entry.since }))
    .toSorted((a, b) => a.since.localeCompare(b.since));
};

/**
 * Clear one item from both maps, for the per-item repair action.
 *
 * Both, not just `quarantined`: a repaired item must stop being reported AND must
 * not resume a stale streak that would re-quarantine it after one more blip.
 */
export const clearFailureKey = (
  state: FailureState,
  key: string,
): { failures: FailureState; cleared: boolean } => {
  const { [key]: clearedStreak, ...streaks } = state.streaks;
  const { [key]: clearedQuarantine, ...quarantined } = state.quarantined;
  return {
    cleared: Boolean(clearedStreak || clearedQuarantine),
    failures: { quarantined, streaks },
  };
};

/**
 * The standing health line for a state row: names any items still quarantined, or
 * null when the loop is clean.
 *
 * Used by the per-item action paths so a single repair never wipes the quarantine
 * signal off the admin - they recompute this line rather than nulling
 * `last_error`.
 */
export const standingHealthLine = (state: FailureState, noun: string): string | null => {
  const keys = Object.keys(state.quarantined);
  if (keys.length === 0) {
    return null;
  }
  return `${keys.length} ${noun}(s) quarantined after repeated failures and skipped by the loop: ${keys.join(", ")}`;
};
