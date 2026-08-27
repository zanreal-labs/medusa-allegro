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
 * An address that is already on the order is left completely alone, even when
 * Allegro's copy differs. A human may have corrected it, and reverting a corrected
 * invoice address to the marketplace's copy is a worse failure than the one this
 * fixes. If Allegro's copy is newer and ours is wrong, that is something to report
 * to a person, not something to resolve automatically.
 *
 * ## All three fields or nothing
 *
 * `street`, `city` and `postal_code` - the exact three the invoice builder's gate
 * demands. A partial address is refused rather than written, because half an
 * address on an invoice is wrong AND looks right, which is worse than an absent
 * one that parks the invoice loudly.
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

/** What the order currently holds, as far as this decision cares. */
export interface OrderAddressSnapshot {
  hasShippingAddress: boolean;
  hasBillingAddress: boolean;
}

/** The three fields the invoice builder demands, all present and non-blank. */
export const isUsableAddress = (address: OrderAddress | undefined): boolean =>
  Boolean(address?.address_1?.trim() && address?.city?.trim() && address?.postal_code?.trim());

export function planOrderAddressRepair(
  candidate: { shippingAddress?: OrderAddress; billingAddress?: OrderAddress },
  snapshot: OrderAddressSnapshot,
): OrderAddressPlan {
  if (snapshot.hasShippingAddress && snapshot.hasBillingAddress) {
    return { kind: "skip", reason: "the order already has both addresses" };
  }

  const patch: { shipping_address?: OrderAddress; billing_address?: OrderAddress } = {};
  const fields: ("shipping_address" | "billing_address")[] = [];

  if (!snapshot.hasShippingAddress && isUsableAddress(candidate.shippingAddress)) {
    patch.shipping_address = candidate.shippingAddress;
    fields.push("shipping_address");
  }
  if (!snapshot.hasBillingAddress && isUsableAddress(candidate.billingAddress)) {
    patch.billing_address = candidate.billingAddress;
    fields.push("billing_address");
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
