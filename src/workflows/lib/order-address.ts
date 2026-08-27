import type { IOrderModuleService, Logger, MedusaContainer } from "@medusajs/framework/types";
import { Modules } from "@medusajs/framework/utils";
import { describeError } from "../../lib/allegro/errors";
import type { OrderAddressPlan } from "../../lib/sync/order-address";

/**
 * Writing an address onto an order that was created without one.
 *
 * ## Through the module service, NOT the stock workflow - and why
 *
 * Everything else in this plugin writes orders through a core workflow, and the
 * first instinct on finding this will be to "fix" it back. Do not, until the
 * upstream defect below is closed.
 *
 * `updateOrderWorkflow` cannot add an address to an order that has none. Its
 * validator reads:
 *
 *   if (input.shipping_address?.country_code &&
 *       order.shipping_address?.country_code !== input.shipping_address?.country_code)
 *     throw new MedusaError(INVALID_DATA, "Country code cannot be changed")
 *
 * With no existing address, `order.shipping_address?.country_code` is `undefined`,
 * so any country code supplied is `!==` it and the guard throws
 * "Country code cannot be changed" on an order that has no country code to change.
 * The guard cannot distinguish ABSENT from DIFFERENT. Filed upstream as
 * https://github.com/medusajs/medusa/issues/16636 - when that closes, this can and
 * should go back to the workflow.
 *
 * The alternative was to omit `country_code` so the guard goes falsy. That was
 * rejected: country is what selects the VAT regime for invoicing, and quietly
 * storing an address without one would put an incomplete record under a document
 * that makes a tax decision from it. It would also have worked, which is what makes
 * it the dangerous option.
 *
 * WHAT THIS GIVES UP: the workflow's hooks and its emitted events for this write.
 * Nothing in this store subscribes to an order-updated event today, and the repair
 * is additive - it fills a field that was null - so no consumer can be relying on
 * being told about a change that, from the order's point of view, restores what
 * should have been there at creation.
 *
 * AND WHAT IT DOES NOT GIVE UP: the validation being stepped around is redundant
 * with a stronger check this code already enforces. The workflow refuses to change
 * a country code; this refuses to touch a present address AT ALL, reading only
 * whether one exists and never comparing contents. So the guard could only ever
 * fire on the case already made impossible here, or on the case it gets wrong.
 * The safety bar is not lowered - see the re-check below, which keeps that true
 * regardless of what any caller passes.
 *
 * ## Never fatal
 *
 * A failure leaves an order that is correct in every other respect without an
 * address, which is exactly where it already was. Throwing would hold the Allegro
 * event cursor and stall every later order behind this one, and it is not needed:
 * the plan is recomputed from scratch on every pass, so the next drain tick or
 * reconciliation sweep simply tries again.
 *
 * ## Never the values
 *
 * The log names which address fields were filled, never what they contain. This
 * line goes to a log the whole team reads and the values are a customer's home
 * address.
 */

/** What one attempt to fill the order's addresses did. */
export interface RepairAddressResult {
  /** True when this pass actually wrote an address that was missing. */
  repaired: boolean;
  /** Why nothing was written, when nothing was. Never an error - these are decisions. */
  skipped?: string;
  /** Set when the write was attempted and failed. */
  error?: string;
}

export const repairOrderAddresses = async (
  container: MedusaContainer,
  logger: Logger,
  orderId: string,
  plan: OrderAddressPlan,
): Promise<RepairAddressResult> => {
  if (plan.kind === "skip") {
    return { repaired: false, skipped: plan.reason };
  }

  // Everything below is inside the try, including resolving the module and the
  // re-read. This function promises never to be fatal - a repair that cannot
  // happen must leave the order where it already was, not take down the drain
  // pass around it - and a resolve or a read can fail just as a write can.
  try {
    const orders = container.resolve<IOrderModuleService>(Modules.ORDER);

    // The gap-only invariant, re-checked against the order as it is RIGHT NOW.
    //
    // Not a duplicate of the planner: the planner decided from a snapshot read
    // earlier in this pass, and this is the last moment before a write that no
    // longer has a workflow validating it. Since the bypass above removed the only
    // downstream guard, this re-check is the sole thing standing between a repair
    // and an overwrite, so it does not get to depend on a caller having planned
    // correctly.
    const [current] = await orders.listOrders(
      { id: orderId },
      { relations: ["shipping_address", "billing_address"], select: ["id"] },
    );
    const wouldOverwrite =
      (plan.patch.shipping_address && current?.shipping_address) ||
      (plan.patch.billing_address && current?.billing_address);
    if (wouldOverwrite) {
      logger.warn(
        `[allegro-orders] refusing to fill ${plan.fields.join(", ")} on Medusa order ${orderId}: it already has an address now, so this pass would overwrite rather than fill. Left alone.`,
      );
      return {
        repaired: false,
        skipped: "the order gained an address between planning and writing",
      };
    }

    await orders.updateOrders([{ id: orderId, ...plan.patch }]);
    logger.info(
      `[allegro-orders] filled ${plan.fields.join(", ")} on Medusa order ${orderId} from the Allegro checkout form, which had no address when the order was created. Only absent addresses were written; anything already set was left alone.`,
    );
    return { repaired: true };
  } catch (error) {
    const message = describeError(error);
    logger.warn(
      `[allegro-orders] could not fill ${plan.fields.join(", ")} on Medusa order ${orderId}: ${message}. The order is otherwise applied and the next pass retries this.`,
    );
    return { error: message, repaired: false };
  }
};
