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
 * Available quantity per variant SKU, at the configured locations.
 *
 * Undefined for a variant whose quantity cannot be read, and that is a real
 * answer the stock planner counts as `unresolved` rather than pushing a guess.
 * The two cases:
 *
 * - **A variant that does not manage inventory** has no meaningful quantity in
 *   Medusa at all. Publishing 0 would delist it; publishing anything else would
 *   be fabricated.
 * - **A read that threw** is a transient fault, and a transient fault must not
 *   look like a stock level.
 * - **No inventory module at all** is the same answer for every variant. Medusa
 *   always registers one, so this is a defensive branch rather than an expected
 *   state - but degrading to "unresolved" keeps the failure mode consistent with
 *   everything else here, and the planner then refuses the whole plan instead of
 *   the loop crashing.
 */
export const readAvailableQuantities = async (
  container: MedusaContainer,
  variants: readonly CatalogVariant[],
  stockLocationIds: readonly string[],
): Promise<Map<string, number | undefined>> => {
  const quantities = new Map<string, number | undefined>();
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
      quantities.set(variant.sku, undefined);
    }
    return quantities;
  }

  const locationIds = await resolveStockLocationIds(container, stockLocationIds);

  for (const variant of variants) {
    if (!variant.manageInventory || variant.inventoryItemIds.length === 0) {
      quantities.set(variant.sku, undefined);
      continue;
    }
    try {
      // Sequential: a catalogue-wide fan-out of inventory reads is the fastest way
      // to exhaust a connection pool, and this runs on a schedule where latency is
      // not the constraint.
      let total = 0;
      for (const itemId of variant.inventoryItemIds) {
        const available = await inventory.retrieveAvailableQuantity(itemId, [...locationIds]);
        total += Number(available ?? 0);
      }
      quantities.set(variant.sku, Number.isFinite(total) ? Math.trunc(total) : undefined);
    } catch {
      quantities.set(variant.sku, undefined);
    }
  }
  return quantities;
};

/**
 * The locations to sum a quantity over: the configured ones, or every location.
 *
 * `retrieveAvailableQuantity` requires an explicit location list, so "all
 * locations" has to be materialised rather than passed as an empty array - an
 * empty list reads as "nowhere" and would report every variant as out of stock.
 */
const resolveStockLocationIds = async (
  container: MedusaContainer,
  configured: readonly string[],
): Promise<string[]> => {
  if (configured.length > 0) {
    return [...configured];
  }
  const query = container.resolve<QueryGraph>(ContainerRegistrationKeys.QUERY);
  const { data } = await query.graph({ entity: "stock_location", fields: ["id"] });
  return data.map((row) => row.id as string).filter(Boolean);
};
