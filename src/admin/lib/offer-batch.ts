import type { OfferRow } from "./types";

/**
 * One request per page of the Catalog table, instead of one per cell.
 *
 * The admin-kit Catalog calls a column's `loadData` once per row, and this
 * plugin now contributes two columns backed by the same offer row (the offer
 * status and the offer price). Done naively that is `2 x pageSize` requests to
 * `/admin/allegro/offers` every time the operator pages or searches - 200
 * requests for a page of 100, all of them asking the same table for one SKU
 * each.
 *
 * The offers route already accepts an exact SKU set (`?skus=A&skus=B`), so the
 * fix is to stop asking one at a time. Every `load()` call inside the same tick
 * lands in one batch: React flushes all the cells' effects in a single pass, so
 * by the time the scheduled flush runs, every visible row of both columns has
 * queued its SKU. One request comes back and fans out to all of them.
 *
 * De-duplication falls out of the same map: the two columns ask for the same
 * SKU, and that SKU appears in the request once.
 *
 * There is deliberately **no cache across batches**. An offer's price and state
 * are exactly the things a sync changes underneath the operator, so a re-render
 * has to be able to re-read them; coalescing within a tick is a saving, holding
 * a stale price is a lie.
 */

/**
 * SKUs per request. The route caps `limit` at 200; this stays under it with
 * room to spare and keeps the query string a sane length. The Catalog's largest
 * page size is 100, so in practice a page is always one request.
 */
export const MAX_SKUS_PER_REQUEST = 100;

/** Fetches the offer rows for an exact set of SKUs. */
export type OfferFetcher = (skus: string[]) => Promise<OfferRow[]>;

/** Defers a flush to the end of the current tick. */
export type FlushScheduler = (flush: () => void) => void;

interface Waiter {
  resolve: (offer: OfferRow | null) => void;
  reject: (error: unknown) => void;
}

export interface OfferBatcher {
  /**
   * The offer row for one SKU, or `null` when that SKU has no mapping at all.
   *
   * Rejects only when the request itself failed, so a cell can tell "this SKU
   * is not on Allegro" (a fact) from "the lookup broke" (an error).
   */
  load: (sku: string) => Promise<OfferRow | null>;
}

/**
 * Index a response by SKU, first row wins.
 *
 * `sku` is unique on the offer model, so this is normally a plain index. First
 * wins anyway because that is what the per-row `offers.find(...)` it replaces
 * did, and a behaviour change hidden inside a batching optimisation is exactly
 * the kind of thing nobody would look for later.
 */
function indexBySku(offers: readonly OfferRow[]): Map<string, OfferRow> {
  const bySku = new Map<string, OfferRow>();
  for (const offer of offers) {
    if (!bySku.has(offer.sku)) {
      bySku.set(offer.sku, offer);
    }
  }
  return bySku;
}

/**
 * Build a batcher over a given fetcher. Exported (rather than only the module
 * singleton below) so the batching contract can be asserted in a unit spec with
 * a fake fetcher and a synchronous scheduler.
 */
export function createOfferBatcher(
  fetchOffers: OfferFetcher,
  schedule: FlushScheduler = (flush) => {
    setTimeout(flush, 0);
  },
): OfferBatcher {
  const pending = new Map<string, Waiter[]>();
  let scheduled = false;

  const runChunk = (chunk: [string, Waiter[]][]): void => {
    const skus = chunk.map(([sku]) => sku);
    fetchOffers(skus)
      .then((offers) => {
        const bySku = indexBySku(offers);
        for (const [sku, waiters] of chunk) {
          const offer = bySku.get(sku) ?? null;
          for (const waiter of waiters) {
            waiter.resolve(offer);
          }
        }
      })
      .catch((error: unknown) => {
        for (const [, waiters] of chunk) {
          for (const waiter of waiters) {
            waiter.reject(error);
          }
        }
      });
  };

  const flush = (): void => {
    scheduled = false;
    const batch = [...pending.entries()];
    // Cleared before the fetch, so a `load` that arrives while this request is
    // in flight opens the next batch instead of joining one already sent.
    pending.clear();
    for (let index = 0; index < batch.length; index += MAX_SKUS_PER_REQUEST) {
      runChunk(batch.slice(index, index + MAX_SKUS_PER_REQUEST));
    }
  };

  return {
    load(sku: string): Promise<OfferRow | null> {
      return new Promise<OfferRow | null>((resolve, reject) => {
        const waiters = pending.get(sku);
        if (waiters) {
          waiters.push({ reject, resolve });
        } else {
          pending.set(sku, [{ reject, resolve }]);
        }
        if (!scheduled) {
          scheduled = true;
          schedule(flush);
        }
      });
    },
  };
}

/**
 * The fetcher itself, and the one batcher the columns share, are wired up in
 * the widget that registers those columns. This module stays free of the admin
 * SDK (whose module reads `import.meta.env`) so the batching contract can be
 * unit-tested in Node, the same way the rest of `src/admin/lib` is.
 */
