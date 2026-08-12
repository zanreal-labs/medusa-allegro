import { model } from "@medusajs/framework/utils";

/**
 * The one persisted row of live, operator-flippable runtime toggles.
 *
 * A SINGLETON: exactly one row exists, keyed by a fixed id
 * (`ALLEGRO_SETTINGS_ID` in the service). It is the source of truth for whether
 * each writer is armed, and it exists so an operator can arm or disarm a writer
 * from the admin WITHOUT a redeploy. Every runtime path resolves its effective
 * state at the top of each tick/handler from this row, so a flip takes effect on
 * the next run rather than the next deploy.
 *
 * Precedence, resolved in `src/lib/runtime-toggles.ts`:
 *
 *   effectiveEnabled = persistedEnabled && !forceDisabled
 *
 * The environment (and the boot-time plugin option) can ONLY force a writer OFF -
 * `ALLEGRO_PRICE_SYNC_DISABLED=1` and friends. They never force one on. So a
 * persisted `true` still yields "off" while the env override is set, and the admin
 * shows that switch as forced-off rather than lying about it; clear the override and
 * the persisted toggle governs again.
 *
 * Fresh-install defaults are the whole reason this is safe to ship: every WRITER
 * defaults OFF, so a freshly connected store publishes nothing to Allegro until an
 * operator deliberately arms each writer. `invoice_attach_enabled` is the one
 * exception - it defaults ON, because by the time an invoice event reaches this
 * plugin the document already exists as a legal record and the only sensible default
 * is to deliver it; it is enabled-but-inert until an invoicing module is wired, since
 * there is nothing to attach before then.
 */
const AllegroSettings = model.define("allegro_settings", {
  /**
   * When the seller-managed fulfillment status is pushed back to Allegro on a
   * Medusa fulfillment/shipment event.
   *
   * NEW as a governed writer: this event-driven path had no kill switch at all
   * before, so a store could not stop it writing to the marketplace without pulling
   * the subscriber. Defaults OFF like every other writer.
   */
  fulfillment_writeback_enabled: model.boolean().default(false),
  id: model.id({ prefix: "algset" }).primaryKey(),
  /**
   * When issued invoice PDFs are attached to their Allegro orders. Defaults ON:
   * the invoice already exists as a legal document by the time the event lands, so
   * delivering it is the safe default. Enabled-but-inert until an invoicing module
   * emits the event, because there is nothing to attach before then.
   */
  invoice_attach_enabled: model.boolean().default(true),
  /** When the order event journal is drained into Medusa orders. Defaults OFF. */
  orders_sync_enabled: model.boolean().default(false),
  /** When price-automation rules and bounds are written to Allegro. Defaults OFF. */
  price_sync_enabled: model.boolean().default(false),
  /** When Medusa available quantity is pushed to Allegro. Defaults OFF. */
  stock_sync_enabled: model.boolean().default(false),
});

export default AllegroSettings;
