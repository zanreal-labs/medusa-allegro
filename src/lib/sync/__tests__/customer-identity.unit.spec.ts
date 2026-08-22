import type { AllegroCheckoutForm } from "../../allegro/types";
import { hasBuyerIdentity, planCustomerName, readBuyerIdentity } from "../customer-identity";
import type { CustomerNameRow } from "../customer-identity";

/**
 * Every name in this file is a fixture and nothing here is a real buyer.
 *
 * The bug being tested is about PII landing in the wrong place, so the spec that proves
 * the fix must not carry any of its own: the account holder is "Anna Testowa", the
 * delivery recipient is "Barbara Odbiorcza", and they are deliberately different people
 * because telling them apart is the whole mapping decision.
 */

/** The Allegro account holder. */
const ACCOUNT = { firstName: "Anna", lastName: "Testowa" };
/** The person the parcel is addressed to, who is somebody else. */
const RECIPIENT = { firstName: "Barbara", lastName: "Odbiorcza" };

const form = (over: Partial<AllegroCheckoutForm> = {}): AllegroCheckoutForm => ({
  buyer: {
    email: "relay-1@allegromail.example",
    login: "test-account",
    ...ACCOUNT,
  },
  delivery: {
    address: {
      city: "Warszawa",
      countryCode: "PL",
      street: "Ulica 1",
      zipCode: "00-001",
      ...RECIPIENT,
    },
  },
  id: "form-1",
  ...over,
});

const customer = (over: Partial<CustomerNameRow> = {}): CustomerNameRow => ({
  company_name: null,
  first_name: null,
  id: "cus_1",
  last_name: null,
  ...over,
});

describe("readBuyerIdentity", () => {
  it("reads the account holder, not the delivery recipient", () => {
    // The distinction the previous system got wrong: the person the account belongs to
    // and the person the parcel goes to are different facts, and the customer entity is
    // the first one.
    expect(readBuyerIdentity(form())).toEqual({
      companyName: undefined,
      firstName: "Anna",
      lastName: "Testowa",
    });
  });

  it("reads nothing when the account holder has no name, rather than borrowing one", () => {
    // The delivery block still names Barbara here. Falling back to it would assert that
    // she holds the account, which is exactly the identity mix-up being avoided.
    const identity = readBuyerIdentity(
      form({ buyer: { email: "relay-1@allegromail.example", login: "test-account" } }),
    );

    expect(hasBuyerIdentity(identity)).toBe(false);
    expect(identity.firstName).toBeUndefined();
  });

  it("keeps the company name of a company account", () => {
    expect(
      readBuyerIdentity(form({ buyer: { companyName: "Testowa Sp. z o.o.", ...ACCOUNT } })),
    ).toMatchObject({ companyName: "Testowa Sp. z o.o." });
  });

  it("treats a whitespace-only name as absent", () => {
    expect(
      hasBuyerIdentity(readBuyerIdentity(form({ buyer: { firstName: "  ", lastName: "" } }))),
    ).toBe(false);
  });
});

describe("planCustomerName", () => {
  it("names a customer created with nothing but the relay email", () => {
    // The incident, exactly: `createOrderWorkflow` creates the customer from the email
    // alone, so every name column is NULL.
    const plan = planCustomerName(readBuyerIdentity(form()), customer());

    expect(plan).toEqual({
      customerId: "cus_1",
      fields: ["first_name", "last_name"],
      kind: "fill",
      patch: { first_name: "Anna", last_name: "Testowa" },
    });
  });

  it("sets the company as well for a company account", () => {
    const plan = planCustomerName(
      readBuyerIdentity(form({ buyer: { companyName: "Testowa Sp. z o.o.", ...ACCOUNT } })),
      customer(),
    );

    expect(plan).toMatchObject({
      fields: ["company_name", "first_name", "last_name"],
      patch: {
        company_name: "Testowa Sp. z o.o.",
        first_name: "Anna",
        last_name: "Testowa",
      },
    });
  });

  it("never overwrites a name somebody already set", () => {
    // Including the emergency hand-patch that named the one live customer this bug
    // produced: the fix has to be idempotent over it rather than fighting it.
    const plan = planCustomerName(
      readBuyerIdentity(form()),
      customer({ first_name: "Barbara", last_name: "Odbiorcza" }),
    );

    expect(plan).toEqual({
      kind: "skip",
      reason: "the customer already carries every name Allegro sent; nothing is overwritten",
    });
  });

  it("fills only the column that is empty on a half-named customer", () => {
    const plan = planCustomerName(readBuyerIdentity(form()), customer({ first_name: "Ania" }));

    expect(plan).toMatchObject({ fields: ["last_name"], patch: { last_name: "Testowa" } });
  });

  it("leaves a company name a human set, even for a company account", () => {
    const plan = planCustomerName(
      readBuyerIdentity(form({ buyer: { companyName: "Testowa Sp. z o.o.", ...ACCOUNT } })),
      customer({ company_name: "Testowa spolka z o.o." }),
    );

    expect(plan).toMatchObject({ fields: ["first_name", "last_name"] });
  });

  it("treats a whitespace-only column as empty", () => {
    // Otherwise a row somebody blanked in the admin would look named forever.
    expect(planCustomerName(readBuyerIdentity(form()), customer({ first_name: "   " }))).toMatchObject(
      { fields: ["first_name", "last_name"] },
    );
  });

  it("writes nothing when Allegro sent no account-holder name", () => {
    const plan = planCustomerName(
      readBuyerIdentity(
        form({ buyer: { email: "relay-1@allegromail.example", login: "test-account" } }),
      ),
      customer(),
    );

    expect(plan.kind).toBe("skip");
  });

  it("writes nothing when the order has no customer at all", () => {
    expect(planCustomerName(readBuyerIdentity(form()), undefined).kind).toBe("skip");
  });
});
