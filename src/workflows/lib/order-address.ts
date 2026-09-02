import type { IOrderModuleService, Logger, MedusaContainer } from "@medusajs/framework/types";
import { Modules } from "@medusajs/framework/utils";
import { describeError } from "../../lib/allegro/errors";
import {
  fillAddressGaps,
  isUsableAddress,
  readAddressFields,
} from "../../lib/sync/order-address";
import type { OrderAddressPlan } from "../../lib/sync/order-address";
import type { OrderAddress } from "./checkout-form";

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
 * a country code; this refuses to change ANY field that already has a value, and
 * only ever fills blanks. So the guard could only ever fire on the case already
 * made impossible here, or on the case it gets wrong. The safety bar is not
 * lowered - see the re-check below, which keeps that true regardless of what any
 * caller passes.
 *
 * ## The re-check is per FIELD, because a partial address is a gap
 *
 * It used to refuse whenever an address row existed at all. That read as strictness
 * and was in fact the bug: an order created from an unfinished checkout form carries a
 * billing address row with a name and a country and no street, city or postal code -
 * see `planOrderAddressRepair` - and refusing on the row's existence meant those three
 * fields were never filled in, on any pass. So the refusal is now "this side is already
 * a USABLE address", and what gets written is Allegro's copy merged UNDER whatever the
 * order currently holds, recomputed against the freshest read rather than against the
 * caller's plan.
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

/** The two sides of an order's address, so the write loop cannot miss one. */
const ADDRESS_SIDES = ["shipping_address", "billing_address"] as const;

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

    const patch: { shipping_address?: OrderAddress; billing_address?: OrderAddress } = {};
    const filled: string[] = [];
    const refused: string[] = [];
    for (const side of ADDRESS_SIDES) {
      const planned = plan.patch[side];
      if (!planned) {
        continue;
      }
      const held = readAddressFields(
        (current as unknown as Record<string, Record<string, unknown> | null>)?.[side],
      );
      if (isUsableAddress(held)) {
        refused.push(side);
        continue;
      }
      patch[side] = fillAddressGaps(held, planned);
      filled.push(side);
    }

    if (refused.length > 0) {
      logger.warn(
        `[allegro-orders] refusing to fill ${refused.join(", ")} on Medusa order ${orderId}: it already carries a complete address there now, so this pass would overwrite rather than fill. Left alone.`,
      );
    }
    if (filled.length === 0) {
      return {
        repaired: false,
        skipped: "the order gained a complete address between planning and writing",
      };
    }

    await orders.updateOrders([{ id: orderId, ...patch }]);
    logger.info(
      `[allegro-orders] filled ${filled.join(", ")} on Medusa order ${orderId} from the Allegro checkout form, which had no usable address there when the order was created. Only blank fields were written; anything already set was left alone.`,
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
