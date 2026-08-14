import type { IInventoryService, MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, MedusaError, Modules } from "@medusajs/framework/utils";
import type { ResolvedAllegroOptions } from "../../lib/options";
import type { EligibleVariant } from "../../lib/sync/offer-discovery";

/**
 * Reading the Medusa catalogue: which variants are sync-eligible, and what
 * quantity each has.
 *
 * Two things here are deliberate and worth stating.
 *
 * **Sales-channel scoping goes through the link entity.** Products and sales
 * channels are joined by a module link, not by a column, so the way to filter is
 * to query `product_sales_channel` for the product ids and then filter products
 * by those. That is exactly what core's own `getAllProductsStep` does; filtering
 * a product query on a nested linked field is not supported and would either
 * throw or silently return everything - and "silently returns everything" here
 * means publishing quantities for products the store never meant to sell on
 * Allegro.
 *
 * **Available, not stocked.** The quantity pushed to a marketplace is
 * `retrieveAvailableQuantity` (stocked minus reserved). Pushing the stocked
 * quantity oversells: units already promised to unfulfilled Medusa orders would
 * be advertised again on Allegro.
 */

/** Pagination size for catalogue reads. Kept modest to keep one query cheap. */
const PAGE_SIZE = 200;

interface QueryGraph {
  graph: (input: {
    entity: string;
    fields: string[];
    filters?: Record<string, unknown>;
    pagination?: { skip: number; take: number };
  }) => Promise<{ data: Record<string, unknown>[] }>;
}

/**
 * Resolve the configured Allegro sales channel to an id.
 *
 * Returns undefined when nothing is configured, which means "the whole catalogue
 * is eligible". A configured channel that cannot be found is an ERROR rather than
 * a fallback to the whole catalogue: an operator who scoped the integration to a
 * channel must not have that scoping silently widened by a typo.
 */
export const resolveSalesChannelId = async (
  container: MedusaContainer,
  options: Pick<ResolvedAllegroOptions, "salesChannelId" | "salesChannelName">,
): Promise<string | undefined> => {
  if (options.salesChannelId) {
    return options.salesChannelId;
  }
  if (!options.salesChannelName) {
    return undefined;
  }
  const query = container.resolve<QueryGraph>(ContainerRegistrationKeys.QUERY);
  const { data } = await query.graph({
    entity: "sales_channel",
    fields: ["id", "name"],
    filters: { name: options.salesChannelName },
  });
  const found = data[0]?.id as string | undefined;
  if (!found) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `medusa-allegro: no sales channel named "${options.salesChannelName}" exists. Create it, or set \`salesChannelId\` instead. Refusing to fall back to the whole catalogue.`,
    );
  }
  return found;
};

/** Product ids in one sales channel, read through the link entity. */
const listChannelProductIds = async (
  query: QueryGraph,
  salesChannelId: string,
): Promise<string[]> => {
  const ids: string[] = [];
  for (let page = 0; ; page += 1) {
    // Offset pagination; each page depends on the previous one.
    const { data } = await query.graph({
      entity: "product_sales_channel",
      fields: ["product_id"],
      filters: { sales_channel_id: salesChannelId },
      pagination: { skip: page * PAGE_SIZE, take: PAGE_SIZE },
    });
    for (const row of data) {
      const productId = row.product_id as string | undefined;
      if (productId) {
        ids.push(productId);
      }
    }
    if (data.length < PAGE_SIZE) {
      return ids;
    }
  }
};

/** A sync-eligible variant, plus what the quantity read needs. */
export interface CatalogVariant extends EligibleVariant {
  productId?: string;
  /** Inventory items backing the variant; empty when it does not manage stock. */
  inventoryItemIds: string[];
  manageInventory: boolean;
  /** Variant metadata, for the SRP lookup. */
  metadata?: Record<string, unknown> | null;
  /** Product metadata, the SRP fallback when the variant carries none. */
  productMetadata?: Record<string, unknown> | null;
  /**
   * The variant's own prices, one row per currency, as fixed-price mode reads
   * them.
   *
   * Read here rather than in a second query because the catalogue is already
   * being paged and the price set hangs off the variant through the pricing
   * module's link. A row carrying a `price_list_id` is a price-list override
   * rather than the variant's own price and is dropped by `buildVariantPriceBySku`
   * - a sale price is not what a store means by "the Medusa price".
   */
  prices: { amount?: number | string | null; currency_code?: string | null; priceListId?: string | null }[];
}

/**
 * Every variant that carries a SKU and is in scope.
 *
 * A variant with no SKU is skipped without comment: the SKU is the mapping key,
 * so a variant without one cannot participate at all, and reporting it as a
 * conflict would fill the admin with rows nobody can act on from this side.
 */
export const listEligibleVariants = async (
  container: MedusaContainer,
  options: Pick<ResolvedAllegroOptions, "salesChannelId" | "salesChannelName">,
): Promise<CatalogVariant[]> => {
  const query = container.resolve<QueryGraph>(ContainerRegistrationKeys.QUERY);
  const salesChannelId = await resolveSalesChannelId(container, options);

  let productIds: string[] | undefined;
  if (salesChannelId) {
    productIds = await listChannelProductIds(query, salesChannelId);
    if (productIds.length === 0) {
      // An empty channel is a legitimate state (nothing published yet), and it
      // must not be widened into "no filter" - `filters: { product_id: [] }` is
      // ambiguous enough across query layers that it is not worth relying on.
      return [];
    }
  }

  const variants: CatalogVariant[] = [];
  for (let page = 0; ; page += 1) {
    // Offset pagination; each page depends on the previous one.
    const { data } = await query.graph({
      entity: "product_variant",
      fields: [
        "id",
        "sku",
        "barcode",
        "ean",
        "manage_inventory",
        "metadata",
        "product_id",
        "product.metadata",
        "inventory_items.inventory_item_id",
        "price_set.prices.amount",
        "price_set.prices.currency_code",
        "price_set.prices.price_list_id",
      ],
      ...(productIds ? { filters: { product_id: productIds } } : {}),
      pagination: { skip: page * PAGE_SIZE, take: PAGE_SIZE },
    });

    for (const row of data) {
      const sku = (row.sku as string | null)?.trim();
      if (!sku) {
        continue;
      }
      const inventoryItems = (row.inventory_items ?? []) as { inventory_item_id?: string }[];
      const priceRows = ((row.price_set as { prices?: unknown } | null)?.prices ?? []) as {
        amount?: number | string | null;
        currency_code?: string | null;
        price_list_id?: string | null;
      }[];
      variants.push({
        // `barcode` first, then `ean`: both exist on a Medusa variant, and a store
        // that fills in only one should still match. Matched against the offer's
        // EAN only as a fallback for a missing sygnatura.
        ean: ((row.barcode as string | null) ?? (row.ean as string | null))?.trim() || undefined,
        id: row.id as string,
        inventoryItemIds: inventoryItems
          .map((item) => item.inventory_item_id)
          .filter((id): id is string => Boolean(id)),
        manageInventory: row.manage_inventory !== false,
        metadata: (row.metadata as Record<string, unknown> | null) ?? null,
        prices: priceRows.map((price) => ({
          amount: price.amount ?? null,
          currency_code: price.currency_code ?? null,
          priceListId: price.price_list_id ?? null,
        })),
        productId: (row.product_id as string | null) ?? undefined,
        productMetadata:
          (row.product as { metadata?: Record<string, unknown> | null } | null)?.metadata ?? null,
        sku,
      });
    }

    if (data.length < PAGE_SIZE) {
      return variants;
    }
  }
};

/**
 * One variant's available quantity, or the REASON it has none.
 *
 * The reason is the point. "Medusa has no quantity for this variant" and "we could not
 * read Medusa's quantity" are different facts with different safe responses, and
 * collapsing both into `undefined` forced the planner to treat them alike - which meant
 * one digital product with an Allegro offer refused the whole catalogue's stock sync
 * forever.
 */
export type VariantQuantity =
  | { quantity: number }
  /**
   * The variant structurally has no quantity: it does not manage inventory, or has no
   * inventory items. A bounded, permanent exclusion - so the offer is skipped and counted
   * and the rest of the catalogue still syncs.
   */
  | { absent: "no-inventory" }
  /**
   * The quantity could not be READ: the inventory call threw, or no inventory module is
   * registered. Unknown rather than absent, and unbounded in scope, so the planner
   * refuses the whole plan.
   */
  | { absent: "unreadable" };

/**
 * Available quantity per variant SKU, at the configured locations.
 *
 * Never a fabricated number: a variant whose quantity is unavailable gets a reason
 * instead, and the planner decides what that reason costs.
 *
 * - **Does not manage inventory** (or has no inventory items) has no meaningful quantity
 *   in Medusa at all. Publishing 0 would delist it, publishing anything else would be
 *   fabricated, so it is `no-inventory` and its offer is skipped rather than blocking
 *   everything else.
 * - **A read that threw** is `unreadable`: a transient fault must not look like a stock
 *   level, and its blast radius is unknown, so the plan is refused.
 * - **No inventory module at all** is `unreadable` for every variant. Medusa always
 *   registers one, so this is defensive, and refusing the plan is the right answer to a
 *   catalogue-wide unknown.
 */
export const readAvailableQuantities = async (
  container: MedusaContainer,
  variants: readonly CatalogVariant[],
  stockLocationIds: readonly string[],
): Promise<Map<string, VariantQuantity>> => {
  const quantities = new Map<string, VariantQuantity>();
  if (variants.length === 0) {
    return quantities;
  }

  let inventory: IInventoryService | undefined;
  try {
    inventory = container.resolve<IInventoryService>(Modules.INVENTORY);
  } catch {
    inventory = undefined;
  }
  if (!inventory) {
    for (const variant of variants) {
      quantities.set(variant.sku, { absent: "unreadable" });
    }
    return quantities;
  }

  const locationIds = await resolveStockLocationIds(container, stockLocationIds);

  for (const variant of variants) {
    if (!variant.manageInventory || variant.inventoryItemIds.length === 0) {
      quantities.set(variant.sku, { absent: "no-inventory" });
      continue;
    }
    try {
      // Sequential: a catalogue-wide fan-out of inventory reads is the fastest way
      // to exhaust a connection pool, and this runs on a schedule where latency is
      // not the constraint.
      let total = 0;
      let readable = true;
      for (const itemId of variant.inventoryItemIds) {
        const available = await inventory.retrieveAvailableQuantity(itemId, [...locationIds]);
        // A null or undefined answer for ONE item must not silently contribute 0 to the
        // sum: that understates the variant's stock by however much that item held, and
        // an understated quantity on a marketplace is a lost sale at best and a delisting
        // at worst. The whole VARIANT becomes unreadable instead.
        const parsed =
          available === null || available === undefined ? undefined : Number(available);
        if (parsed === undefined || !Number.isFinite(parsed)) {
          readable = false;
          break;
        }
        total += parsed;
      }
      quantities.set(
        variant.sku,
        readable && Number.isFinite(total)
          ? { quantity: Math.trunc(total) }
          : { absent: "unreadable" },
      );
    } catch {
      quantities.set(variant.sku, { absent: "unreadable" });
    }
  }
  return quantities;
};

/**
 * The locations to sum a quantity over: the configured ones, or every location.
 *
 * `retrieveAvailableQuantity` requires an explicit location list, so "all locations" has
 * to be materialised rather than passed as an empty array.
 *
 * An empty resolved list ABORTS the run, and this is the sharpest edge in the stock path.
 * `InventoryModuleService.retrieveAvailableQuantity` opens with
 * `if (locationIds.length === 0) return new BigNumber(0)` - verified in
 * `@medusajs/inventory` - so an empty list does not fail, it answers ZERO. Every variant
 * would read as available: 0, the planner would see no unresolved quantities, and the run
 * would push a quantity of 0 across the whole catalogue and report itself clean. That is
 * a full marketplace delisting presented as a healthy sync.
 *
 * A store with no stock locations is a configuration state, not a stock level.
 */
const resolveStockLocationIds = async (
  container: MedusaContainer,
  configured: readonly string[],
): Promise<string[]> => {
  const query = container.resolve<QueryGraph>(ContainerRegistrationKeys.QUERY);

  if (configured.length > 0) {
    // Configured ids are VALIDATED, not trusted. `retrieveAvailableQuantity` does not
    // complain about a location id that does not exist - it simply finds no levels there and
    // sums to zero - so a single typo in `stockLocationIds` produced exactly the same
    // catastrophe as the empty list: every variant reads as 0, the plan looks safe, and the
    // run pushes a zero quantity across the whole catalogue while reporting itself clean.
    // Same posture as `resolveSalesChannelId`: an operator who named a location must not have
    // that silently reinterpreted.
    const { data } = await query.graph({
      entity: "stock_location",
      fields: ["id"],
      filters: { id: [...configured] },
    });
    const known = new Set(data.map((row) => row.id as string));
    const unknown = configured.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `medusa-allegro: the configured \`stockLocationIds\` include ${unknown.length} id(s) that do not exist: ${unknown.join(", ")}. Refusing the stock run: Medusa reports zero available quantity for an unknown location rather than failing, so this would push a zero quantity for every variant and delist the catalogue on Allegro while reporting a clean sync.`,
      );
    }
    return [...configured];
  }

  const { data } = await query.graph({ entity: "stock_location", fields: ["id"] });
  const ids = data.map((row) => row.id as string).filter(Boolean);
  if (ids.length === 0) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "medusa-allegro: no stock locations exist, so available quantity cannot be read for any variant. Refusing the stock run rather than reading every quantity as 0, which would push a zero quantity across the whole catalogue and delist it on Allegro while reporting a clean sync. Create a stock location, or set the `stockLocationIds` option.",
    );
  }
  return ids;
};
