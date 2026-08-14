# @zanreal/medusa-allegro

![status: pre-release](https://img.shields.io/badge/status-pre--release-orange)
![medusa: v2](https://img.shields.io/badge/medusa-v2-blueviolet)
![license: MIT](https://img.shields.io/badge/license-MIT-green)

Medusa v2 plugin for [Allegro](https://allegro.pl), the largest marketplace in
Poland.

**Status: pre-release.** The full sync engine is here: offer discovery, a read-only
pricing monitor, price-automation writes, the quantity push, and the order event
drain. Treat the schema as settled and the API surface as still moving until 1.0.

What is here:

- A zero-dependency, fetch-based Allegro REST client, ported from a production
  integration. Offers, promo options, price-automation rules and commands, order
  events, checkout forms, categories, fee preview.
- OAuth 2.0 authorization-code flow with a CSRF-protected callback, refresh-token
  rotation, and AES-256-GCM encryption of both tokens at rest.
- **Offer discovery** matches every seller offer's sygnatura to a Medusa variant
  SKU, sweeps promotion state in one paginated pass, creates category rate rows,
  and records conflicts instead of guessing.
- **A read-only pricing monitor** records each offer's price mode, attached rule
  and drift, and audits real rule transitions.
- **Price sync** attaches the rule the promotion state calls for and asserts
  `[break-even, SRP]` bounds, with a per-run change cap, per-offer quarantine, a
  circuit breaker, and write-scope detection.
- **Stock push** reconciles Medusa's available quantity into Allegro through the
  quantity-change command.
- **Order sync** drains `GET /order/events` into Medusa orders, with fulfillment
  write-back and an operator import window for gaps beyond the event retention
  period.
- **Invoice attach** puts an issued invoice PDF onto the Allegro order, driven by an
  event from `@zanreal/medusa-infakt` and retried by a bounded sweep. A soft
  dependency in one direction only - see [The invoice chain](#the-invoice-chain).
- Admin surfaces built around one rule - **per-product state on the product,
  everything else under Settings**. A product detail widget shows each variant
  SKU's linked offer, status, drift, promotion state and per-offer price sync
  opt-out (with a push-history drawer); a compact product-list banner rolls up
  linked / drifting / conflicting counts; the connection, writer toggles,
  category rates, the cross-catalogue offers table and the orders task-flow all
  live under **Settings -> Allegro**, with nothing Allegro-specific in the main
  ecommerce sidebar. See [Admin UI](#admin-ui).

**Nothing writes to Allegro until you arm it.** Every writer is governed by a
persisted, admin-flippable toggle that ships **off** on a fresh install, so a newly
connected store publishes nothing until an operator arms each writer under **Settings
-> Allegro** - no redeploy needed to arm or disarm, and the environment can still hard
force-disable any writer regardless. On top of that: price sync is inert without
`automationRules`, and a fresh install starts its order cursor at "now" rather than
importing history. See [Runtime toggles](#runtime-toggles) and
[Turning the writers on](#turning-the-writers-on).

## Install

```bash
npm install @zanreal/medusa-allegro
npx medusa plugin:add @zanreal/medusa-allegro   # local development only
```

Register it in `medusa-config.ts`:

```ts
import { defineConfig } from "@medusajs/framework/utils";

module.exports = defineConfig({
  plugins: [
    {
      resolve: "@zanreal/medusa-allegro",
      options: {
        clientId: process.env.ALLEGRO_CLIENT_ID,
        clientSecret: process.env.ALLEGRO_CLIENT_SECRET,
        environment: process.env.ALLEGRO_ENVIRONMENT ?? "production",

        // App identity. `appName` must match the app registered in the Allegro
        // Developer Portal; Allegro rejects requests whose User-Agent does not
        // identify a real app.
        appName: "MyStoreAllegro",
        appVersion: "1.0.0",
        docsUrl: "https://mystore.example.com/integrations/allegro",

        // openssl rand -base64 32
        encryptionKey: process.env.ALLEGRO_ENCRYPTION_KEY,
      },
    },
  ],
});
```

Then run the migrations:

```bash
npx medusa db:migrate
```

## Options

| Option                         | Type                        | Required | Default                                                                                | Notes                                                                                                                                                                                                                                                                                                 |
| ------------------------------ | --------------------------- | -------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clientId`                     | `string`                    | yes      | -                                                                                      | Allegro application client id.                                                                                                                                                                                                                                                                        |
| `clientSecret`                 | `string`                    | yes      | -                                                                                      | Allegro application client secret.                                                                                                                                                                                                                                                                    |
| `environment`                  | `"production" \| "sandbox"` | no       | `"production"`                                                                         | Sandbox talks to `api.allegro.pl.allegrosandbox.pl`.                                                                                                                                                                                                                                                  |
| `appName`                      | `string`                    | yes      | -                                                                                      | Must match the registered app name. No whitespace or HTTP separators.                                                                                                                                                                                                                                 |
| `appVersion`                   | `string`                    | yes      | -                                                                                      | Your integration version, e.g. `"1.0.0"`.                                                                                                                                                                                                                                                             |
| `docsUrl`                      | `string`                    | yes      | -                                                                                      | Public http(s) URL documenting or contacting the integration.                                                                                                                                                                                                                                         |
| `encryptionKey`                | `string`                    | yes      | -                                                                                      | Base64-encoded 32 bytes. Seals the stored tokens. Rotating it makes existing tokens unreadable: reconnect after a rotation.                                                                                                                                                                           |
| `redirectPath`                 | `string`                    | no       | `"/admin/allegro/oauth/callback"`                                                      | A rooted path on this backend, matching the redirect URI registered for the app character for character. `//host/...` is rejected: it is a protocol-relative URL, not a path.                                                                                                                         |
| `scopes`                       | `string`                    | no       | `"allegro:api:sale:offers:read allegro:api:sale:offers:write allegro:api:orders:read"` | Space-separated. Drop `:write` if you only ever want read access; the plugin then reports the missing write scope in the UI.                                                                                                                                                                          |
| `priceSyncDisabled`            | `boolean`                   | no       | `false`                                                                                | **Force-disable** override for price writes. It can only force the writer OFF - the live arming is the persisted [runtime toggle](#runtime-toggles). Must be a real boolean: a string throws at boot rather than failing open. Prefer `ALLEGRO_PRICE_SYNC_DISABLED` for the env-driven incident case. |
| `fulfillmentWritebackDisabled` | `boolean`                   | no       | `false`                                                                                | Force-disable override for the fulfillment write-back (the seller-status push on a Medusa fulfillment/shipment). NEW: this event-driven writer had no kill switch before. Live arming is its runtime toggle; env is `ALLEGRO_FULFILLMENT_WRITEBACK_DISABLED`.                                         |
| `invoiceAttachDisabled`        | `boolean`                   | no       | `false`                                                                                | Force-disable override for attaching invoice PDFs to Allegro orders. Its own switch, not a reading of `ordersSyncDisabled` - see [The invoice chain](#the-invoice-chain). Same boolean-only contract.                                                                                                 |
| `backendUrl`                   | `string`                    | no       | derived                                                                                | Absolute base URL of this backend. Set it when a proxy rewrites `Host`. Falls back to `MEDUSA_BACKEND_URL`, then the request.                                                                                                                                                                         |

### Sync options

| Option               | Type                                     | Required | Default          | Notes                                                                                                                                                                                                                                                                                                                                 |
| -------------------- | ---------------------------------------- | -------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pricingMode`        | `"monitor" \| "automation_rule" \| "fixed_price"` | no | `"automation_rule"` | How this store prices its Allegro offers - see [Pricing modes](#pricing-modes). This is the DEFAULT; the persisted admin choice wins over it. `"automation_rule"` is what this plugin did before the mode existed, so an upgrade changes nothing. |
| `automationRules`    | `{ promoted: string; standard: string }` | no       | -                | Names of two price-automation rules that must **already exist** on the Allegro account. Resolved by name every run; missing, renamed or ambiguous aborts the run with nothing written. **Omit it and price sync is inert.** Also editable and persisted from the admin - see [Sync configuration fields](#sync-configuration-fields). |
| `changeCap`          | `number`                                 | no       | `100`            | Price-automation commands per run. Positive integer; `0` is rejected - use a kill switch to stop writes, not a zero cap. Also editable and persisted from the admin.                                                                                                                                                                  |
| `stockSyncDisabled`  | `boolean`                                | no       | `false`          | Force-disable override for quantity writes. Can only force OFF; the live arming is the [runtime toggle](#runtime-toggles). Same boolean-only contract as `priceSyncDisabled`.                                                                                                                                                         |
| `ordersSyncDisabled` | `boolean`                                | no       | `false`          | Force-disable override for the order drain. Forced off, the journal is not consumed at all, so the cursor holds and nothing is skipped. Live arming is the runtime toggle.                                                                                                                                                            |
| `salesChannelId`     | `string`                                 | no       | -                | Scopes which products are sync-eligible. With neither this nor `salesChannelName`, the whole catalogue is eligible. Also editable and persisted from the admin - **wiring-critical**, see [Sync configuration fields](#sync-configuration-fields).                                                                                    |
| `salesChannelName`   | `string`                                 | no       | -                | Resolved by name at run time. A configured name that does not exist is an **error**, not a fallback to the whole catalogue. Also editable and persisted from the admin.                                                                                                                                                               |
| `stockLocationIds`   | `string[]`                               | no       | every location   | Locations whose available quantity is summed for the push. `ALLEGRO_STOCK_LOCATION_IDS` overrides it.                                                                                                                                                                                                                                 |
| `srpMetadataKey`     | `string`                                 | no       | -                | Reads the SRP (the price-range ceiling) from that key in the variant's `metadata`, falling back to the product's. Mutually exclusive with `srpPriceListId`. Also editable and persisted from the admin.                                                                                                                               |
| `srpPriceListId`     | `string`                                 | no       | -                | Reads the SRP from the variant's price in that price list. Also editable and persisted from the admin.                                                                                                                                                                                                                                |
| `costsModuleKey`     | `string`                                 | no       | `"productCosts"` | Container key of `@zanreal/medusa-product-costs`, resolved lazily and optionally. Without it, every offer is skipped with `missing-break-even`. There is never a default floor.                                                                                                                                                       |
| `invoiceModuleKey`   | `string`                                 | no       | `"infakt"`       | Container key of `@zanreal/medusa-infakt`, resolved lazily and optionally. Without it the invoice chain is inert. See [The invoice chain](#the-invoice-chain).                                                                                                                                                                        |
| `marketplaceId`      | `string`                                 | no       | `"allegro-pl"`   | Marketplace the rule assignment targets. Also editable and persisted from the admin - **wiring-critical**, see [Sync configuration fields](#sync-configuration-fields).                                                                                                                                                               |
| `regionId`           | `string`                                 | no       | derived          | Region Allegro orders are created in. Falls back to the first region matching the order currency, then the first region at all (with a warning).                                                                                                                                                                                      |

All options are validated in a module loader, so a misconfiguration fails at boot
with a specific message instead of surfacing as an opaque Allegro error later. The
validations worth knowing about, because each catches a mistake that would
otherwise present as a silently inert loop:

- A boolean-looking **string** on any kill switch throws. `priceSyncDisabled:
process.env.X` yields `"true"`, which a truthiness test honours and a `=== true`
  test ignores - the switch would read as enabled while you believed it was off.
- **One rule name used for both promotion states** throws. A promotion flip would
  then be a no-op switch, so the promoted commission rate would never reach the
  price floor, and price sync would look healthy while systematically
  under-flooring every promoted offer.
- **Both SRP sources set at once** throws. The ceiling is what stops an automation
  rule ratcheting a price down; two sources means an ambiguous ceiling.

### Environment variables

| Variable                                 | Effect                                                                                                                                                                                                                                          |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ALLEGRO_PRICE_SYNC_DISABLED`            | `1`, `true` or `yes` **force-disables** price writes, beating a persisted toggle that is armed. A hard override that can only force OFF - it never arms a writer. The env wins on purpose: an operator setting it is responding to an incident. |
| `ALLEGRO_STOCK_SYNC_DISABLED`            | The same, for quantity writes. **`ALLEGRO_PRICE_SYNC_DISABLED` alone does not stop all writes** - the quantity command is a separate writer.                                                                                                    |
| `ALLEGRO_ORDERS_SYNC_DISABLED`           | The same, for the order drain.                                                                                                                                                                                                                  |
| `ALLEGRO_FULFILLMENT_WRITEBACK_DISABLED` | The same, for the fulfillment write-back (the seller-status push on a Medusa fulfillment/shipment). NEW - this event-driven writer previously had no kill switch. See [Fulfillment write-back](#fulfillment-write-back).                        |
| `ALLEGRO_INVOICE_ATTACH_DISABLED`        | The same, for attaching invoice PDFs. A separate switch from the drain on purpose - see [The invoice chain](#the-invoice-chain).                                                                                                                |
| `ALLEGRO_OFFER_SYNC_CRON`                | Schedule for the hourly catalogue pass (discovery, monitor, price sync). Default `"15 * * * *"`.                                                                                                                                                |
| `ALLEGRO_STOCK_SYNC_CRON`                | Schedule for the quantity push. Default `"*/15 * * * *"`.                                                                                                                                                                                       |
| `ALLEGRO_ORDERS_SYNC_INTERVAL_MS`        | Interval, in ms, for the order drain. Default `20000` (20s). The drain schedules on an interval by default because Medusa's cron only resolves to the minute and a fresh order should be drained sub-minute.                                    |
| `ALLEGRO_ORDERS_SYNC_CRON`               | Switches the order drain back to a cron expression instead of an interval. The two are mutually exclusive in Medusa's scheduler; when both are set the cron wins.                                                                               |
| `ALLEGRO_STOCK_LOCATION_IDS`             | Comma-separated stock location ids, overriding `stockLocationIds`.                                                                                                                                                                              |
| `ALLEGRO_PRICING_MODE`                   | **Locks** the pricing mode, beating both the admin picker and `pricingMode`. Ignored (read as unset) unless it names a real mode. See [Pricing modes](#pricing-modes).                                                                            |
| `ALLEGRO_AUTOMATION_RULE_STANDARD`       | **Locks** the standard-offer automation rule name, beating both the admin field and `automationRules.standard`. See [Sync configuration fields](#sync-configuration-fields).                                                                    |
| `ALLEGRO_AUTOMATION_RULE_PROMOTED`       | The same, for the promoted-offer rule name.                                                                                                                                                                                                     |
| `ALLEGRO_SRP_METADATA_KEY`               | The same, for the SRP metadata key.                                                                                                                                                                                                             |
| `ALLEGRO_SRP_PRICE_LIST_ID`              | The same, for the SRP price list id.                                                                                                                                                                                                            |
| `ALLEGRO_CHANGE_CAP`                     | The same, for the per-run change cap. Ignored (read as unset) unless it is a positive integer.                                                                                                                                                  |
| `ALLEGRO_MARKETPLACE_ID`                 | The same, for the marketplace id. **Wiring-critical** - see [Sync configuration fields](#sync-configuration-fields).                                                                                                                            |
| `ALLEGRO_SALES_CHANNEL_ID`               | The same, for the sales-channel id. **Wiring-critical.**                                                                                                                                                                                        |
| `ALLEGRO_SALES_CHANNEL_NAME`             | The same, for the sales-channel name.                                                                                                                                                                                                           |
| `MEDUSA_BACKEND_URL`                     | Fallback for `backendUrl` when deriving the OAuth redirect URI.                                                                                                                                                                                 |

The schedules and force-disable overrides are env vars rather than plugin options
because Medusa evaluates a scheduled job's `schedule` at plugin-load time, before the
DI container - and therefore this plugin's `options` - exists. There is no way to read
a module's resolved options from that static export.

**The schedules start firing as soon as the plugin loads, but the writers are armed by
the persisted toggles, which ship off.** Installing or upgrading this plugin runs the
loops on their cadence, but every writer stays disarmed until you arm it under Settings
-> Allegro (or the environment force-disable, if set, keeps it off regardless). The
read paths are harmless (discovery and the monitor write nothing to Allegro). If you
are staging a cutover from another system and want belt-and-braces, set the
force-disable env vars BEFORE the version that reads them ships. See
[Runtime toggles](#runtime-toggles) and [Turning the writers on](#turning-the-writers-on).

## Pricing modes

**How this store prices its Allegro offers is a setting, not an assumption.** Pick one
of three modes under **Settings -> Allegro**; it takes effect on the next sync run,
with nothing to restart.

| Mode                                | What it writes to Allegro                                                                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `monitor` (Monitor only)            | Nothing at all. Every run still works out each linked offer's break-even floor and SRP ceiling and counts how many offers sit outside them.                  |
| `automation_rule` (Allegro automation rule) | One `POST /sale/offer-price-automation-commands` per offer: attach the named rule its promotion state calls for, with `[floor, ceiling]` as the rule's price range. Allegro's engine then picks the number inside that range. |
| `fixed_price` (Fixed price from Medusa)     | One `PUT /sale/offer-price-change-commands/{id}` per offer, setting the Buy Now price to the variant's own Medusa price - preceded by a rule-REMOVAL command when the offer still carries an automation rule. |

`automation_rule` is the default, because it is what this plugin did before the mode
existed. Upgrading changes nothing about what your store writes.

### The floor and the ceiling apply in every mode

The break-even floor (from `@zanreal/medusa-product-costs`, grossed for VAT and for the
category commission) and the SRP ceiling (from variant metadata or a price list) are the
safety story of this whole plugin, so no mode is allowed to skip them:

- `monitor` computes both and reports how many offers are priced outside them. That
  report is what you read **before** choosing a mode that writes.
- `automation_rule` sends them as the rule's price range, so Allegro's engine cannot
  move the price outside them.
- `fixed_price` checks the Medusa price against them and **refuses** to push a price
  below the floor or above the ceiling, counting it as `price-outside-bounds`.

A refusal is deliberate, and it is not a clamp. Clamping would sell at a price the store
never set; pushing would sell below cost. Refusing does neither, and it names the
variants whose Medusa price needs fixing.

### What fixed-price mode needs, and what it does about it

Two things are true and worth stating plainly before you switch a live store to it:

- **The scope is already there.** `PUT /sale/offer-price-change-commands/{commandId}`
  needs `allegro:api:sale:offers:write`, which is in this plugin's default scope string
  and is the same scope the rule assignment already uses. Moving to fixed-price mode
  needs no reconnect and no new consent.
- **An automation rule beats a fixed price, so the rule has to go first.** Allegro's
  engine recalculates an offer on its own schedule, so a price pushed under a live rule
  does not survive it. Fixed-price mode therefore issues
  `POST /sale/offer-price-automation-commands` with a `remove` modification for the
  offer's marketplace, waits for it to confirm, and only then sets the price. **If the
  removal does not confirm, the price is not sent at all** - a half-applied pair that
  left the rule attached and the price changed is precisely the fight with Allegro's
  engine the sequencing exists to avoid. Re-running the pair next tick is idempotent.

Both commands count as one offer against the per-run [change cap](#sync-options).

### Where the fixed price comes from

The variant's own default price in Medusa, in the offer's own currency. Two rules, both
fail-closed:

- **Price-list rows are ignored.** A price carrying a `price_list_id` is a sale or a
  customer-group override with its own validity window and conditions, none of which this
  plugin evaluates. Pushing one would leave a sale price on Allegro long after the sale
  ended.
- **There is no currency conversion.** A variant with no price in the offer's currency is
  skipped as `missing-medusa-price` rather than priced from a rate this plugin cannot
  audit.

### Auditing

Every mode writes to the same append-only `allegro_price_push` trail, but they fill
different columns, and the difference is load-bearing:

- automation-rule rows carry `bound_floor` / `bound_ceiling` and the rule ids. Those two
  columns are the **only** memory of the price range attached to a rule, because Allegro
  accepts a range and never returns one.
- fixed-price rows carry `price_amount` / `price_currency` and leave the bounds columns
  null, plus `rule_id_old` / `rule_name_old` for the rule that was removed. Writing the
  guard rails into the bounds columns would make a later automation-rule run read back a
  price range that was never attached, and skip an offer it should have re-attached.

### Monitor mode and the price-write toggle

Monitor mode runs even while the **Price writes** toggle is off, because it has no
command path to reach - exactly like the read-only price-automation monitor, which has
never had a kill switch. The two writing modes honour the toggle as they always have,
re-reading it before every single command. An explicit per-offer push from a product page
is refused in monitor mode rather than quietly performed.

## Runtime toggles

Every writer that reaches Allegro is governed by a **persisted, operator-flippable
toggle**, stored as a one-row `allegro_settings` singleton. This is the live arming an
operator controls from **Settings -> Allegro** - flip a switch and it takes effect on
the next tick or event, with no redeploy, because every runtime path resolves its
effective state from the persisted row at the top of each run rather than from a value
captured at boot.

The five governed writers:

| Toggle                 | Column                          | Fresh-install default | Env force-disable                        |
| ---------------------- | ------------------------------- | --------------------- | ---------------------------------------- |
| Price writes           | `price_sync_enabled`            | **off**               | `ALLEGRO_PRICE_SYNC_DISABLED`            |
| Quantity writes        | `stock_sync_enabled`            | **off**               | `ALLEGRO_STOCK_SYNC_DISABLED`            |
| Order drain            | `orders_sync_enabled`           | **off**               | `ALLEGRO_ORDERS_SYNC_DISABLED`           |
| Fulfillment write-back | `fulfillment_writeback_enabled` | **off**               | `ALLEGRO_FULFILLMENT_WRITEBACK_DISABLED` |
| Invoice attach         | `invoice_attach_enabled`        | **on** (inert)        | `ALLEGRO_INVOICE_ATTACH_DISABLED`        |

### Precedence

The environment (and the boot-time plugin option) is a **hard override that can only
force a writer OFF**. It never arms one. The effective state is:

```
effectiveEnabled = persistedEnabled && !forceDisabled
```

So:

- persisted **on** + env unset -> **on** (the writer runs)
- persisted **on** + env force-disable -> **off** (the override wins; an operator
  responding to an incident is not undone by a stale armed toggle)
- persisted **off** + env unset -> **off** (nothing arms a writer but the toggle)

The admin shows a switch that the environment forces off as **locked and "forced off by
environment"**, with the env var to clear - it never renders an armed-looking switch for
a writer the environment is holding down. A write to a forced-off toggle is still
accepted and stored, so the intent is preserved for when the override is lifted.

### Fresh-install defaults

Every **writer** ships **off**, so a freshly connected store publishes nothing to
Allegro until an operator arms each writer deliberately. **Invoice attach** is the one
exception - it ships **on but inert**: by the time an invoice event reaches this plugin
the document already exists as a legal record, so delivering it is the safe default, and
there is nothing to attach until an invoicing module (`@zanreal/medusa-infakt`) is wired
and emitting events.

The singleton row is created lazily under a fixed primary key on first read, with these
defaults. Upgrading an existing install runs the additive migration that creates the
table; the row appears the first time any runtime path or the admin reads it.

## Sync configuration fields

Nine settings - the [pricing mode](#pricing-modes), the two automation rule names, the
SRP source, the change cap, the marketplace id and the sales-channel scope - are
**editable from Settings -> Allegro**, on the same `allegro_settings` singleton the
runtime toggles use. An edit persists and takes effect on the next sync run, no
redeploy - the same property the toggles have. A store that never touches these admin
fields behaves exactly as before: every persisted column starts `null`, and `null`
falls through to the `medusa-config.ts` option.

| Field                              | Column                     | `medusa-config.ts` option  | Env lock                           |
| ---------------------------------- | -------------------------- | -------------------------- | ---------------------------------- |
| Pricing mode                       | `pricing_mode`             | `pricingMode`              | `ALLEGRO_PRICING_MODE`             |
| Automation rule (standard)         | `automation_rule_standard` | `automationRules.standard` | `ALLEGRO_AUTOMATION_RULE_STANDARD` |
| Automation rule (promoted)         | `automation_rule_promoted` | `automationRules.promoted` | `ALLEGRO_AUTOMATION_RULE_PROMOTED` |
| SRP source: metadata key           | `srp_metadata_key`         | `srpMetadataKey`           | `ALLEGRO_SRP_METADATA_KEY`         |
| SRP source: price list id          | `srp_price_list_id`        | `srpPriceListId`           | `ALLEGRO_SRP_PRICE_LIST_ID`        |
| Change cap                         | `change_cap`               | `changeCap`                | `ALLEGRO_CHANGE_CAP`               |
| Marketplace id (wiring-critical)   | `marketplace_id`           | `marketplaceId`            | `ALLEGRO_MARKETPLACE_ID`           |
| Sales channel id (wiring-critical) | `sales_channel_id`         | `salesChannelId`           | `ALLEGRO_SALES_CHANNEL_ID`         |
| Sales channel name                 | `sales_channel_name`       | `salesChannelName`         | `ALLEGRO_SALES_CHANNEL_NAME`       |

### Precedence

Adapted from the toggles' "the override can only force off" contract to a value
rather than a boolean - there is no "off" for a string or a number, so a set
environment lock wins outright:

```
effectiveValue = envLock ?? persistedValue ?? medusaConfigDefault
```

- an env lock, when set, is authoritative - it beats both a persisted admin edit AND
  the `medusa-config.ts` option, and the admin shows the field **locked**, the same
  treatment a forced-off toggle gets
- otherwise the persisted admin value governs, when one has been entered
- otherwise the `medusa-config.ts` option governs, exactly as it always did

Clearing a field in the admin (blank it and Save) writes `null`, which falls back to
the `medusa-config.ts` option rather than to an empty value - the same "clear"
contract the category-rates page already uses.

### Marketplace id and sales channel id are wiring-critical

Editing `marketplaceId` or `salesChannelId` **re-scopes which Medusa products this
plugin matches against Allegro offers**, not merely a tuning knob - a wrong value
breaks the mapping silently rather than producing an obviously bad result. Both stay
editable and persisted, with the same env-lock escape hatch as everything else: set
`ALLEGRO_MARKETPLACE_ID` or `ALLEGRO_SALES_CHANNEL_ID` to pin the correct value against
an admin mistake during a cutover. The admin renders an explicit warning on both
inputs saying so.

### Automation rule names and SRP source stay mutually consistent

Two invariants that already existed as **boot-time** checks in `resolveAllegroOptions` -
the standard and promoted rule names must differ, and at most one SRP source may be
set - are now also enforced on every **admin write**, because persisting a field
independently of the other can newly create a collision the boot-time check never saw
(one half configured, the other newly persisted to the same value). The write is
rejected with a `MedusaError` rather than silently accepted.

## OAuth setup

### 1. Register an application with Allegro

1. Sign in to [apps.developer.allegro.pl](https://apps.developer.allegro.pl) with
   the seller account you want to connect (use
   [apps.developer.allegro.pl.allegrosandbox.pl](https://apps.developer.allegro.pl.allegrosandbox.pl)
   for sandbox).
2. Create a new application. Choose the type that has **a web application with a
   redirect URI** - the plugin uses the authorization-code grant, not the device
   flow.
3. Name it something stable and machine-safe, with no spaces:
   `MyStoreAllegro`. This exact string goes into the `appName` option, because
   Allegro requires every request to carry a `User-Agent` that identifies the
   registered app one-to-one. The plugin composes
   `{appName}/{appVersion} (+{docsUrl})` and validates it at construction time,
   so a name with a space is rejected before any request is sent.
4. Set the redirect URI to your backend plus `redirectPath`:

   ```
   https://your-medusa-backend.example.com/admin/allegro/oauth/callback
   ```

   Allegro compares this byte for byte during the token exchange. A trailing
   slash difference is a failed connection.

5. Grant the app the scopes you configured: offer read, offer write, order read.
6. Copy the client id and secret into `ALLEGRO_CLIENT_ID` and
   `ALLEGRO_CLIENT_SECRET`.

### 2. Generate an encryption key

```bash
openssl rand -base64 32
```

Put it in `ALLEGRO_ENCRYPTION_KEY`. The plugin refuses to boot unless the value is
canonical base64 (standard or URL-safe) for exactly 32 bytes, rather than
silently accepting a weak one. The check is deliberately strict about the
encoding and not only the length, because `Buffer.from(value, "base64")` never
throws: it drops every character outside the alphabet, so a length test alone
accepts mangled input, and `"A".repeat(43)` decodes to a well-formed all-zero
key. Both are rejected.

The key also signs the OAuth `state` (see below), so rotating it invalidates any
connection flow that is mid-air as well as the stored tokens.

### 3. Connect from the admin

Open **Settings -> Allegro** in the Medusa Admin and click **Connect Allegro**.
You land on Allegro's consent screen, approve, and come back to the settings page
with the account login, granted scopes, and token expiry filled in.

The page distinguishes three unhealthy states from a working connection, because
each needs a different response: a missing refresh token (reconnect before the
access token expires), an unreadable token envelope (the `encryptionKey` no longer
opens what is stored - restore the old key or reconnect), and price sync disabled.
A row whose envelope will not open is reported as such rather than as a green
"Connected", which would send you looking at Allegro instead of at your own
configuration.

### How the flow is protected

- `GET /admin/allegro/oauth/start` mints a `state`, parks it in an httpOnly
  `SameSite=Lax` cookie with a 10-minute lifetime, and returns the authorization
  URL for the admin to navigate to. Over https the cookie carries the `__Host-`
  prefix, so a sibling subdomain cannot shadow it; over plain http it does not,
  because a `__Host-` cookie without `Secure` is dropped and local development
  would break.
- The `state` is not an opaque nonce. It is `v1.<issuedAt>.<nonce>.<mac>`, where
  the MAC is HMAC-SHA256 over the mint time, the nonce and the admin user's
  `actor_id`, keyed by `encryptionKey`. The admin id itself is not in the value,
  because the value travels through Allegro's authorize URL and into browser
  history and access logs.
- `GET /admin/allegro/oauth/callback` requires that `state` to match the cookie,
  compared in constant time, **and** to verify against the actor completing the
  flow. The cookie proves same-browser; the signature proves same-server, same
  admin, and minted within the last ten minutes. A state planted in someone
  else's browser fails the second check.
- The state cookie is cleared only once the authorization code has actually been
  handed to Allegro - which is when the state is spent, so it stays single-use.
  Branches that run before the state is verified (`?error=...`, a missing code, a
  state mismatch) deliberately leave it alone, so a lured GET to the callback
  cannot destroy a flow the operator legitimately started in another tab.
- Both routes live under `/admin`, which Medusa authenticates by default. The
  callback keeps that default: Allegro's redirect back is a top-level GET
  navigation and Medusa's admin session cookie is `SameSite=Lax`, so the session
  survives the hop. Making it public would also remove the `actor_id` the signed
  state is verified against, so every flow would fail instead.

If your deployment authenticates the admin with a bearer token in local storage
rather than a session cookie, the callback will 401, because the browser has no
cookie to send on that navigation. Serve the admin and the backend on the same
origin with session auth; do not make the callback public.

### Disconnecting

`POST /admin/allegro/disconnect` revokes the refresh and access tokens at Allegro
and then deletes the stored row. Revocation is best-effort - if Allegro is
unreachable the local connection is still removed, because refusing to disconnect
would leave an operator unable to remove access they asked to remove.

When revocation is skipped or fails, the response carries a `warning` and the
settings page shows it. That matters here more than in most places: the stored
rows are the only copy of the tokens, so after this call there is nothing left to
revoke with, and the refresh token stays valid at Allegro until it expires unless
you remove the application's access by hand in the developer panel.

## Admin UI

The information architecture answers two things at once: **you should not have
to open a separate table to see a product's Allegro state**, and **nothing
Allegro-specific belongs in the main ecommerce sidebar** - it is an
integration's configuration and operator tooling, not a merchandising surface,
so every non-per-product view lives under Settings.

- **Product detail widget** (`product.details.after`) - the authoritative
  per-product view. For every variant SKU it shows the linked offer (with a link
  to the live listing), a short status (linked / not linked / conflict), the
  observed price mode and drift, promotion state, the last price and stock sync
  times, and the per-offer **price sync opt-out** switch. The push history - the
  only record of the bounds ever sent - opens in a drawer. This is where an
  operator checks or opts a single product out, without touching the catalogue
  table.

  **It fetches its own variants, and must.** The dashboard loads the product for
  this zone with
  `PRODUCT_DETAIL_FIELDS = getLinkedFields("product", "*categories,*shipping_profile,-variants")`
  (`@medusajs/dashboard/src/routes/products/product-detail/constants.ts`). That
  `-variants` is an explicit exclusion - the page fetches the variant table
  separately with `useProductVariants` - so `data.variants` handed to a
  `product.details.*` widget is `undefined`. This widget derived its SKU list
  from `data.variants` and returned `null` when that list was empty, which meant
  it rendered nothing, on every product, on every store. It now calls
  `sdk.admin.product.listVariants(productId, { fields: "id,title,sku" })` itself
  and still prefers `data.variants` if a future dashboard version passes it.
- **Product list banner** (`product.list.before`) - a compact roll-up (N linked
  / N unlinked / N drifting / N conflicts) above the **stock** products table, each
  count linking into Settings -> Allegro offers filtered to those rows. **Medusa
  2.18 does not allow injecting a custom column into the core products data
  table**, and it exposes no list-row widget zone, so on that page a roll-up is
  the only thing a plugin can offer. It stays as the zero-dependency fallback for
  a store that has not installed admin-kit.
- **Catalog column** (`src/admin/widgets/register-variant-columns.tsx`) - an
  `Allegro` column registered into
  [`@zanreal/medusa-admin-kit`](https://github.com/zanreal-labs)'s Catalog route,
  which lists **one variant per row**. The cell names what is wrong with that one
  SKU: the conflict code (`duplicate-sku`, `no-offer`, ...) in red, `drift` in
  orange, Allegro's own offer status in green when it is listed and healthy,
  `unlinked` in grey, and a muted "not listed" when the SKU has no mapping at all.
  This is the real per-row status the banner could only approximate, and it does
  not cost this plugin a competing products list of its own.

  It used to read `"3 offers / 1 conflict"`, because an admin-kit row was a
  product and a product spans many SKUs - which told an operator that something
  was broken without telling them which SKU, the one thing they needed in order
  to act. Now a row is one variant with at most one offer. The registration moved
  from `registerProductColumn` to `registerVariantColumn` and the SKU roll-up in
  `src/admin/lib` is gone: `summarizeOfferStatus` / `formatOfferStatus` became
  `resolveVariantOffer` / `formatVariantOffer` / `variantOfferColor`.
- **Settings -> Allegro** - the configuration and control home: the OAuth
  connection, the **live writer toggles** (interactive switches backed by the
  persisted [runtime settings](#runtime-toggles) - arm or disarm each writer without
  a redeploy; a writer the environment forces off is shown locked), the **sync
  configuration fields** (editable inputs backed by the same singleton - see
  [Sync configuration fields](#sync-configuration-fields); a field an environment
  variable locks is shown locked, same treatment as a forced-off toggle), a
  catalogue roll-up, sync health, and links into the three nested Settings pages
  below.
- **Settings -> Allegro -> Offers** - the cross-catalogue offer table with
  conflict and drift filters, bulk rediscovery, and manual push. An operator
  triage surface for catalogue-wide "which offers are not syncing, and fix them"
  work - a genuine multi-item workflow the per-product widget cannot serve, and
  distinct from the browse case the admin-kit Catalog column covers.
- **Settings -> Allegro -> Orders** - the orders quarantine repair and import
  window. Operational task-flow, not a setting itself, but still nested here
  rather than in the main sidebar.
- **Settings -> Allegro -> Category rates** - the per-category sale commissions
  that set every price floor. Pure configuration, hand-maintained from Allegro's
  published fee table.

## The sygnatura / SKU mapping principle

**A Medusa variant and an Allegro offer are linked by SKU, and only by SKU.**

Allegro lets a seller put their own identifier on every offer, in the field the
API calls `external.id` and the seller panel calls **sygnatura**. This plugin's
contract is that you put the Medusa variant SKU there. Offer discovery then
matches `external.id` against variant SKUs, and `allegro_offer.sku` carries a
unique constraint because it is the identity of the row.

`allegro_offer.offer_id` is a **resolved cache**, never the identity. Allegro
offer ids are not stable across an item's life: re-listing an ended offer
produces a new id, and one SKU legitimately moves between offers over time. A
mapping keyed on the offer id turns every re-list into a silent orphan that stops
receiving stock and price updates while still looking healthy. A mapping keyed on
the SKU turns the same event into a row whose `offer_id` needs re-resolving,
which the next discovery pass does on its own.

Practical consequence: **fill in the sygnatura on every Allegro offer you want
managed.** An offer without one is invisible to this plugin by design. That is
the correct default - it means a seller can keep offers outside Medusa's control
simply by leaving the field empty.

## Data model

| Table                   | What it holds                                                                                                                                                        |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `allegro_auth`          | The OAuth connection. Both tokens AES-256-GCM encrypted, plus expiry, granted scope, and the account login.                                                          |
| `allegro_offer`         | SKU-to-offer mapping. `sku` unique, `offer_id` a resolved cache. Money as text, verbatim from Allegro.                                                               |
| `allegro_category_rate` | Sale commission per Allegro category, plain and promoted. Maintained by an operator - see below.                                                                     |
| `allegro_price_push`    | Append-only audit of every pricing decision: the rule and the pushed `[floor, ceiling]` in automation-rule mode, the exact `price_amount` / `price_currency` in fixed-price mode.                                        |
| `allegro_order`         | One row per Allegro checkout form: the Medusa order it produced, the raw and derived statuses, conflicts, and the attached invoice document.                         |
| `allegro_sync_state`    | Per-loop health: status, cursor, counters, last error, failure state, the write-scope flag, and the claim's fencing token plus its heartbeat.                        |
| `allegro_settings`      | The one-row singleton of persisted settings: the [pricing mode](#pricing-modes), the [sync configuration fields](#sync-configuration-fields), and the [runtime toggles](#runtime-toggles) - the live, operator-flippable arming of each writer. Writers default off, invoice-attach on. |

Three of these carry non-obvious constraints worth knowing before you build on
them.

**`allegro_price_push` is append-only, and it is the only record of pushed price
bounds.** Allegro's API accepts a `[min, max]` price range when you attach a
price-automation rule to an offer, and it will tell you afterwards _which rule_ is
attached - but it never returns the range. The bounds are write-only. So this
table is the only place that can answer "what floor is this offer pinned to, and
who set it". Never update or delete a row; correct a mistake by appending. Rows
with `result: "observed"` record state the plugin saw without touching, which is
what makes a read-only monitoring pass worth running.

**`allegro_category_rate` is filled in by hand, on purpose.** Allegro does publish
a fee calculator (`POST /pricing/offer-fee-preview`, wrapped by the SDK as
`offerFeePreview`), but in production it rejects the offer bodies you can build
from a seller's own live offers, so sweeping a real catalogue returns errors
rather than rates. Until that changes, an operator enters rates from the published
fee table. Both rate columns are nullable so "unknown" stays distinguishable from
"zero commission": a margin calculation that reads a missing rate as 0% quietly
turns a loss-making price into an acceptable one.

**`allegro_order` is separate from the Medusa order on purpose.** A checkout form
can exist without an order (creation failed, so the form stays visible with its
error rather than vanishing), Allegro's status ladder is richer than Medusa's enum,
and `derived_status` has to be the comparison basis for "did Allegro move?" - see
[Status mapping](#status-mapping). Its two invoice columns follow the same
write-last discipline: `allegro_invoice_id` is stamped when the document is registered
and `invoice_attached_at` only once Allegro has the file, so a row reading attached
carries a PDF the buyer can download - see [The invoice chain](#the-invoice-chain).

## The sync architecture

Five loops, each with its own row in `allegro_sync_state`, its own single-flight
claim, and - for the ones that write - its own kill switch. They are independently
observable and independently runnable from the admin.

Two things write to Allegro outside the loops, both on a Medusa event: the fulfillment
write-back and the invoice attach. Neither is a loop because neither has reconcilable
state to compare - see [Fulfillment write-back](#fulfillment-write-back) and
[The invoice chain](#the-invoice-chain).

| Loop            | Provider           | Schedule                                | Writes to Allegro?                   |
| --------------- | ------------------ | --------------------------------------- | ------------------------------------ |
| Offer discovery | `offers`           | `ALLEGRO_OFFER_SYNC_CRON`, `15 * * * *` | No                                   |
| Pricing monitor | `price-automation` | chained after discovery                 | No                                   |
| Price sync      | `prices`           | chained after the monitor               | Yes - price-automation command       |
| Stock push      | `stock`            | `ALLEGRO_STOCK_SYNC_CRON`, `*/15 * * *` | Yes - quantity-change command        |
| Order drain     | `orders`           | `ALLEGRO_ORDERS_SYNC_CRON`, `* * * * *` | Only fulfillment status, on an event |

The first three are chained into one job rather than scheduled separately because
they all need the same input - a complete listing of the seller's offers - and
paging a full catalogue three times an hour is how a well-behaved integration earns
a rate limit. The order matters: discovery establishes which offer owns which SKU
and which mappings are conflicted, and price sync refuses to write to anything
conflicted, so running price sync against a stale mapping is exactly the case where
a command lands on the wrong offer.

Stock has its own cadence because stock moves on every order and an hour-stale
marketplace quantity is how a sold-out item stays purchasable. Orders runs per
minute because an unapplied `BOUGHT` event is an order nobody has been told about.

### Reconciliation first, events almost never

Every loop except fulfillment write-back is a **reconciliation**: it reads the whole
relevant state on each run and computes the difference. None of them depends on a
Medusa event firing.

That is deliberate. Medusa's inventory events are not a reliable trigger
([medusa#11691](https://github.com/medusajs/medusa/issues/11691)), and a design that
depended on them would leave a permanently wrong marketplace quantity behind every
missed event. With reconciliation, a missed event costs at most one cycle of
staleness.

The one exception is fulfillment write-back, and it is an exception for a structural
reason rather than a convenient one: a fulfillment is a point-in-time act, not
reconcilable state. There is no "current fulfillment status" in Medusa for a sweep
to compare against Allegro's, so the event is the only signal there is.

### Medusa inventory is the source of truth for stock

The quantity pushed to Allegro is `retrieveAvailableQuantity` - stocked minus
reserved, so units already promised to unfulfilled Medusa orders are not advertised
again.

**Keeping Medusa inventory honest is explicitly not this plugin's job.** In this
stack that belongs to [`@zanreal/medusa-marken`](https://github.com/zanreal-labs/medusa-marken),
which owns the supplier snapshot and the `stockArmed` gate that refuses to propagate
an untrustworthy one into Medusa inventory. That guard lives one layer up, where the
supplier response is actually visible; a second one here would be a guess about data
this plugin has no source for.

What this loop does refuse on is its own uncertainty, and the line is drawn at UNKNOWNS
rather than at gaps. An ambiguous SKU match, or a quantity that could not be READ on
either side, refuses the **whole plan**: a partial push in that state leaves some offers
fresh and others stale with nothing recording which is which, so the next run cannot tell
either.

A KNOWN, bounded exclusion does not refuse anything. Each is counted, reported in
`last_error`, and leaves exactly one offer alone: an inactive offer, a variant that does
not manage inventory (so Medusa has no quantity to publish - a digital product, say), an
offer that contradicts its mapping row, a mapped offer absent from the listing, an offer
whose own Allegro listing carried no usable `stock.available`, and an eligible variant no
mapped offer claims. Treating "this variant has no inventory" as an
unknown is what previously let a single digital product with an Allegro offer refuse the
entire catalogue's stock sync indefinitely.

**A configured `stockLocationIds` is validated against the locations that exist**, and an
unknown id aborts the run. Medusa reports zero available quantity for a location that does
not exist rather than failing, so a single typo produced the same catastrophe as the empty
case below: every variant reads 0, the plan looks safe, and the whole catalogue is delisted
by a run that reports itself clean.

**A store with no stock locations aborts the run.** Medusa's `retrieveAvailableQuantity`
answers `0` for an empty location list rather than failing, so every variant would read
as out of stock, the plan would look perfectly safe, and the run would push a quantity of
0 across the whole catalogue and report itself complete - a full marketplace delisting
presented as a healthy sync. Create a stock location, or set `stockLocationIds`.

**The offer listing is read before quantities.** Paging a full catalogue is the slowest
step in the run, so reading quantities first left every figure ageing across the whole
pagination window before it was compared and written.

### Conflicts are recorded, never resolved

Five mapping conflicts are recorded on `allegro_offer.conflict`, and a conflicted row is
stripped of its `offer_id` and its `promoted` flag so no write path can act on it:

| Conflict              | Meaning                                                     | What to do                                                               |
| --------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------ |
| `duplicate-sku`       | Two live offers claim one SKU, or two variants share one    | Decide which one keeps it. The message names the competing ids.          |
| `missing-external-id` | A previously mapped offer no longer carries a sygnatura     | Set the sygnatura back on Allegro.                                       |
| `no-variant`          | A sygnatura matches no variant in the Allegro sales channel | Fix the sygnatura, or publish the product to the channel.                |
| `no-offer`            | A stored mapping's offer is gone from the listing           | Usually nothing: the link was cleared and discovery re-links on re-list. |
| `sku-mismatch`        | The LIVE offer contradicts its mapping row                  | Fix the sygnatura on Allegro, or let discovery re-map it.                |

`duplicate-sku` covers one case worth naming explicitly: two offers can reach the same
variant by DIFFERENT keys - one by sygnatura, another by an EAN matching that variant's
barcode - so neither looks contested on its own. Both are held out.

`sku-mismatch` is recorded by the stock loop rather than by discovery, because the stock
push is the only place the mapping row and the live offer are compared at write time. A
seller who edits a sygnatura between discovery and the push makes the two disagree, and
re-pairing on the live value is how one product's quantity lands on another product's
listing. Only that offer is skipped; the rest of the catalogue still syncs.

Picking a winner for a contested SKU would push a price or a quantity to the wrong
offer, which is a real mispricing or a real oversell. So the plugin refuses, and the
Offers admin page has a conflicts filter for exactly this.

### The empty-response guard

Discovery unlinks a stored mapping whose offer is no longer in the listing. That is
only sound when the listing is trustworthy, so unlinking requires a listing that is
both **non-empty** and **verified complete** against Allegro's own `totalCount`. A
transient failure yielding zero offers would otherwise clear every mapping the store
has, leaving the next run nothing to rebuild from.

The listing itself is fail-closed for the same reason: a short page is an error
rather than a smaller array, because every consumer draws a conclusion from an
offer's absence.

### Price sync: the bounds

Bounds are `[ceil(break-even), SRP]`, and they apply in every
[pricing mode](#pricing-modes) - as the rule's price range in `automation_rule`, as the
range a pushed price has to sit inside in `fixed_price`, and as the report in `monitor`.

- **The floor** is `grossCost / (1 - commissionRate)`, the smallest gross price at
  which net income reaches zero. `grossCost` comes from
  `@zanreal/medusa-product-costs` (a **soft** dependency, resolved lazily), and the
  commission rate from `allegro_category_rate` selected by the offer's category
  **and its promotion state**. Ceiled to a whole unit, because the managed rules
  require it.
- **The ceiling** is the SRP, from `srpMetadataKey` or `srpPriceListId`. A price-list SRP
  is matched to the offer's **own currency**, and there is deliberately no conversion: a
  converted ceiling would depend on a rate this plugin does not have and cannot audit, so
  an offer whose currency has no SRP row is skipped with `missing-srp`. A number in
  variant metadata carries no currency and is taken as being in the offer's currency,
  which is what putting a bare number there means.

**Any missing input skips the offer with a counted reason. Neither bound is ever
defaulted.** A defaulted floor is a licence to sell at a loss; a ceiling guessed
from the current selling price lets a rule ratchet the price down on every run,
since each run's price becomes the next run's ceiling. The skip reasons, in the
order the ladder reports them:

`not-linked`, `sync-disabled`, `status-unknown`, `offer-not-active`,
`promotion-unresolved`, `missing-break-even`, `missing-srp`, `invalid-bounds`.

Fixed-price mode adds two of its own, for the two ways a Medusa price can fail to be a
usable Allegro price: `missing-medusa-price` (the variant has no price in the offer's
currency) and `price-outside-bounds` (it has one, and it is below the floor or above the
ceiling, so it is refused rather than clamped).

`promotion-unresolved` is worth understanding, because it is the one an operator is most
likely to meet on a fresh install. `allegro_offer.promoted` is **three-state**: `true`,
`false`, or NULL meaning "the promo-options sweep has not resolved it". NULL is not "not
promoted", and the difference is money: promotion state selects the commission rate, the
rate sets the break-even, and the break-even is the floor a rule may sell down to - so
pricing an unresolved offer as unpromoted gives a genuinely promoted one a floor below
its true break-even. Discovery fills it in from a successful sweep; until then the offer
is skipped and the Offers page shows `unresolved`. The promo sweep returns nothing
resolvable when it hits its page cap, when Allegro answers "Feature unavailable", or on a
non-systemic error, and each of those is reported on the offers state row.

The monitor withholds its drift verdict for the same offers, and counts them as
`promotionUnresolved`: without a resolved promotion state there is no expectation to
compare the attached rule against, so reporting "no drift" would be a guess.

The order IS the reported reason, deliberately: an unlinked SKU reports
`not-linked` even when it is also missing an SRP, and the per-offer opt-out
short-circuits before any data check so a disabled offer never surfaces a spurious
"missing break-even" for somebody to chase.

Two subtleties worth knowing. A promoted offer whose category has a standard rate
filled in but a **blank promoted rate** is skipped - flooring it on the standard
rate would under-floor it. And `status-unknown` is its own reason rather than a
pass-through: a write is only safe against an offer positively observed as ACTIVE.

### Price sync: bounds memory

Allegro accepts a `[min, max]` range when you attach a rule and returns it nowhere.
It is write-only. So `allegro_price_push` is the only bounds memory there is, and the
scan that reads it has two rules:

- Rows newest-first, **first success per offer wins**. A newer success that carries
  no bounds deliberately claims the slot, so it reads as "no bounds on record" and
  triggers a re-push rather than letting an older row's stale range look current.
- Only `result: "success"` counts. An `observed` row is the monitor recording state
  it did not write; a `failed` row's bounds never landed.

An offer with no recorded bounds is re-pushed, which is idempotent.

### Price sync: the safety machinery

- **Fail-loud rule resolution.** Both rule names are resolved against the live rules
  list every run. Missing, renamed or ambiguous aborts the whole run with nothing
  written. The plugin never guesses which rule you meant and never creates one.
- **Change cap** (`changeCap`, default 100). A bug that mislabels the whole catalogue
  as drifting can reprice at most that many offers before a human sees the run and
  can flip the switch. The remainder waits for the next tick.
- **Per-offer quarantine** after 5 consecutive failures, so one permanently bad offer
  cannot burn the run's budget every tick. Never silent: named in `last_error` and in
  the admin, with a manual push as the remedy.
- **Circuit breaker.** A tick where every command failed, or where any command hit
  429 / 5xx / an auth error / a 403, is SYSTEMIC: nothing is quarantined, the run
  holds, the next tick retries. Quarantine is only safe on the evidence that the rest
  of the pipeline works - without that gate, a five-minute outage would quarantine
  the whole working set at once. Stuck-and-self-healing beats skipped.
- **Write-scope detection.** A 403 on a command is the signature of a token granted
  without `allegro:api:sale:offers:write`. It is one systemic condition, not a
  hundred bad offers, so it sets `write_scope_missing`, raises a persistent admin
  banner, and no-ops safely. The first run that reaches the endpoint without a 403
  clears it.
- **Single-flight claim** on the provider row, so a scheduled run and an operator's
  manual push cannot interleave on the same offer. A `running` claim older than six
  minutes is taken over as crashed, so one killed process cannot wedge the loop.

### Orders: the event journal drain

`GET /order/events` is the only scheduled input. Polling
`checkout-forms?updatedAt.gte=` cannot replace it: Allegro does not reliably bump a
form's `updatedAt` when only its fulfillment status changed, so a window sweep cannot
see the most common status change there is.

**Cursor discipline.** Events are consumed in order and the cursor advances only over
the leading run of events whose order landed. The first event belonging to a failed
or deferred order stops the advance, so it and everything after it replay next tick.
Applying an order twice is harmless - the upsert is idempotent - and no status change
can be lost to a transient failure.

Three failure modes a single-input sync has to answer for, and how:

- **One bad order must not wedge the tick.** After 5 consecutive failures the form is
  quarantined and the cursor is allowed past it. Without that escape, one permanently
  broken order pins the cursor forever and eventually no order imports at all.
- **An outage must not be mistaken for a hundred bad orders.** A tick where every
  refresh failed and none succeeded is systemic: no streak grows, nothing is
  quarantined, the cursor holds.
- **A backlog must not starve new orders.** The per-run cap is spent oldest-first,
  because that is the only order in which the backlog shrinks - but 20 of the 100 are
  reserved for the newest candidates, applied out of cursor order. Pure newest-first
  was rejected because it deadlocks: deferring the oldest blocks the cursor at the
  first event, so the same page replays forever.

**Bootstrap.** With no cursor, the newest event id is recorded and nothing is
consumed. Replaying the 60 days Allegro retains would be thousands of calls, so a
fresh install starts tracking from "now" and importing history is an operator action -
the import window below.

### Status mapping

Allegro reports a checkout status and a seller-managed fulfillment status. Their
product is the ladder on `allegro_order.derived_status`:

| Allegro                                    | Derived              |
| ------------------------------------------ | -------------------- |
| checkout `CANCELLED` (wins over anything)  | `cancelled`          |
| fulfillment `NEW` + checkout `BOUGHT`      | `pending`            |
| fulfillment `NEW` + `READY_FOR_PROCESSING` | `new`                |
| `PROCESSING`, `SUSPENDED`                  | `processing`         |
| `READY_FOR_SHIPMENT`, `READY_FOR_PICKUP`   | `ready_for_shipment` |
| `SENT`                                     | `sent`               |
| `PICKED_UP`                                | `delivered`          |
| `RETURNED`                                 | `returned`           |
| an unmodelled fulfillment status           | nothing is written   |

Medusa's `order.status` enum has no `sent` or `ready_for_shipment`, so only the two
ends Medusa genuinely models are pushed onto the order, through their own workflows:
`cancelled` cancels it, `delivered` completes it. Writing the column directly would
fight the dashboard and the order-edit flows.

**`derived_status` is the comparison basis, not the raw status columns.** The raw
columns are rewritten on every pass, so re-deriving from them made a single
suppressed status write permanent - the guard saw "no transition" forever after and
the order froze at whatever status it happened to carry. `derived_status` is written
in the same operation as any action, so a lost write simply retries, and a staff edit
survives because staff change the order and leave the derived status where Allegro
put it.

**Crash-safe ordering.** The bookkeeping row goes in first without `synced_at`, then
the Medusa order, then the status action, then the watermark LAST. A crash anywhere
earlier leaves the row unfinished so the next pass repairs it.

**Unmatched lines do not lose the sale.** A line whose sygnatura matches no Medusa
variant is carried as a title-only custom item and recorded in `line_conflicts`. The
sale happened on Allegro whatever Medusa's catalogue says, and an order nobody can see
is not safer than one that is visibly half-mapped. Totals and line prices come from
Allegro verbatim, never recomputed.

### Fulfillment write-back

A subscriber on `order.fulfillment_created` and `shipment.created` sets Allegro's
seller-managed status - `READY_FOR_SHIPMENT` and `SENT` respectively - for
Allegro-sourced orders. It is a no-op for any other order.

It **never throws**. The Medusa fulfillment already exists by the time it runs, so
failing the subscriber would not undo it and would bury the reason; the error is
recorded on `allegro_order.last_error` instead, and an operator can set the status by
hand on Allegro.

`ordersSyncDisabled` deliberately does not gate it. That switch stops the drain from
CONSUMING the journal, and pausing an import is a different decision from refusing to
tell the buyer a shipment happened. The write-back has its **own** runtime toggle
instead - `fulfillment_writeback_enabled`, force-disable env
`ALLEGRO_FULFILLMENT_WRITEBACK_DISABLED` - so this single write can be stopped live
while order import keeps running, and vice versa.

This closes what used to be a real gap: before, this event-driven write had no kill
switch at all, so the only way to stop it was to disconnect the account (which stopped
every write, import included). Now, if the mapping is suspect and you are worried about
marking the wrong Allegro order as shipped, disarm the fulfillment write-back toggle
under Settings -> Allegro, fix the mapping, and re-arm it - no reconnect, and order
import is unaffected. Like every writer it ships **off** on a fresh install, so it
never reaches the marketplace until you arm it. The toggle is resolved at the top of
each fulfillment event, so a flip takes effect immediately.

### The invoice chain

Allegro expects the invoice for an order to be downloadable from the order view. This
plugin does not issue invoices - `@zanreal/medusa-infakt` does - so the chain is:

```
order paid -> medusa-infakt issues the invoice (+ KSeF for a B2B sale)
           -> emits `infakt.invoice.issued`
           -> medusa-allegro registers the document on the checkout form
           -> uploads the PDF
           -> stamps `allegro_order.invoice_attached_at`
```

**Neither plugin imports the other.** The whole contract is an event name, its payload,
and a container key (`invoiceModuleKey`, default `"infakt"`) that this plugin resolves
lazily. A store can invoice without selling on Allegro and sell on Allegro without
invoicing, so a hard dependency either way would make each plugin unusable without the
other. With no invoicing module registered the chain is simply inert: nothing is logged,
nothing is retried, and every other loop behaves identically.

The event payload is read defensively, because it crosses a version boundary:
`order_id` and `invoice_uuid` are required, everything else is optional, unknown fields
are ignored, and a malformed payload is **logged and dropped rather than thrown**. A
throwing subscriber would be retried with the same malformed payload until its budget
ran out, and the reason would never reach anybody.

Only the PDF fetch and one listing read touch the invoicing module, both through its
public surface (`apiClient.getInvoicePdf`, `listInfaktInvoices`). Fetching the PDF flips
the invoice to `printed` on the inFakt side - that is inFakt recording that the document
left the system, not a mistake - which is why this plugin resolves the Allegro client
_before_ fetching: paying that side effect for an upload that cannot happen buys nothing.

#### Why the dedupe read is not optional

`POST /order/checkout-forms/{id}/invoices` **has no idempotency key.** A second call with
the same invoice number registers a second document rather than returning the first, and
Allegro accepts at most ten documents per order. Two things therefore happen before any
create:

1. If `allegro_order.allegro_invoice_id` is set, that document is reused outright.
2. Otherwise `GET .../invoices` is read and matched on invoice number. A match is reused.

The id is persisted the instant a create returns, **before** the upload is attempted. That
write is the whole reason the column exists: a crash between a successful create and the
upload would otherwise register a second document for the same invoice on the retry. This
guard is carried over unchanged from the pipeline this plugin replaces, where it was the
fix for exactly that failure in production.

The size check also happens before anything is registered. Allegro rejects a file over
3 MB, and a registered document with no file still counts against the ten - so registering
first (as the old pipeline did) could eventually leave an order unable to accept the
invoice that _would_ fit. An oversized or empty PDF is recorded on the row and never
uploaded.

#### The retry sweep

The event is not the only path. At the end of every orders drain - inside the same
single-flight claim, because it writes to the same rows - a bounded sweep asks the
invoicing module for its most recently touched invoices (50) and attaches any whose
Allegro order has no `invoice_attached_at`, up to 10 per tick. It covers both halves of a
failed attach: the one that registered nothing, and the one that registered but never
uploaded.

Candidates come from the invoicing module rather than from a marker of this plugin's own,
and that is deliberate. Attach failures are recorded in `allegro_order.last_error`, which
is shared with the drain and cleared on its next clean pass of the same form - so a sweep
keyed off that string would silently lose exactly the orders that are otherwise healthy.
Comparing "what has been issued" against `invoice_attached_at` cannot be invalidated that
way.

Two limitations, stated rather than left to be discovered:

- **The sweep only runs when the drain runs.** `ordersSyncDisabled` therefore pauses the
  retry as well. The event path is unaffected, so a newly issued invoice still lands.
- **An attach failure can be overwritten in `last_error`** by a later healthy drain pass of
  the same form. The sweep is unaffected (above), but the admin may stop showing the
  reason; the run's own error line on the orders state row names the count.

#### Its own kill switch

Invoice attach has its own [runtime toggle](#runtime-toggles),
`invoice_attach_enabled` (force-disable env `ALLEGRO_INVOICE_ATTACH_DISABLED`), and it
is the one writer that ships **on** - because by the time this plugin hears about an
invoice it already exists as a legal document, so delivering it is the safe default. It
is on-but-inert until an invoicing module is emitting events, so nothing is attached
prematurely. It is deliberately not a reading of `ordersSyncDisabled`: that switch stops
the drain from consuming the journal, and an operator reaches for it to halt a runaway
import. Delivering an invoice the marketplace order needs is a different decision with
different consequences, and one switch covering both would mean pausing an import
silently stops issued invoices reaching buyers.

When the writer is disarmed, the reason is recorded on the order row rather than only
logged: "the invoice is not on the order" looks identical to a broken integration from
outside, and a disarmed writer is the one explanation nobody guesses.

## Turning the writers on

Every writer ships **disarmed**, so the loops run read-only until you arm each writer
under Settings -> Allegro. The safe order, and why each step comes where it does:

1. **Connect** the account with the write scope in `scopes` (the default includes
   it). Without it, every command answers 403 and the admin raises the reconnect
   banner.
2. **Leave the writers disarmed** while you prepare - which is the fresh-install
   default, so there is nothing to do here unless you upgraded with writers already
   armed. If you are cutting over from another system that currently writes to Allegro
   and want belt-and-braces beyond the off default, set the force-disable env vars
   (`ALLEGRO_PRICE_SYNC_DISABLED`, `ALLEGRO_STOCK_SYNC_DISABLED`,
   `ALLEGRO_INVOICE_ATTACH_DISABLED`, `ALLEGRO_FULFILLMENT_WRITEBACK_DISABLED`) so no
   toggle flip can arm a writer until the old system is retired. Two systems writing to
   one catalogue is the worst possible state, and each writer is separate - price,
   quantity, invoice and fulfillment each have their own switch.
3. **Let discovery and the monitor run.** Both are read-only. Watch the Offers page:
   resolve every conflict, and look at what `price_mode` and drift actually say about
   the catalogue. This is the step that turns arming the writers into a decision
   rather than a leap.
4. **Fill in the category rates.** Until a category has both rates, every offer in it
   is skipped with `missing-break-even`.
5. **Configure the SRP source**, and check that variants actually carry a value.
   Without it every offer is skipped with `missing-srp`.
6. **Create the two price-automation rules** on the Allegro account and set
   `automationRules` to their names. Until then price sync is inert by construction.
7. **Arm the writers under Settings -> Allegro - stock first, then prices.** A wrong
   quantity is recoverable in one run; a wrong price may already have sold something.
   Start with a low `changeCap` and watch the push history in the Offers drawer. Arm
   the order drain, fulfillment write-back and invoice attach when you are ready for
   each; every toggle takes effect on the next run, no redeploy.

## Operator runbook

### A conflicted mapping

Offers page, "Conflicts only" filter. Each row names what is wrong and what to do
(see the conflict table above). Nothing about that SKU is synced until it is
resolved - deliberately. After fixing it on Allegro or in Medusa, press "Rediscover
offers"; you do not need to clear the conflict by hand.

### A quarantined offer

Symptom: `last_error` on the `prices` row names offer ids, and the loop is no longer
retrying them.

Fix the underlying cause, then press **Push** on that offer in the Offers table. A
successful push clears the offer from both failure maps, so the loop resumes
correcting it from the next tick. The push also overrides the per-offer opt-out - the
operator asked for that specific offer - but not the kill switch or the eligibility
checks.

### A quarantined order

Symptom: the Orders page quarantine list, and `last_error` on the `orders` row.

Each entry carries its error and how long it has been failing. Fix the cause, then
press **Repair**. A success clears both failure maps and hands the form back to the
drain. A failed repair does NOT grow the streak, so retrying while you work on it
cannot make things worse.

If the order is older than Allegro's event retention (roughly 60 days), Repair still
works - it fetches the form directly rather than through the journal.

### A disputed order total

The drain compares every order's Medusa total against the `totalToPay` Allegro recorded
for the form, to the grosz and in the same currency. A disagreement is recorded on
`allegro_order.conflict` as `total-mismatch`, with both figures in `conflict_detail`, and
the Orders admin page shows it beside the total. `totalMismatch=1` filters the list to
them, and `totalMismatchCount` on the response is the table-wide count.

**It never blocks or rolls back the order.** The sale happened on Allegro whatever
Medusa's arithmetic says, and an order nobody can see is not a safer outcome than one that
is visibly disputed. The conflict clears itself on the next pass once the totals agree, so
there is no action to take beyond fixing the cause.

The usual benign cause is a line whose sygnatura matched no Medusa variant: it is carried
as a title-only custom item, which can legitimately move the total. The detail says how
many custom lines the order has for exactly that reason - check that count before
investigating arithmetic.

### The manual push budget

`POST /admin/allegro/offers/:sku/push` shares the scheduled loop's blast radius. Manual
pushes are counted over a rolling hour, and once that count reaches `changeCap` further
pushes are refused with HTTP **429** and a `Retry-After` of one hour.

This exists for scripts rather than for people. Each call takes the sync claim, so calls
serialise - but serialising is not bounding, and a loop over this route would otherwise
reprice the entire catalogue, walking straight around the `changeCap` that exists to stop
a bad plan doing that before a human sees it. The count comes from `pushed_by` on the
audit table, so the plugin's own loops never consume an operator's budget and the cap
survives a restart.

If you legitimately need to push more than that in an hour, raise `changeCap` - which
raises it for the scheduled loop too, deliberately, because that is the same decision.

### The write-scope banner

Symptom: a persistent error banner on the settings page, and `write_scope_missing` on
a provider row.

Allegro answered 403 on a price or quantity command. No retry fixes it: the stored
grant does not include `allegro:api:sale:offers:write`. Press **Reconnect** and
approve the consent screen again. The first run afterwards that reaches the endpoint
without a 403 clears the flag on its own.

### Importing orders the journal never named

Orders page, **Import window**. Needed when the drain was disabled longer than the
event retention window, after restoring a database, if the cursor was lost, or to
bring in history on a new install (the drain starts at "now" by design).

It never moves the event cursor - an import fills a gap behind it - and it holds the
orders claim while it runs, so the per-minute drain cannot import anything new in the
meantime. One run covers at most 3,000 orders; for a larger backfill, run several
windows with a moving `since`.

### Stopping the writers, now

Set the relevant env var to `1` and restart, or redeploy the process environment:

```bash
ALLEGRO_PRICE_SYNC_DISABLED=1      # price-automation commands
ALLEGRO_STOCK_SYNC_DISABLED=1      # quantity-change commands
ALLEGRO_ORDERS_SYNC_DISABLED=1     # the order drain
ALLEGRO_INVOICE_ATTACH_DISABLED=1  # attaching invoice PDFs to orders
```

The env var wins over the plugin option on purpose: an operator reaching for it is
responding to an incident, and a stale `false` in config must not undo that. A
disabled loop RECORDS that it was disabled on its state row, so "disabled" stays
distinguishable from "broken" - both look like "nothing happened" from outside.

**The env var can only ever disable, never enable.** The resolution is
`option === true || envIsTruthy`, so `ALLEGRO_PRICE_SYNC_DISABLED=0` does not re-arm
a loop whose option is `true`. What re-arming takes therefore depends on how your
config was written, and it is worth settling before you need it under pressure:

```ts
// Pattern A - option pinned. Re-arming means editing config and redeploying.
priceSyncDisabled: true,

// Pattern B - option derived from the same variable. Re-arming is one env change,
// and the incident switch still wins, because =1 also yields option true:
//   unset -> true (disabled)    =1 -> true (disabled)    =0 -> false (armed)
priceSyncDisabled: process.env.ALLEGRO_PRICE_SYNC_DISABLED !== "0",
```

Pattern B is the better default for a staged cutover: one variable is both the
pre-cutover hold and the arming switch, so no config edit stands between an operator
and a working sync. Pattern A is right when you want arming to require a code review.
Pattern B must compare against `"0"` explicitly rather than coercing -
`Boolean(process.env.X)` is `true` for the string `"0"`, which would pin it disabled
forever.

Note that `ordersSyncDisabled` does not stop the fulfillment write-back subscriber, and
does not stop the invoice attach either - that has its own switch. It DOES stop the
invoice retry sweep, which runs at the end of the drain. To stop every write to Allegro,
disconnect the account.

### A loop that looks stuck

Check the state row's `status` on the settings page:

- **`running` and not moving.** A crashed run holds the claim for up to six minutes,
  after which the next tick takes it over as stale and logs that it did. If it persists
  longer than that, something is genuinely holding it live. Staleness is measured from
  `claim_heartbeat_at`, which a live run bumps at least once a minute, so a long but
  healthy run (an orders drain refreshing a hundred forms, a stock run polling several
  commands, a full-catalogue price push) keeps its claim instead of being taken over
  mid-flight.
- **`running`, and a log line about losing the claim.** A run discovered it had been
  taken over and stopped without writing anything further, including its own outcome -
  the row belongs to whichever run replaced it. Nothing is lost: the abandoned work
  replays.
- **`idle` or `error` with a kill-switch message, while a run is in flight.** A skip
  that arrives while another run holds the claim deliberately does NOT touch the state
  row, and logs that it declined to. Writing it would have released that run's claim and
  let the next tick start a second concurrent run.
- **`error` with `SYSTEMIC` in the message.** The loop is waiting on Allegro. Nothing
  was skipped and nothing quarantined; it retries on its own.
- **`ok` with zero counters.** Nothing to do, which is different from broken - the
  counters are on the health table precisely so those two are distinguishable.
- **`idle` with a message about a kill switch.** Working as configured.

## Using the module from your own code

```ts
import { ALLEGRO_MODULE } from "@zanreal/medusa-allegro/modules/allegro";
import type AllegroModuleService from "@zanreal/medusa-allegro/modules/allegro/service";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const allegro = req.scope.resolve(ALLEGRO_MODULE) as AllegroModuleService;

  // null when no Allegro account is connected
  const client = await allegro.getClient();
  if (!client) {
    return res.status(409).json({ message: "Allegro is not connected" });
  }

  const { offers } = await client.listOffers({ limit: 100 });
  res.json({ offers });
}
```

`getClient()` returns an SDK client whose refreshes are persisted back to the
database, and whose app-token fallback is deliberately off: every call this plugin
makes is seller-scoped, and an app-only token would return empty result sets that
read as "this seller has no offers" instead of failing. The client is memoized per
service instance, which is what makes the SDK's refresh de-duplication apply; it
is dropped whenever the stored connection is replaced or deleted.

Every call has a 60-second wall-clock budget by default (`timeoutMs`), and that
budget covers a token refresh triggered on the way, not just the API request that
follows it. The OAuth token and revoke calls carry the same timeout. Both are
deliberate divergences from the reference Allegro SDK, marked as such in
`src/lib/allegro/`: without them a black-holed Allegro hangs a Medusa request or a
sync loop for as long as the platform's socket default allows.

`getPublicOptions()` answers "how is this configured?" - environment, app identity,
callback path, requested scopes, the sync configuration, and all three effective
kill switches. The fully resolved options are protected on purpose, because they
carry `clientSecret` and `encryptionKey` and nothing outside the service needs them.

### Running a loop from your own code

Every loop is exported as both a workflow and a plain function through
`@zanreal/medusa-allegro/workflows`:

```ts
import {
  discoverAllegroOffersWorkflow,
  runOfferDiscovery,
  runPriceAutomationMonitor,
  syncAllegroPrices,
} from "@zanreal/medusa-allegro/workflows";

// As a workflow, e.g. from your own admin route:
const { result } = await discoverAllegroOffersWorkflow(container).run();

// As plain functions, when you want to chain several loops off ONE offer listing -
// which is what the bundled hourly job does, because paging a full catalogue is the
// expensive part of all three:
const discovery = await runOfferDiscovery(container);
if (!discovery.result.skipped) {
  await runPriceAutomationMonitor(container, discovery.listing);
  await syncAllegroPrices(container, discovery.listing);
}
```

Each takes its own single-flight claim and honours its own kill switch, so calling
one directly is as safe as letting the schedule call it. A collision with a scheduled
run comes back as a `skipped` summary rather than an error, because it is retryable.

None of the workflows is compensated, and that is deliberate rather than an omission:
every write they make is an idempotent re-assertion of state Allegro owns, so the
repair for a partial run is another run. "Undoing" a price push would mean restoring
a range Allegro will not tell us, and "undoing" an order import would mean deleting
orders that really were placed.

### Known limitation: refresh de-duplication is per process

The SDK collapses concurrent refreshes into one in-flight promise, and the module
service keeps one client per instance so that promise is actually shared. Neither
coordinates across processes. Allegro rotates the refresh token on every use, so a
server and a worker refreshing at the same moment can invalidate each other's token
and force a reconnect.

The single-flight claims on `allegro_sync_state` DO work across processes - they are a
compare-and-set on the row, and every write a running loop makes is additionally fenced on
the claim token it was issued - so two instances cannot run the same loop concurrently, and
a run that has been taken over as stale discovers that fact rather than trampling its
successor's state. It is only the token refresh that is uncovered. Until a cross-process
lock lands, run the scheduled jobs in exactly one instance.

## Allegro API quirks encoded in this plugin

These are all load-bearing. Each one cost a production incident somewhere.

- **Offer reads go to `/sale/product-offers/{id}`.** Allegro disabled
  `GET /sale/offers/{id}` for reading offers in 2024. `product-offers` returns the
  same name, category and `sellingMode` shape.
- **Promo options did not move.** `GET /sale/offers/{offerId}/promo-options` is
  still the only route to an offer's promotion packages;
  `/sale/product-offers/{id}/promo-options` answers "Feature unavailable". The
  offer body itself carries no promotion state, so this is the authoritative
  source for whether an offer is promoted. Prefer the bulk
  `GET /sale/offers/promo-options` when resolving many offers.
- **The `User-Agent` is mandatory** and must identify your registered app. Allegro
  has been enforcing this since June 2026. The plugin builds
  `{appName}/{appVersion} (+{docsUrl})` and validates every part at construction
  time; the `+` prefix on the URL is required by their validator.
- **Rule types were removed from read resources** on 8 July 2025. A per-offer read
  gives you the rule id but may omit its type, so resolve names and types against
  `GET /sale/price-automation/rules`.
- **Quantity and price-automation changes are asynchronous commands.** You submit
  a command with a caller-supplied UUID and poll for a report. A report is
  terminal when `completedAt` is stamped - or, defensively, when the task tally
  accounts for every scheduled offer, because `completedAt` can lag the counts.
  Quantity commands take 1 to 1,000 offers and one exact non-negative integer.
- **HTTP 403 on a write command means a missing scope, not a bad offer.** A token
  without `allegro:api:sale:offers:write` reports itself that way. Treat it as a
  circuit-breaker condition that holds the whole run, not as a per-offer failure -
  `AllegroApiError.isForbidden()` exists for exactly this, and is deliberately
  separate from `isSystemic()`.
- **Money is a string.** Allegro speaks decimal strings, and this plugin keeps
  them as strings end to end. Round-tripping through a float is how price sync
  starts pushing `233.20999999999998`.
- **The order event journal retains about 60 days.** `GET /order/events` is the
  only reliable feed for order state changes, because a fulfillment update does
  not necessarily bump the parent checkout form's `updatedAt`. Lose the cursor for
  longer than the retention window and you need the checkout-forms backfill.
- **A checkout form carries up to three different people.** `buyer` is the account
  holder's registration data, which no Allegro seller ever sees in their own UI;
  `delivery.address` is the buyer-entered shipping recipient, and it IS what the
  seller sees against the order; `invoice.address` is the invoice recipient, which
  can legitimately name someone else again. Reading only the first is how an
  integration ends up displaying a name the Allegro seller panel contradicts. This
  plugin puts `delivery.address` on the Medusa shipping address and `invoice.address`
  on the billing address, falling back to shipping rather than to the account holder.
- **The buyer block spells the postal code `postCode`**, not `zipCode` - alone among
  the addresses in a checkout form. Typing it as the common address shape silently
  drops it.
- **An invoice company's tax id lives in a typed array now.** `company.ids` with a
  `PL_NIP` entry is the current source; the flat `company.taxId` is deprecated but
  still populated, so it stays as the fallback. The other id types Allegro can return
  are foreign registration numbers of similar length to a NIP, so this plugin
  deliberately does NOT read them: a wrong pairing is worse than no pairing.
- **`RETURNED` is Allegro-managed.** It appears once every unit is returned and
  refunded, and `PUT /order/checkout-forms/{id}/fulfillment` rejects it, so it is
  readable but never settable.
- **Registering an invoice document has no idempotency key.**
  `POST /order/checkout-forms/{id}/invoices` creates a second document for the same
  invoice number rather than returning the first, and an order accepts at most ten. Every
  caller therefore needs its own guard: read `GET .../invoices`, match on invoice number,
  and persist the returned id before uploading the file. See
  [The invoice chain](#the-invoice-chain).
- **The invoice file is the raw request body**, not JSON and not multipart:
  `PUT .../invoices/{invoiceId}/file` with `Content-Type: application/pdf` and the bytes.
  Handing a `Uint8Array` to `JSON.stringify` yields `{}`, which Allegro **accepts** - the
  order then carries an invoice document with a two-byte file and nothing reports a
  failure. Max 3 MB, and a rejected upload leaves the registered document behind.

## Roadmap

Shipped, read paths before write paths, so each stage could be run in production and
observed before the next was allowed to change anything:

- **Wave 1 - foundation.** Ported SDK, module and migrations, encrypted OAuth, admin
  settings page.
- **Wave 2 - read-only discovery.** Offer discovery by sygnatura/SKU, the bulk
  promo-options sweep, category discovery, and the read-only price-automation monitor.
- **Wave 3 - writes.** Price sync with `[break-even, SRP]` bounds and the stock push,
  both behind kill switches, with per-item quarantine, the circuit breaker, and
  write-scope detection.
- **Wave 4 - orders.** The event journal drain into Medusa orders, fulfillment
  write-back, and the operator import window.
- **Wave 5 - invoices.** The invoice attach: the two checkout-form invoice write calls,
  the dedupe-before-create guard, the event subscriber, and the retry sweep.

Known gaps, in rough priority order:

- **Refresh de-duplication is per process.** Two Medusa instances can each hold a
  memoized client and race on a refresh-token rotation. The single-flight claims
  protect the LOOPS across processes; the token refresh is not yet covered. Until it
  is, run the scheduled jobs in one instance. See
  [the note below](#known-limitation-refresh-de-duplication-is-per-process).
- **No taxes on imported orders.** Line prices are taken from Allegro verbatim, which
  is right for reconciliation, but no tax lines are computed - so an Allegro order's
  tax breakdown in Medusa is empty.
- **`paused` price mode is never emitted.** The bulk offer read cannot distinguish a
  paused rule from an active one. The column and the drift matrix already handle it
  for the day a paused signal becomes available.
- **Fulfillment write-back is one-directional per event.** A store that creates a
  fulfillment and a shipment in one action sends two updates; the second wins, which
  is correct but wasteful.
- **The invoice retry sweep rides the order drain**, so `ordersSyncDisabled` pauses it
  too, and an attach failure recorded in the shared `last_error` can be overwritten by a
  later healthy drain pass of the same form. The sweep itself does not depend on that
  string - see [The invoice chain](#the-invoice-chain) - but the admin may stop showing
  the per-order reason.

## Development

```bash
npm install
npm test                       # typecheck (both configs) + 847 unit tests
npx medusa plugin:build        # compile to .medusa/server
npx medusa plugin:db:generate  # regenerate migrations after a model change
npx medusa lint
```

### How the tests are organised

The split is deliberate, and it is what keeps the sync logic testable without a
database:

- **`src/lib/**`** is framework-agnostic and pure. `src/lib/allegro`is the REST
client with no Medusa imports at all;`src/lib/sync` is every decision the loops
  make - the eligibility ladder, the attach/switch/bounds decision, the quarantine
  machinery, the stock planner, the status ladder, the cursor discipline. All of it is
  I/O-free, so it is tested exhaustively and directly.
- **`src/workflows/**`** owns the side effects, and is tested against in-memory fakes
of the module service and the Allegro client (`src/workflows/**tests**/fixtures.ts`).
  A live Postgres would prove nothing these assertions do not - what is under test is
  which rows get written, in what order, and what the loop reports.
- **`src/api/**`\*\* routes are tested for their filter translation and validation,
  which is where their decisions live.

The one test to read first if you are changing anything here is
`src/lib/sync/__tests__/failure-state.unit.spec.ts`: it pins the eviction rules whose
rationale is easy to lose, notably why streaks and quarantines need SEPARATE caps.

### Regenerating migrations

`plugin:db:generate` needs a reachable Postgres to diff against. It reads `DB_HOST`,
`DB_PORT`, `DB_USERNAME`, `DB_PASSWORD`, and `DATABASE_URL`, and the individual
variables take precedence over the URL. A throwaway database is enough - the diff is
against the committed snapshot, not against live data:

```bash
docker run -d --name allegro-gen -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16
docker exec allegro-gen psql -U postgres -c "CREATE DATABASE medusa_allegro_gen;"

DB_HOST=127.0.0.1 DB_PORT=5432 DB_USERNAME=postgres DB_PASSWORD=postgres \
  DATABASE_URL="postgres://postgres:postgres@127.0.0.1:5432/medusa_allegro_gen" \
  npx medusa plugin:db:generate

docker rm -f allegro-gen
```

Commit both the migration and the updated `.snapshot-*.json` next to it; the snapshot
is what makes the next generation an incremental diff. Read the generated SQL before
committing: every migration this plugin has shipped is additive and nullable, and a
generated `NOT NULL` or a dropped column on a table that is already carrying
production sync state is a bug in the model change, not in the generator.

To develop against a real Medusa app, run `npx medusa plugin:publish` once here,
then `npx medusa plugin:add @zanreal/medusa-allegro` in the app, and keep
`npx medusa plugin:develop` running.

## Contributing

Issues and pull requests are welcome. Two house rules:

- The Allegro client in `src/lib/allegro` is framework-agnostic and must stay
  that way. No Medusa imports there, so it remains portable and testable in
  isolation.
- Every API quirk gets a comment explaining _why_, with a link to the Allegro
  changelog entry or OpenAPI schema that establishes it. The comments in that
  directory are the reason the integration works; do not trim them.

## License

MIT. See [LICENSE](./LICENSE).
