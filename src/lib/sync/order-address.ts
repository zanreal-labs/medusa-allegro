import type { OrderAddress } from "../../workflows/lib/checkout-form";

/**
 * Filling in an order address the create path never received.
 *
 * ## The failure this exists for
 *
 * The drain creates the Medusa order from a checkout form snapshot. A buyer who
 * has not finished the form yet has no `delivery.address` on it, so the order is
 * created without one - correctly, because there was nothing to write. Minutes
 * later the buyer finishes, the address appears at Allegro, and nothing ever puts
 * it on the order: addresses are written in exactly one place, inside
 * `createOrderWorkflow`, and no path updates them afterwards.
 *
 * Measured on this store: of 27 drained orders, 26 have both addresses and one -
 * order #49 - has neither. Its form was last updated 2m11s AFTER we created the
 * order. The mapping was never wrong; it was handed nothing, and then never asked
 * again. That order could not be invoiced at all.
 *
 * ## Gap only. Never an overwrite
 *
 * A field that already has a value is left completely alone, even when Allegro's copy
 * differs. A human may have corrected it, and reverting a corrected invoice address to
 * the marketplace's copy is a worse failure than the one this fixes. If Allegro's copy
 * is newer and ours is wrong, that is something to report to a person, not something to
 * resolve automatically.
 *
 * ## All three fields or nothing
 *
 * `street`, `city` and `postal_code` - the exact three the invoice builder's gate
 * demands. A partial address is refused rather than written, because half an
 * address on an invoice is wrong AND looks right, which is worse than an absent
 * one that parks the invoice loudly.
 *
 * ## Completeness is a property of the FIELDS, never of the row
 *
 * This used to ask the order whether a `billing_address` row existed, and that was a
 * latch. `createOrderWorkflow` is handed `view.billingAddress` with no gate, and
 * `orUndefined` in `checkout-form` returns an address when ANY field is truthy - so a
 * form that had reached Allegro carrying only, say, a first name and a country code
 * created a billing address row with no street, no city and no postal code. From that
 * moment the row existed, this planner said "the order already has both addresses",
 * and the three fields the invoice needs were never filled in on any pass. The orders
 * that most needed the repair were the exact ones it refused.
 *
 * So the question asked here is `isUsableAddress`, against the values the order
 * actually holds. A partial address is a GAP, not an address.
 *
 * ## Filling a partial address fills the blanks only
 *
 * Repairing a partial row is still gap-only, one field at a time: every value the
 * order already carries survives, and only the blanks are taken from Allegro's copy.
 * See `fillAddressGaps`. That keeps the promise the whole module is built on - a human
 * may have corrected a field, and Allegro's copy is not automatically the better one -
 * while letting the fields nobody ever set be filled in.
 */

/** The decision: write these addresses, or do nothing and say why. */
export type OrderAddressPlan =
  | { kind: "skip"; reason: string }
  | {
      kind: "write";
      /** Only the fields that were absent. Never includes one already set. */
      patch: { shipping_address?: OrderAddress; billing_address?: OrderAddress };
      /** Which ones are being filled, for the log line. */
      fields: ("shipping_address" | "billing_address")[];
    };

/**
 * What the order currently holds, as far as this decision cares.
 *
 * The ADDRESSES, not two booleans about whether a row exists. The booleans were the
 * latch described above: a partial row read as "has an address" forever.
 */
export interface OrderAddressSnapshot {
  /** The order's shipping address as it stands. Absent when it has none at all. */
  shippingAddress?: OrderAddress;
  /** The order's billing address as it stands. Absent when it has none at all. */
  billingAddress?: OrderAddress;
}

/** The three fields the invoice builder demands, all present and non-blank. */
export const isUsableAddress = (address: OrderAddress | undefined): boolean =>
  Boolean(address?.address_1?.trim() && address?.city?.trim() && address?.postal_code?.trim());

/**
 * Every field of an order address, named rather than walked.
 *
 * A row read back off the query graph carries far more than an address - an id,
 * timestamps, an `order_id`, a `metadata` column - and spreading that into a write
 * would send the order module fields it never asked for. Naming the nine is also what
 * makes `fillAddressGaps` total: a field added here in future is merged, and one that
 * is not is visibly not.
 */
const ADDRESS_FIELDS = [
  "first_name",
  "last_name",
  "company",
  "address_1",
  "address_2",
  "city",
  "postal_code",
  "country_code",
  "phone",
] as const;

const isBlank = (value: string | undefined): boolean => !value?.trim();

/** The address fields off a row that carries more than an address. */
export const readAddressFields = (
  row: Record<string, unknown> | null | undefined,
): OrderAddress | undefined => {
  if (!row) {
    return undefined;
  }
  const address: OrderAddress = {};
  for (const field of ADDRESS_FIELDS) {
    const value = row[field];
    if (typeof value === "string" && value.trim()) {
      address[field] = value;
    }
  }
  return address;
};

/**
 * `candidate` under `current`: every value the order already has survives, and only
 * its blanks are taken from Allegro's copy.
 *
 * This is the gap-only invariant expressed one field at a time rather than one address
 * at a time, which is what makes repairing a PARTIAL address safe. Writing the
 * candidate wholesale would revert a company name or a phone number a human had
 * corrected, on an order whose street happened to be missing.
 */
export const fillAddressGaps = (
  current: OrderAddress | undefined,
  candidate: OrderAddress,
): OrderAddress => {
  if (!current) {
    return candidate;
  }
  const merged: OrderAddress = {};
  for (const field of ADDRESS_FIELDS) {
    const kept = current[field];
    const value = isBlank(kept) ? candidate[field] : kept;
    if (value !== undefined) {
      merged[field] = value;
    }
  }
  return merged;
};

export function planOrderAddressRepair(
  candidate: { shippingAddress?: OrderAddress; billingAddress?: OrderAddress },
  snapshot: OrderAddressSnapshot,
): OrderAddressPlan {
  const shippingUsable = isUsableAddress(snapshot.shippingAddress);
  const billingUsable = isUsableAddress(snapshot.billingAddress);
  if (shippingUsable && billingUsable) {
    return { kind: "skip", reason: "the order already has both addresses" };
  }

  const patch: { shipping_address?: OrderAddress; billing_address?: OrderAddress } = {};
  const fields: ("shipping_address" | "billing_address")[] = [];

  // The merge happens BEFORE the usability test, deliberately: a row holding only a
  // city and Allegro's copy holding only a street together make a usable address that
  // neither of them is on its own, and refusing it would leave the order uninvoiceable
  // over a completeness test applied to the wrong half of the answer.
  if (!shippingUsable && candidate.shippingAddress) {
    const merged = fillAddressGaps(snapshot.shippingAddress, candidate.shippingAddress);
    if (isUsableAddress(merged)) {
      patch.shipping_address = merged;
      fields.push("shipping_address");
    }
  }
  if (!billingUsable && candidate.billingAddress) {
    const merged = fillAddressGaps(snapshot.billingAddress, candidate.billingAddress);
    if (isUsableAddress(merged)) {
      patch.billing_address = merged;
      fields.push("billing_address");
    }
  }

  if (fields.length === 0) {
    return {
      kind: "skip",
      // Named separately from "already complete" because they need different
      // actions: one is fine, the other means Allegro still has nothing usable.
      reason: "the checkout form carries no address with a street, a city and a postal code",
    };
  }

  return { fields, kind: "write", patch };
}
