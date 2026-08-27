import { describeError } from "../errors";

describe("describeError", () => {
  it("renders a plain object as something actionable, not [object Object]", () => {
    // The defect this exists for. An address repair failed on 2026-08-27 and the
    // log said only "[object Object]"; the cause had to be found by reading
    // Medusa's source instead.
    const rendered = describeError({ code: "invalid_data", type: "invalid_data" });

    expect(rendered).not.toContain("[object Object]");
    expect(rendered).toContain("invalid_data");
  });

  it("reads a message off an object that is not an Error instance", () => {
    // How a MedusaError arrives when its prototype chain does not survive a realm
    // boundary: it has a message and fails `instanceof Error`.
    expect(describeError({ code: "invalid_data", message: "Country code cannot be changed" })).toBe(
      "Country code cannot be changed (invalid_data)",
    );
  });

  it("unwraps the workflow engine's errors[] rejection", () => {
    // The workflow engine rejects with a wrapper rather than the error itself, so
    // the useful message is one level in.
    expect(
      describeError({ errors: [{ error: new Error("Country code cannot be changed") }] }),
    ).toBe("Country code cannot be changed");
  });

  it("still handles the ordinary cases", () => {
    expect(describeError(new Error("boom"))).toBe("boom");
    expect(describeError("boom")).toBe("boom");
    expect(describeError(null)).toBe("null");
    expect(describeError(undefined)).toBe("undefined");
  });

  it("names the type rather than throwing on a circular object", () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;

    // A logger that throws while describing a failure turns one problem into two.
    expect(() => describeError(circular)).not.toThrow();
    expect(describeError(circular)).toContain("Object");
  });
})
