import type {
  AllegroCheckoutForm,
  AllegroOrderEvent,
} from "../../lib/allegro/types";
import { QUARANTINE_AFTER_FAILURES } from "../../lib/sync/failure-state";
import {
  drainAllegroOrders,
  repairAllegroOrder,
} from "../drain-allegro-orders";
import { importAllegroOrdersWindow } from "../import-allegro-orders-window";
import { pushAllegroFulfillment } from "../push-allegro-fulfillment";
import { fakeAllegroService, fakeContainer } from "./fixtures";
import type { StateRowFixture } from "./fixtures";

/**
 * Engine-level tests for the orders sync.
 *
 * The drain's decisions - cursor advance, split budget, quarantine, the systemic
 * gate - are covered exhaustively against `lib/sync/order-events`. What is left here
 * is the Medusa wiring: which rows are written and in what order, that the watermark
 * is stamped LAST, that an unmatched line becomes a recorded conflict rather than a
 * lost sale, and that the operator paths clear the right failure entries.
 */

const RECENT = new Date(Date.now() - 60_000).toISOString();

/** A Medusa customer as the order query returns it. */
interface CustomerFixture {
  id: string;
  first_name?: string | null;
  last_name?: string | null;
  company_name?: string | null;
}

/**
 * Recorder for the three core order workflows the upsert reaches for.
 *
 * `order-upsert` imports them at module level, so they are replaced through the
 * module registry rather than the container. The mock factory below is hoisted above
 * the imports, which is why it can only reference a `var` - a `const` would still be
 * in its temporal dead zone when the factory first runs.
 */
// eslint-disable-next-line no-var, vars-on-top -- must be hoisted with the jest.mock factory
var coreFlows: {
  created: Record<string, unknown>[];
  cancelled: string[];
  completed: string[][];
  createError?: Error;
  /**
   * Checkout-form ids whose order creation fails.
   *
   * Keyed off the metadata the upsert stamps on the order, because that is the only
   * thing tying a `createOrderWorkflow` call back to one form. The import path reads
   * its forms straight from `listCheckoutForms` and never calls `getCheckoutForm`, so
   * a per-form failure has to be injected here rather than at the fetch.
   */
  failCreateForForms: Set<string>;
  /** Makes `cancelOrderWorkflow` reject, e.g. an order with live fulfillments. */
  cancelError?: Error;
  /**
   * Live `order.status` per created order id, so the already-satisfied pre-check has
   * something real to read.
   *
   * Tracked rather than stubbed: `createOrderWorkflow` records the status it was asked to
   * create with, and cancel/complete move it. That is what makes the deterministic case
   * expressible - a form first seen CANCELLED is created ALREADY cancelled, and step 3 then
   * tries to cancel it again.
   */
  statusById: Record<string, string>;
  sequence: number;
  /** Payment collections created, in order: `{ order_id, amount }`. */
  paymentCollections: { order_id: string; amount: number }[];
  /** Collections marked paid, in order. Each one emits `payment.captured` in Medusa. */
  markedPaid: { order_id: string; payment_collection_id: string }[];
  /** Makes the mark-as-paid workflow reject, e.g. no system provider registered. */
  markPaidError?: Error;
  /**
   * Customer updates, in order: `{ selector, update }`.
   *
   * The only place a customer name can be written from here: `createOrderWorkflow`
   * takes an email and nothing else about the person, so a spec that only watched the
   * order workflow could never see whether the customer got named.
   */
  customerUpdates: { id: string[]; update: Record<string, unknown> }[];
  /** Makes the customer update reject, so the never-fatal path is exercised. */
  customerUpdateError?: Error;
  /**
   * The customer behind each Medusa order, keyed by order id.
   *
   * Modelled rather than stubbed, because the incident IS this table: Medusa's
   * `findOrCreateCustomerStep` calls `createCustomers({ email })` and nothing else, so
   * an order created with an email gets a customer whose every name column is NULL.
   * The fake reproduces that, and `updateCustomersWorkflow` writes back into it - which
   * is what lets one spec assert that a second pass over an already-named customer
   * writes nothing.
   */
  customerByOrderId: Record<string, CustomerFixture | undefined>;
  customerSequence: number;
} = {
  cancelled: [],
  completed: [],
  created: [],
  customerByOrderId: {},
  customerSequence: 0,
  customerUpdates: [],
  failCreateForForms: new Set(),
  markedPaid: [],
  paymentCollections: [],
  sequence: 0,
  statusById: {},
};

jest.mock("@medusajs/medusa/core-flows", () => ({
  cancelOrderWorkflow: () => ({
    run: ({ input }: { input: { order_id: string } }) => {
      if (coreFlows.cancelError) {
        return Promise.reject(coreFlows.cancelError);
      }
      coreFlows.cancelled.push(input.order_id);
      coreFlows.statusById[input.order_id] = "canceled";
      return Promise.resolve({ result: undefined });
    },
  }),
  completeOrderWorkflow: () => ({
    run: ({ input }: { input: { orderIds: string[] } }) => {
      coreFlows.completed.push(input.orderIds);
      for (const id of input.orderIds) {
        coreFlows.statusById[id] = "completed";
      }
      return Promise.resolve({ result: [] });
    },
  }),
  createOrderPaymentCollectionWorkflow: () => ({
    run: ({ input }: { input: { order_id: string; amount: number } }) => {
      coreFlows.paymentCollections.push(input);
      return Promise.resolve({
        result: [{ id: `paycol_${coreFlows.paymentCollections.length}` }],
      });
    },
  }),
  markPaymentCollectionAsPaid: () => ({
    run: ({
      input,
    }: {
      input: { order_id: string; payment_collection_id: string };
    }) => {
      if (coreFlows.markPaidError) {
        return Promise.reject(coreFlows.markPaidError);
      }
      coreFlows.markedPaid.push(input);
      return Promise.resolve({ result: { id: "pay_1" } });
    },
  }),
  updateCustomersWorkflow: () => ({
    run: ({
      input,
    }: {
      input: { selector: { id: string[] }; update: Record<string, unknown> };
    }) => {
      if (coreFlows.customerUpdateError) {
        return Promise.reject(coreFlows.customerUpdateError);
      }
      coreFlows.customerUpdates.push({
        id: input.selector.id,
        update: input.update,
      });
      // Written back, so a later pass reads what this one set. A recorder that only
      // appended calls could not tell "already named" from "named twice".
      for (const row of Object.values(coreFlows.customerByOrderId)) {
        if (row && input.selector.id.includes(row.id)) {
          Object.assign(row, input.update);
        }
      }
      return Promise.resolve({ result: [] });
    },
  }),
  createOrderWorkflow: () => ({
    run: ({ input }: { input: Record<string, unknown> }) => {
      if (coreFlows.createError) {
        return Promise.reject(coreFlows.createError);
      }
      const formId = (
        input.metadata as { allegro_checkout_form_id?: string } | undefined
      )?.allegro_checkout_form_id;
      if (formId && coreFlows.failCreateForForms.has(formId)) {
        return Promise.reject(
          new Error(`cannot create an order for ${formId}`),
        );
      }
      coreFlows.sequence += 1;
      coreFlows.created.push(input);
      const id = `order_${coreFlows.sequence}`;
      // The status the order is CREATED with, verbatim. For a form first seen CANCELLED that
      // is already "canceled", which is exactly why cancelling it afterwards can never work.
      coreFlows.statusById[id] =
        (input.status as string | undefined) ?? "pending";
      if (input.email) {
        // The email and NOTHING else, exactly as `findOrCreateCustomerStep` does it.
        coreFlows.customerSequence += 1;
        coreFlows.customerByOrderId[id] = {
          company_name: null,
          first_name: null,
          id: `cus_${coreFlows.customerSequence}`,
          last_name: null,
        };
      }
      return Promise.resolve({ result: { id } });
    },
  }),
}));

const event = (
  id: string,
  formId: string,
  type: AllegroOrderEvent["type"] = "BOUGHT",
): AllegroOrderEvent => ({ id, order: { checkoutForm: { id: formId } }, type });

const form = (
  over: Partial<AllegroCheckoutForm> & { id: string },
): AllegroCheckoutForm => ({
  buyer: { email: "buyer@example.com", login: "buyer1" },
  delivery: {
    address: {
      city: "Warszawa",
      countryCode: "PL",
      firstName: "Jan",
      lastName: "Kowalski",
      street: "Ulica 1",
      zipCode: "00-001",
    },
    cost: { amount: "12.99", currency: "PLN" },
    method: { name: "Kurier" },
  },
  lineItems: [
    {
      boughtAt: "2026-06-01T10:00:00.000Z",
      offer: { external: { id: "SKU-1" }, id: "o1", name: "A product" },
      price: { amount: "199.99", currency: "PLN" },
      quantity: 2,
    },
  ],
  status: "READY_FOR_PROCESSING",
  summary: { totalToPay: { amount: "412.97", currency: "PLN" } },
  updatedAt: "2026-06-01T10:05:00.000Z",
  ...over,
});

interface OrderRowFixture {
  id: string;
  checkout_form_id: string;
  medusa_order_id?: string | null;
  derived_status?: string | null;
  synced_at?: Date | null;
  last_error?: string | null;
  line_conflicts?: unknown;
  fulfillment_status?: string | null;
  [key: string]: unknown;
}

/** Records the exact sequence of writes, so ordering can be asserted. */
const orderTable = (seed: OrderRowFixture[] = []) => {
  const rows = [...seed];
  const writes: { id: string; patch: Record<string, unknown> }[] = [];
  let sequence = rows.length;
  return {
    create: (data: Record<string, unknown>[]) => {
      const created = data.map((entry) => {
        sequence += 1;
        const row = { id: `algorder_${sequence}`, ...entry } as OrderRowFixture;
        rows.push(row);
        writes.push({ id: row.id, patch: entry });
        return row;
      });
      return Promise.resolve(created);
    },
    list: (
      filters: Record<string, unknown>,
      config: { take?: number } = {},
    ) => {
      let out = rows.map((row) => ({ ...row }));
      for (const [key, value] of Object.entries(filters)) {
        // An ARRAY as well as a scalar, because the generated CRUD surface accepts both
        // (Mikro-ORM turns a list into `$in`) and the invoice sweep looks its candidates up
        // in bulk by `medusa_order_id`. A fake that only understood the scalar form would
        // silently return nothing for that read and make the sweep look inert.
        if (Array.isArray(value)) {
          out = out.filter((row) => value.includes(row[key]));
          continue;
        }
        // `null` means IS NULL in Mikro-ORM, and the sweep asks for `invoice_attached_at:
        // null`. Strict equality would only match a row carrying a literal null, not one
        // where the column was never written - which is every unattached order.
        if (value === null) {
          out = out.filter(
            (row) => row[key] === null || row[key] === undefined,
          );
          continue;
        }
        out = out.filter((row) => row[key] === value);
      }
      return Promise.resolve(
        config.take === undefined ? out : out.slice(0, config.take),
      );
    },
    rows,
    update: (data: (Record<string, unknown> & { id: string })[]) => {
      for (const entry of data) {
        writes.push({ id: entry.id, patch: entry });
        const index = rows.findIndex((row) => row.id === entry.id);
        if (index !== -1) {
          rows[index] = { ...rows[index], ...entry } as OrderRowFixture;
        }
      }
      return Promise.resolve(data);
    },
    writes,
  };
};

const fakeClient = (input: {
  pages?: AllegroOrderEvent[][];
  forms?: AllegroCheckoutForm[];
  latest?: string;
  formError?: Record<string, Error>;
  fulfillmentError?: Error;
  checkoutFormPages?: AllegroCheckoutForm[][];
}) => {
  let page = 0;
  const fulfillmentCalls: { id: string; status: string }[] = [];
  const invoiceUploads: { formId: string; invoiceId: string }[] = [];
  let checkoutPage = 0;
  let invoiceSequence = 0;
  return {
    createCheckoutFormInvoice: () => {
      invoiceSequence += 1;
      return Promise.resolve({ id: `inv-${invoiceSequence}` });
    },
    fulfillmentCalls,
    getCheckoutForm: (id: string) => {
      const failure = input.formError?.[id];
      if (failure) {
        return Promise.reject(failure);
      }
      const found = (input.forms ?? []).find((entry) => entry.id === id);
      return Promise.resolve(found ?? form({ id }));
    },
    getCheckoutFormInvoices: () => Promise.resolve({ invoices: [] }),
    getOrderEventStats: () =>
      Promise.resolve(
        input.latest ? { latestEvent: { id: input.latest } } : {},
      ),
    invoiceUploads,
    listCheckoutForms: () => {
      const forms = input.checkoutFormPages?.[checkoutPage] ?? [];
      checkoutPage += 1;
      return Promise.resolve({
        checkoutForms: forms,
        count: forms.length,
        totalCount: (input.checkoutFormPages ?? []).flat().length,
      });
    },
    listOrderEvents: () => {
      const events = input.pages?.[page] ?? [];
      page += 1;
      return Promise.resolve({ events });
    },
    updateCheckoutFormFulfillment: (id: string, status: string) => {
      if (input.fulfillmentError) {
        return Promise.reject(input.fulfillmentError);
      }
      fulfillmentCalls.push({ id, status });
      return Promise.resolve();
    },
    uploadCheckoutFormInvoiceFile: (formId: string, invoiceId: string) => {
      invoiceUploads.push({ formId, invoiceId });
      return Promise.resolve();
    },
  };
};

const setup = (input: {
  pages?: AllegroOrderEvent[][];
  forms?: AllegroCheckoutForm[];
  latest?: string;
  formError?: Record<string, Error>;
  fulfillmentError?: Error;
  checkoutFormPages?: AllegroCheckoutForm[][];
  orders?: OrderRowFixture[];
  states?: StateRowFixture[];
  variants?: { id: string; sku: string }[];
  ordersSyncDisabled?: boolean;
  regions?: { id: string; currency_code: string }[];
  /** Medusa orders that already exist, for the duplicate-adoption path. */
  existingOrders?: { id: string; metadata?: Record<string, unknown> }[];
  /**
   * Make the `metadata` JSON filter throw, so the bounded fallback scan is exercised.
   *
   * Worth having as a switch: the nested-metadata filter is the one part of adoption that
   * depends on query-layer behaviour this plugin does not own, and the fallback is what
   * keeps a duplicate order from being created if it is ever unsupported.
   */
  orderQueryThrows?: boolean;
  /** Make the filter match everything, as a filter that silently does nothing would. */
  orderQueryIgnoresFilter?: boolean;
  /** Simulates the claim being taken over mid-run: every heartbeat reports it lost. */
  claimLost?: boolean;
  /**
   * What the created Medusa order totals, by order id, for the reconciliation read.
   *
   * Absent means the order cannot be read - which must NOT be reported as a mismatch, since
   * an unreadable total is not evidence of one.
   */
  medusaOrderTotals?: Record<
    string,
    { total?: number | string; currency_code?: string }
  >;
  /** Live `order.status` for orders that already existed before this run. */
  medusaOrderStatuses?: Record<string, string>;
  /**
   * Customers behind orders that already existed, by Medusa order id.
   *
   * This is how an order created before the pipeline wrote customer names is expressed:
   * a customer row with every name column NULL, which is what the live table held.
   */
  medusaOrderCustomers?: Record<string, CustomerFixture>;
  /**
   * Payment collections already linked to a Medusa order, by order id.
   *
   * An order with none is what every Allegro order looked like before the payment step
   * existed, so an ABSENT entry is the incident's own shape rather than an untested edge.
   */
  paymentCollections?: Record<
    string,
    { captured_amount?: number | string; refunded_amount?: number | string }[]
  >;
  /** Unregister the payment module, as a store with no `STRIPE_API_KEY` has it. */
  noPaymentModule?: boolean;
  /**
   * Issued invoices the invoicing module would report, registering the module under
   * `infakt` so the drain's post-drain sweep has something to find.
   *
   * Omitted in every other case here, and that is the point: the key then resolves to a
   * throw, exactly as it does in a store with no invoicing module, so the sweep is inert
   * and the rest of the drain's behaviour is unchanged by its existence.
   */
  issuedInvoices?: {
    order_id: string;
    invoice_uuid: string;
    invoice_number?: string;
  }[];
}) => {
  for (const [orderId, seeded] of Object.entries(input.medusaOrderCustomers ?? {})) {
    coreFlows.customerByOrderId[orderId] = { ...seeded };
  }
  const client = fakeClient(input);
  const table = orderTable(input.orders ?? []);
  const allegro = fakeAllegroService({
    claimLost: input.claimLost,
    client,
    ordersSyncDisabled: input.ordersSyncDisabled,
    states: input.states ?? [],
    syncOptions: { salesChannelId: "sc_allegro" },
  }) as ReturnType<typeof fakeAllegroService> & Record<string, unknown>;

  allegro.createAllegroOrders = table.create;
  allegro.listAllegroOrders = table.list;
  allegro.updateAllegroOrders = table.update;

  const createdOrders: Record<string, unknown>[] = [];
  const logs: string[] = [];
  const variants = input.variants ?? [{ id: "v1", sku: "SKU-1" }];
  const regions = input.regions ?? [{ currency_code: "pln", id: "reg_pl" }];

  const invoicePdfCalls: string[] = [];
  const container = {
    resolve: (key: string) => {
      if (key === "allegro") {
        return allegro;
      }
      if (key === "infakt") {
        if (!input.issuedInvoices) {
          throw new Error("infakt is not registered");
        }
        return {
          apiClient: {
            getInvoicePdf: (uuid: string) => {
              invoicePdfCalls.push(uuid);
              return Promise.resolve(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
            },
          },
          listInfaktInvoices: () => Promise.resolve(input.issuedInvoices ?? []),
        };
      }
      if (key === "payment") {
        // Resolvable unless the test says otherwise. A store whose payment module is
        // absent is a real configuration, so it gets its own switch rather than being
        // the default that silently makes every payment assertion vacuous.
        if (input.noPaymentModule) {
          throw new Error("payment module is not registered");
        }
        return {};
      }
      if (key === "logger") {
        return {
          error: (message: string) => logs.push(`error: ${message}`),
          info: (message: string) => logs.push(`info: ${message}`),
          warn: (message: string) => logs.push(`warn: ${message}`),
        };
      }
      if (key === "query") {
        return {
          graph: ({
            entity,
            filters,
            pagination,
          }: {
            entity: string;
            filters?: Record<string, unknown>;
            pagination?: { skip: number; take: number };
          }) => {
            if (entity === "product_variant") {
              return Promise.resolve({ data: variants });
            }
            if (entity === "region") {
              return Promise.resolve({ data: regions });
            }
            if (entity === "order") {
              const all = input.existingOrders ?? [];
              // The batched payment-state read. Only ids the test seeded answer: an order
              // whose total cannot be read must stay "unknown" rather than default to a
              // total of zero, which would read as already paid.
              if (Array.isArray(filters?.id)) {
                const ids = filters.id as string[];
                return Promise.resolve({
                  data: ids
                    .filter(
                      (id) =>
                        input.medusaOrderTotals?.[id] !== undefined ||
                        input.paymentCollections?.[id] !== undefined,
                    )
                    .map((id) => ({
                      id,
                      payment_collections: input.paymentCollections?.[id] ?? [],
                      ...input.medusaOrderTotals?.[id],
                    })),
                });
              }
              // The total-reconciliation read: by id, asking for `total`/`currency_code`.
              const byId = (filters?.id as string | undefined) ?? undefined;
              if (byId !== undefined) {
                const seeded = input.medusaOrderTotals?.[byId];
                const status =
                  coreFlows.statusById[byId] ??
                  input.medusaOrderStatuses?.[byId];
                const customer = coreFlows.customerByOrderId[byId];
                if (
                  seeded === undefined &&
                  status === undefined &&
                  customer === undefined
                ) {
                  return Promise.resolve({ data: [] });
                }
                return Promise.resolve({
                  data: [
                    {
                      id: byId,
                      ...(status ? { status } : {}),
                      ...(customer ? { customer } : {}),
                      ...seeded,
                    },
                  ],
                });
              }
              const wanted = (
                filters?.metadata as
                  | { allegro_checkout_form_id?: string }
                  | undefined
              )?.allegro_checkout_form_id;
              if (wanted !== undefined) {
                if (input.orderQueryThrows) {
                  return Promise.reject(
                    new Error("json filters are not supported here"),
                  );
                }
                // A filter that "works" narrows; one that silently does nothing returns
                // everything, which is the case the in-memory re-check has to survive.
                return Promise.resolve({
                  data: input.orderQueryIgnoresFilter
                    ? all
                    : all.filter(
                        (order) =>
                          order.metadata?.allegro_checkout_form_id === wanted,
                      ),
                });
              }
              const skip = pagination?.skip ?? 0;
              const take = pagination?.take ?? all.length;
              return Promise.resolve({ data: all.slice(skip, skip + take) });
            }
            return Promise.resolve({ data: [] });
          },
        };
      }
      throw new Error(`unexpected container key ${key}`);
    },
  };

  return { allegro, client, container, invoicePdfCalls, logs, table };
};

beforeEach(() => {
  coreFlows.created.length = 0;
  coreFlows.cancelled.length = 0;
  coreFlows.completed.length = 0;
  coreFlows.createError = undefined;
  coreFlows.cancelError = undefined;
  coreFlows.statusById = {};
  coreFlows.sequence = 0;
  coreFlows.failCreateForForms.clear();
  coreFlows.paymentCollections.length = 0;
  coreFlows.markedPaid.length = 0;
  coreFlows.markPaidError = undefined;
  coreFlows.customerUpdates.length = 0;
  coreFlows.customerUpdateError = undefined;
  coreFlows.customerByOrderId = {};
  coreFlows.customerSequence = 0;
});

describe("drainAllegroOrders: bootstrap", () => {
  it("records the newest event id and consumes nothing on a fresh install", async () => {
    // Replaying the 60 days Allegro retains would be thousands of `getCheckoutForm`
    // calls, so a new installation starts tracking from now and importing history
    // stays an explicit operator action.
    const context = setup({ latest: "e-newest", pages: [[event("e1", "f1")]] });

    const result = await drainAllegroOrders(context.container as never);

    expect(result).toMatchObject({
      bootstrapped: true,
      eventsRead: 0,
      refreshed: 0,
    });
    expect(context.allegro.states.get("orders")).toMatchObject({
      cursor: "e-newest",
    });
    expect(context.table.rows).toEqual([]);
    expect(
      context.logs.some((line) => line.includes("cursor bootstrapped")),
    ).toBe(true);
  });
});

describe("drainAllegroOrders: the claim is re-asserted between forms", () => {
  const withCursor = (input: Parameters<typeof setup>[0] = {}) =>
    setup({
      states: [{ cursor: "e0", provider: "orders", status: "ok" }],
      ...input,
    });

  it("abandons the drain and holds the cursor when the claim is taken over", async () => {
    // A drain refreshes up to 100 forms sequentially, each a `getCheckoutForm` plus a
    // multi-step order write, so on a slow Allegro it outlives the staleness window - and
    // the run then kept applying forms concurrently with the pass that had replaced it,
    // interleaving full item replacements on the same order.
    const context = withCursor({
      claimLost: true,
      forms: [form({ id: "f1" }), form({ id: "f2" })],
      pages: [[event("e1", "f1"), event("e2", "f2")]],
    });

    const result = await drainAllegroOrders(context.container as never);

    // Not one form applied: the check happens BEFORE each.
    expect(coreFlows.created).toEqual([]);
    expect(result.refreshed).toBe(0);
    // Abandoned forms are treated like deferred ones - never attempted, so they must NOT
    // count as failures against their own quarantine streaks.
    expect(result.failed).toBe(0);
    expect(result.truncated).toBe(true);
    // And the cursor holds where it was, so they replay.
    expect(context.allegro.states.get("orders")?.cursor).toBe("e0");
  });

  it("does not write its outcome over the successor's state row", async () => {
    const context = withCursor({
      claimLost: true,
      forms: [form({ id: "f1" })],
      pages: [[event("e1", "f1")]],
    });

    await drainAllegroOrders(context.container as never);

    expect(context.allegro.states.get("orders")?.status).toBe("ok");
    expect(
      context.logs.some((line) => line.includes("belongs to its successor")),
    ).toBe(true);
  });

  it("heartbeats under its own token while it still holds the claim", async () => {
    const context = withCursor({
      forms: [form({ id: "f1" })],
      pages: [[event("e1", "f1")]],
    });

    await drainAllegroOrders(context.container as never);

    expect(context.allegro.heartbeats.map((beat) => beat.provider)).toEqual([
      "orders",
    ]);
  });
});

describe("drainAllegroOrders: a pre-claim skip never releases a live claim", () => {
  it("leaves the state row alone when the kill switch fires while a run is in flight", async () => {
    // The finding: the disabled path wrote `status: "idle"` unconditionally. On a row held
    // by a run in flight that releases its claim, so the NEXT tick acquires it and two runs
    // execute concurrently - the exact failure single-flight exists to prevent, reached by
    // the code meant to report a skip.
    const context = setup({
      ordersSyncDisabled: true,
      states: [
        {
          claim_heartbeat_at: new Date(),
          claim_token: "incumbent",
          cursor: "e0",
          provider: "orders",
          status: "running",
        },
      ],
    });

    const result = await drainAllegroOrders(context.container as never);

    expect(result.disabled).toBe(true);
    const state = context.allegro.states.get("orders");
    expect(state).toMatchObject({
      claim_token: "incumbent",
      status: "running",
    });
    expect(context.allegro.preClaimWritesSkipped).toEqual(["orders"]);
    // Skipped, but never silently: "nothing happened and nothing was recorded" is the state
    // this repo has been bitten by before.
    expect(
      context.logs.some((line) =>
        line.includes("held by a run currently in flight"),
      ),
    ).toBe(true);
  });

  it("still records the reason when no run holds the claim", async () => {
    const context = setup({
      ordersSyncDisabled: true,
      states: [{ cursor: "e0", provider: "orders", status: "ok" }],
    });

    await drainAllegroOrders(context.container as never);

    expect(context.allegro.states.get("orders")).toMatchObject({
      last_error: null,
      status: "disabled",
    });
    expect(context.allegro.states.get("orders")?.last_finding).toContain(
      "orders sync is disabled",
    );
  });
});

describe("drainAllegroOrders: never duplicating a Medusa order", () => {
  const withCursor = (input: Parameters<typeof setup>[0] = {}) =>
    setup({
      states: [{ cursor: "e0", provider: "orders", status: "ok" }],
      ...input,
    });

  /** The state a crash between order creation and the link write leaves behind. */
  const orphaned = (over: Parameters<typeof setup>[0] = {}) =>
    withCursor({
      existingOrders: [
        { id: "order_pre", metadata: { allegro_checkout_form_id: "f1" } },
      ],
      forms: [form({ id: "f1" })],
      // The bookkeeping row exists but never learned the order id.
      orders: [
        { checkout_form_id: "f1", id: "algorder_1", medusa_order_id: null },
      ],
      pages: [[event("e1", "f1")]],
      ...over,
    });

  it("adopts the existing order instead of creating a second one", async () => {
    // The regression: `medusa_order_id` is written in a separate statement from the order
    // creation, so a crash in between leaves a real Medusa order this row does not know
    // about. The next pass saw a null and created ANOTHER one, with nothing reconciling
    // them - so one marketplace sale silently became two Medusa orders, each pickable and
    // each shippable.
    const context = orphaned();

    await drainAllegroOrders(context.container as never);

    expect(coreFlows.created).toEqual([]);
    expect(context.table.rows[0]).toMatchObject({
      medusa_order_id: "order_pre",
    });
    expect(
      context.logs.some((line) =>
        line.includes("adopted existing Medusa order"),
      ),
    ).toBe(true);
  });

  it("falls back to a bounded scan when the metadata filter is unsupported", async () => {
    // The JSON filter is the one part of adoption that depends on query-layer behaviour
    // the plugin does not own. If it throws, creating a duplicate is not an acceptable
    // degradation, so a bounded newest-first scan verifies in memory instead.
    const context = orphaned({ orderQueryThrows: true });

    await drainAllegroOrders(context.container as never);

    expect(coreFlows.created).toEqual([]);
    expect(context.table.rows[0]).toMatchObject({
      medusa_order_id: "order_pre",
    });
  });

  it("never adopts an order belonging to a different checkout form", async () => {
    // The safety property that makes adoption sound at all: only an EXACT metadata match
    // is accepted. Here the filter is broken in the most dangerous way - it matches
    // everything - and the order on offer belongs to another form. Adopting it would
    // attach somebody else's sale to this one.
    const context = withCursor({
      existingOrders: [
        {
          id: "order_other",
          metadata: { allegro_checkout_form_id: "f-OTHER" },
        },
      ],
      forms: [form({ id: "f1" })],
      orderQueryIgnoresFilter: true,
      pages: [[event("e1", "f1")]],
    });

    await drainAllegroOrders(context.container as never);

    // A fresh order was created, and the unrelated one was left alone.
    expect(coreFlows.created).toHaveLength(1);
    expect(context.table.rows[0]?.medusa_order_id).toBe("order_1");
  });

  it("creates the order normally when nothing exists to adopt", async () => {
    const context = withCursor({
      forms: [form({ id: "f1" })],
      pages: [[event("e1", "f1")]],
    });

    await drainAllegroOrders(context.container as never);

    expect(coreFlows.created).toHaveLength(1);
  });
});

describe("drainAllegroOrders: a malformed form is refused, not fabricated", () => {
  const withCursor = (input: Parameters<typeof setup>[0] = {}) =>
    setup({
      states: [{ cursor: "e0", provider: "orders", status: "ok" }],
      ...input,
    });

  const malformed = (over: Partial<AllegroCheckoutForm>) =>
    withCursor({
      forms: [form({ id: "f1", ...over })],
      pages: [[event("e1", "f1")]],
    });

  it("refuses a line whose unit price cannot be parsed", async () => {
    // This became `unit_price: 0` - a free sale - while `total_to_pay` recorded what
    // Allegro actually charged. The order disagreed with its own stored total and nothing
    // said so.
    const context = malformed({
      lineItems: [
        {
          offer: { external: { id: "SKU-1" }, id: "o1", name: "A product" },
          price: { amount: "not-a-number", currency: "PLN" },
          quantity: 2,
        },
      ],
    });

    const result = await drainAllegroOrders(context.container as never);

    expect(coreFlows.created).toEqual([]);
    expect(result.failed).toBe(1);
    // The form stays VISIBLE with a precise reason, and unsynced so the drain retries it.
    expect(context.table.rows[0]?.last_error).toContain(
      "no parseable unit price",
    );
    expect(context.table.rows[0]?.synced_at ?? null).toBeNull();
    expect(context.table.rows[0]?.derived_status ?? null).toBeNull();
  });

  it("refuses a line with no quantity", async () => {
    // This became `quantity: 1`, which is a short shipment on any multi-unit order.
    const context = malformed({
      lineItems: [
        {
          offer: { external: { id: "SKU-1" }, id: "o1", name: "A product" },
          price: { amount: "199.99", currency: "PLN" },
        },
      ],
    });

    const result = await drainAllegroOrders(context.container as never);

    expect(coreFlows.created).toEqual([]);
    expect(result.failed).toBe(1);
    expect(context.table.rows[0]?.last_error).toContain("no usable quantity");
  });

  it("refuses an order with no currency", async () => {
    // This became PLN, so a foreign order was priced as a Polish one.
    const context = malformed({
      summary: { totalToPay: { amount: "412.97" } } as never,
    });

    const result = await drainAllegroOrders(context.container as never);

    expect(coreFlows.created).toEqual([]);
    expect(result.failed).toBe(1);
    expect(context.table.rows[0]?.last_error).toContain("carries no currency");
  });

  it("refuses a line with no currency", async () => {
    const context = malformed({
      lineItems: [
        {
          offer: { external: { id: "SKU-1" }, id: "o1", name: "A product" },
          price: { amount: "199.99" } as never,
          quantity: 1,
        },
      ],
    });

    const result = await drainAllegroOrders(context.container as never);

    expect(coreFlows.created).toEqual([]);
    expect(context.table.rows[0]?.last_error).toContain("has no currency");
  });

  it("refuses a line priced in a different currency from the order", async () => {
    // Medusa has one currency per order, so a line in another currency cannot be summed into
    // it. Applying it would produce an order whose arithmetic is meaningless - the same class
    // as an unparseable price.
    const context = malformed({
      lineItems: [
        {
          offer: { external: { id: "SKU-1" }, id: "o1", name: "A product" },
          price: { amount: "199.99", currency: "EUR" },
          quantity: 1,
        },
      ],
    });

    const result = await drainAllegroOrders(context.container as never);

    expect(coreFlows.created).toEqual([]);
    expect(result.failed).toBe(1);
    expect(context.table.rows[0]?.last_error).toContain("priced in EUR");
  });

  it("refuses a form with no line items at all", async () => {
    // Not an order. Applied, it would create an empty Medusa order whose total could never
    // match the `totalToPay` recorded beside it.
    const context = malformed({ lineItems: [] });

    const result = await drainAllegroOrders(context.container as never);

    expect(coreFlows.created).toEqual([]);
    expect(result.failed).toBe(1);
    expect(context.table.rows[0]?.last_error).toContain("no line items");
  });

  it("refuses a present-but-unreadable delivery cost", async () => {
    // Money the buyer paid. Silently dropping it understates the order total.
    const context = malformed({
      delivery: {
        cost: { amount: "??", currency: "PLN" },
        method: { name: "Kurier" },
      },
    });

    const result = await drainAllegroOrders(context.container as never);

    expect(coreFlows.created).toEqual([]);
    expect(context.table.rows[0]?.last_error).toContain("delivery cost");
  });

  it("holds the event cursor on a malformed form, so it is retried", async () => {
    // The refusal has to behave like any other per-form failure: the throw is what holds
    // the cursor, and five consecutive failures are what eventually quarantine it.
    const context = malformed({
      lineItems: [
        {
          offer: { external: { id: "SKU-1" }, id: "o1", name: "A product" },
          price: { amount: "oops", currency: "PLN" },
          quantity: 1,
        },
      ],
    });

    await drainAllegroOrders(context.container as never);

    expect(context.allegro.states.get("orders")).toMatchObject({
      cursor: "e0",
    });
  });

  it("still records a missing SKU as a line conflict rather than refusing the sale", async () => {
    // The distinction that matters: money versus mapping. An unmatched sygnatura is a
    // catalogue gap, and the sale really did happen, so it is carried as a title-only
    // line item and recorded. Only unreadable MONEY refuses the form.
    const context = withCursor({
      forms: [form({ id: "f1" })],
      pages: [[event("e1", "f1")]],
      variants: [],
    });

    const result = await drainAllegroOrders(context.container as never);

    expect(coreFlows.created).toHaveLength(1);
    expect(result.failed).toBe(0);
    expect(context.table.rows[0]?.line_conflicts).toHaveLength(1);
  });
});

describe("drainAllegroOrders: applying a form", () => {
  const withCursor = (input: Parameters<typeof setup>[0] = {}) =>
    setup({
      states: [{ cursor: "e0", provider: "orders", status: "ok" }],
      ...input,
    });

  it("creates the order with Allegro's totals and the shipping address", async () => {
    const context = withCursor({
      forms: [form({ id: "f1" })],
      pages: [[event("e1", "f1")]],
    });

    const result = await drainAllegroOrders(context.container as never);

    expect(result).toMatchObject({
      created: 1,
      eventsRead: 1,
      refreshed: 1,
      statusChanged: 1,
    });
    expect(coreFlows.created).toHaveLength(1);
    expect(coreFlows.created[0]).toMatchObject({
      currency_code: "pln",
      email: "buyer@example.com",
      region_id: "reg_pl",
      sales_channel_id: "sc_allegro",
      status: "pending",
    });
    // Allegro's price, verbatim. Never recomputed: the buyer paid this.
    expect(coreFlows.created[0]?.items).toEqual([
      { quantity: 2, title: "A product", unit_price: 199.99, variant_id: "v1" },
    ]);
    // Delivery is a real cost the buyer paid, so it is on the order rather than
    // dropped or folded into a line price.
    expect(coreFlows.created[0]?.shipping_methods).toEqual([
      { amount: 12.99, name: "Kurier" },
    ]);
    expect(coreFlows.created[0]?.shipping_address).toMatchObject({
      city: "Warszawa",
      country_code: "pl",
      first_name: "Jan",
      last_name: "Kowalski",
    });
  });

  it("stamps the watermark LAST, after the order id and the status", async () => {
    // A crash anywhere before the watermark must leave the row looking unfinished so
    // the next pass repairs it. That is only true if `synced_at` is the final write.
    const context = withCursor({
      forms: [form({ id: "f1" })],
      pages: [[event("e1", "f1")]],
    });

    await drainAllegroOrders(context.container as never);

    const { writes } = context.table;
    const watermarkIndex = writes.findIndex(
      (write) => write.patch.synced_at !== undefined,
    );
    const orderIdIndex = writes.findIndex(
      (write) => write.patch.medusa_order_id !== undefined,
    );
    expect(watermarkIndex).toBeGreaterThan(orderIdIndex);
    expect(watermarkIndex).toBe(writes.length - 1);
  });

  it("writes derived_status in the same operation as the watermark", async () => {
    const context = withCursor({
      forms: [form({ id: "f1" })],
      pages: [[event("e1", "f1")]],
    });

    await drainAllegroOrders(context.container as never);

    const final = context.table.writes.at(-1);
    expect(final?.patch).toMatchObject({ derived_status: "new" });
    expect(final?.patch.synced_at).toBeInstanceOf(Date);
  });

  it("records the raw Allegro statuses even when nothing else changes", async () => {
    const context = withCursor({
      forms: [form({ fulfillment: { status: "SENT" }, id: "f1" })],
      pages: [[event("e1", "f1", "FULFILLMENT_STATUS_CHANGED")]],
    });

    await drainAllegroOrders(context.container as never);

    expect(context.table.rows[0]).toMatchObject({
      allegro_status: "READY_FOR_PROCESSING",
      buyer_login: "buyer1",
      currency: "PLN",
      derived_status: "sent",
      fulfillment_status: "SENT",
      total_to_pay: "412.97",
    });
  });

  it("carries an unmatched line as a custom item and records the conflict", async () => {
    // The sale happened on Allegro whatever Medusa's catalogue says. An order nobody
    // can see is not a safer outcome than one that is visibly half-mapped.
    const context = withCursor({
      forms: [
        form({
          id: "f1",
          lineItems: [
            {
              offer: {
                external: { id: "SKU-GHOST" },
                id: "o9",
                name: "Unknown thing",
              },
              price: { amount: "50.00", currency: "PLN" },
              quantity: 1,
            },
          ],
        }),
      ],
      pages: [[event("e1", "f1")]],
    });

    const result = await drainAllegroOrders(context.container as never);

    expect(result.withLineConflicts).toBe(1);
    expect(coreFlows.created[0]?.items).toEqual([
      { quantity: 1, title: "Unknown thing", unit_price: 50 },
    ]);
    expect(context.table.rows[0]?.line_conflicts).toEqual([
      { name: "Unknown thing", offerId: "o9", quantity: 1, sku: "SKU-GHOST" },
    ]);
    expect(result.error).toContain("matches no Medusa variant");
  });

  it("cancels the Medusa order for a cancelled checkout form", async () => {
    const context = withCursor({
      forms: [form({ id: "f1", status: "CANCELLED" })],
      orders: [
        {
          checkout_form_id: "f1",
          id: "algorder_1",
          medusa_order_id: "order_1",
        },
      ],
      pages: [[event("e1", "f1", "BUYER_CANCELLED")]],
    });

    await drainAllegroOrders(context.container as never);

    expect(coreFlows.cancelled).toEqual(["order_1"]);
    expect(context.table.rows[0]?.derived_status).toBe("cancelled");
  });

  it("leaves derived_status stale when the Medusa action failed, so the retry happens", async () => {
    // The regression: `derived_status` was written unconditionally, in the same operation
    // as the watermark, even when the cancel or complete had just thrown. But
    // `derived_status` IS the comparison basis - `resolveStatusWrite` compares against it -
    // so once it had advanced, the next pass saw no transition, returned no `status`, and
    // the failed action was NEVER attempted again. The order froze mid-ladder: cancelled
    // on Allegro, still open in Medusa, with nothing retrying it.
    coreFlows.cancelError = new Error("order has live fulfillments");
    const context = withCursor({
      forms: [form({ id: "f1", status: "CANCELLED" })],
      orders: [
        {
          checkout_form_id: "f1",
          id: "algorder_1",
          medusa_order_id: "order_1",
        },
      ],
      pages: [[event("e1", "f1", "BUYER_CANCELLED")]],
    });

    await drainAllegroOrders(context.container as never);

    expect(coreFlows.cancelled).toEqual([]);
    // Unchanged, so the next pass still sees a transition and tries again.
    expect(context.table.rows[0]?.derived_status ?? null).toBeNull();
    expect(context.table.rows[0]?.synced_at ?? null).toBeNull();
    expect(context.table.rows[0]?.last_error).toContain("cancel failed");
  });

  it("retries the failed action on the next pass, and lands it once it succeeds", async () => {
    // The consequence of the above, and the whole point of the gate.
    coreFlows.cancelError = new Error("order has live fulfillments");
    const context = withCursor({
      forms: [form({ id: "f1", status: "CANCELLED" })],
      orders: [
        {
          checkout_form_id: "f1",
          id: "algorder_1",
          medusa_order_id: "order_1",
        },
      ],
      pages: [
        [event("e1", "f1", "BUYER_CANCELLED")],
        [event("e1", "f1", "BUYER_CANCELLED")],
      ],
    });

    await drainAllegroOrders(context.container as never);
    expect(coreFlows.cancelled).toEqual([]);

    // The cause is fixed; the cursor held, so the same event replays.
    coreFlows.cancelError = undefined;
    await drainAllegroOrders(context.container as never);

    expect(coreFlows.cancelled).toEqual(["order_1"]);
    expect(context.table.rows[0]?.derived_status).toBe("cancelled");
    expect(context.table.rows[0]?.synced_at).toBeInstanceOf(Date);
  });

  it("does not advance derived_status when the order could not be created", async () => {
    // The reason the gate is on the whole `lastError` and not just the action's own error:
    // when the CREATE fails, no action runs at all, so an action-only gate would still
    // advance `derived_status` - and suppress the complete on the later pass that does
    // manage to create the order.
    coreFlows.failCreateForForms.add("f1");
    const context = withCursor({
      forms: [form({ fulfillment: { status: "PICKED_UP" }, id: "f1" })],
      pages: [[event("e1", "f1", "FULFILLMENT_STATUS_CHANGED")]],
    });

    await drainAllegroOrders(context.container as never);

    expect(context.table.rows[0]?.derived_status ?? null).toBeNull();
    expect(context.table.rows[0]?.synced_at ?? null).toBeNull();
  });

  it("completes the Medusa order for a picked-up form", async () => {
    const context = withCursor({
      forms: [form({ fulfillment: { status: "PICKED_UP" }, id: "f1" })],
      orders: [
        {
          checkout_form_id: "f1",
          id: "algorder_1",
          medusa_order_id: "order_1",
        },
      ],
      pages: [[event("e1", "f1", "FULFILLMENT_STATUS_CHANGED")]],
    });

    await drainAllegroOrders(context.container as never);

    expect(coreFlows.completed).toEqual([["order_1"]]);
  });

  it("takes no Medusa action for a status Medusa cannot represent", async () => {
    // `none` is the correct answer, not a gap: writing `order.status = "sent"`
    // directly would fight the dashboard and the order-edit flows.
    const context = withCursor({
      forms: [form({ fulfillment: { status: "SENT" }, id: "f1" })],
      orders: [
        {
          checkout_form_id: "f1",
          id: "algorder_1",
          medusa_order_id: "order_1",
        },
      ],
      pages: [[event("e1", "f1", "FULFILLMENT_STATUS_CHANGED")]],
    });

    await drainAllegroOrders(context.container as never);

    expect(coreFlows.cancelled).toEqual([]);
    expect(coreFlows.completed).toEqual([]);
    expect(context.table.rows[0]?.derived_status).toBe("sent");
  });

  it("re-asserts the derived status without acting again when Allegro has not moved", async () => {
    // How a staff edit survives: staff change the order and leave `derived_status`
    // where Allegro put it, so the next pass sees no transition.
    const context = withCursor({
      forms: [form({ fulfillment: { status: "PICKED_UP" }, id: "f1" })],
      orders: [
        {
          checkout_form_id: "f1",
          derived_status: "delivered",
          id: "algorder_1",
          medusa_order_id: "order_1",
        },
      ],
      pages: [[event("e1", "f1", "FULFILLMENT_STATUS_CHANGED")]],
    });

    const result = await drainAllegroOrders(context.container as never);

    expect(coreFlows.completed).toEqual([]);
    expect(result.statusChanged).toBe(0);
    expect(context.table.rows[0]?.derived_status).toBe("delivered");
  });

  it("holds the cursor and records the error when the order cannot be created", async () => {
    coreFlows.createError = new Error("no shipping profile");
    const context = withCursor({
      forms: [form({ id: "f1" })],
      pages: [[event("e1", "f1")]],
    });

    const result = await drainAllegroOrders(context.container as never);

    expect(result.failed).toBe(1);
    expect(context.allegro.states.get("orders")).toMatchObject({
      cursor: "e0",
    });
    // Visible, and NOT stamped as synced - so the next pass repairs it.
    expect(context.table.rows[0]?.last_error).toContain("no shipping profile");
    expect(context.table.rows[0]?.synced_at).toBeUndefined();
  });

  it("records the failure with an actionable message when no region exists", async () => {
    const context = withCursor({
      forms: [form({ id: "f1" })],
      pages: [[event("e1", "f1")]],
      regions: [],
    });

    const result = await drainAllegroOrders(context.container as never);

    expect(result.failed).toBe(1);
    expect(context.table.rows[0]?.last_error).toContain(
      "no Medusa region exists",
    );
  });

  it("warns and falls back when no region matches the order currency", async () => {
    const context = withCursor({
      forms: [form({ id: "f1" })],
      pages: [[event("e1", "f1")]],
      regions: [{ currency_code: "eur", id: "reg_eu" }],
    });

    await drainAllegroOrders(context.container as never);

    expect(coreFlows.created[0]?.region_id).toBe("reg_eu");
    expect(
      context.logs.some((line) => line.includes("no region uses currency")),
    ).toBe(true);
  });

  it("does not create a second order for a form that already has one", async () => {
    const context = withCursor({
      forms: [form({ id: "f1" })],
      orders: [
        {
          checkout_form_id: "f1",
          id: "algorder_1",
          medusa_order_id: "order_1",
        },
      ],
      pages: [[event("e1", "f1")]],
    });

    const result = await drainAllegroOrders(context.container as never);

    expect(coreFlows.created).toEqual([]);
    expect(result.created).toBe(0);
  });

  it("advances the cursor past a quarantined form while keeping it visible", async () => {
    const context = withCursor({
      formError: { f1: new Error("permanently broken") },
      pages: [[event("e1", "f1"), event("e2", "f2")]],
      states: [
        {
          cursor: "e0",
          failures: {
            quarantined: {},
            streaks: {
              f1: {
                count: QUARANTINE_AFTER_FAILURES - 1,
                error: "old",
                since: RECENT,
              },
            },
          },
          provider: "orders",
          status: "error",
        },
      ],
    });

    const result = await drainAllegroOrders(context.container as never);

    expect(result.quarantined).toEqual(["f1"]);
    expect(context.allegro.states.get("orders")).toMatchObject({
      cursor: "e2",
    });
    expect(result.error).toContain("quarantined after repeated failures");
  });

  it("writes nothing and holds the cursor when the kill switch is on", async () => {
    const context = withCursor({
      ordersSyncDisabled: true,
      pages: [[event("e1", "f1")]],
    });

    const result = await drainAllegroOrders(context.container as never);

    expect(result.skipped).toContain("orders sync is disabled");
    expect(result.disabled).toBe(true);
    expect(context.table.rows).toEqual([]);
    expect(context.allegro.claims).toEqual([]);
    // The cursor is untouched, so nothing is skipped while the switch is on.
    expect(context.allegro.states.get("orders")).toMatchObject({
      cursor: "e0",
    });
  });
});

describe("repairAllegroOrder", () => {
  it("re-applies one form and clears its failure entries", async () => {
    const context = setup({
      forms: [form({ id: "f1" })],
      states: [
        {
          cursor: "e5",
          failures: {
            quarantined: { f1: { error: "was broken", since: RECENT } },
            streaks: { f1: { count: 2, error: "was broken", since: RECENT } },
          },
          provider: "orders",
          status: "error",
        },
      ],
    });

    const result = await repairAllegroOrder(context.container as never, "f1");

    expect(result).toMatchObject({ created: true, ok: true });
    expect(context.allegro.states.get("orders")).toMatchObject({
      failures: null,
      status: "ok",
    });
  });

  it("keeps every other quarantined order on the health line", async () => {
    const context = setup({
      forms: [form({ id: "f1" })],
      states: [
        {
          cursor: "e5",
          failures: {
            quarantined: {
              "f-other": { error: "still broken", since: RECENT },
            },
            streaks: {},
          },
          provider: "orders",
          status: "error",
        },
      ],
    });

    await repairAllegroOrder(context.container as never, "f1");

    const state = context.allegro.states.get("orders");
    expect(state?.status).toBe("error");
    expect(state?.last_error).toContain("f-other");
  });

  it("reports a failed repair without growing the streak", async () => {
    // A retried repair must not drive the quarantine streak for an order an operator
    // is actively working on.
    const context = setup({
      formError: { f1: new Error("still broken") },
      states: [
        {
          cursor: "e5",
          failures: {
            quarantined: {},
            streaks: { f1: { count: 1, error: "x", since: RECENT } },
          },
          provider: "orders",
          status: "error",
        },
      ],
    });

    const result = await repairAllegroOrder(context.container as never, "f1");

    expect(result.ok).toBe(false);
    const failures = context.allegro.states.get("orders")?.failures as {
      streaks: Record<string, { count: number }>;
    };
    expect(failures.streaks.f1).toMatchObject({ count: 1 });
  });

  it("works even while the kill switch is on", async () => {
    // The switch stops the schedule, not the human: an operator who disabled the
    // drain to stop a runaway still needs to fix the order that caused it.
    const context = setup({
      forms: [form({ id: "f1" })],
      ordersSyncDisabled: true,
      states: [{ cursor: "e5", provider: "orders", status: "ok" }],
    });

    const result = await repairAllegroOrder(context.container as never, "f1");

    expect(result.ok).toBe(true);
  });

  it("never moves the cursor", async () => {
    const context = setup({
      forms: [form({ id: "f1" })],
      states: [{ cursor: "e5", provider: "orders", status: "ok" }],
    });

    await repairAllegroOrder(context.container as never, "f1");

    expect(context.allegro.states.get("orders")).toMatchObject({
      cursor: "e5",
    });
  });
});

describe("importAllegroOrdersWindow: the standing quarantine line survives", () => {
  it("keeps a standing quarantine on the row after a clean import", async () => {
    // The regression: the import composed its error line from its OWN findings only, so a
    // clean import wrote `last_error: null, status: "ok"` over any standing quarantine the
    // per-minute drain had recorded. The orders set aside for manual repair silently vanished
    // from the admin, and nothing else reports them.
    const context = setup({
      checkoutFormPages: [[form({ id: "f1" })]],
      states: [
        {
          failures: {
            quarantined: { "f-broken": { error: "boom", since: RECENT } },
            streaks: {},
          },
          provider: "orders",
          status: "error",
        },
      ],
    });

    const result = await importAllegroOrdersWindow(context.container as never, {
      since: "2026-06-01T00:00:00.000Z",
    });

    expect(result.imported).toBe(1);
    const state = context.allegro.states.get("orders");
    expect(state?.status).toBe("error");
    expect(state?.last_error).toContain("f-broken");
    // Exactly as `repairAllegroOrder` does it.
    expect(state?.last_error).toContain("quarantined");
  });

  it("settles ok when the import is clean and nothing is standing", async () => {
    const context = setup({
      checkoutFormPages: [[form({ id: "f1" })]],
      states: [{ provider: "orders", status: "ok" }],
    });

    await importAllegroOrdersWindow(context.container as never, {
      since: "2026-06-01T00:00:00.000Z",
    });

    expect(context.allegro.states.get("orders")).toMatchObject({
      last_error: null,
      status: "ok",
    });
  });
});

describe("importAllegroOrdersWindow", () => {
  it("imports every form in the window", async () => {
    const context = setup({
      checkoutFormPages: [[form({ id: "f1" }), form({ id: "f2" })]],
      states: [{ cursor: "e5", provider: "orders", status: "ok" }],
    });

    const result = await importAllegroOrdersWindow(context.container as never, {
      since: "2026-05-01T00:00:00.000Z",
    });

    expect(result).toMatchObject({
      created: 2,
      failed: 0,
      fetched: 2,
      imported: 2,
    });
  });

  it("never moves the event cursor", async () => {
    // An import fills a gap BEHIND the cursor; moving it would skip live events the
    // drain has not consumed yet.
    const context = setup({
      checkoutFormPages: [[form({ id: "f1" })]],
      states: [{ cursor: "e5", provider: "orders", status: "ok" }],
    });

    await importAllegroOrdersWindow(context.container as never, {
      since: "2026-05-01T00:00:00.000Z",
    });

    expect(context.allegro.states.get("orders")).toMatchObject({
      cursor: "e5",
    });
  });

  it("names the failures and keeps importing the rest", async () => {
    // One unapplyable order must not stop the other 2,999, and an operator needs the
    // ids to chase what is left.
    const context = setup({
      checkoutFormPages: [
        [form({ id: "f1" }), form({ id: "f2" }), form({ id: "f3" })],
      ],
      states: [{ cursor: "e5", provider: "orders", status: "ok" }],
    });
    coreFlows.failCreateForForms.add("f2");

    const result = await importAllegroOrdersWindow(context.container as never, {
      since: "2026-05-01T00:00:00.000Z",
    });

    expect(result).toMatchObject({
      failed: 1,
      failedFormIds: ["f2"],
      imported: 2,
    });
    expect(result.error).toContain("f2");
  });

  it("reports truncation when the page cap is hit", async () => {
    const context = setup({
      checkoutFormPages: [[form({ id: "f1" })], [form({ id: "f2" })]],
      states: [{ cursor: "e5", provider: "orders", status: "ok" }],
    });

    const result = await importAllegroOrdersWindow(context.container as never, {
      maxPages: 1,
      pageLimit: 1,
      since: "2026-05-01T00:00:00.000Z",
    });

    expect(result.truncated).toBe(true);
    expect(result.error).toContain("re-run the import with a later `since`");
  });
});

describe("pushAllegroFulfillment", () => {
  it("sets READY_FOR_SHIPMENT for a fulfillment and SENT for a shipment", async () => {
    const first = setup({
      orders: [
        {
          checkout_form_id: "f1",
          id: "algorder_1",
          medusa_order_id: "order_1",
        },
      ],
    });
    await pushAllegroFulfillment(first.container as never, {
      eventName: "order.fulfillment_created",
      orderId: "order_1",
    });
    expect(first.client.fulfillmentCalls).toEqual([
      { id: "f1", status: "READY_FOR_SHIPMENT" },
    ]);

    const second = setup({
      orders: [
        {
          checkout_form_id: "f1",
          id: "algorder_1",
          medusa_order_id: "order_1",
        },
      ],
    });
    await pushAllegroFulfillment(second.container as never, {
      eventName: "shipment.created",
      orderId: "order_1",
    });
    expect(second.client.fulfillmentCalls).toEqual([
      { id: "f1", status: "SENT" },
    ]);
    expect(second.table.rows[0]).toMatchObject({
      fulfillment_status: "SENT",
      last_error: null,
    });
  });

  it("is a no-op for an order that did not come from Allegro", async () => {
    const context = setup({});
    const result = await pushAllegroFulfillment(context.container as never, {
      eventName: "shipment.created",
      orderId: "order_native",
    });
    expect(result.attempted).toBe(false);
    expect(context.client.fulfillmentCalls).toEqual([]);
  });

  it("is a no-op for an event it does not map", async () => {
    const context = setup({
      orders: [
        {
          checkout_form_id: "f1",
          id: "algorder_1",
          medusa_order_id: "order_1",
        },
      ],
    });
    const result = await pushAllegroFulfillment(context.container as never, {
      eventName: "order.updated",
      orderId: "order_1",
    });
    expect(result.attempted).toBe(false);
  });

  it("records the failure and never throws", async () => {
    // The Medusa fulfillment already exists; throwing would not undo it and would
    // bury the reason.
    const context = setup({
      fulfillmentError: new Error("Allegro said no"),
      orders: [
        {
          checkout_form_id: "f1",
          id: "algorder_1",
          medusa_order_id: "order_1",
        },
      ],
    });

    const result = await pushAllegroFulfillment(context.container as never, {
      eventName: "shipment.created",
      orderId: "order_1",
    });

    expect(result.error).toContain("Allegro said no");
    expect(context.table.rows[0]?.last_error).toContain("fulfillment push");
  });
});

describe("drainAllegroOrders: reconciling the total against Allegro", () => {
  const withCursor = (input: Parameters<typeof setup>[0] = {}) =>
    setup({
      states: [{ cursor: "e0", provider: "orders", status: "ok" }],
      ...input,
    });

  /**
   * The form fixture totals 412.97 PLN.
   *
   * `total` is spelled with `?` rather than `| undefined` because omitting it is a real
   * case here ("the order's total cannot be read"), and the formatter's
   * no-useless-undefined fix rewrites `reconciled(undefined)` into `reconciled()` - which
   * a `| undefined` parameter rejects as a missing argument.
   */
  const reconciled = (
    total?: number | string,
    over: Parameters<typeof setup>[0] = {},
  ) =>
    withCursor({
      forms: [form({ id: "f1" })],
      medusaOrderTotals:
        total === undefined ? {} : { order_1: { currency_code: "pln", total } },
      pages: [[event("e1", "f1")]],
      ...over,
    });

  it("records a conflict when the Medusa total disagrees with what the buyer paid", async () => {
    // Nothing compared the two, so an order could silently disagree with the money Allegro
    // actually charged. Recorded, never blocking: the sale happened whatever Medusa's
    // arithmetic says, and an invisible order is not safer than a visibly disputed one.
    const context = reconciled(399.99);

    const result = await drainAllegroOrders(context.container as never);

    // The order still exists and the form still counts as applied.
    expect(coreFlows.created).toHaveLength(1);
    expect(result.failed).toBe(0);
    expect(result.withTotalMismatch).toBe(1);
    const row = context.table.rows[0];
    expect(row).toMatchObject({
      conflict: "total-mismatch",
      synced_at: expect.any(Date),
    });
    expect(row?.conflict_detail).toContain("412.97");
    expect(row?.conflict_detail).toContain("399.99");
    expect(result.error).toContain(
      "disagrees with the amount Allegro says the buyer paid",
    );
  });

  it("records no conflict when the totals agree to the grosz", async () => {
    const context = reconciled(412.97);

    const result = await drainAllegroOrders(context.container as never);

    expect(result.withTotalMismatch).toBe(0);
    expect(context.table.rows[0]?.conflict ?? null).toBeNull();
  });

  it("compares to the grosz, so a float round-trip cannot invent a mismatch", async () => {
    const context = reconciled("412.970000000001");

    const result = await drainAllegroOrders(context.container as never);

    expect(result.withTotalMismatch).toBe(0);
  });

  it("names the custom-line count, because that is the usual benign cause", async () => {
    // An unmatched sygnatura is carried as a title-only item, which legitimately moves the
    // total. Putting the count in the message stops an operator investigating arithmetic when
    // the real answer is "this order is half-mapped".
    const context = reconciled(399.99, { variants: [] });

    await drainAllegroOrders(context.container as never);

    expect(context.table.rows[0]?.conflict_detail).toContain(
      "1 custom line item(s)",
    );
  });

  it("reports a currency mismatch as its own explanation", async () => {
    const context = withCursor({
      forms: [form({ id: "f1" })],
      medusaOrderTotals: { order_1: { currency_code: "eur", total: 412.97 } },
      pages: [[event("e1", "f1")]],
    });

    await drainAllegroOrders(context.container as never);

    expect(context.table.rows[0]?.conflict_detail).toContain(
      "Currency mismatch",
    );
    expect(context.table.rows[0]?.conflict_detail).toContain("EUR");
  });

  it("records nothing when the order's total cannot be read", async () => {
    // An unreadable total is not evidence of a mismatch, and recording one on that basis
    // would be the same fabrication this check exists to catch.
    const context = reconciled();

    const result = await drainAllegroOrders(context.container as never);

    expect(result.withTotalMismatch).toBe(0);
    expect(context.table.rows[0]?.conflict ?? null).toBeNull();
  });

  it("clears a stale conflict once the totals agree again", async () => {
    const context = reconciled(412.97, {
      orders: [
        {
          checkout_form_id: "f1",
          conflict: "total-mismatch",
          conflict_detail: "an older disagreement",
          id: "algorder_1",
          medusa_order_id: "order_1",
        },
      ],
    });

    await drainAllegroOrders(context.container as never);

    expect(context.table.rows[0]?.conflict ?? null).toBeNull();
    expect(context.table.rows[0]?.conflict_detail ?? null).toBeNull();
  });
});

describe("drainAllegroOrders: an already-satisfied action must not latch", () => {
  const withCursor = (input: Parameters<typeof setup>[0] = {}) =>
    setup({
      states: [{ cursor: "e0", provider: "orders", status: "ok" }],
      ...input,
    });

  it("lands a form first seen as CANCELLED on the FIRST pass", async () => {
    // The guaranteed case. `createMedusaOrder` creates the order with `status: "canceled"`
    // for a cancelled form, and step 3 then tried to cancel it - which `throwIfOrderIsCancelled`
    // rejects with "has been canceled". Reported as a failure, that was a permanent latch:
    // `derived_status` is gated on the pass landing, so it never advanced, every pass retried
    // the same impossible action, the form quarantined after five, and `repairAllegroOrder`
    // could not clear it because the condition never changes.
    const context = withCursor({
      forms: [form({ id: "f1", status: "CANCELLED" })],
      pages: [[event("e1", "f1", "BUYER_CANCELLED")]],
    });

    const result = await drainAllegroOrders(context.container as never);

    expect(result.failed).toBe(0);
    expect(result.quarantined).toEqual([]);
    // Created already cancelled, so the redundant cancel is never even attempted.
    expect(coreFlows.created[0]).toMatchObject({ status: "canceled" });
    expect(coreFlows.cancelled).toEqual([]);
    // Landed: the ladder advanced and the watermark stamped, so it is not retried.
    expect(context.table.rows[0]).toMatchObject({
      derived_status: "cancelled",
    });
    expect(context.table.rows[0]?.synced_at).toBeInstanceOf(Date);
    expect(context.table.rows[0]?.last_error ?? null).toBeNull();
    expect(context.allegro.states.get("orders")?.cursor).toBe("e1");
  });

  it("lands a staff-cancelled order when the Allegro CANCELLED event arrives later", async () => {
    // Staff cancelled by hand, then Allegro reports it too. The action cannot succeed and
    // never will, but the outcome Allegro is asking for already holds.
    const context = withCursor({
      forms: [form({ id: "f1", status: "CANCELLED" })],
      medusaOrderStatuses: { order_pre: "canceled" },
      orders: [
        {
          checkout_form_id: "f1",
          id: "algorder_1",
          medusa_order_id: "order_pre",
        },
      ],
      pages: [[event("e1", "f1", "BUYER_CANCELLED")]],
    });

    const result = await drainAllegroOrders(context.container as never);

    expect(result.failed).toBe(0);
    expect(coreFlows.cancelled).toEqual([]);
    expect(context.table.rows[0]).toMatchObject({
      derived_status: "cancelled",
    });
    expect(context.table.rows[0]?.synced_at).toBeInstanceOf(Date);
  });

  it("classifies the core workflow's own already-canceled error as satisfied", async () => {
    // The race the pre-check cannot cover: the snapshot said pending, the workflow disagreed.
    // Matched against what `throwIfOrderIsCancelled` actually throws, read from
    // @medusajs/core-flows rather than guessed.
    coreFlows.cancelError = new Error(
      "Order with id order_1 has been canceled.",
    );
    const context = withCursor({
      forms: [form({ id: "f1", status: "CANCELLED" })],
      medusaOrderStatuses: { order_pre: "pending" },
      orders: [
        {
          checkout_form_id: "f1",
          id: "algorder_1",
          medusa_order_id: "order_pre",
        },
      ],
      pages: [[event("e1", "f1", "BUYER_CANCELLED")]],
    });

    const result = await drainAllegroOrders(context.container as never);

    expect(result.failed).toBe(0);
    expect(context.table.rows[0]).toMatchObject({
      derived_status: "cancelled",
    });
    expect(context.table.rows[0]?.synced_at).toBeInstanceOf(Date);
  });

  it("still retries a cancel that failed for a real reason", async () => {
    // The contrast, so "satisfied" cannot become a blanket excuse. An order with live
    // fulfillments is a genuine conflict: the order is NOT cancelled, so the ladder must not
    // advance and the next pass must try again.
    coreFlows.cancelError = new Error("order has live fulfillments");
    const context = withCursor({
      forms: [form({ id: "f1", status: "CANCELLED" })],
      medusaOrderStatuses: { order_pre: "pending" },
      orders: [
        {
          checkout_form_id: "f1",
          id: "algorder_1",
          medusa_order_id: "order_pre",
        },
      ],
      pages: [[event("e1", "f1", "BUYER_CANCELLED")]],
    });

    const result = await drainAllegroOrders(context.container as never);

    expect(result.failed).toBe(1);
    expect(context.table.rows[0]?.derived_status ?? null).toBeNull();
    expect(context.table.rows[0]?.synced_at ?? null).toBeNull();
    expect(context.table.rows[0]?.last_error).toContain("cancel failed");
  });

  it("does not re-complete an order Medusa already reports as completed", async () => {
    const context = withCursor({
      forms: [form({ fulfillment: { status: "PICKED_UP" }, id: "f1" })],
      medusaOrderStatuses: { order_pre: "completed" },
      orders: [
        {
          checkout_form_id: "f1",
          id: "algorder_1",
          medusa_order_id: "order_pre",
        },
      ],
      pages: [[event("e1", "f1", "FULFILLMENT_STATUS_CHANGED")]],
    });

    const result = await drainAllegroOrders(context.container as never);

    expect(coreFlows.completed).toEqual([]);
    expect(result.failed).toBe(0);
    expect(context.table.rows[0]).toMatchObject({
      derived_status: "delivered",
    });
  });

  it("still completes an order that is not yet completed", async () => {
    const context = withCursor({
      forms: [form({ fulfillment: { status: "PICKED_UP" }, id: "f1" })],
      medusaOrderStatuses: { order_pre: "pending" },
      orders: [
        {
          checkout_form_id: "f1",
          id: "algorder_1",
          medusa_order_id: "order_pre",
        },
      ],
      pages: [[event("e1", "f1", "FULFILLMENT_STATUS_CHANGED")]],
    });

    await drainAllegroOrders(context.container as never);

    expect(coreFlows.completed).toEqual([["order_pre"]]);
  });
});

describe("drainAllegroOrders: the invoice-attach sweep", () => {
  const quiet = (input: Parameters<typeof setup>[0] = {}) =>
    setup({
      pages: [[]],
      states: [{ cursor: "e0", provider: "orders", status: "ok" }],
      ...input,
    });

  it("attaches an issued invoice the event never landed for", async () => {
    // The retry path. The subscriber may have run while Allegro was unreachable, or the
    // event may have been lost outright - either way "issued but not attached" is a
    // comparable state, so a sweep can finish the job.
    const context = quiet({
      issuedInvoices: [
        {
          invoice_number: "FV/2026/08/001",
          invoice_uuid: "uuid-1",
          order_id: "order_1",
        },
      ],
      orders: [
        {
          checkout_form_id: "f1",
          id: "algorder_1",
          medusa_order_id: "order_1",
        },
      ],
    });

    const result = await drainAllegroOrders(context.container as never);

    expect(result.invoicesAttached).toBe(1);
    expect(result.invoiceAttachFailures).toBe(0);
    expect(context.invoicePdfCalls).toEqual(["uuid-1"]);
    expect(context.client.invoiceUploads).toEqual([
      { formId: "f1", invoiceId: "inv-1" },
    ]);
    expect(context.table.rows[0]?.invoice_attached_at).toBeInstanceOf(Date);
  });

  it("runs after the drain, so a form imported this tick is already sweepable", async () => {
    const context = quiet({
      forms: [form({ id: "f1" })],
      issuedInvoices: [{ invoice_uuid: "uuid-1", order_id: "order_1" }],
      pages: [[event("e1", "f1")]],
    });

    const result = await drainAllegroOrders(context.container as never);

    // The form was created by this run, and the sweep found it in the same tick.
    expect(result.created).toBe(1);
    expect(result.invoicesAttached).toBe(1);
  });

  it("is inert in a store with no invoicing module", async () => {
    // The `infakt` key resolves to a throw here, exactly as in a store that does not
    // invoice through a module. Nothing is attempted and nothing is logged about it.
    const context = quiet({
      orders: [
        {
          checkout_form_id: "f1",
          id: "algorder_1",
          medusa_order_id: "order_1",
        },
      ],
    });

    const result = await drainAllegroOrders(context.container as never);

    expect(result.invoicesAttached).toBe(0);
    expect(context.client.invoiceUploads).toEqual([]);
    expect(context.logs.some((line) => line.includes("invoice"))).toBe(false);
  });

  it("reports a persistent attach failure in the run's own error line", async () => {
    // Named separately from the drain's failures because the remedy differs: the order is
    // fine, and what is missing is the document the buyer expects to find on it.
    const context = quiet({
      issuedInvoices: [{ invoice_uuid: "uuid-1", order_id: "order_1" }],
      orders: [
        {
          checkout_form_id: "f1",
          id: "algorder_1",
          medusa_order_id: "order_1",
        },
      ],
    });
    context.client.uploadCheckoutFormInvoiceFile = () =>
      Promise.reject(new Error("Allegro is unreachable"));

    const result = await drainAllegroOrders(context.container as never);

    expect(result.invoiceAttachFailures).toBe(1);
    expect(result.error).toMatch(/could not be attached/);
    expect(context.allegro.states.get("orders")).toMatchObject({
      status: "error",
    });
    expect(context.table.rows[0]?.last_error).toContain(
      "Allegro is unreachable",
    );
  });
});

describe("drainAllegroOrders: recording the buyer's payment", () => {
  const withCursor = (input: Parameters<typeof setup>[0] = {}) =>
    setup({
      states: [{ cursor: "e0", provider: "orders", status: "ok" }],
      ...input,
    });

  const paidForm = (id: string) =>
    form({
      id,
      payment: {
        finishedAt: "2026-08-19T18:18:40.000Z",
        paidAmount: { amount: "412.97", currency: "PLN" },
        type: "ONLINE",
      },
    });

  it("records the payment on the same pass that applies a paid form", async () => {
    // The primary path, and the one that was missing entirely: the buyer pays, the event
    // arrives, and the money is on the Medusa order seconds later. Nothing about this
    // should need the reconciliation sweep to notice.
    const context = withCursor({
      forms: [paidForm("f1")],
      medusaOrderTotals: { order_1: { currency_code: "pln", total: 412.97 } },
      pages: [[event("e1", "f1")]],
    });

    await drainAllegroOrders(context.container as never);

    expect(coreFlows.paymentCollections).toEqual([
      { amount: 412.97, order_id: "order_1" },
    ]);
    expect(coreFlows.markedPaid).toEqual([
      { order_id: "order_1", payment_collection_id: "paycol_1" },
    ]);
  });

  it("does not record a payment twice, which is what makes a re-run safe", async () => {
    const context = withCursor({
      forms: [paidForm("f1")],
      medusaOrderTotals: { order_1: { currency_code: "pln", total: 412.97 } },
      orders: [
        {
          checkout_form_id: "f1",
          derived_status: "new",
          id: "algorder_1",
          medusa_order_id: "order_1",
        },
      ],
      pages: [[event("e1", "f1")]],
      paymentCollections: { order_1: [{ captured_amount: 412.97 }] },
    });

    await drainAllegroOrders(context.container as never);

    expect(coreFlows.paymentCollections).toEqual([]);
    expect(coreFlows.markedPaid).toEqual([]);
  });

  it("records nothing for cash on delivery, which Allegro also calls ready for processing", async () => {
    // The buyer pays the courier, later. A capture here would have an invoice issued for
    // money nobody has received.
    const context = withCursor({
      forms: [
        form({
          id: "f1",
          payment: { finishedAt: "2026-08-19T18:18:40.000Z", type: "CASH_ON_DELIVERY" },
        }),
      ],
      medusaOrderTotals: { order_1: { currency_code: "pln", total: 412.97 } },
      pages: [[event("e1", "f1")]],
    });

    await drainAllegroOrders(context.container as never);

    expect(coreFlows.paymentCollections).toEqual([]);
  });

  it("records nothing when Allegro reports no finished payment", async () => {
    const context = withCursor({
      forms: [form({ id: "f1", status: "BOUGHT" })],
      medusaOrderTotals: { order_1: { currency_code: "pln", total: 412.97 } },
      pages: [[event("e1", "f1")]],
    });

    await drainAllegroOrders(context.container as never);

    expect(coreFlows.paymentCollections).toEqual([]);
  });

  it("reports a store with no payment module instead of crashing the drain", async () => {
    const context = withCursor({
      forms: [paidForm("f1")],
      medusaOrderTotals: { order_1: { currency_code: "pln", total: 412.97 } },
      noPaymentModule: true,
      pages: [[event("e1", "f1")]],
    });

    const result = await drainAllegroOrders(context.container as never);

    expect(coreFlows.paymentCollections).toEqual([]);
    // The order still lands. A missing payment module is a configuration problem, not a
    // reason to lose the sale or to hold the event cursor.
    expect(result.created).toBe(1);
    expect(result.error ?? null).toBeNull();
  });

  it("does not hold the event cursor when the payment write fails", async () => {
    // Holding it would stall every LATER order behind one whose payment module is broken,
    // and it is not needed: the sweep classifies by the order's actual payment state, so
    // this order stays in the fast tier and is retried within seconds.
    const context = withCursor({
      forms: [paidForm("f1")],
      medusaOrderTotals: { order_1: { currency_code: "pln", total: 412.97 } },
      pages: [[event("e1", "f1")]],
    });
    coreFlows.markPaidError = new Error("no system payment provider");

    const result = await drainAllegroOrders(context.container as never);

    expect(result.failed).toBe(0);
    expect(context.allegro.states.get("orders")?.cursor).toBe("e1");
    expect(
      context.logs.some((line) => line.includes("FAILED to register the buyer's payment")),
    ).toBe(true);
  });
});

describe("drainAllegroOrders: the customer gets their name", () => {
  /**
   * Fixture names only, and three deliberately different people.
   *
   * The whole mapping decision is that these do not have to be the same person, so a
   * spec written with one name could not tell a correct fill from the wrong one.
   */
  const ACCOUNT = { firstName: "Anna", lastName: "Testowa" };
  const RECIPIENT = { firstName: "Barbara", lastName: "Odbiorcza" };

  const withCursor = (input: Parameters<typeof setup>[0] = {}) =>
    setup({
      states: [{ cursor: "e0", provider: "orders", status: "ok" }],
      ...input,
    });

  /** A form whose account holder and delivery recipient are different people. */
  const namedForm = (id: string, buyer: Record<string, unknown> = ACCOUNT) =>
    form({
      buyer: { email: "relay-1@allegromail.example", login: "test-account", ...buyer },
      delivery: {
        address: {
          city: "Warszawa",
          countryCode: "PL",
          street: "Ulica 1",
          zipCode: "00-001",
          ...RECIPIENT,
        },
        cost: { amount: "12.99", currency: "PLN" },
        method: { name: "Kurier" },
      },
      id,
    });

  it("names the customer on the pass that creates the order", async () => {
    // The production shape, from the other side: `createOrderWorkflow` creates the
    // customer from the relay email alone, so unless this pass writes the name nothing
    // ever will.
    const context = withCursor({
      forms: [namedForm("f1")],
      pages: [[event("e1", "f1")]],
    });

    await drainAllegroOrders(context.container as never);

    expect(coreFlows.customerUpdates).toEqual([
      { id: ["cus_1"], update: { first_name: "Anna", last_name: "Testowa" } },
    ]);
  });

  it("takes the account holder's name, not the delivery recipient's", async () => {
    // The order's shipping address is Barbara's and stays Barbara's; the customer entity
    // is the account the order was placed from, which is Anna's. Conflating the two is
    // the identity error this mapping exists to avoid.
    const context = withCursor({
      forms: [namedForm("f1")],
      pages: [[event("e1", "f1")]],
    });

    await drainAllegroOrders(context.container as never);

    expect(coreFlows.customerUpdates[0]?.update).not.toMatchObject({
      first_name: "Barbara",
    });
    expect(coreFlows.created[0]).toMatchObject({
      shipping_address: { first_name: "Barbara", last_name: "Odbiorcza" },
    });
  });

  it("sets the company for a company account", async () => {
    const context = withCursor({
      forms: [namedForm("f1", { ...ACCOUNT, companyName: "Testowa Sp. z o.o." })],
      pages: [[event("e1", "f1")]],
    });

    await drainAllegroOrders(context.container as never);

    expect(coreFlows.customerUpdates[0]?.update).toEqual({
      company_name: "Testowa Sp. z o.o.",
      first_name: "Anna",
      last_name: "Testowa",
    });
  });

  it("writes nothing when Allegro sent no name for the account holder", async () => {
    // Rather than reaching for the delivery recipient, who is somebody else. An unnamed
    // customer beside a correctly named address is honest; a wrong name is not.
    const context = withCursor({
      forms: [namedForm("f1", {})],
      pages: [[event("e1", "f1")]],
    });

    await drainAllegroOrders(context.container as never);

    expect(coreFlows.customerUpdates).toEqual([]);
  });

  it("heals a customer created before the pipeline wrote names, without touching anything else", async () => {
    // The backfill, through the reconciliation sweep: the order already exists, its
    // customer has NULL names, and nobody has to run anything by hand.
    const context = setup({
      forms: [namedForm("f1")],
      medusaOrderCustomers: {
        order_9: { company_name: null, first_name: null, id: "cus_9", last_name: null },
      },
      orders: [
        {
          checkout_form_id: "f1",
          derived_status: "new",
          id: "algorder_1",
          medusa_order_id: "order_9",
        },
      ],
      pages: [[]],
      paymentCollections: { order_9: [{ captured_amount: 412.97 }] },
      states: [{ cursor: "e0", provider: "orders", status: "ok" }],
    });

    const result = await drainAllegroOrders(context.container as never);

    expect(coreFlows.customerUpdates).toEqual([
      { id: ["cus_9"], update: { first_name: "Anna", last_name: "Testowa" } },
    ]);
    expect(result.reconcileCustomersNamed).toBe(1);
    // NOT a repair, and so not in the run's error line: a name backfill says nothing
    // about whether the event journal is losing events, which is what `reconcileRepaired`
    // and that line mean.
    expect(result.reconcileRepaired).toBe(0);
    expect(result.error ?? null).toBeNull();
  });

  it("never overwrites a name a human already set", async () => {
    // Including the emergency hand-patch that named the one live customer this bug
    // produced from its order address. The fix has to make that patch redundant, not
    // fight it.
    const context = setup({
      forms: [namedForm("f1")],
      medusaOrderCustomers: {
        order_9: {
          company_name: null,
          first_name: "Barbara",
          id: "cus_9",
          last_name: "Odbiorcza",
        },
      },
      orders: [
        {
          checkout_form_id: "f1",
          derived_status: "new",
          id: "algorder_1",
          medusa_order_id: "order_9",
        },
      ],
      pages: [[]],
      paymentCollections: { order_9: [{ captured_amount: 412.97 }] },
      states: [{ cursor: "e0", provider: "orders", status: "ok" }],
    });

    const result = await drainAllegroOrders(context.container as never);

    expect(coreFlows.customerUpdates).toEqual([]);
    expect(result.reconcileCustomersNamed).toBe(0);
  });

  it("fills only the column that is empty, leaving the corrected one alone", async () => {
    const context = setup({
      forms: [namedForm("f1")],
      medusaOrderCustomers: {
        order_9: { company_name: null, first_name: "Ania", id: "cus_9", last_name: null },
      },
      orders: [
        {
          checkout_form_id: "f1",
          derived_status: "new",
          id: "algorder_1",
          medusa_order_id: "order_9",
        },
      ],
      pages: [[]],
      paymentCollections: { order_9: [{ captured_amount: 412.97 }] },
      states: [{ cursor: "e0", provider: "orders", status: "ok" }],
    });

    await drainAllegroOrders(context.container as never);

    expect(coreFlows.customerUpdates).toEqual([
      { id: ["cus_9"], update: { last_name: "Testowa" } },
    ]);
  });

  it("does not hold the event cursor when the customer write fails", async () => {
    // An unnamed customer must never stall every LATER order behind it. The order itself
    // is correct, and the next pass tries the name again.
    coreFlows.customerUpdateError = new Error("customer module is unavailable");
    const context = withCursor({
      forms: [namedForm("f1")],
      pages: [[event("e1", "f1")]],
    });

    const result = await drainAllegroOrders(context.container as never);

    expect(result.failed).toBe(0);
    expect(context.allegro.states.get("orders")).toMatchObject({ cursor: "e1" });
    expect(
      context.logs.some((line) => line.includes("could not fill first_name, last_name")),
    ).toBe(true);
  });
});

describe("drainAllegroOrders: the reconciliation sweep", () => {
  const quiet = (input: Parameters<typeof setup>[0] = {}) =>
    setup({
      pages: [[]],
      states: [{ cursor: "e0", provider: "orders", status: "ok" }],
      ...input,
    });

  const paidForm = (id: string) =>
    form({
      id,
      payment: {
        finishedAt: "2026-08-19T18:18:40.000Z",
        paidAmount: { amount: "412.97", currency: "PLN" },
        type: "ONLINE",
      },
    });

  it("recovers an order whose payment event the journal never delivered", async () => {
    // The incident, reproduced: the order exists, Allegro says it is paid, the event that
    // said so is long past the cursor, and nothing else in this plugin would ever look at
    // it again.
    const context = quiet({
      forms: [paidForm("f1")],
      medusaOrderTotals: { order_1: { currency_code: "pln", total: 412.97 } },
      orders: [
        {
          checkout_form_id: "f1",
          derived_status: "new",
          id: "algorder_1",
          medusa_order_id: "order_1",
        },
      ],
      paymentCollections: { order_1: [] },
    });

    const result = await drainAllegroOrders(context.container as never);

    expect(coreFlows.markedPaid).toEqual([
      { order_id: "order_1", payment_collection_id: "paycol_1" },
    ]);
    expect(result.reconcilePayments).toBe(1);
    expect(result.reconcileRepaired).toBe(1);
    // A repair by the safety net is a finding: the journal lost something.
    expect(result.error).toMatch(/reconciliation sweep/);
    expect(
      context.logs.some((line) => line.includes("an order event was lost or never arrived")),
    ).toBe(true);
  });

  it("leaves a fully paid, still-open order alone", async () => {
    const context = quiet({
      forms: [paidForm("f1")],
      medusaOrderTotals: { order_1: { currency_code: "pln", total: 412.97 } },
      orders: [
        {
          checkout_form_id: "f1",
          derived_status: "new",
          id: "algorder_1",
          medusa_order_id: "order_1",
        },
      ],
      paymentCollections: { order_1: [{ captured_amount: 412.97 }] },
    });

    const result = await drainAllegroOrders(context.container as never);

    expect(coreFlows.paymentCollections).toEqual([]);
    // Re-read - the slow tier is due on a row that has never been swept - but nothing
    // needed repairing, so nothing is reported.
    expect(result.reconciled).toBe(1);
    expect(result.reconcileRepaired).toBe(0);
    expect(result.error ?? null).toBeNull();
  });

  it("spends no Allegro request on an order that has reached the end of the ladder", async () => {
    const context = quiet({
      forms: [paidForm("f1")],
      medusaOrderTotals: { order_1: { currency_code: "pln", total: 412.97 } },
      orders: [
        {
          checkout_form_id: "f1",
          derived_status: "delivered",
          id: "algorder_1",
          medusa_order_id: "order_1",
        },
      ],
      paymentCollections: { order_1: [{ captured_amount: 412.97 }] },
    });

    const result = await drainAllegroOrders(context.container as never);

    expect(result.reconciled).toBe(0);
  });

  it("does not re-read a form the drain applied on this same tick", async () => {
    // One Allegro read per open order per tick is the whole budget; spending a second on
    // the form that was just applied from the same upstream state buys nothing.
    const context = setup({
      forms: [paidForm("f1")],
      medusaOrderTotals: { order_1: { currency_code: "pln", total: 412.97 } },
      pages: [[event("e1", "f1")]],
      states: [{ cursor: "e0", provider: "orders", status: "ok" }],
    });

    const result = await drainAllegroOrders(context.container as never);

    expect(result.created).toBe(1);
    expect(result.reconciled).toBe(0);
    // The payment was still recorded - by the drain's own pass, which is the point.
    expect(coreFlows.markedPaid).toHaveLength(1);
  });
});
