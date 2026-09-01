import { pickCompanyTaxId, readCheckoutForm } from "../lib/checkout-form";
import { planOrderTaxIdFill } from "../../lib/sync/order-tax-id";
import type { AllegroCheckoutForm } from "../../lib/allegro/types";

/**
 * Where the invoice recipient's tax id lives.
 *
 * The regression these pin down: `buildBillingAddress` used to write
 * `${companyName} (${taxId})` into `billing_address.company`, and the invoicing
 * plugin then had to un-concatenate it. Two real invoices went out reading
 * `NZOZ "Familia" Monika Kwasniak ( )` because the strip removed the digits and
 * left the brackets. The company field must now carry the company name and nothing
 * else, and the tax id must reach the order as structured data.
 */

/** A form that `readCheckoutForm` accepts: one priced line and an order currency. */
const form = (invoice?: AllegroCheckoutForm["invoice"]): AllegroCheckoutForm => ({
  id: "form-1",
  ...(invoice ? { invoice } : {}),
  lineItems: [
    {
      boughtAt: "2026-08-31T15:00:00Z",
      offer: { external: { id: "SKU-1" }, id: "offer-1", name: "Widget" },
      price: { amount: "100.00", currency: "PLN" },
      quantity: 1,
    },
  ],
  summary: { totalToPay: { amount: "100.00", currency: "PLN" } },
});

const viewOf = (input: AllegroCheckoutForm) => {
  const read = readCheckoutForm(input);
  if (!read.ok) {
    throw new Error(`expected a readable form, got: ${read.problems.join("; ")}`);
  }
  return read.view;
};

describe("the billing address never carries a tax id", () => {
  it("keeps the company name clean and carries the NIP separately", () => {
    const view = viewOf(
      form({
        address: {
          city: "Warszawa",
          company: {
            ids: [{ type: "PL_NIP", value: "5261040828" }],
            name: 'NZOZ "Familia" Monika Kwasniak',
          },
          countryCode: "PL",
          street: "Rynek 5",
          zipCode: "00-001",
        },
        required: true,
      }),
    );

    expect(view.billingAddress?.company).toBe('NZOZ "Familia" Monika Kwasniak');
    expect(view.billingAddress?.company).not.toContain("(");
    expect(view.billingTaxId).toBe("5261040828");
  });

  it("reads the deprecated flat taxId when the typed ids carry nothing usable", () => {
    const view = viewOf(
      form({
        address: {
          city: "Warszawa",
          company: { ids: [{ type: "PL_NIP", value: "  " }], name: "ACME", taxId: "5261040828" },
          street: "Rynek 5",
          zipCode: "00-001",
        },
      }),
    );

    expect(view.billingAddress?.company).toBe("ACME");
    expect(view.billingTaxId).toBe("5261040828");
  });

  it("a natural person has no company and no tax id at all", () => {
    const view = viewOf(
      form({
        address: {
          city: "Krakow",
          naturalPerson: { firstName: "Monika", lastName: "Kwasniak" },
          street: "Dluga 1",
          zipCode: "31-042",
        },
      }),
    );

    expect(view.billingAddress?.company).toBeUndefined();
    expect(view.billingTaxId).toBeUndefined();
    expect(view.billingAddress?.first_name).toBe("Monika");
  });

  it("a company whose tax id Allegro sent in a refused type keeps its name and gets no id", () => {
    const view = viewOf(
      form({
        address: {
          city: "Praha",
          company: { ids: [{ type: "CZ_ICO", value: "12345678" }], name: "Ceska s.r.o." },
          countryCode: "CZ",
          street: "Namesti 3",
          zipCode: "11000",
        },
      }),
    );

    expect(view.billingAddress?.company).toBe("Ceska s.r.o.");
    expect(view.billingTaxId).toBeUndefined();
  });

  it("carries the tax id even when the invoice block has no usable address", () => {
    // The billing address falls back to the shipping address here. The tax id is read
    // off the invoice block regardless, so the fallback cannot lose it.
    const view = viewOf(
      form({ address: { company: { ids: [{ type: "PL_NIP", value: "5261040828" }] } } }),
    );

    expect(view.billingTaxId).toBe("5261040828");
  });

  it("prefers PL_NIP over VAT_EU", () => {
    expect(
      pickCompanyTaxId({
        ids: [
          { type: "VAT_EU", value: "PL5261040828" },
          { type: "PL_NIP", value: "5261040828" },
        ],
      }),
    ).toBe("5261040828");
  });
});

describe("planOrderTaxIdFill", () => {
  it("writes the tax id onto an order whose metadata has none", () => {
    expect(planOrderTaxIdFill("5261040828", { allegro_checkout_form_id: "form-1" })).toEqual({
      kind: "write",
      nip: "5261040828",
    });
  });

  it("leaves an order that already carries a tax id alone, even a different one", () => {
    const plan = planOrderTaxIdFill("5261040828", { nip: "1132191233" });
    expect(plan.kind).toBe("skip");
  });

  it("respects every key the invoicing extractor accepts, not just `nip`", () => {
    for (const key of ["nip", "tax_id", "taxId", "vat_id", "vatId"]) {
      expect(planOrderTaxIdFill("5261040828", { [key]: "1132191233" }).kind).toBe("skip");
    }
  });

  it("does nothing for a form with no tax id", () => {
    expect(planOrderTaxIdFill(undefined, {}).kind).toBe("skip");
    expect(planOrderTaxIdFill("   ", {}).kind).toBe("skip");
  });

  it("treats a blank stored value as absent", () => {
    expect(planOrderTaxIdFill("5261040828", { nip: "  " })).toEqual({
      kind: "write",
      nip: "5261040828",
    });
  });
});
