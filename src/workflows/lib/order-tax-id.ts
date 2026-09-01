import type { IOrderModuleService, Logger, MedusaContainer } from "@medusajs/framework/types";
import { Modules } from "@medusajs/framework/utils";
import { describeError } from "../../lib/allegro/errors";
import { hasTaxId, type OrderTaxIdPlan } from "../../lib/sync/order-tax-id";

/**
 * Writing the invoice recipient's tax id onto an order that has none.
 *
 * ## Through the module service, and why the metadata is re-read first
 *
 * Medusa stores `order.metadata` as one JSON column, so a write replaces the whole
 * object rather than merging into it. The current metadata is therefore read
 * immediately before the write and spread underneath the new key - a stale copy from
 * the snapshot taken earlier in the pass would silently drop
 * `allegro_checkout_form_id`, which is the only link back to Allegro and the key the
 * drain adopts orders by.
 *
 * That same re-read carries the gap-only invariant: if the order gained a tax id
 * between planning and writing, nothing is written. Like the address repair, this is
 * the last guard before a write with no workflow validating it, so it does not get to
 * depend on the caller having planned correctly.
 *
 * ## Never fatal
 *
 * A failure leaves the order exactly where it already was - and for an order created
 * before this key existed, that is still invoiceable, because the inFakt plugin also
 * parses a NIP out of `billing_address.company`. Throwing would hold the Allegro event
 * cursor and stall every later order behind this one. The plan is recomputed from
 * scratch on every pass, so the next drain tick simply tries again.
 *
 * ## Never the value
 *
 * The log says that a tax id was written, never which one. A NIP is buyer identity
 * data and this line goes to a log the whole team reads.
 */

/** What one attempt to fill the order's tax id did. */
export interface FillTaxIdResult {
  /** True when this pass actually wrote a tax id that was missing. */
  filled: boolean;
  /** Why nothing was written, when nothing was. Never an error - these are decisions. */
  skipped?: string;
  /** Set when the write was attempted and failed. */
  error?: string;
}

export const fillOrderTaxId = async (
  container: MedusaContainer,
  logger: Logger,
  orderId: string,
  plan: OrderTaxIdPlan,
): Promise<FillTaxIdResult> => {
  if (plan.kind === "skip") {
    return { filled: false, skipped: plan.reason };
  }

  try {
    const orders = container.resolve<IOrderModuleService>(Modules.ORDER);
    const [current] = await orders.listOrders({ id: orderId }, { select: ["id", "metadata"] });
    const metadata = (current?.metadata ?? {}) as Record<string, unknown>;

    // Every key the planner checks, not just `nip`. Checking one key here while
    // `planOrderTaxIdFill` checks five meant an order that gained a `tax_id`
    // between planning and writing got a second tax-id key written beside it -
    // two tax ids on one order, with a precedence rule deciding which one the
    // invoice carries. That is exactly the state the planner exists to prevent,
    // and this is the guard that actually runs before the write.
    if (hasTaxId(metadata)) {
      logger.warn(
        `[allegro-orders] refusing to write the invoice tax id onto Medusa order ${orderId}: it already carries one now, so this pass would overwrite rather than fill. Left alone.`,
      );
      return { filled: false, skipped: "the order gained a tax id between planning and writing" };
    }

    await orders.updateOrders([{ id: orderId, metadata: { ...metadata, nip: plan.nip } }]);
    logger.info(
      `[allegro-orders] wrote the invoice tax id onto Medusa order ${orderId} as \`metadata.nip\`, which had none. The value is not logged.`,
    );
    return { filled: true };
  } catch (error) {
    const message = describeError(error);
    logger.warn(
      `[allegro-orders] could not write the invoice tax id onto Medusa order ${orderId}: ${message}. The order is otherwise applied and the next pass retries this.`,
    );
    return { error: message, filled: false };
  }
};
