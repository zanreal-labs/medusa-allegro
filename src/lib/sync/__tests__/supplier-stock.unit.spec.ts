import {
  MAX_SUPPLIER_SKUS,
  readSupplierStockChanged,
  SUPPLIER_STOCK_CHANGED_EVENT,
} from "../supplier-stock";

/** The refusal reason, or a failure if the reader unexpectedly accepted the payload. */
const skipReason = (data: unknown): string => {
  const read = readSupplierStockChanged(data);
  if (read.ok) {
    throw new Error("expected the payload to be refused, but it was accepted");
  }
  return read.skip;
};

/**
 * The cross-plugin payload reader.
 *
 * It crosses a version boundary between two separately-installable plugins, so the
 * question every case here answers is the same: does an unexpected shape cost the
 * fast path (acceptable - the reconciliation covers it) or does it cost correctness
 * (never acceptable)?
 */
describe("readSupplierStockChanged", () => {
  it("accepts the documented payload", () => {
    expect(readSupplierStockChanged({ skus: ["SKU-1", "SKU-2"] })).toEqual({
      ok: true,
      skus: ["SKU-1", "SKU-2"],
    });
    // The contract, spelled once on each side and asserted on both.
    expect(SUPPLIER_STOCK_CHANGED_EVENT).toBe("marken.stock.changed");
  });

  it("ignores extra fields rather than refusing a payload it half-understands", () => {
    // Additive-only: the supplier plugin must be free to add fields without this one
    // needing a release.
    expect(
      readSupplierStockChanged({ reason: "restock", skus: ["SKU-1"], version: 2 }),
    ).toEqual({ ok: true, skus: ["SKU-1"] });
  });

  it("drops blank and non-string entries individually, not the whole batch", () => {
    // One bad entry in a list of fifty should cost that entry, not the other
    // forty-nine - each survivor is a listing that stops being wrong sooner.
    expect(
      readSupplierStockChanged({ skus: ["SKU-1", "", "  ", 42, null, "SKU-2"] }),
    ).toEqual({ ok: true, skus: ["SKU-1", "SKU-2"] });
  });

  it("de-duplicates", () => {
    expect(readSupplierStockChanged({ skus: ["A", "A", "B"] })).toEqual({
      ok: true,
      skus: ["A", "B"],
    });
  });

  it("describes a payload of the wrong shape rather than throwing", () => {
    // A throwing subscriber would be retried with the same malformed payload until its
    // budget ran out, and the reason would reach nobody.
    expect(skipReason(null)).toContain("not an object");
    expect(skipReason("nope")).toContain("not an object");
    expect(skipReason({})).toContain("no `skus` array");
    expect(skipReason({ skus: "SKU-1" })).toContain("no `skus` array");
  });

  it("tells an empty list apart from a wrong shape", () => {
    // Only the second is a compatibility problem; conflating them would either hide a
    // broken contract or cry wolf about a harmless no-op.
    expect(skipReason({ skus: [] })).toContain("no usable SKU");
    expect(skipReason({ skus: ["", "  "] })).toContain("no usable SKU");
  });

  it("truncates an implausibly large announcement, and says how much it dropped", () => {
    const skus = Array.from({ length: MAX_SUPPLIER_SKUS + 5 }, (_, i) => `SKU-${i}`);
    const read = readSupplierStockChanged({ skus });

    // A feed reporting its entire catalogue as changed is a bug in the feed, not an
    // event. The remainder is left to the reconciliation rather than dropped silently.
    if (!read.ok) {
      throw new Error(`expected a usable payload, got: ${read.skip}`);
    }
    expect(read.skus).toHaveLength(MAX_SUPPLIER_SKUS);
    expect(read.truncated).toBe(5);
  });
});
