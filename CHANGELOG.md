# Changelog

All notable changes to `@zanreal/medusa-allegro` are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). A version
reaches npm only through a GitHub Release, so the dates below are publish dates on the
registry, not merge dates on `main` - see [Releasing](./README.md#releasing).

Entries name the behaviour an operator sees. A plugin that writes to a live marketplace
is judged on what it does to offers and orders, not on which files moved.

## [Unreleased]

### Changed

- **Built and tested against Medusa 2.21.1** (was 2.18.0), with the admin toolchain Medusa 2.19
  requires: Vite 7 and, where used, React Router 7. `react-i18next` and `i18next` deliberately stay
  on the majors the Medusa dashboard itself ships (13 and 23): admin extensions share the host's
  i18n instance, and a second major would give them one of their own. Install alongside Medusa
  2.21.1; Node ^20.19 or ^22.12 is required from Medusa 2.19 on.

### Changed

- **The price loop now checks the range actually on the offer, not its own record of what it
  sent.** A floor or ceiling edited in the Allegro seller panel used to be invisible: the loop
  compared the desired range against the last push in its audit, found them equal, and left the
  offer alone indefinitely - possibly below break-even. It now reads the attached range from
  `GET /sale/price-automation/offers/{offerId}/rules`, notices the edit, logs it by offer, and
  puts the break-even floor back. The plugin was built believing that range was write-only; it is
  not (#37).
- An offer whose rule was attached by hand already carrying the right range is no longer
  re-pushed just because the audit had no record of it.
- The read costs one request per offer, only for offers already on the right rule, paced at
  4/second against Allegro's 5/second limit. If it fails, the loop falls back to the audit
  exactly as before, so an Allegro hiccup degrades a run to the old behaviour rather than
  re-pushing the whole catalogue. An expired token still aborts the run with the reconnect
  message.

## [1.0.0] - 2026-09-08

### Added

- **Promotions.** A read-only preview on Medusa's promotion page shows what a discount
  would do to the matching Allegro offers, and an overlay switches those offers onto a
  promotional price rule and back off again. The preview is anchored on the live auction
  price, not on the shop price, because that is the number the discount actually moves.
- **Stock.** A sold SKU's quantity now reaches Allegro in seconds instead of waiting for
  the fifteen-minute sweep, and a supplier-side stock movement pushes as well - not only
  a sale in Medusa.
- **Margin after commission.** The catalog and the variant detail page show the margin
  that remains once Allegro's category commission is taken off, so the number on screen
  is the one worth deciding on.
- **Alerts.** `allegro.*` notifications are raised into the admin feed (and mirrored to
  Slack where that is configured) through a single emitter.
- **Audit columns.** `promotion_id` and `promotion_discount` on the price-push record, so
  a price change made by a promotion can be told apart from one made by a pricing rule.
- **Billing data.** An Allegro order announces itself when the buyer's invoice data
  becomes complete, instead of leaving an operator to poll for it.

### Fixed

- An order address the buyer supplied *after* the order was created is now filled in, and
  the repair path that was meant to do that could previously never write at all.
- A parcel locker is no longer treated as a company, and the pickup point id has a field
  of its own rather than being smuggled into a name.
- The invoice tax id travels in order metadata instead of being appended to the customer
  name.
- Stock no longer pages CRITICAL for a variant that simply has no Allegro auction.
- Promotion pricing uses the real purchase cost and commission; the SRP-derived mode is
  gone, because it produced a margin figure that was not the store's margin.
- Errors render through `describeError` instead of the `[object Object]` idiom that had
  spread across the plugin.

### Changed

- Depends on `@zanreal/medusa-admin-kit` as a registry range (`^0.2.0`) rather than a
  `github:` spec, so installing from npm no longer needs git access to GitHub.

## [0.1.0] - 2026-08-26

First public release. MIT, published from CI with npm provenance.

### Added

- **Allegro REST client** in `src/lib/allegro`, dependency-free and framework-agnostic:
  offers, price automation rules, order events, checkout forms and commission preview.
- **OAuth2 connection** with refresh-token rotation and AES-256-GCM at rest on the stored
  tokens.
- **Offer discovery** keyed on signature to SKU, so an existing Allegro catalogue can be
  adopted without re-listing it.
- **Order sync**: continuous drain on a 20 second interval, buyer payment recorded,
  inventory reserved so an Allegro order can be fulfilled, `order.placed` announced,
  shipment events driving the Allegro SENT write-back with a retry path on the sweep that
  already runs.
- **Invoice attachment**: issued invoice PDFs attached to their Allegro orders, with its
  own kill switch.
- **Pricing**: the pricing strategy is a persisted setting rather than an assumption, with
  an SRP ceiling derived from cost, per-run change caps, and a bounded, stable scan for
  the price-automation monitor.
- **Catalog surface** through `@zanreal/medusa-admin-kit`: one row per variant showing the
  shop price, the SRP, the live Allegro price and offer status.
- **Runtime toggles**, persisted and editable in Settings, resolved per run. Every writer
  ships **off** on a fresh install and an environment variable can force it off, so
  installing the plugin cannot by itself change anything on Allegro.
- **Admin UI in English and Polish.**

[Unreleased]: https://github.com/zanreal-labs/medusa-allegro/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/zanreal-labs/medusa-allegro/releases/tag/v1.0.0
[0.1.0]: https://github.com/zanreal-labs/medusa-allegro/releases/tag/v0.1.0
