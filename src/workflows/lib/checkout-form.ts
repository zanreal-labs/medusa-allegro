import type { AllegroCheckoutForm, AllegroInvoiceCompany } from "../../lib/allegro/types";
import { parseAmount } from "../../lib/sync/money";

/**
 * Reading a checkout form: who the order is for, what was bought, what was paid.
 *
 * ## A checkout form carries up to THREE different people
 *
 * Reading only the first of them is how an integration ends up displaying a name
 * the Allegro seller panel contradicts:
 *
 * - `form.buyer` is the ACCOUNT holder's registration data. No Allegro seller ever
 *   sees these names in their own UI.
 * - `form.delivery.address` is the buyer-entered SHIPPING recipient. This IS what
 *   the seller sees against the order on Allegro, and it is what a parcel label
 *   needs.
 * - `form.invoice.address` is the invoice recipient - `company` for a corporate
 *   purchase, `naturalPerson` for a private one. This is the name the issued
 *   invoice carries, and it can legitimately name someone other than the buyer.
 *
 * They are genuinely different facts, so they are kept separately. The shipping
 * address becomes the Medusa order's shipping address (that is what it is for); the
 * billing address comes from the invoice block when there is one, and falls back to
 * the shipping address rather than to the account holder's registration address.
 */

/** Money on an order, kept as the decimal string Allegro sent plus a parsed number. */
export interface OrderMoney {
  amount: number;
  /** Absent when Allegro stated an amount without a currency. Never defaulted. */
  currency?: string;
}

const money = (value?: { amount: string; currency: string }): OrderMoney | undefined => {
  const amount = parseAmount(value?.amount);
  if (amount === undefined) {
    return undefined;
  }
  // No PLN fallback. It was dead for the order total - `readCheckoutForm` refuses a form with
  // no order currency before this runs - and for the delivery cost it would have labelled a
  // foreign delivery charge as Polish. An amount whose currency Allegro did not state is
  // reported as having no currency, and the caller decides.
  return { amount, currency: value?.currency?.trim() || undefined };
};

/** One line of an Allegro order, reduced to what a Medusa line item needs. */
export interface CheckoutFormLine {
  /** The offer's sygnatura, which is the Medusa variant SKU by contract. */
  sku?: string;
  offerId?: string;
  title: string;
  quantity: number;
  unitPrice: number;
  currency: string;
}

/** An address as Medusa's order workflows accept it. */
export interface OrderAddress {
  first_name?: string;
  last_name?: string;
  company?: string;
  address_1?: string;
  city?: string;
  postal_code?: string;
  country_code?: string;
  phone?: string;
}

/**
 * The facts about a form that are safe to record even when it cannot be applied.
 *
 * Kept separate from `CheckoutFormView` so a malformed form still produces a visible
 * bookkeeping row, without any code being able to reach for a money field that was never
 * readable. Everything here is either verbatim from Allegro or absent.
 */
export interface CheckoutFormFacts {
  checkoutFormId: string;
  allegroStatus?: string;
  fulfillmentStatus?: string;
  buyerLogin?: string;
  /** Absent when the form carries no order currency at all. */
  currency?: string;
  /** The total exactly as Allegro sent it, unparsed. */
  totalToPayAmount?: string;
  updatedAt?: string;
}

/** Everything the order upsert reads off one checkout form. */
export interface CheckoutFormView extends CheckoutFormFacts {
  email?: string;
  /** Always present on a view: a form with no order currency never becomes one. */
  currency: string;
  totalToPay?: OrderMoney;
  deliveryCost?: OrderMoney;
  deliveryMethod?: string;
  paidAt?: string;
  lines: CheckoutFormLine[];
  shippingAddress?: OrderAddress;
  billingAddress?: OrderAddress;
  /**
   * The invoice recipient's tax id, kept OUT of `billingAddress.company`.
   *
   * Absent for a private purchase, for a form with no invoice block, and for a
   * company whose tax id Allegro sent in a type this plugin does not accept (see
   * `pickCompanyTaxId`). Stored on `order.metadata.nip`, which is where the inFakt
   * plugin looks first; it is not part of the address because it is not part of
   * anybody's name.
   */
  billingTaxId?: string;
  /** Earliest `boughtAt` across the lines: when the order was actually placed. */
  boughtAt?: string;
}

/**
 * A form read: either a usable view, or a refusal with reasons.
 *
 * A discriminated union rather than a view plus a warning list, and that shape is the
 * fix. The previous version ALWAYS produced a view, filling gaps with fabricated
 * numbers - an unparseable unit price became 0, a missing quantity became 1, a missing
 * currency became PLN. Those defaults created real Medusa orders that silently
 * disagreed with the Allegro total stored beside them, on real marketplace sales, with
 * nothing anywhere reporting a problem. Making refusal a separate variant means no
 * caller can reach a money field the form did not actually carry.
 */
export type CheckoutFormRead =
  | { ok: true; view: CheckoutFormView }
  | { ok: false; problems: string[]; facts: CheckoutFormFacts };

/**
 * Which typed tax id of an invoice company to keep, best first.
 *
 * `PL_NIP` is the Polish NIP, unambiguous, so it wins. `VAT_EU` for a Polish
 * company is that same NIP with a country prefix; for a foreign company it is a
 * foreign VAT number, which simply fails to match anything downstream - a miss,
 * never a mispairing.
 *
 * The other types Allegro can return (`CZ_ICO`, `CZ_DIC`, `HU_ADOSZAM`, `SK_ICO`,
 * `SK_IC_DPH`, `OTHER`) are deliberately excluded. They are foreign registration
 * numbers of similar length to a NIP, and admitting them would let an 8-digit
 * Czech ICO collide with a Polish NIP in a comparison that has no country to
 * disambiguate it. A foreign company still reaches the order through its name.
 */
const TAX_ID_TYPE_PREFERENCE = ["PL_NIP", "VAT_EU"] as const;

/**
 * The tax id to store for an invoice company.
 *
 * Allegro marks the flat `company.taxId` deprecated in favour of the typed
 * `company.ids` array, so `ids` is read first. The flat field stays as the fallback
 * rather than being dropped: it is what older orders carry, and reading it only
 * when the typed array has no USABLE answer closes the "Allegro stops populating
 * it" hole without breaking anything that works today.
 */
export const pickCompanyTaxId = (company?: AllegroInvoiceCompany): string | undefined => {
  for (const type of TAX_ID_TYPE_PREFERENCE) {
    const match = company?.ids?.find((id) => id.type === type && id.value?.trim());
    const value = match?.value?.trim();
    if (value) {
      return value;
    }
  }
  return company?.taxId?.trim() || undefined;
};

/** Undefined when every field is empty, so an all-blank address is not stored. */
const orUndefined = (address: OrderAddress): OrderAddress | undefined =>
  Object.values(address).some(Boolean) ? address : undefined;

/**
 * The shipping recipient.
 *
 * From `delivery.address`, which is the buyer-entered recipient and what the seller
 * sees. For a pickup-point delivery the address block is the point's address, so
 * the point's name is folded into `company` - a label with only a street and no
 * point name is not deliverable.
 */
const buildShippingAddress = (form: AllegroCheckoutForm): OrderAddress | undefined => {
  const delivery = form.delivery?.address;
  if (!delivery) {
    return undefined;
  }
  return orUndefined({
    address_1: delivery.street,
    city: delivery.city,
    company: delivery.companyName ?? form.delivery?.pickupPoint?.name,
    country_code: delivery.countryCode?.toLowerCase(),
    first_name: delivery.firstName,
    last_name: delivery.lastName,
    phone: delivery.phoneNumber,
    postal_code: delivery.zipCode,
  });
};

/**
 * The invoice recipient, as a billing address.
 *
 * ## The company name is the company name, and nothing else
 *
 * This used to write `${companyName} (${taxId})` into `company`, on the reasoning
 * that Medusa's order address has no tax-id field and losing the NIP would make the
 * order useless for invoicing. Losing it was indeed unacceptable; putting it inside a
 * human-readable name was the wrong way to keep it. Two invoices went out reading
 * `NZOZ "Familia" Monika Kwasniak ( )` because the invoicing plugin has to
 * un-concatenate what this concatenated, and the strip left the brackets behind.
 *
 * A tax id is structured data. It travels on `order.metadata.nip` now - see
 * `billingTaxId` on the view and the `nip` key in `order-upsert` - which is the key
 * the inFakt plugin's default extractor reads first, and `company` carries the name
 * Allegro sent, verbatim.
 *
 * A private purchase that named an invoice recipient uses that person's name rather
 * than the account holder's.
 */
const buildBillingAddress = (form: AllegroCheckoutForm): OrderAddress | undefined => {
  const invoice = form.invoice?.address;
  if (!invoice) {
    return undefined;
  }
  return orUndefined({
    address_1: invoice.street,
    city: invoice.city,
    company: invoice.company?.name?.trim() || undefined,
    country_code: invoice.countryCode?.toLowerCase(),
    first_name: invoice.naturalPerson?.firstName,
    last_name: invoice.naturalPerson?.lastName,
    postal_code: invoice.zipCode,
  });
};

/** Earliest `boughtAt` across the lines: when the order was actually placed. */
const earliestBoughtAt = (form: AllegroCheckoutForm): string | undefined =>
  (form.lineItems ?? [])
    .map((item) => item.boughtAt)
    .filter((value): value is string => Boolean(value))
    .toSorted((a, b) => a.localeCompare(b))[0];

/** The bookkeeping facts, readable off any form however malformed the money is. */
const readFacts = (form: AllegroCheckoutForm): CheckoutFormFacts => ({
  allegroStatus: form.status,
  buyerLogin: form.buyer?.login,
  checkoutFormId: form.id,
  currency: form.summary?.totalToPay?.currency?.trim() || undefined,
  fulfillmentStatus: form.fulfillment?.status,
  totalToPayAmount: form.summary?.totalToPay?.amount,
  updatedAt: form.updatedAt,
});

/**
 * Read one checkout form, or refuse it.
 *
 * ## Nothing here is defaulted, and that is the point
 *
 * Every field this used to default is money or a multiplier on money, and every default
 * was silently wrong in the same direction: it produced a plausible order. An
 * unparseable unit price became `0` (a free sale), a missing quantity became `1` (a
 * short shipment), a missing currency became `PLN` (a foreign order priced as Polish).
 * The Medusa order was then created with those numbers while `total_to_pay` stored what
 * Allegro actually charged, so the order disagreed with its own recorded total and
 * nothing reported it. On a live marketplace that is a real money discrepancy, not a
 * display bug.
 *
 * So a form whose money cannot be read is REFUSED, and the caller turns that into a
 * per-form failure that feeds the streak and quarantine machinery with a precise reason.
 * Losing the sale is not the alternative: the form stays visible with its Allegro
 * statuses recorded, the drain retries it, and an operator sees exactly which field
 * Allegro sent unreadably.
 *
 * A missing SKU is deliberately NOT a problem here. That is a catalogue mapping gap,
 * recorded as a line conflict and carried as a title-only item, because the sale really
 * did happen whatever Medusa's catalogue says. The distinction is money versus mapping.
 */
export const readCheckoutForm = (form: AllegroCheckoutForm): CheckoutFormRead => {
  const facts = readFacts(form);
  const problems: string[] = [];

  if (!facts.currency) {
    problems.push(
      "the order carries no currency (`summary.totalToPay.currency` is absent), so its lines cannot be priced",
    );
  }

  // A delivery cost that is PRESENT but unreadable is a problem for the same reason: it
  // is money the buyer paid, and dropping it silently understates the order. An absent
  // cost block is legitimate (free delivery, or none chosen) and is not flagged.
  if (form.delivery?.cost && parseAmount(form.delivery.cost.amount) === undefined) {
    problems.push(
      `the delivery cost "${form.delivery.cost.amount}" is not a parseable amount, so the order total would understate what the buyer paid`,
    );
  }

  const lineItems = form.lineItems ?? [];
  if (lineItems.length === 0) {
    // An order with no lines is not an order. Applied, it would create an empty Medusa order
    // whose total could never match the `totalToPay` sitting beside it, so it is refused for
    // the same reason as an unreadable price: the form does not describe a sale this plugin
    // can represent.
    problems.push("the order carries no line items at all, so there is nothing to create");
  }
  const lines: CheckoutFormLine[] = [];
  for (const [index, item] of lineItems.entries()) {
    // Named by position AND by offer, because a form can carry several lines and the
    // operator needs to know which one Allegro sent badly.
    const where = `line ${index + 1}${item.offer?.id ? ` (offer ${item.offer.id})` : ""}`;
    const unitPrice = parseAmount(item.price?.amount);
    const lineCurrency = item.price?.currency?.trim() || undefined;
    const { quantity } = item;

    if (unitPrice === undefined) {
      problems.push(
        `${where} has no parseable unit price (received ${JSON.stringify(item.price?.amount)})`,
      );
    }
    if (!lineCurrency) {
      problems.push(`${where} has no currency`);
    } else if (facts.currency && lineCurrency.toLowerCase() !== facts.currency.toLowerCase()) {
      // A line priced in a different currency from the order cannot be summed into it, and
      // Medusa has one currency per order. Refused for the same reason as an unparseable
      // price: applying it would create an order whose arithmetic is meaningless.
      problems.push(
        `${where} is priced in ${lineCurrency} but the order is in ${facts.currency}, so its price cannot be applied`,
      );
    }
    if (!(Number.isInteger(quantity) && (quantity as number) >= 1)) {
      problems.push(`${where} has no usable quantity (received ${JSON.stringify(quantity)})`);
    }

    if (unitPrice !== undefined && lineCurrency && Number.isInteger(quantity)) {
      lines.push({
        currency: lineCurrency,
        offerId: item.offer?.id,
        quantity: quantity as number,
        // The sygnatura, which is the SKU by this plugin's contract. Absent when the
        // offer never carried one, which becomes a recorded line conflict rather than
        // a reason to lose the sale.
        sku: item.offer?.external?.id?.trim() || undefined,
        title: item.offer?.name ?? "(unknown offer)",
        unitPrice,
      });
    }
  }

  if (problems.length > 0) {
    return { facts, ok: false, problems };
  }

  const shippingAddress = buildShippingAddress(form);
  return {
    ok: true,
    view: {
      ...facts,
      billingAddress: buildBillingAddress(form) ?? shippingAddress,
      // Read off the invoice block whether or not that block produced an address, so
      // a tax id is never lost to the shipping-address fallback above.
      billingTaxId: pickCompanyTaxId(form.invoice?.address?.company),
      boughtAt: earliestBoughtAt(form),
      // Non-null by construction: the `!facts.currency` check above already refused.
      currency: facts.currency as string,
      deliveryCost: money(form.delivery?.cost),
      deliveryMethod: form.delivery?.method?.name,
      email: form.buyer?.email,
      lines,
      paidAt: form.payment?.finishedAt,
      shippingAddress,
      totalToPay: money(form.summary?.totalToPay),
    },
  };
};
