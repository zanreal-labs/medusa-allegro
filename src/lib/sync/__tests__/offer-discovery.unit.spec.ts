import type { AllegroOffer } from "../../allegro/types";
import { planOfferDiscovery } from "../offer-discovery";
import type { EligibleVariant, StoredOffer } from "../offer-discovery";

const offer = (over: Partial<AllegroOffer> & { id: string }): AllegroOffer => ({
  category: { id: "cat-1" },
  name: "An offer",
  publication: { status: "ACTIVE" },
  sellingMode: { price: { amount: "199.99", currency: "PLN" } },
  stock: { available: 4 },
  ...over,
});

const linked = (id: string, sku: string, over: Partial<AllegroOffer> = {}): AllegroOffer =>
  offer({ external: { id: sku }, id, ...over });

const variant = (id: string, sku: string, ean?: string): EligibleVariant => ({ ean, id, sku });

const plan = (input: {
  offers?: AllegroOffer[];
  variants?: EligibleVariant[];
  stored?: StoredOffer[];
  listingComplete?: boolean;
}) =>
  planOfferDiscovery({
    listingComplete: input.listingComplete ?? true,
    offers: input.offers ?? [],
    stored: input.stored ?? [],
    variants: input.variants ?? [],
  });

describe("planOfferDiscovery", () => {
  it("maps a sygnatura match onto the variant's SKU", () => {
    const result = plan({
      offers: [linked("o1", "SKU-1")],
      variants: [variant("v1", "SKU-1")],
    });
    expect(result.upserts).toEqual([
      {
        available_quantity: 4,
        category_id: "cat-1",
        conflict: null,
        conflict_detail: null,
        ean: null,
        name: "An offer",
        offer_id: "o1",
        price_amount: "199.99",
        price_currency: "PLN",
        sku: "SKU-1",
        status: "ACTIVE",
        variant_id: "v1",
      },
    ]);
    expect(result.matched).toBe(1);
    expect(result.conflicts).toEqual([]);
  });

  it("keeps money as the string Allegro sent", () => {
    // A float round-trip is how a price starts reading 199.98999999999998.
    const result = plan({
      offers: [
        linked("o1", "SKU-1", { sellingMode: { price: { amount: "233.21", currency: "PLN" } } }),
      ],
      variants: [variant("v1", "SKU-1")],
    });
    expect(result.upserts[0]?.price_amount).toBe("233.21");
  });

  it("maps a non-ACTIVE offer without treating it as a conflict", () => {
    // An ended offer is a perfectly valid mapping; the write paths gate on status
    // themselves.
    const result = plan({
      offers: [linked("o1", "SKU-1", { publication: { status: "ENDED" } })],
      variants: [variant("v1", "SKU-1")],
    });
    expect(result.upserts[0]?.status).toBe("ENDED");
    expect(result.conflicts).toEqual([]);
  });

  it("falls back to the EAN and still keys the row by the variant SKU", () => {
    // Keying on the EAN would create a second row for a SKU that already has one.
    const result = plan({
      offers: [offer({ ean: "5901234123457", id: "o1" })],
      variants: [variant("v1", "SKU-1", "5901234123457")],
    });
    expect(result.upserts[0]).toMatchObject({ offer_id: "o1", sku: "SKU-1", variant_id: "v1" });
  });

  it("counts an offer with neither sygnatura nor EAN as skipped", () => {
    const result = plan({ offers: [offer({ id: "o1" })], variants: [variant("v1", "SKU-1")] });
    expect(result.skippedNoSku).toBe(1);
    expect(result.upserts).toEqual([]);
  });

  it("records a duplicate sygnatura and writes nothing for it", () => {
    // Which offer owns the SKU is not a decision this plugin may take: pushing a
    // price or a quantity to the wrong one is a real mispricing or an oversell.
    const result = plan({
      offers: [linked("o1", "SKU-1"), linked("o2", "SKU-1")],
      variants: [variant("v1", "SKU-1")],
    });
    expect(result.upserts).toEqual([]);
    expect(result.conflicts).toEqual([
      {
        conflict: "duplicate-sku",
        conflict_detail: expect.stringContaining("o1, o2"),
        sku: "SKU-1",
      },
    ]);
  });

  it("records a sygnatura matching no eligible variant", () => {
    const result = plan({ offers: [linked("o1", "SKU-GHOST")], variants: [] });
    expect(result.conflicts).toEqual([
      {
        conflict: "no-variant",
        conflict_detail: expect.stringContaining("not published to the channel"),
        offer_id: "o1",
        sku: "SKU-GHOST",
      },
    ]);
  });

  it("records two Medusa variants sharing one SKU as the same ambiguity", () => {
    const result = plan({
      offers: [linked("o1", "SKU-1")],
      variants: [variant("v1", "SKU-1"), variant("v2", "SKU-1")],
    });
    expect(result.upserts).toEqual([]);
    expect(result.conflicts[0]).toMatchObject({ conflict: "duplicate-sku", offer_id: "o1" });
    expect(result.conflicts[0]?.conflict_detail).toContain("v1, v2");
  });

  it("still discovers the category of a conflicted offer", () => {
    // The commission rate is needed the moment the conflict is resolved, and
    // discovering it is free here.
    const result = plan({
      offers: [linked("o1", "SKU-1", { category: { id: "cat-9" } }), linked("o2", "SKU-1")],
      variants: [variant("v1", "SKU-1")],
    });
    expect(result.categoryIds.toSorted()).toEqual(["cat-1", "cat-9"]);
  });

  it("counts eligible variants that no offer claimed", () => {
    const result = plan({
      offers: [linked("o1", "SKU-1")],
      variants: [variant("v1", "SKU-1"), variant("v2", "SKU-2")],
    });
    expect(result.unmatchedVariants).toBe(1);
  });

  it("unlinks a stored offer that vanished from the listing", () => {
    const result = plan({
      offers: [linked("o1", "SKU-1")],
      stored: [
        { id: "row-1", offer_id: "o1", sku: "SKU-1" },
        { id: "row-2", offer_id: "o-gone", sku: "SKU-2" },
      ],
      variants: [variant("v1", "SKU-1")],
    });
    expect(result.unlink).toEqual(["SKU-2"]);
    expect(result.conflicts).toEqual([
      {
        conflict: "no-offer",
        conflict_detail: expect.stringContaining("absent from the current Allegro listing"),
        sku: "SKU-2",
      },
    ]);
  });

  it("unlinks a stored offer whose sygnatura was renamed to another SKU", () => {
    // Without this the old row keeps a now-misattributed offer id, and a quantity
    // push lands on somebody else's offer.
    const result = plan({
      offers: [linked("o1", "SKU-NEW")],
      stored: [{ id: "row-1", offer_id: "o1", sku: "SKU-OLD" }],
      variants: [variant("v1", "SKU-NEW"), variant("v2", "SKU-OLD")],
    });
    expect(result.unlink).toEqual(["SKU-OLD"]);
  });

  it("records the sygnatura being removed from a still-listed offer", () => {
    const result = plan({
      offers: [offer({ id: "o1" })],
      stored: [{ id: "row-1", offer_id: "o1", sku: "SKU-1" }],
      variants: [variant("v1", "SKU-1")],
    });
    expect(result.unlink).toEqual(["SKU-1"]);
    expect(result.conflicts).toEqual([
      {
        conflict: "missing-external-id",
        conflict_detail: expect.stringContaining("no longer carries a sygnatura"),
        offer_id: "o1",
        sku: "SKU-1",
      },
    ]);
  });

  it("never unlinks on an empty listing", () => {
    // The empty-response guard. A transient Allegro failure that yields zero
    // offers would otherwise clear every mapping the store has, and the next run
    // would have nothing left to re-link by.
    const result = plan({
      offers: [],
      stored: [{ id: "row-1", offer_id: "o1", sku: "SKU-1" }],
      variants: [variant("v1", "SKU-1")],
    });
    expect(result.unlink).toEqual([]);
    expect(result.conflicts).toEqual([]);
  });

  it("never unlinks on an incomplete listing, even a non-empty one", () => {
    // A page that went missing mid-pagination looks exactly like a deleted offer.
    const result = plan({
      listingComplete: false,
      offers: [linked("o1", "SKU-1")],
      stored: [{ id: "row-1", offer_id: "o-gone", sku: "SKU-2" }],
      variants: [variant("v1", "SKU-1")],
    });
    expect(result.unlink).toEqual([]);
  });

  it("leaves an already-unlinked stored row alone", () => {
    const result = plan({
      offers: [linked("o1", "SKU-1")],
      stored: [{ id: "row-2", offer_id: null, sku: "SKU-2" }],
      variants: [variant("v1", "SKU-1")],
    });
    expect(result.unlink).toEqual([]);
  });

  it("does not unlink a stored row whose offer still owns its SKU", () => {
    const result = plan({
      offers: [linked("o1", "SKU-1")],
      stored: [{ id: "row-1", offer_id: "o1", sku: "SKU-1" }],
      variants: [variant("v1", "SKU-1")],
    });
    expect(result.unlink).toEqual([]);
  });

  it("unlinks a stored row whose SKU became contested", () => {
    // Nothing is written for a contested key, so the stale link must go too -
    // otherwise the row keeps pointing at one of two offers that may not be the
    // one an operator eventually keeps.
    const result = plan({
      offers: [linked("o1", "SKU-1"), linked("o2", "SKU-1")],
      stored: [{ id: "row-1", offer_id: "o1", sku: "SKU-1" }],
      variants: [variant("v1", "SKU-1")],
    });
    expect(result.unlink).toEqual(["SKU-1"]);
  });

  it("records exactly one conflict for a contested SKU that also had a stored link", () => {
    // Both passes have an opinion about this SKU. The offers pass wins, because
    // `duplicate-sku` names the competing offer ids an operator needs, whereas
    // `no-offer` would claim the offer is absent from a listing it is plainly in.
    const result = plan({
      offers: [linked("o1", "SKU-1"), linked("o2", "SKU-1")],
      stored: [{ id: "row-1", offer_id: "o1", sku: "SKU-1" }],
      variants: [variant("v1", "SKU-1")],
    });
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({ conflict: "duplicate-sku", sku: "SKU-1" });
  });

  it("records exactly one conflict for an unmatched SKU that also had a stored link", () => {
    const result = plan({
      offers: [linked("o1", "SKU-GHOST")],
      stored: [{ id: "row-1", offer_id: "o1", sku: "SKU-GHOST" }],
      variants: [],
    });
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({ conflict: "no-variant" });
  });

  it("records an unreadable offer quantity as null, not zero", () => {
    const result = plan({
      offers: [linked("o1", "SKU-1", { stock: {} })],
      variants: [variant("v1", "SKU-1")],
    });
    expect(result.upserts[0]?.available_quantity).toBeNull();
  });

  it("deduplicates discovered category ids", () => {
    const result = plan({
      offers: [linked("o1", "SKU-1"), linked("o2", "SKU-2")],
      variants: [variant("v1", "SKU-1"), variant("v2", "SKU-2")],
    });
    expect(result.categoryIds).toEqual(["cat-1"]);
  });

  it("trims a padded sygnatura before matching", () => {
    const result = plan({
      offers: [offer({ external: { id: " SKU-1 " }, id: "o1" })],
      variants: [variant("v1", "SKU-1")],
    });
    expect(result.upserts[0]?.sku).toBe("SKU-1");
  });
});
