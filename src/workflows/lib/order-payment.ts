import type { Logger, MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import {
  createOrderPaymentCollectionWorkflow,
  markPaymentCollectionAsPaid,
} from "@medusajs/medusa/core-flows";
import { describeError } from "../../lib/allegro/errors";
import { parseAmount } from "../../lib/sync/money";
import type { AmountInput } from "../../lib/sync/money";
import type { OrderPaymentState, PaymentPlan } from "../../lib/sync/order-reconcile";

/**
 * Registering the money an Allegro buyer already paid on the Medusa order.
 *
 * ## Why this exists at all
 *
 * It did not, and that was the bug. The drain created the order and mapped the
 * status ladder, but nothing ever wrote a payment - `payment_collection` was empty
 * for every Allegro order this store has ever taken. Downstream that is not
 * cosmetic: inFakt's paid gate sums `payment_collections[].captured_amount` and
 * refuses to invoice until it covers the total, so a real, paid sale sat forever
 * with no invoice and nothing saying why.
 *
 * ## The money is already in hand, so this is a recording, not a charge
 *
 * An Allegro order arrives settled. Nobody is being charged here and no provider is
 * contacted for authorization - `markPaymentCollectionAsPaid` runs the collection
 * through the SYSTEM provider (`pp_system_default`), which is Medusa's own
 * "recorded outside Medusa" provider and exactly what the admin's "mark as paid"
 * button uses. Using the stock workflow rather than writing the rows by hand is
 * deliberate: it is the one path whose sessions, captures and order transactions
 * are guaranteed to agree with each other, and it emits `payment.captured`, which
 * is what the invoicing and digital-delivery subscribers are waiting for.
 *
 * That emission is the point, and it is also the reason this must never guess. See
 * `planOrderPayment` for the four cases it refuses.
 */

interface QueryGraph {
  graph: (input: {
    entity: string;
    fields: string[];
    filters?: Record<string, unknown>;
  }) => Promise<{ data: Record<string, unknown>[] }>;
}

interface PaymentCollectionRow {
  captured_amount?: AmountInput;
  refunded_amount?: AmountInput;
}

const toMinor = (amount: number | undefined): number => Math.round((amount ?? 0) * 100);

/**
 * Read what each order's payments currently cover, in one round trip.
 *
 * Read from the ORDER rather than from the payment module, because the link row is
 * what makes a collection count: an unlinked collection is invisible to
 * `order.payment_status` and to every consumer downstream of it, so counting one
 * would report an order as paid that no invoicing gate agrees is paid.
 *
 * Net of refunds. A fully refunded order is not a paid one, and sweeping it back
 * into the "unpaid" tier so a second payment gets registered on top is the worst
 * outcome available here.
 */
export const readOrderPaymentStates = async (
  container: MedusaContainer,
  logger: Logger,
  orderIds: readonly string[],
): Promise<Map<string, OrderPaymentState>> => {
  const states = new Map<string, OrderPaymentState>();
  if (orderIds.length === 0) {
    return states;
  }
  try {
    const query = container.resolve<QueryGraph>(ContainerRegistrationKeys.QUERY);
    const { data } = await query.graph({
      entity: "order",
      fields: [
        "id",
        "total",
        "payment_collections.id",
        "payment_collections.captured_amount",
        "payment_collections.refunded_amount",
      ],
      // Batched on purpose. The sweep classifies every open order on every tick, and one
      // round trip per order turns a cheap local read into the sweep's dominant cost.
      filters: { id: [...orderIds] },
    });
    for (const order of data) {
      const collections = (order.payment_collections as PaymentCollectionRow[] | null) ?? [];
      const capturedMinor = collections.reduce(
        (sum, collection) =>
          sum +
          toMinor(parseAmount(collection.captured_amount)) -
          toMinor(parseAmount(collection.refunded_amount)),
        0,
      );
      states.set(order.id as string, {
        capturedMinor,
        collections: collections.length,
        totalMinor: toMinor(parseAmount(order.total as AmountInput)),
      });
    }
  } catch (error) {
    logger.warn(
      `[allegro-orders] could not read the payment state of ${orderIds.length} Medusa order(s): ${describeError(error)}. No payment is registered against a state that could not be read - inventing one is the failure this guard exists to prevent.`,
    );
  }
  return states;
};

/** The single-order read, for the apply path. */
export const readOrderPaymentState = async (
  container: MedusaContainer,
  logger: Logger,
  orderId: string,
): Promise<OrderPaymentState | undefined> =>
  (await readOrderPaymentStates(container, logger, [orderId])).get(orderId);

/** The order's currency, for the plan's comparison. Lowercased, or undefined. */
export const readOrderCurrency = (currencyCode: unknown): string | undefined =>
  typeof currencyCode === "string" ? currencyCode.trim().toLowerCase() || undefined : undefined;

/** What one attempt to register a payment did. */
export interface RegisterPaymentResult {
  registered: boolean;
  /** Why nothing was written, when nothing was. Never an error - these are decisions. */
  skipped?: string;
  /** Set when the write was attempted and failed. */
  error?: string;
}

/**
 * Whether this store has a payment module at all.
 *
 * It is conditional in at least one deployment of this plugin, so an absent module
 * is a configuration state to report rather than a crash to propagate. Failing the
 * whole form over it would hold the event cursor on something no retry fixes.
 */
const paymentModuleAvailable = (container: MedusaContainer): boolean => {
  try {
    return Boolean(container.resolve(Modules.PAYMENT, { allowUnregistered: true }));
  } catch {
    return false;
  }
};

/**
 * Create the payment collection and mark it paid.
 *
 * Two stock workflows, in this order, because the second needs a collection to
 * work on and the first is the only thing that links one to the order.
 *
 * Never fatal. A failure here leaves the order exactly as it was - unpaid, in the
 * fast reconciliation tier - so the next sweep retries it within seconds. Throwing
 * instead would hold the event cursor and eventually quarantine a form whose only
 * problem is that the payment module is misconfigured.
 */
export const registerOrderPayment = async (
  container: MedusaContainer,
  logger: Logger,
  orderId: string,
  plan: PaymentPlan,
): Promise<RegisterPaymentResult> => {
  if (plan.kind === "skip") {
    return { registered: false, skipped: plan.reason };
  }
  if (!paymentModuleAvailable(container)) {
    return {
      registered: false,
      skipped:
        "no payment module is registered in this Medusa instance, so a payment cannot be recorded. Register `@medusajs/medusa/payment` to unblock invoicing.",
    };
  }

  try {
    const { result } = await createOrderPaymentCollectionWorkflow(container).run({
      input: { amount: plan.amount, order_id: orderId },
    });
    const [collection] = result as { id: string }[];
    if (!collection?.id) {
      return {
        error: "the payment collection workflow returned no collection",
        registered: false,
      };
    }

    // `pp_system_default` by omission: the workflow's own default, and the correct
    // provider for money that moved outside Medusa. Passing a real provider would ask it
    // to authorize a charge that already happened.
    await markPaymentCollectionAsPaid(container).run({
      input: { order_id: orderId, payment_collection_id: collection.id },
    });

    logger.warn(
      `[allegro-orders] registered a payment of ${plan.amount} ${plan.currencyCode.toUpperCase()} on Medusa order ${orderId}, which Allegro reports the buyer completed at ${plan.capturedAt.toISOString()}. ` +
        // WARN rather than INFO, and deliberately so: on the event path this should never
        // happen, because the drain registers the payment as it applies the form. Reaching
        // this line from the sweep means an event was lost, and that is worth seeing.
        "Medusa stamps its own capture time, so the order's payment timestamp is when this ran, not when the buyer paid." +
        (plan.shortfall ? ` ${plan.shortfall}.` : ""),
    );
    return { registered: true };
  } catch (error) {
    const message = describeError(error);
    logger.error(
      `[allegro-orders] FAILED to register the buyer's payment on Medusa order ${orderId}: ${message}. The order stays unpaid, so it stays in the fast reconciliation tier and the next sweep retries it. Invoicing is blocked until this succeeds.`,
    );
    return { error: message, registered: false };
  }
};
