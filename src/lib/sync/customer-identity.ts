import type { AllegroCheckoutForm } from "../allegro/types";

/**
 * Who the Medusa CUSTOMER is for an order that arrived from Allegro.
 *
 * ## The gap this closes
 *
 * Medusa's `createOrderWorkflow` takes an `email` and nothing else about the person.
 * Its `findOrCreateCustomerStep` then calls `createCustomers({ email })` - literally
 * that one field - so every customer this plugin has ever created was a masked
 * Allegro relay address with `first_name`, `last_name` and `company_name` all NULL.
 * The order's shipping `order_address` carried the names correctly the whole time,
 * which is what made the hole easy to miss: the order LOOKED named, and only the
 * customer entity behind it was anonymous.
 *
 * There is no input on the order workflow that would have carried them, so the names
 * are written onto the customer after the order exists. See `nameOrderCustomer`.
 *
 * ## Which of the three people the customer entity is
 *
 * A checkout form carries up to three different people (`readCheckoutForm` documents
 * them in full):
 *
 * - `form.buyer` - the Allegro ACCOUNT holder's registration data.
 * - `form.delivery.address` - the buyer-entered SHIPPING recipient.
 * - `form.invoice.address` - the INVOICE recipient, `company` or `naturalPerson`.
 *
 * The Medusa customer is the ACCOUNT HOLDER, and only ever the account holder. The
 * decision follows from what a customer entity IS: the identity behind the account
 * that placed the order, the thing every future order from that login resolves to and
 * the thing `customer.email` already names. The relay email on the row is the account
 * holder's; pairing it with the delivery recipient's name would assert that the two
 * are the same person, and they routinely are not - a gift shipped to a relative, an
 * office delivery, a purchase invoiced to an employer. That mismatch is exactly the
 * error the previous system taught this team the hard way, where an account holder was
 * silently treated as the invoice recipient.
 *
 * So the other two people keep the homes they already have and are NOT copied here:
 * the delivery recipient stays on the shipping `order_address`, the invoice recipient
 * stays on the billing one. Nothing about that changes; this module only fills the
 * fourth place, which was empty.
 *
 * A consequence worth stating: for an order whose account holder is anonymous on
 * Allegro's side, the customer stays unnamed. Reaching for the delivery name to avoid
 * an empty field would be inventing an identity, and an unnamed customer beside a
 * correctly named address is both honest and repairable.
 */

/** The Allegro account holder, as this plugin names a Medusa customer from them. */
export interface BuyerIdentity {
  firstName?: string;
  lastName?: string;
  /** Set when the Allegro account is a company account. */
  companyName?: string;
}

const trimmed = (value?: string | null): string | undefined =>
  typeof value === "string" ? value.trim() || undefined : undefined;

/**
 * The account holder's name, from `form.buyer` alone.
 *
 * Deliberately not a fallback chain. Falling back to `delivery.address` when the buyer
 * block is thin would fill the field with the wrong person rather than leaving it
 * empty, which is the whole judgement this module exists to make.
 */
export const readBuyerIdentity = (form: AllegroCheckoutForm): BuyerIdentity => ({
  companyName: trimmed(form.buyer?.companyName),
  firstName: trimmed(form.buyer?.firstName),
  lastName: trimmed(form.buyer?.lastName),
});

/** Whether Allegro said anything about the account holder at all. */
export const hasBuyerIdentity = (identity: BuyerIdentity): boolean =>
  Boolean(identity.firstName ?? identity.lastName ?? identity.companyName);

/** The Medusa customer, as the fill reads it back off the order. */
export interface CustomerNameRow {
  id: string;
  first_name?: string | null;
  last_name?: string | null;
  company_name?: string | null;
}

/** Only the name columns, and only the ones this pass is actually filling. */
export interface CustomerNamePatch {
  first_name?: string;
  last_name?: string;
  company_name?: string;
}

/** What one pass should write onto the customer, or why it should write nothing. */
export type CustomerNamePlan =
  | { kind: "skip"; reason: string }
  | {
      kind: "fill";
      customerId: string;
      patch: CustomerNamePatch;
      /** The columns being filled, for the log line. Never the values - they are PII. */
      fields: string[];
    };

/** A column counts as empty when it is null, absent, or whitespace. */
const isEmpty = (value?: string | null): boolean => trimmed(value) === undefined;

/**
 * Fill-if-empty, never overwrite.
 *
 * The asymmetry is the point and it is what makes this safe to run on every pass of
 * both the drain and the reconciliation sweep:
 *
 * - An empty column is a gap this plugin left, so it gets Allegro's answer.
 * - A populated column is somebody's decision - a staff member correcting a name in
 *   the admin, or the emergency hand-patch that named the one live customer this bug
 *   produced - and Allegro never wins against it. That also makes the fix idempotent
 *   over that hand-patch: the row is already named, so this plans nothing.
 *
 * Per-column rather than per-row. A customer with a first name and no last name gets
 * only the last name written, because "partially named" is a real state and re-writing
 * the field a human already fixed is exactly the overwrite being avoided.
 */
export const planCustomerName = (
  identity: BuyerIdentity,
  customer: CustomerNameRow | undefined,
): CustomerNamePlan => {
  if (!customer?.id) {
    return {
      kind: "skip",
      reason:
        "the Medusa order carries no customer, so there is nobody to name (a guest order created without an email has none)",
    };
  }
  if (!hasBuyerIdentity(identity)) {
    return {
      kind: "skip",
      reason:
        "Allegro sent no name for the account holder on this checkout form, and the delivery recipient is a different person, so nothing is invented",
    };
  }

  const patch: CustomerNamePatch = {};
  if (identity.firstName && isEmpty(customer.first_name)) {
    patch.first_name = identity.firstName;
  }
  if (identity.lastName && isEmpty(customer.last_name)) {
    patch.last_name = identity.lastName;
  }
  // Only for a company account. A private buyer has no `companyName`, and the invoice
  // company - which a private buyer CAN have, ordering from their own firm - belongs on
  // the billing address rather than on the person's customer record.
  if (identity.companyName && isEmpty(customer.company_name)) {
    patch.company_name = identity.companyName;
  }

  const fields = Object.keys(patch).sort();
  if (fields.length === 0) {
    return {
      kind: "skip",
      reason: "the customer already carries every name Allegro sent; nothing is overwritten",
    };
  }
  return { customerId: customer.id, fields, kind: "fill", patch };
};
