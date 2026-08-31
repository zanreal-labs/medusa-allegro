import type { Logger, MedusaContainer } from "@medusajs/framework/types";
import { updateCustomersWorkflow } from "@medusajs/medusa/core-flows";
import { describeError } from "../../lib/allegro/errors";
import type { CustomerNamePlan } from "../../lib/sync/customer-identity";

/**
 * Writing the Allegro account holder's name onto the Medusa customer.
 *
 * ## Why it is a separate write at all
 *
 * `createOrderWorkflow` has no input that carries a customer name. Its
 * `findOrCreateCustomerStep` creates the customer from the email alone, so the name
 * cannot be passed in on the way through - it has to be written onto the customer the
 * order was just linked to. See `customer-identity` for which of the checkout form's
 * three people that name comes from, and why.
 *
 * ## Through the stock workflow, not the module service
 *
 * `updateCustomersWorkflow` is what the admin's own customer edit uses. Going through
 * it rather than calling `updateCustomers` directly keeps this write on the same path
 * as every other customer edit in the system, hooks and events included, which is the
 * same reasoning `registerOrderPayment` applies to marking a collection paid.
 *
 * ## Never fatal
 *
 * A failure here leaves an order that is correct in every other respect with an
 * unnamed customer. Throwing would hold the Allegro event cursor - stalling every
 * later order behind this one - over a display-level field, and it is not needed: the
 * plan is recomputed from scratch on every pass, so the next drain tick or
 * reconciliation sweep simply tries again.
 */

/** What one attempt to name the customer did. */
export interface NameCustomerResult {
  /** True when this pass actually wrote a name that was missing. */
  named: boolean;
  /** Why nothing was written, when nothing was. Never an error - these are decisions. */
  skipped?: string;
  /** Set when the write was attempted and failed. */
  error?: string;
}

export const nameOrderCustomer = async (
  container: MedusaContainer,
  logger: Logger,
  orderId: string,
  plan: CustomerNamePlan,
): Promise<NameCustomerResult> => {
  if (plan.kind === "skip") {
    return { named: false, skipped: plan.reason };
  }

  try {
    await updateCustomersWorkflow(container).run({
      input: { selector: { id: [plan.customerId] }, update: plan.patch },
    });
    // The COLUMNS, never the values. This line goes to a log the whole team reads, and
    // the values are the customer's name.
    logger.info(
      `[allegro-orders] filled ${plan.fields.join(", ")} on customer ${plan.customerId} (Medusa order ${orderId}) from the Allegro account holder. Only empty fields were written; anything already set was left alone.`,
    );
    return { named: true };
  } catch (error) {
    const message = describeError(error);
    logger.warn(
      `[allegro-orders] could not fill ${plan.fields.join(", ")} on customer ${plan.customerId} (Medusa order ${orderId}): ${message}. The order is otherwise applied and the next pass retries this.`,
    );
    return { error: message, named: false };
  }
};
