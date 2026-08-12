/**
 * The runtime-toggle precedence, in one pure function, plus the metadata that ties
 * each writer to its persisted column and its environment override.
 *
 * Deliberately framework-free and dependency-free: no Medusa imports, no model, no
 * `process.env` read. The service wires the persisted row and the env readers into
 * this, and the pure shape is what makes the precedence trivially unit-testable.
 */

/**
 * The effective armed state of a writer.
 *
 *   effectiveEnabled = persistedEnabled && !forceDisabled
 *
 * The persisted toggle governs; `forceDisabled` (the environment override, or the
 * boot-time plugin option) can ONLY force a writer off. It never forces one on, which
 * is what lets an operator flip the persisted toggle live while an env override that
 * is set keeps the writer safely off until the override is cleared.
 *
 * Written with explicit `=== true` / `!== true` rather than truthiness so a stray
 * `undefined` from a malformed row reads as "not armed" and "not forced off" - the
 * conservative reading in both directions.
 */
export const resolveEffectiveEnabled = (
  persistedEnabled: boolean,
  forceDisabled: boolean,
): boolean => persistedEnabled === true && forceDisabled !== true;

/** The stable key for each governed writer. */
export type RuntimeToggleKey =
  | "priceSync"
  | "stockSync"
  | "ordersSync"
  | "fulfillmentWriteback"
  | "invoiceAttach";

/** The persisted boolean column backing each toggle on `allegro_settings`. */
export type RuntimeToggleColumn =
  | "price_sync_enabled"
  | "stock_sync_enabled"
  | "orders_sync_enabled"
  | "fulfillment_writeback_enabled"
  | "invoice_attach_enabled";

export interface RuntimeToggleMeta {
  key: RuntimeToggleKey;
  /** The persisted column on `allegro_settings`. */
  column: RuntimeToggleColumn;
  /** The environment variable that force-disables this writer at runtime. */
  envVar: string;
  /** What an operator is deciding about, named after what it does. */
  label: string;
  /** One line of what flipping it off stops. */
  description: string;
}

/**
 * Every governed writer, in the order the admin lists them.
 *
 * The single source of truth for "which writers exist and what backs them". The
 * service maps each to its persisted column and its force-disable predicate; the
 * admin renders one switch per entry. Adding a writer is a matter of adding a column
 * and an entry here.
 */
export const RUNTIME_TOGGLES: readonly RuntimeToggleMeta[] = [
  {
    column: "price_sync_enabled",
    description:
      "Attaches price-automation rules and asserts the break-even/SRP bounds on Allegro.",
    envVar: "ALLEGRO_PRICE_SYNC_DISABLED",
    key: "priceSync",
    label: "Price writes",
  },
  {
    column: "stock_sync_enabled",
    description: "Pushes Medusa available quantity to Allegro.",
    envVar: "ALLEGRO_STOCK_SYNC_DISABLED",
    key: "stockSync",
    label: "Quantity writes",
  },
  {
    column: "orders_sync_enabled",
    description: "Drains the Allegro order event journal into Medusa orders.",
    envVar: "ALLEGRO_ORDERS_SYNC_DISABLED",
    key: "ordersSync",
    label: "Order drain",
  },
  {
    column: "fulfillment_writeback_enabled",
    description:
      "Pushes the seller-managed fulfillment status back to Allegro on a Medusa fulfillment or shipment.",
    envVar: "ALLEGRO_FULFILLMENT_WRITEBACK_DISABLED",
    key: "fulfillmentWriteback",
    label: "Fulfillment write-back",
  },
  {
    column: "invoice_attach_enabled",
    description: "Attaches issued invoice PDFs to their Allegro orders.",
    envVar: "ALLEGRO_INVOICE_ATTACH_DISABLED",
    key: "invoiceAttach",
    label: "Invoice attach",
  },
] as const;

/**
 * The fresh-install persisted defaults.
 *
 * Every WRITER off, so a freshly connected store publishes nothing until an operator
 * arms it. `invoice_attach_enabled` is the single exception, on for the reasons in the
 * model comment. Passed explicitly on the singleton's first create so the resolver
 * never depends on ORM default hydration to read a sane state.
 */
export const FRESH_INSTALL_SETTINGS: Record<RuntimeToggleColumn, boolean> = {
  fulfillment_writeback_enabled: false,
  invoice_attach_enabled: true,
  orders_sync_enabled: false,
  price_sync_enabled: false,
  stock_sync_enabled: false,
};
