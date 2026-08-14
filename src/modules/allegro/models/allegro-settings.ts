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
 *
 * The same row also carries the editable sync-configuration fields
 * (`automation_rule_standard` and friends, see `src/lib/config-fields.ts`). They were
 * `medusa-config.ts` constructor options only, rendered in the admin as inert text -
 * changing one meant editing the config file and redeploying. Every one of these
 * columns is NULLABLE with NO default: `null` means "nothing persisted, fall back to
 * the `medusa-config.ts` default", the same precedence the runtime toggles use for
 * an environment override, adapted to a value instead of a boolean. A fresh install
 * or an unedited field is therefore indistinguishable from before this row existed.
 */
const AllegroSettings = model.define("allegro_settings", {
  /**
   * Name of the price-automation rule attached to a promoted offer.
   *
   * Persisted counterpart of the `automationRules.promoted` plugin option. `null`
   * falls back to that option. Must differ from `automation_rule_standard` once
   * both resolve to a value - see the write-side check in the service - because a
   * promotion flip would otherwise attach the same rule regardless of promotion
   * state, silently defeating the promoted commission rate.
   */
  automation_rule_promoted: model.text().nullable(),
  /**
   * Name of the price-automation rule attached to a standard (non-promoted)
   * offer. Persisted counterpart of the `automationRules.standard` plugin option.
   * `null` falls back to that option.
   */
  automation_rule_standard: model.text().nullable(),
  /**
   * Commands issued per price-sync run. Persisted counterpart of the `changeCap`
   * plugin option. `null` falls back to that option (which itself defaults to
   * `DEFAULT_CHANGE_CAP`). The write-side check rejects anything that is not a
   * positive integer, for the same reason `resolveChangeCap` does at boot: a cap
   * of 0 or less is not "no writes" - the kill switches exist for that.
   */
  change_cap: model.number().nullable(),
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
  /**
   * Marketplace the price-automation rule assignment targets. Persisted
   * counterpart of the `marketplaceId` plugin option. `null` falls back to that
   * option (which itself defaults to `DEFAULT_MARKETPLACE_ID`).
   *
   * WIRING-CRITICAL: a wrong value silently breaks the Allegro<->Medusa mapping
   * rather than merely mis-tuning a run. Editable, but the `medusa-config.ts` /
   * `ALLEGRO_MARKETPLACE_ID` value can hard-lock it - see
   * `marketplaceIdEnvOverride` in `src/lib/options.ts`.
   */
  marketplace_id: model.text().nullable(),
  /** When the order event journal is drained into Medusa orders. Defaults OFF. */
  orders_sync_enabled: model.boolean().default(false),
  /**
   * How this store prices its Allegro offers: `monitor`, `automation_rule` or
   * `fixed_price` (see `src/lib/pricing-mode.ts` for what each one writes).
   *
   * Persisted counterpart of the `pricingMode` plugin option. `null` falls back
   * to that option, which itself defaults to `automation_rule` - the behaviour
   * this plugin had before the mode existed, so an upgrade never silently changes
   * what a store writes.
   *
   * Text rather than an enum column on purpose: the valid set is enforced in one
   * place (`isPricingMode`, checked by the write route and by the option
   * resolver), and a database enum would need a migration every time the set
   * moves. A value that is not a known mode reads as the default at runtime
   * rather than throwing on every sync run.
   */
  pricing_mode: model.text().nullable(),
  /** When price-automation rules and bounds are written to Allegro. Defaults OFF. */
  price_sync_enabled: model.boolean().default(false),
  /**
   * Sales channel id that scopes which Medusa products are matched against
   * Allegro offers. Persisted counterpart of the `salesChannelId` plugin option.
   * `null` falls back to that option.
   *
   * WIRING-CRITICAL, same reasoning as `marketplace_id`: re-scoping which
   * products are sync-eligible is not a tuning knob, it changes what this plugin
   * matches. `ALLEGRO_SALES_CHANNEL_ID` can hard-lock it.
   */
  sales_channel_id: model.text().nullable(),
  /**
   * Sales channel name that scopes eligible products when no channel id is set.
   * Persisted counterpart of the `salesChannelName` plugin option. `null` falls
   * back to that option.
   */
  sales_channel_name: model.text().nullable(),
  /**
   * Variant (or product) metadata key holding the SRP ceiling. Persisted
   * counterpart of the `srpMetadataKey` plugin option. `null` falls back to that
   * option. Mutually exclusive with `srp_price_list_id` once both resolve to a
   * value - see the write-side check in the service.
   */
  srp_metadata_key: model.text().nullable(),
  /**
   * Price list id whose price is read as the SRP ceiling. Persisted counterpart
   * of the `srpPriceListId` plugin option. `null` falls back to that option.
   * Mutually exclusive with `srp_metadata_key`.
   */
  srp_price_list_id: model.text().nullable(),
  /** When Medusa available quantity is pushed to Allegro. Defaults OFF. */
  stock_sync_enabled: model.boolean().default(false),
});

export default AllegroSettings;
