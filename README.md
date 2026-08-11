# @zanreal/medusa-allegro

![status: pre-release](https://img.shields.io/badge/status-pre--release-orange)
![medusa: v2](https://img.shields.io/badge/medusa-v2-blueviolet)
![license: MIT](https://img.shields.io/badge/license-MIT-green)

Medusa v2 plugin for [Allegro](https://allegro.pl), the largest marketplace in
Poland.

**Status: pre-release.** This is wave 1. It gives you a working, encrypted OAuth
connection to an Allegro seller account, the data model the later waves write
into, and a settings page in the Medusa Admin. It does **not** sync anything yet:
no offer discovery, no stock push, no price writes, no order import. See
[Roadmap](#roadmap) for what lands when, and treat the schema as settled but the
API surface as still moving until 1.0.

What is here today:

- A zero-dependency, fetch-based Allegro REST client, ported from a production
  integration and covered by 111 unit tests. Offers, promo options,
  price-automation rules and commands, order events, checkout forms, categories,
  fee preview.
- OAuth 2.0 authorization-code flow with a CSRF-protected callback, refresh-token
  rotation, and AES-256-GCM encryption of both tokens at rest.
- Five data models with generated migrations: the connection, the SKU-to-offer
  mapping, per-category commission rates, an append-only price-push audit trail,
  and per-loop sync health.
- An admin settings page under Settings -> Allegro: connection status, connect,
  reconnect, disconnect, and a sync-health table.

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

| Option              | Type                        | Required | Default                                                                                | Notes                                                                                                                         |
| ------------------- | --------------------------- | -------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `clientId`          | `string`                    | yes      | -                                                                                      | Allegro application client id.                                                                                                |
| `clientSecret`      | `string`                    | yes      | -                                                                                      | Allegro application client secret.                                                                                            |
| `environment`       | `"production" \| "sandbox"` | no       | `"production"`                                                                         | Sandbox talks to `api.allegro.pl.allegrosandbox.pl`.                                                                          |
| `appName`           | `string`                    | yes      | -                                                                                      | Must match the registered app name. No whitespace or HTTP separators.                                                         |
| `appVersion`        | `string`                    | yes      | -                                                                                      | Your integration version, e.g. `"1.0.0"`.                                                                                     |
| `docsUrl`           | `string`                    | yes      | -                                                                                      | Public http(s) URL documenting or contacting the integration.                                                                 |
| `encryptionKey`     | `string`                    | yes      | -                                                                                      | Base64-encoded 32 bytes. Seals the stored tokens. Rotating it makes existing tokens unreadable: reconnect after a rotation.   |
| `redirectPath`      | `string`                    | no       | `"/admin/allegro/oauth/callback"`                                                      | Must match the redirect URI registered for the app, character for character.                                                  |
| `scopes`            | `string`                    | no       | `"allegro:api:sale:offers:read allegro:api:sale:offers:write allegro:api:orders:read"` | Space-separated. Drop `:write` if you only ever want read access; the plugin then reports the missing write scope in the UI.  |
| `priceSyncDisabled` | `boolean`                   | no       | `false`                                                                                | Kill-switch for every price-affecting write.                                                                                  |
| `backendUrl`        | `string`                    | no       | derived                                                                                | Absolute base URL of this backend. Set it when a proxy rewrites `Host`. Falls back to `MEDUSA_BACKEND_URL`, then the request. |

All options are validated in a module loader, so a misconfiguration fails at boot
with a specific message instead of surfacing as an opaque Allegro error later.

### Environment variables

| Variable                      | Effect                                                                                                                                                      |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ALLEGRO_PRICE_SYNC_DISABLED` | `1`, `true` or `yes` disables price writes regardless of `priceSyncDisabled`. The env wins on purpose: an operator setting it is responding to an incident. |
| `MEDUSA_BACKEND_URL`          | Fallback for `backendUrl` when deriving the OAuth redirect URI.                                                                                             |

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

Put it in `ALLEGRO_ENCRYPTION_KEY`. The plugin refuses to boot if the key does
not decode to exactly 32 bytes, rather than silently stretching a weak one.

### 3. Connect from the admin

Open **Settings -> Allegro** in the Medusa Admin and click **Connect Allegro**.
You land on Allegro's consent screen, approve, and come back to the settings page
with the account login, granted scopes, and token expiry filled in.

### How the flow is protected

- `GET /admin/allegro/oauth/start` mints a random `state`, parks it in an
  httpOnly `SameSite=Lax` cookie with a 10-minute lifetime, and returns the
  authorization URL for the admin to navigate to.
- `GET /admin/allegro/oauth/callback` requires that `state` to match what Allegro
  echoes back, compared in constant time.
- Both routes live under `/admin`, which Medusa authenticates by default. The
  callback keeps that default: Allegro's redirect back is a top-level GET
  navigation and Medusa's admin session cookie is `SameSite=Lax`, so the session
  survives the hop.

If your deployment authenticates the admin with a bearer token in local storage
rather than a session cookie, the callback will 401, because the browser has no
cookie to send on that navigation. Serve the admin and the backend on the same
origin with session auth; do not make the callback public.

### Disconnecting

`POST /admin/allegro/disconnect` revokes the refresh and access tokens at Allegro
and then deletes the stored row. Revocation is best-effort - if Allegro is
unreachable the local connection is still removed, because refusing to disconnect
would leave an operator unable to remove access they asked to remove.

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

| Table                   | What it holds                                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------------------------------- |
| `allegro_auth`          | The OAuth connection. Both tokens AES-256-GCM encrypted, plus expiry, granted scope, and the account login. |
| `allegro_offer`         | SKU-to-offer mapping. `sku` unique, `offer_id` a resolved cache. Money as text, verbatim from Allegro.      |
| `allegro_category_rate` | Sale commission per Allegro category, plain and promoted. Maintained by an operator - see below.            |
| `allegro_price_push`    | Append-only audit of price-automation decisions, including the pushed `[floor, ceiling]`.                   |
| `allegro_sync_state`    | Per-loop health: status, cursor, last error, failure streaks, and whether a write scope is missing.         |

Two of these carry non-obvious constraints worth knowing before you build on
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
read as "this seller has no offers" instead of failing.

### Known limitation: refresh de-duplication is per process

The SDK collapses concurrent refreshes into one in-flight promise, which covers
the common case of many parallel calls in a single Medusa instance. It does **not**
coordinate across processes. Allegro rotates the refresh token on every use, so a
server and a worker refreshing at the same moment can invalidate each other's
token and force a reconnect. Until a cross-process lock lands (wave 3, alongside
worker-mode support), run the sync loops in exactly one instance.

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

## Roadmap

Wave 1 is the foundation. The sync loops follow, read paths before write paths, so
each wave can be run in production and observed before the next one is allowed to
change anything.

- **Wave 1 - foundation (this release).** Ported SDK, module and migrations,
  encrypted OAuth, admin settings page.
- **Wave 2 - read-only discovery.** Offer discovery by sygnatura/SKU, promotion
  sweep via the bulk promo-options resource, and a read-only price-automation
  monitor that records observations into `allegro_price_push` without writing to
  Allegro.
- **Wave 3 - writes.** Stock push through the quantity-change command, price
  sync through the price-automation command with `[floor, ceiling]` bounds, the
  kill-switch wired to real writes, per-SKU failure quarantine, and a
  cross-process refresh lock for worker mode.
- **Wave 4 - orders.** Draining `GET /order/events` into Medusa orders, with
  fulfillment status write-back and a checkout-forms backfill for gaps beyond the
  event retention window.

## Development

```bash
npm install
npm test                       # typecheck + 111 unit tests
npx medusa plugin:build        # compile to .medusa/server
npx medusa plugin:db:generate  # regenerate migrations after a model change
npx medusa lint
```

`plugin:db:generate` needs a reachable Postgres to diff against. It reads
`DB_HOST`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD`, and `DATABASE_URL`, and the
individual variables take precedence over the URL:

```bash
DB_HOST=127.0.0.1 DB_PORT=5432 DB_USERNAME=postgres DB_PASSWORD=postgres \
  DATABASE_URL="postgres://postgres:postgres@127.0.0.1:5432/medusa_allegro_gen" \
  npx medusa plugin:db:generate
```

Commit both the migration and the updated `.snapshot-*.json` next to it; the
snapshot is what makes the next generation an incremental diff.

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
