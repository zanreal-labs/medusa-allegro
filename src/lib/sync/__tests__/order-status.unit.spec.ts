import type { AllegroCheckoutForm } from "../../allegro/types";
import {
  checkoutOnlyStatus,
  mapCheckoutFormStatus,
  mapStatusPair,
  medusaActionForStatus,
  resolveStatusWrite,
} from "../order-status";

describe("checkoutOnlyStatus", () => {
  it("reads READY_FOR_PROCESSING as actionable", () => {
    expect(checkoutOnlyStatus("READY_FOR_PROCESSING")).toBe("new");
  });

  it("reads an unpaid order as pending", () => {
    expect(checkoutOnlyStatus("BOUGHT")).toBe("pending");
    expect(checkoutOnlyStatus("FILLED_IN")).toBe("pending");
  });

  it("reads an absent status as pending, which claims nothing", () => {
    expect(checkoutOnlyStatus()).toBe("pending");
    expect(checkoutOnlyStatus(null)).toBe("pending");
  });

  it("reads CANCELLED as cancelled", () => {
    expect(checkoutOnlyStatus("CANCELLED")).toBe("cancelled");
  });
});

describe("mapStatusPair", () => {
  it("lets a cancelled checkout win over any fulfillment status", () => {
    // A cancelled order can still carry a stale fulfillment status; reading that
    // instead would resurrect an order the buyer or Allegro killed.
    expect(mapStatusPair("CANCELLED", "SENT")).toBe("cancelled");
    expect(mapStatusPair("CANCELLED", "PROCESSING")).toBe("cancelled");
    expect(mapStatusPair("CANCELLED")).toBe("cancelled");
  });

  it("defers to the checkout status on fulfillment NEW", () => {
    // Allegro sets fulfillment NEW as soon as the order exists, before payment.
    // Deferring here is what makes the payment transition visible at all.
    expect(mapStatusPair("BOUGHT", "NEW")).toBe("pending");
    expect(mapStatusPair("READY_FOR_PROCESSING", "NEW")).toBe("new");
  });

  it("maps the processing statuses", () => {
    expect(mapStatusPair("READY_FOR_PROCESSING", "PROCESSING")).toBe("processing");
    expect(mapStatusPair("READY_FOR_PROCESSING", "SUSPENDED")).toBe("processing");
  });

  it("maps both ready statuses to one local state", () => {
    expect(mapStatusPair("READY_FOR_PROCESSING", "READY_FOR_SHIPMENT")).toBe("ready_for_shipment");
    expect(mapStatusPair("READY_FOR_PROCESSING", "READY_FOR_PICKUP")).toBe("ready_for_shipment");
  });

  it("maps SENT, PICKED_UP, RETURNED and CANCELLED", () => {
    expect(mapStatusPair("READY_FOR_PROCESSING", "SENT")).toBe("sent");
    expect(mapStatusPair("READY_FOR_PROCESSING", "PICKED_UP")).toBe("delivered");
    expect(mapStatusPair("READY_FOR_PROCESSING", "RETURNED")).toBe("returned");
    expect(mapStatusPair("READY_FOR_PROCESSING", "CANCELLED")).toBe("cancelled");
  });

  it("returns undefined for a fulfillment status it does not model", () => {
    // A real answer, not a failure: Allegro adds statuses over time, and a mapping
    // that guessed would report an unknown state as "new".
    expect(mapStatusPair("READY_FOR_PROCESSING", "SOMETHING_NEW")).toBeUndefined();
  });

  it("falls back to the checkout status when there is no fulfillment block", () => {
    expect(mapStatusPair("READY_FOR_PROCESSING")).toBe("new");
    expect(mapStatusPair("BOUGHT", null)).toBe("pending");
  });
});

describe("mapCheckoutFormStatus", () => {
  it("reads both statuses off the form", () => {
    const form: AllegroCheckoutForm = {
      fulfillment: { status: "SENT" },
      id: "f1",
      status: "READY_FOR_PROCESSING",
    };
    expect(mapCheckoutFormStatus(form)).toBe("sent");
  });
});

describe("resolveStatusWrite", () => {
  it("writes both columns for a brand-new order", () => {
    expect(resolveStatusWrite("new")).toEqual({ derived_status: "new", status: "new" });
  });

  it("writes nothing at all for an unmodelled upstream state", () => {
    expect(resolveStatusWrite(undefined, { derived_status: "new" })).toEqual({});
  });

  it("writes both columns when Allegro moved", () => {
    expect(resolveStatusWrite("sent", { derived_status: "processing" })).toEqual({
      derived_status: "sent",
      status: "sent",
    });
  });

  it("re-asserts the derived status without touching the order when Allegro did not move", () => {
    // This is how a staff edit survives: a staff action changes the order and
    // leaves `derived_status` where Allegro put it, so the next pass sees no
    // transition.
    expect(resolveStatusWrite("sent", { derived_status: "sent" })).toEqual({
      derived_status: "sent",
    });
  });

  it("treats a null derived status as a transition, to heal a latched row", () => {
    // A row predating the column. Healing every latched status once is worth
    // overwriting a pre-existing staff override a single time.
    expect(resolveStatusWrite("sent", { derived_status: null })).toEqual({
      derived_status: "sent",
      status: "sent",
    });
  });

  it("always carries the derived status alongside a status write, never separately", () => {
    // The invariant that makes a suppressed write self-heal: writing `status`
    // without `derived_status` in the same operation is what let a single lost
    // write latch the order forever.
    const write = resolveStatusWrite("sent", { derived_status: "new" });
    expect(write.status).toBeDefined();
    expect(write.derived_status).toBe(write.status);
  });

  it("never writes status without also writing derived_status", () => {
    const cases: Parameters<typeof resolveStatusWrite>[] = [
      ["new", undefined],
      ["sent", { derived_status: "new" }],
      ["sent", { derived_status: "sent" }],
      ["sent", { derived_status: null }],
      [undefined, { derived_status: "sent" }],
    ];
    for (const [derived, existing] of cases) {
      const write = resolveStatusWrite(derived, existing);
      if (write.status !== undefined) {
        expect(write.derived_status).toBe(write.status);
      }
    }
  });
});

describe("medusaActionForStatus", () => {
  it("cancels a cancelled order", () => {
    expect(medusaActionForStatus("cancelled")).toBe("cancel");
  });

  it("completes a delivered order", () => {
    expect(medusaActionForStatus("delivered")).toBe("complete");
  });

  it("does nothing for the states Medusa does not model", () => {
    // `none` is the correct answer, not a gap: writing `order.status = "sent"`
    // directly would fight the dashboard and the order-edit flows.
    for (const status of [
      "pending",
      "new",
      "processing",
      "ready_for_shipment",
      "sent",
      "returned",
    ] as const) {
      expect(medusaActionForStatus(status)).toBe("none");
    }
  });
});
