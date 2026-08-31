/**
 * The supplier stock-change contract, read defensively.
 *
 * ## What this is
 *
 * A supplier plugin (in this stack, the Marken licence integration) announces the
 * SKUs whose quantity it just moved in Medusa inventory. This plugin listens, and
 * pushes those offers to Allegro immediately instead of waiting for its own 15-minute
 * reconciliation to notice.
 *
 * The whole coupling is this event name and the shape below. Neither plugin imports
 * the other, for the same reason the invoicing chain does not: a store can sell on
 * Allegro without reselling licences, and resell licences without selling on Allegro.
 * With no supplier plugin installed, nothing here is ever reached.
 *
 * ## Why the payload is read this defensively
 *
 * It crosses a version boundary between two separately-installable, separately-versioned
 * plugins. `skus` is required and everything else is ignored; a malformed payload is
 * DESCRIBED and dropped rather than thrown, because a throwing subscriber would be
 * retried with the same malformed payload until its budget ran out and the reason
 * would never reach anybody.
 *
 * Dropping is safe in a way that is worth being explicit about: the event is a HINT
 * about what to re-read, never a source of quantity. The push reads Medusa's available
 * quantity and Allegro's offer for itself, so the worst case of a payload this module
 * refuses is the staleness the store had before the fast path existed - one
 * reconciliation cycle - never a wrong number on a listing.
 */

/** The event the supplier plugin emits. Spelled once, asserted on both sides. */
export const SUPPLIER_STOCK_CHANGED_EVENT = "marken.stock.changed";

/**
 * SKUs accepted from one announcement.
 *
 * A supplier feed that suddenly reports its entire catalogue as changed is a bug in
 * the feed or a systemic re-derivation, not a real event, and honouring it would put
 * the whole catalogue through the push path at once. The cap is generous enough that
 * a genuine bulk restock still passes, and the queue's own coalescing bounds what
 * arrives anyway; anything past it is truncated with a warning rather than dropped
 * silently, and the reconciliation covers the remainder.
 */
export const MAX_SUPPLIER_SKUS = 1000;

/**
 * A payload this plugin could use, or the reason it could not.
 *
 * Discriminated on an explicit `ok` rather than on the presence of `skip`: an
 * optional-undefined property does not narrow a union reliably, and the version this
 * replaced type-checked at the definition and then failed at every call site.
 */
export type SupplierStockChanged =
  | { ok: true; skus: string[]; truncated?: number }
  | { ok: false; skip: string };

/**
 * Read a `marken.stock.changed` payload.
 *
 * Accepts `{ skus: string[] }` and nothing else. Blank and non-string entries are
 * dropped individually rather than refusing the batch - one bad entry in a list of
 * fifty should cost that entry, not the other forty-nine.
 */
export const readSupplierStockChanged = (data: unknown): SupplierStockChanged => {
  if (typeof data !== "object" || data === null) {
    return { ok: false, skip: "the payload is not an object" };
  }
  const raw = (data as { skus?: unknown }).skus;
  if (!Array.isArray(raw)) {
    return { ok: false, skip: "the payload carries no `skus` array" };
  }
  const skus = [
    ...new Set(
      raw
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
  if (skus.length === 0) {
    // Distinguished from a missing array on purpose: "the supplier sent an empty
    // list" is a no-op worth naming differently from "the payload was the wrong
    // shape", because only the second is a compatibility problem.
    return { ok: false, skip: "the payload named no usable SKU" };
  }
  if (skus.length > MAX_SUPPLIER_SKUS) {
    return {
      ok: true,
      skus: skus.slice(0, MAX_SUPPLIER_SKUS),
      truncated: skus.length - MAX_SUPPLIER_SKUS,
    };
  }
  return { ok: true, skus };
};
