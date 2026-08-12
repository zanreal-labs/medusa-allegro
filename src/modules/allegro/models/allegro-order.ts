import { model } from "@medusajs/framework/utils";

/**
 * One Allegro checkout form, and the Medusa order it produced.
 *
 * This table is the sync's own bookkeeping, deliberately separate from the
 * Medusa order it points at. Three things make that separation necessary rather
 * than tidy:
 *
 * - **A checkout form can exist without an order.** The drain records the form
 *   the moment it decides to work on it, so a form whose Medusa order could not
 *   be created (an unmatched SKU that also failed validation, a region that
 *   cannot price it) is still visible with its error instead of vanishing.
 *   `medusa_order_id` is therefore nullable, and a null one is a to-do.
 * - **Allegro's status ladder is richer than Medusa's.** Allegro reports a
 *   checkout status and a seller-managed fulfillment status, and their product
 *   maps onto states Medusa's `order.status` enum simply does not have
 *   (`ready_for_shipment`, `sent`, `returned`). `derived_status` keeps the full
 *   mapped ladder; only the parts Medusa can represent are pushed onto the
 *   order itself.
 * - **Staff edits must survive.** `derived_status` is the comparison basis for
 *   whether Allegro moved, and it is written in the same operation as any
 *   order-facing action. See `resolveStatusWrite`: re-deriving from the raw
 *   status columns instead made a single suppressed write permanent, because the
 *   raw columns are rewritten on every pass and so never showed a transition
 *   again.
 *
 * Money is text, verbatim from Allegro, for the same reason as on
 * `allegro_offer`: the API speaks decimal strings and a float round-trip is how
 * a total starts reading 233.20999999999998.
 */
const AllegroOrder = model.define("allegro_order", {
  /**
   * Allegro's id for the invoice document registered on this checkout form.
   *
   * Persisted the moment the create returns, BEFORE the file is uploaded, because
   * `POST .../invoices` has no idempotency key: a crash between a successful create
   * and this column being written would otherwise register a second document on the
   * next attempt, and an order accepts only ten. With the id stored, the retry
   * uploads against the document that already exists.
   */
  allegro_invoice_id: model.text().nullable(),
  /** Checkout status, verbatim: BOUGHT, FILLED_IN, READY_FOR_PROCESSING, CANCELLED. */
  allegro_status: model.text().nullable(),
  /** Buyer's Allegro login. Display-only; never a mapping key. */
  buyer_login: model.text().nullable(),
  /**
   * Allegro checkout-form id. The identity of the row and of the order upstream.
   * Unique, so a replayed event is an update rather than a duplicate - the whole
   * drain depends on that idempotency.
   */
  checkout_form_id: model.text().unique(),
  /**
   * A reconciliation problem with this order, when it has one. Null is healthy.
   *
   * - `total-mismatch` - the Medusa order's total does not equal the `totalToPay` Allegro
   *   recorded for the form, compared to the grosz in the same currency.
   *
   * Deliberately NOT a reason to refuse or roll back the order. The sale happened on
   * Allegro whatever Medusa's arithmetic says, and an order nobody can see is not a safer
   * outcome than one that is visibly disputed. It is recorded, counted and surfaced so a
   * human decides, which is the same trade `line_conflicts` makes.
   */
  conflict: model.enum(["total-mismatch"]).nullable(),
  /** Human-readable detail for `conflict`: both figures, and the benign-cause hint. */
  conflict_detail: model.text().nullable(),
  /** ISO currency of `total_to_pay`, verbatim from Allegro. */
  currency: model.text().nullable(),
  /**
   * The status this sync last derived from Allegro's own state, across the full
   * ladder. The comparison basis for "did Allegro move?", written in the same
   * operation as any status write so a suppressed write self-heals on the next
   * pass rather than latching forever.
   */
  derived_status: model
    .enum([
      "pending",
      "new",
      "processing",
      "ready_for_shipment",
      "sent",
      "delivered",
      "returned",
      "cancelled",
    ])
    .nullable(),
  /** Seller-managed fulfillment status, verbatim (NEW, SENT, RETURNED, ...). */
  fulfillment_status: model.text().nullable(),
  id: model.id({ prefix: "algorder" }).primaryKey(),
  /**
   * When Allegro accepted the invoice PDF for this order. Null is "not attached".
   *
   * Stamped LAST, after the upload returned, so a row that reads attached really
   * carries a file the buyer can download. The sweep in the orders job uses the same
   * reading in reverse: null with an invoice already issued means unfinished work,
   * whatever step it stopped at.
   */
  invoice_attached_at: model.dateTime().nullable(),
  /** Last failure for this form, cleared on the next successful pass. */
  last_error: model.text().nullable(),
  /** `occurredAt` of the newest journal event this row was refreshed for. */
  last_event_at: model.dateTime().nullable(),
  /**
   * Line items whose Allegro sygnatura matched no Medusa variant, as
   * `[{ sku, offerId, name, quantity }]`.
   *
   * The order is still created - a missing product mapping is not a reason to
   * lose a real sale - with those lines carried as custom (title-only) items.
   * The conflict is recorded here so the admin can show which sale is only
   * half-mapped, because a custom line item carries no variant and therefore no
   * inventory, cost or reporting linkage.
   */
  line_conflicts: model.json().nullable(),
  /**
   * The Medusa order this form produced. Null while the form is known but its
   * order could not be created - see the class comment.
   */
  medusa_order_id: model.text().index().nullable(),
  /**
   * When the sync last applied this form completely.
   *
   * Stamped LAST, after the order and the status write are consistent. A crash
   * anywhere earlier therefore leaves the row looking unfinished and the next
   * pass repairs it, rather than a half-applied form reading as done.
   */
  synced_at: model.dateTime().nullable(),
  /** `summary.totalToPay`, verbatim from Allegro (decimal string). */
  total_to_pay: model.text().nullable(),
});

export default AllegroOrder;
