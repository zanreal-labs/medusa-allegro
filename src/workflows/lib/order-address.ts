import type { Logger, MedusaContainer } from "@medusajs/framework/types";
import { updateOrderWorkflow } from "@medusajs/medusa/core-flows";
import type { OrderAddressPlan } from "../../lib/sync/order-address";

/**
 * Writing an address onto an order that was created without one.
 *
 * ## Through the stock workflow, not the module service
 *
 * `updateOrderWorkflow` is what the admin's own order edit uses, so this write
 * takes the same path as every other order edit - hooks, events and validation
 * included. The same reasoning `nameOrderCustomer` and `registerOrderPayment`
 * already apply.
 *
 * That validation is worth having here specifically: the workflow REFUSES a change
 * to an address's country code. This only ever fills an address that is absent, so
 * there is no country to change and the refusal can never fire - but it means that
 * if this were ever loosened into an overwrite, the workflow itself would stop the
 * most dangerous version of it.
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

/**
 * Who the resulting order change is attributed to.
 *
 * `updateOrderWorkflow` records `created_by`/`confirmed_by` on an order change from
 * this value, so the repair is auditable rather than anonymous. Deliberately a
 * synthetic name and not a real admin's id: no person made this edit, and borrowing
 * an operator's identity for a background write would put their name on something
 * they never did.
 */
export const ADDRESS_REPAIR_ACTOR = "allegro-order-sync";

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

  try {
    await updateOrderWorkflow(container).run({
      input: { id: orderId, user_id: ADDRESS_REPAIR_ACTOR, ...plan.patch },
    });
    logger.info(
      `[allegro-orders] filled ${plan.fields.join(", ")} on Medusa order ${orderId} from the Allegro checkout form, which had no address when the order was created. Only absent addresses were written; anything already set was left alone.`,
    );
    return { repaired: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(
      `[allegro-orders] could not fill ${plan.fields.join(", ")} on Medusa order ${orderId}: ${message}. The order is otherwise applied and the next pass retries this.`,
    );
    return { error: message, repaired: false };
  }
};
