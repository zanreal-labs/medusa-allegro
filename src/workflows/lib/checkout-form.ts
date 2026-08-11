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
  currency: string;
}

const money = (value?: { amount: string; currency: string }): OrderMoney | undefined => {
  const amount = parseAmount(value?.amount);
  if (amount === undefined) {
    return undefined;
  }
  return { amount, currency: value?.currency ?? "PLN" };
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

/** Everything the order upsert reads off one checkout form. */
export interface CheckoutFormView {
  checkoutFormId: string;
  allegroStatus?: string;
  fulfillmentStatus?: string;
  buyerLogin?: string;
  email?: string;
  currency: string;
  totalToPay?: OrderMoney;
  deliveryCost?: OrderMoney;
  deliveryMethod?: string;
  paidAt?: string;
  lines: CheckoutFormLine[];
  shippingAddress?: OrderAddress;
  billingAddress?: OrderAddress;
  /** Earliest `boughtAt` across the lines: when the order was actually placed. */
  boughtAt?: string;
  updatedAt?: string;
}

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
 * Company name and tax id go into `company` together, because Medusa's order
 * address has no tax-id field and losing the NIP would make the order useless for
 * invoicing. A private purchase that named an invoice recipient uses that person's
 * name rather than the account holder's.
 */
const buildBillingAddress = (form: AllegroCheckoutForm): OrderAddress | undefined => {
  const invoice = form.invoice?.address;
  if (!invoice) {
    return undefined;
  }
  const taxId = pickCompanyTaxId(invoice.company);
  const companyName = invoice.company?.name;
  return orUndefined({
    address_1: invoice.street,
    city: invoice.city,
    company: companyName && taxId ? `${companyName} (${taxId})` : (companyName ?? undefined),
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

/** Read one checkout form into the shape the order upsert works from. */
export const readCheckoutForm = (form: AllegroCheckoutForm): CheckoutFormView => {
  const currency = form.summary?.totalToPay?.currency ?? "PLN";
  const shippingAddress = buildShippingAddress(form);
  return {
    allegroStatus: form.status,
    billingAddress: buildBillingAddress(form) ?? shippingAddress,
    boughtAt: earliestBoughtAt(form),
    buyerLogin: form.buyer?.login,
    checkoutFormId: form.id,
    currency,
    deliveryCost: money(form.delivery?.cost),
    deliveryMethod: form.delivery?.method?.name,
    email: form.buyer?.email,
    fulfillmentStatus: form.fulfillment?.status,
    lines: (form.lineItems ?? []).map((item) => ({
      currency: item.price?.currency ?? currency,
      offerId: item.offer?.id,
      // The sygnatura, which is the SKU by this plugin's contract. Absent when the
      // offer never carried one, which becomes a recorded line conflict rather than
      // a reason to lose the sale.
      sku: item.offer?.external?.id?.trim() || undefined,
      title: item.offer?.name ?? "(unknown offer)",
      quantity: item.quantity ?? 1,
      unitPrice: parseAmount(item.price?.amount) ?? 0,
    })),
    paidAt: form.payment?.finishedAt,
    shippingAddress,
    totalToPay: money(form.summary?.totalToPay),
    updatedAt: form.updatedAt,
  };
};
