import type { AllegroCheckoutForm, AllegroOrderEvent } from "../../lib/allegro/types";
import { QUARANTINE_AFTER_FAILURES } from "../../lib/sync/failure-state";
import { drainAllegroOrders, repairAllegroOrder } from "../drain-allegro-orders";
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
  sequence: number;
} = {
  cancelled: [],
  completed: [],
  created: [],
  failCreateForForms: new Set(),
  sequence: 0,
};

jest.mock("@medusajs/medusa/core-flows", () => ({
  cancelOrderWorkflow: () => ({
    run: ({ input }: { input: { order_id: string } }) => {
      if (coreFlows.cancelError) {
        return Promise.reject(coreFlows.cancelError);
      }
      coreFlows.cancelled.push(input.order_id);
      return Promise.resolve({ result: undefined });
    },
  }),
  completeOrderWorkflow: () => ({
    run: ({ input }: { input: { orderIds: string[] } }) => {
      coreFlows.completed.push(input.orderIds);
      return Promise.resolve({ result: [] });
    },
  }),
  createOrderWorkflow: () => ({
    run: ({ input }: { input: Record<string, unknown> }) => {
      if (coreFlows.createError) {
        return Promise.reject(coreFlows.createError);
      }
      const formId = (input.metadata as { allegro_checkout_form_id?: string } | undefined)
        ?.allegro_checkout_form_id;
      if (formId && coreFlows.failCreateForForms.has(formId)) {
        return Promise.reject(new Error(`cannot create an order for ${formId}`));
      }
      coreFlows.sequence += 1;
      coreFlows.created.push(input);
      return Promise.resolve({ result: { id: `order_${coreFlows.sequence}` } });
    },
  }),
}));

const event = (
  id: string,
  formId: string,
  type: AllegroOrderEvent["type"] = "BOUGHT",
): AllegroOrderEvent => ({ id, order: { checkoutForm: { id: formId } }, type });

const form = (over: Partial<AllegroCheckoutForm> & { id: string }): AllegroCheckoutForm => ({
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
    list: (filters: Record<string, unknown>, config: { take?: number } = {}) => {
      let out = rows.map((row) => ({ ...row }));
      for (const [key, value] of Object.entries(filters)) {
        out = out.filter((row) => row[key] === value);
      }
      return Promise.resolve(config.take === undefined ? out : out.slice(0, config.take));
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
  let checkoutPage = 0;
  return {
    fulfillmentCalls,
    getCheckoutForm: (id: string) => {
      const failure = input.formError?.[id];
      if (failure) {
        return Promise.reject(failure);
      }
      const found = (input.forms ?? []).find((entry) => entry.id === id);
      return Promise.resolve(found ?? form({ id }));
    },
    getOrderEventStats: () =>
      Promise.resolve(input.latest ? { latestEvent: { id: input.latest } } : {}),
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
}) => {
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

  const container = {
    resolve: (key: string) => {
      if (key === "allegro") {
        return allegro;
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
              const wanted = (
                filters?.metadata as { allegro_checkout_form_id?: string } | undefined
              )?.allegro_checkout_form_id;
              if (wanted !== undefined) {
                if (input.orderQueryThrows) {
                  return Promise.reject(new Error("json filters are not supported here"));
                }
                // A filter that "works" narrows; one that silently does nothing returns
                // everything, which is the case the in-memory re-check has to survive.
                return Promise.resolve({
                  data: input.orderQueryIgnoresFilter
                    ? all
                    : all.filter((order) => order.metadata?.allegro_checkout_form_id === wanted),
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

  return { allegro, client, container, logs, table };
};

beforeEach(() => {
  coreFlows.created.length = 0;
  coreFlows.cancelled.length = 0;
  coreFlows.completed.length = 0;
  coreFlows.createError = undefined;
  coreFlows.cancelError = undefined;
  coreFlows.sequence = 0;
  coreFlows.failCreateForForms.clear();
});

describe("drainAllegroOrders: bootstrap", () => {
  it("records the newest event id and consumes nothing on a fresh install", async () => {
    // Replaying the 60 days Allegro retains would be thousands of `getCheckoutForm`
    // calls, so a new installation starts tracking from now and importing history
    // stays an explicit operator action.
    const context = setup({ latest: "e-newest", pages: [[event("e1", "f1")]] });

    const result = await drainAllegroOrders(context.container as never);

    expect(result).toMatchObject({ bootstrapped: true, eventsRead: 0, refreshed: 0 });
    expect(context.allegro.states.get("orders")).toMatchObject({ cursor: "e-newest" });
    expect(context.table.rows).toEqual([]);
    expect(context.logs.some((line) => line.includes("cursor bootstrapped"))).toBe(true);
  });
});

describe("drainAllegroOrders: the claim is re-asserted between forms", () => {
  const withCursor = (input: Parameters<typeof setup>[0] = {}) =>
    setup({ states: [{ cursor: "e0", provider: "orders", status: "ok" }], ...input });

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
    expect(context.logs.some((line) => line.includes("belongs to its successor"))).toBe(true);
  });

  it("heartbeats under its own token while it still holds the claim", async () => {
    const context = withCursor({ forms: [form({ id: "f1" })], pages: [[event("e1", "f1")]] });

    await drainAllegroOrders(context.container as never);

    expect(context.allegro.heartbeats.map((beat) => beat.provider)).toEqual(["orders"]);
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
    expect(state).toMatchObject({ claim_token: "incumbent", status: "running" });
    expect(context.allegro.preClaimWritesSkipped).toEqual(["orders"]);
    // Skipped, but never silently: "nothing happened and nothing was recorded" is the state
    // this repo has been bitten by before.
    expect(context.logs.some((line) => line.includes("held by a run currently in flight"))).toBe(
      true,
    );
  });

  it("still records the reason when no run holds the claim", async () => {
    const context = setup({
      ordersSyncDisabled: true,
      states: [{ cursor: "e0", provider: "orders", status: "ok" }],
    });

    await drainAllegroOrders(context.container as never);

    expect(context.allegro.states.get("orders")).toMatchObject({ status: "idle" });
    expect(context.allegro.states.get("orders")?.last_error).toContain("orders sync is disabled");
  });
});

describe("drainAllegroOrders: never duplicating a Medusa order", () => {
  const withCursor = (input: Parameters<typeof setup>[0] = {}) =>
    setup({ states: [{ cursor: "e0", provider: "orders", status: "ok" }], ...input });

  /** The state a crash between order creation and the link write leaves behind. */
  const orphaned = (over: Parameters<typeof setup>[0] = {}) =>
    withCursor({
      existingOrders: [{ id: "order_pre", metadata: { allegro_checkout_form_id: "f1" } }],
      forms: [form({ id: "f1" })],
      // The bookkeeping row exists but never learned the order id.
      orders: [{ checkout_form_id: "f1", id: "algorder_1", medusa_order_id: null }],
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
    expect(context.table.rows[0]).toMatchObject({ medusa_order_id: "order_pre" });
    expect(context.logs.some((line) => line.includes("adopted existing Medusa order"))).toBe(true);
  });

  it("falls back to a bounded scan when the metadata filter is unsupported", async () => {
    // The JSON filter is the one part of adoption that depends on query-layer behaviour
    // the plugin does not own. If it throws, creating a duplicate is not an acceptable
    // degradation, so a bounded newest-first scan verifies in memory instead.
    const context = orphaned({ orderQueryThrows: true });

    await drainAllegroOrders(context.container as never);

    expect(coreFlows.created).toEqual([]);
    expect(context.table.rows[0]).toMatchObject({ medusa_order_id: "order_pre" });
  });

  it("never adopts an order belonging to a different checkout form", async () => {
    // The safety property that makes adoption sound at all: only an EXACT metadata match
    // is accepted. Here the filter is broken in the most dangerous way - it matches
    // everything - and the order on offer belongs to another form. Adopting it would
    // attach somebody else's sale to this one.
    const context = withCursor({
      existingOrders: [{ id: "order_other", metadata: { allegro_checkout_form_id: "f-OTHER" } }],
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
    const context = withCursor({ forms: [form({ id: "f1" })], pages: [[event("e1", "f1")]] });

    await drainAllegroOrders(context.container as never);

    expect(coreFlows.created).toHaveLength(1);
  });
});

describe("drainAllegroOrders: a malformed form is refused, not fabricated", () => {
  const withCursor = (input: Parameters<typeof setup>[0] = {}) =>
    setup({ states: [{ cursor: "e0", provider: "orders", status: "ok" }], ...input });

  const malformed = (over: Partial<AllegroCheckoutForm>) =>
    withCursor({ forms: [form({ id: "f1", ...over })], pages: [[event("e1", "f1")]] });

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
    expect(context.table.rows[0]?.last_error).toContain("no parseable unit price");
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
    const context = malformed({ summary: { totalToPay: { amount: "412.97" } } as never });

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

  it("refuses a present-but-unreadable delivery cost", async () => {
    // Money the buyer paid. Silently dropping it understates the order total.
    const context = malformed({
      delivery: { cost: { amount: "??", currency: "PLN" }, method: { name: "Kurier" } },
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

    expect(context.allegro.states.get("orders")).toMatchObject({ cursor: "e0" });
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
    setup({ states: [{ cursor: "e0", provider: "orders", status: "ok" }], ...input });

  it("creates the order with Allegro's totals and the shipping address", async () => {
    const context = withCursor({ forms: [form({ id: "f1" })], pages: [[event("e1", "f1")]] });

    const result = await drainAllegroOrders(context.container as never);

    expect(result).toMatchObject({ created: 1, eventsRead: 1, refreshed: 1, statusChanged: 1 });
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
    expect(coreFlows.created[0]?.shipping_methods).toEqual([{ amount: 12.99, name: "Kurier" }]);
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
    const context = withCursor({ forms: [form({ id: "f1" })], pages: [[event("e1", "f1")]] });

    await drainAllegroOrders(context.container as never);

    const { writes } = context.table;
    const watermarkIndex = writes.findIndex((write) => write.patch.synced_at !== undefined);
    const orderIdIndex = writes.findIndex((write) => write.patch.medusa_order_id !== undefined);
    expect(watermarkIndex).toBeGreaterThan(orderIdIndex);
    expect(watermarkIndex).toBe(writes.length - 1);
  });

  it("writes derived_status in the same operation as the watermark", async () => {
    const context = withCursor({ forms: [form({ id: "f1" })], pages: [[event("e1", "f1")]] });

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
              offer: { external: { id: "SKU-GHOST" }, id: "o9", name: "Unknown thing" },
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
      orders: [{ checkout_form_id: "f1", id: "algorder_1", medusa_order_id: "order_1" }],
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
      orders: [{ checkout_form_id: "f1", id: "algorder_1", medusa_order_id: "order_1" }],
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
      orders: [{ checkout_form_id: "f1", id: "algorder_1", medusa_order_id: "order_1" }],
      pages: [[event("e1", "f1", "BUYER_CANCELLED")], [event("e1", "f1", "BUYER_CANCELLED")]],
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
      orders: [{ checkout_form_id: "f1", id: "algorder_1", medusa_order_id: "order_1" }],
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
      orders: [{ checkout_form_id: "f1", id: "algorder_1", medusa_order_id: "order_1" }],
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
    const context = withCursor({ forms: [form({ id: "f1" })], pages: [[event("e1", "f1")]] });

    const result = await drainAllegroOrders(context.container as never);

    expect(result.failed).toBe(1);
    expect(context.allegro.states.get("orders")).toMatchObject({ cursor: "e0" });
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
    expect(context.table.rows[0]?.last_error).toContain("no Medusa region exists");
  });

  it("warns and falls back when no region matches the order currency", async () => {
    const context = withCursor({
      forms: [form({ id: "f1" })],
      pages: [[event("e1", "f1")]],
      regions: [{ currency_code: "eur", id: "reg_eu" }],
    });

    await drainAllegroOrders(context.container as never);

    expect(coreFlows.created[0]?.region_id).toBe("reg_eu");
    expect(context.logs.some((line) => line.includes("no region uses currency"))).toBe(true);
  });

  it("does not create a second order for a form that already has one", async () => {
    const context = withCursor({
      forms: [form({ id: "f1" })],
      orders: [{ checkout_form_id: "f1", id: "algorder_1", medusa_order_id: "order_1" }],
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
            streaks: { f1: { count: QUARANTINE_AFTER_FAILURES - 1, error: "old", since: RECENT } },
          },
          provider: "orders",
          status: "error",
        },
      ],
    });

    const result = await drainAllegroOrders(context.container as never);

    expect(result.quarantined).toEqual(["f1"]);
    expect(context.allegro.states.get("orders")).toMatchObject({ cursor: "e2" });
    expect(result.error).toContain("quarantined after repeated failures");
  });

  it("writes nothing and holds the cursor when the kill switch is on", async () => {
    const context = withCursor({ ordersSyncDisabled: true, pages: [[event("e1", "f1")]] });

    const result = await drainAllegroOrders(context.container as never);

    expect(result.skipped).toContain("orders sync is disabled");
    expect(result.disabled).toBe(true);
    expect(context.table.rows).toEqual([]);
    expect(context.allegro.claims).toEqual([]);
    // The cursor is untouched, so nothing is skipped while the switch is on.
    expect(context.allegro.states.get("orders")).toMatchObject({ cursor: "e0" });
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
    expect(context.allegro.states.get("orders")).toMatchObject({ failures: null, status: "ok" });
  });

  it("keeps every other quarantined order on the health line", async () => {
    const context = setup({
      forms: [form({ id: "f1" })],
      states: [
        {
          cursor: "e5",
          failures: {
            quarantined: { "f-other": { error: "still broken", since: RECENT } },
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
          failures: { quarantined: {}, streaks: { f1: { count: 1, error: "x", since: RECENT } } },
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

    expect(context.allegro.states.get("orders")).toMatchObject({ cursor: "e5" });
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

    expect(context.allegro.states.get("orders")).toMatchObject({ last_error: null, status: "ok" });
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

    expect(result).toMatchObject({ created: 2, failed: 0, fetched: 2, imported: 2 });
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

    expect(context.allegro.states.get("orders")).toMatchObject({ cursor: "e5" });
  });

  it("names the failures and keeps importing the rest", async () => {
    // One unapplyable order must not stop the other 2,999, and an operator needs the
    // ids to chase what is left.
    const context = setup({
      checkoutFormPages: [[form({ id: "f1" }), form({ id: "f2" }), form({ id: "f3" })]],
      states: [{ cursor: "e5", provider: "orders", status: "ok" }],
    });
    coreFlows.failCreateForForms.add("f2");

    const result = await importAllegroOrdersWindow(context.container as never, {
      since: "2026-05-01T00:00:00.000Z",
    });

    expect(result).toMatchObject({ failed: 1, failedFormIds: ["f2"], imported: 2 });
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
      orders: [{ checkout_form_id: "f1", id: "algorder_1", medusa_order_id: "order_1" }],
    });
    await pushAllegroFulfillment(first.container as never, {
      eventName: "order.fulfillment_created",
      orderId: "order_1",
    });
    expect(first.client.fulfillmentCalls).toEqual([{ id: "f1", status: "READY_FOR_SHIPMENT" }]);

    const second = setup({
      orders: [{ checkout_form_id: "f1", id: "algorder_1", medusa_order_id: "order_1" }],
    });
    await pushAllegroFulfillment(second.container as never, {
      eventName: "shipment.created",
      orderId: "order_1",
    });
    expect(second.client.fulfillmentCalls).toEqual([{ id: "f1", status: "SENT" }]);
    expect(second.table.rows[0]).toMatchObject({ fulfillment_status: "SENT", last_error: null });
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
      orders: [{ checkout_form_id: "f1", id: "algorder_1", medusa_order_id: "order_1" }],
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
      orders: [{ checkout_form_id: "f1", id: "algorder_1", medusa_order_id: "order_1" }],
    });

    const result = await pushAllegroFulfillment(context.container as never, {
      eventName: "shipment.created",
      orderId: "order_1",
    });

    expect(result.error).toContain("Allegro said no");
    expect(context.table.rows[0]?.last_error).toContain("fulfillment push");
  });
});
