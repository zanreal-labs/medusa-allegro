/**
 * Filling in the tax id an order was created without.
 *
 * ## The failure this exists for
 *
 * The invoice recipient's tax id used to be concatenated into
 * `billing_address.company` as `Name (NIP)`, because Medusa's order address has no
 * tax-id field. Every downstream consumer then had to un-concatenate it, and the
 * inFakt plugin's strip left the brackets behind - two invoices went out reading
 * `Name ( )`. `buildBillingAddress` no longer does that: the company field carries
 * the name Allegro sent and the tax id travels on `order.metadata.nip`.
 *
 * That leaves two orders this planner is for:
 *
 * 1. Orders created BEFORE the change. Their `metadata` has no `nip`, and their
 *    `company` still has `(NIP)` baked into it. The inFakt plugin still parses that
 *    (`nipFromCompanyField`), so they invoice correctly either way - but a pass that
 *    can hand them the structured value should, because that is the field the
 *    invoice is meant to read.
 * 2. Orders created from a checkout form the buyer had not finished. Those get their
 *    billing address filled in later by `planOrderAddressRepair`, and that fill now
 *    writes a CLEAN company name. Without this, the tax id would have nowhere left to
 *    live and a company sale would be invoiced as a consumer one.
 *
 * ## Gap only. Never an overwrite
 *
 * A `nip` already on the order's metadata is left alone, exactly like an address
 * already on the order. A human or another plugin may have corrected it, and Allegro's
 * copy is not automatically the better one. Only the absence of the key is acted on -
 * never a difference between the two values.
 */

/** The decision: write this tax id onto the order's metadata, or do nothing and say why. */
export type OrderTaxIdPlan = { kind: "skip"; reason: string } | { kind: "write"; nip: string };

/** Keys that already mean "this order's tax id", in the inFakt extractor's own order. */
const TAX_ID_METADATA_KEYS = ["nip", "tax_id", "taxId", "vat_id", "vatId"] as const;

/**
 * Whether the order's metadata already designates a tax id.
 *
 * All five keys the inFakt plugin's default extractor accepts are checked, not just
 * `nip`. Writing `nip` beside an existing `tax_id` would create two tax ids on one
 * order with a precedence rule deciding which one the invoice carries, which is the
 * kind of thing nobody finds until an invoice is wrong.
 */
const hasTaxId = (metadata: Record<string, unknown> | null | undefined): boolean =>
  TAX_ID_METADATA_KEYS.some((key) => {
    const value = metadata?.[key];
    return typeof value === "string" && value.trim().length > 0;
  });

export function planOrderTaxIdFill(
  taxId: string | undefined,
  metadata: Record<string, unknown> | null | undefined,
): OrderTaxIdPlan {
  const nip = taxId?.trim();
  if (!nip) {
    // Not a problem: a private purchase has no tax id, and neither has a company
    // whose id Allegro sent in a type `pickCompanyTaxId` refuses.
    return { kind: "skip", reason: "the checkout form carries no invoice tax id" };
  }
  if (hasTaxId(metadata)) {
    return { kind: "skip", reason: "the order already carries a tax id in its metadata" };
  }
  return { kind: "write", nip };
}
