export type OrderDiscountPayload = {
  discount_applications?: { type?: string; title?: string; value?: string }[];
  line_items?: {
    discount_allocations?: {
      amount?: string;
      amount_set?: { presentment_money?: { amount?: string } };
      discount_application_index?: number;
    }[];
  }[];
};

/**
 * Total the order's loyalty discount actually took off, from an orders/paid
 * payload. The discount is found by title — the order may record either the
 * discount's title or the Function's message, so callers pass both. Returns
 * null when the order has no loyalty discount at all.
 */
export function loyaltyDiscountAmount(payload: OrderDiscountPayload, titles: string[]) {
  const applications = payload.discount_applications ?? [];
  const indexes = applications
    .map((application, index) => ({ application, index }))
    .filter(({ application }) => application.type === "automatic" && titles.includes(application.title ?? ""))
    .map(({ index }) => index);
  if (indexes.length === 0) return null;

  let amount = 0;
  for (const line of payload.line_items ?? []) {
    for (const allocation of line.discount_allocations ?? []) {
      if (indexes.includes(allocation.discount_application_index ?? -1)) {
        // The Function sets its amount in the cart's (presentment) currency.
        amount += Number(allocation.amount_set?.presentment_money?.amount ?? allocation.amount ?? 0);
      }
    }
  }
  if (amount <= 0) {
    amount = indexes.reduce((sum, i) => sum + Number(applications[i]?.value ?? 0), 0);
  }
  return amount;
}

/** Points a discount amount is worth, never more than the buyer asked to spend. */
export function pointsForDiscount(amount: number, redemptionRate: number, requested: number) {
  if (!(redemptionRate > 0) || !(amount > 0)) return 0;
  return Math.max(0, Math.min(requested, Math.round(amount * redemptionRate)));
}
