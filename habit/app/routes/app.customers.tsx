import { useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useSearchParams } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { PointTransactionType } from "@prisma/client";
import { authenticate } from "../shopify.server";
import db from "../db.server";

const ADJUST_MODAL_ID = "adjust-points-modal";

function membersHref(page: number, q: string) {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (page > 1) params.set("page", String(page));
  const qs = params.toString();
  return qs ? `/app/customers?${qs}` : "/app/customers";
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const q = url.searchParams.get("q")?.trim() ?? "";
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);
  const PAGE_SIZE = 50;

  const rows = await db.customer.findMany({
    where: {
      shop: session.shop,
      ...(q
        ? {
            OR: [
              { email: { contains: q, mode: "insensitive" } },
              { displayName: { contains: q, mode: "insensitive" } },
              { shopifyCustomerId: { contains: q } },
            ],
          }
        : {}),
    },
    include: { vipTier: true },
    orderBy: { updatedAt: "desc" },
    take: PAGE_SIZE + 1,
    skip: (page - 1) * PAGE_SIZE,
  });

  const hasNext = rows.length > PAGE_SIZE;
  const customers = rows.slice(0, PAGE_SIZE);

  return {
    q,
    page,
    hasNext,
    customers: customers.map((c) => ({
      id: c.id,
      shopifyCustomerId: c.shopifyCustomerId,
      email: c.email,
      displayName: c.displayName,
      pointsBalance: c.pointsBalance,
      tierName: c.vipTier?.name ?? null,
      createdAt: c.createdAt.toISOString(),
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const customerId = String(formData.get("customerId"));
  const amount = Number(formData.get("amount"));
  const reason = String(formData.get("reason") ?? "").trim();

  if (!customerId || !Number.isFinite(amount) || amount === 0) {
    return { errors: { amount: "Enter a non-zero number of points." } };
  }
  if (!reason) {
    return { errors: { reason: "A reason is required for manual adjustments." } };
  }

  const customer = await db.customer.findFirst({
    where: { id: customerId, shop: session.shop },
  });
  if (!customer) return { errors: { amount: "Member not found." } };

  await db.$transaction([
    db.pointTransaction.create({
      data: {
        shop: session.shop,
        customerId: customer.id,
        type: PointTransactionType.MANUAL_ADJUSTMENT,
        points: amount,
        description: reason,
      },
    }),
    db.customer.update({
      where: { id: customer.id },
      data: { pointsBalance: { increment: amount } },
    }),
  ]);

  return { ok: true };
};

export default function Customers() {
  const { q, page, hasNext, customers } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const [, setSearchParams] = useSearchParams();
  const modalRef = useRef<any>(null);
  const [target, setTarget] = useState<{ id: string; label: string } | null>(null);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  // Mirror target/amount/reason in refs for reads inside handleAdjust. The
  // Save button lives in `<s-modal slot="primary-action">`, and that
  // slotted button's onClick handler gets "frozen" to whatever closure was
  // bound when the modal's content first committed — it does not pick up
  // newer closures from later re-renders. Refs sidestep this since
  // `.current` is always read fresh regardless of which closure reads it.
  const targetRef = useRef<{ id: string; label: string } | null>(null);
  const amountRef = useRef("");
  const reasonRef = useRef("");
  // Bumped every time the modal opens so the (uncontrolled) fields below
  // remount with a fresh defaultValue instead of relying on a controlled
  // `value` prop, which Polaris's number/text field elements don't reliably
  // accept updates to after mount.
  const [modalSession, setModalSession] = useState(0);
  const errors: Partial<Record<"amount" | "reason", string>> =
    (fetcher.data && "errors" in fetcher.data ? fetcher.data.errors : null) ?? {};

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data && !("errors" in fetcher.data && fetcher.data.errors)) {
      modalRef.current?.hideOverlay?.();
      setAmount("");
      setReason("");
      shopify.toast.show("Points adjusted");
    }
  }, [fetcher.state, fetcher.data, shopify]);

  const openAdjust = (customer: {
    id: string;
    email: string | null;
    displayName: string | null;
    shopifyCustomerId: string;
  }) => {
    const label = customer.displayName || customer.email || customer.shopifyCustomerId;
    targetRef.current = { id: customer.id, label };
    amountRef.current = "";
    reasonRef.current = "";
    setTarget({ id: customer.id, label });
    setAmount("");
    setReason("");
    setModalSession((s) => s + 1);
    modalRef.current?.showOverlay?.();
  };

  const handleAdjust = () => {
    const currentTarget = targetRef.current;
    if (!currentTarget) return;
    fetcher.submit(
      { customerId: currentTarget.id, amount: amountRef.current, reason: reasonRef.current },
      { method: "POST" },
    );
  };

  return (
    <s-page heading="Members">
      <s-section>
        <s-search-field
          label="Search members"
          labelAccessibilityVisibility="exclusive"
          placeholder="Search by name, email, or customer ID"
          value={q}
          onChange={(e: any) => {
            const value = e.currentTarget?.value ?? "";
            setSearchParams(value ? { q: value } : {});
          }}
        />
      </s-section>

      <s-section>
        {customers.length === 0 ? (
          <s-paragraph color="subdued">
            No members yet. They'll show up here after their first order.
          </s-paragraph>
        ) : (
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header listSlot="primary">Member</s-table-header>
              <s-table-header listSlot="labeled">Points balance</s-table-header>
              <s-table-header listSlot="labeled">VIP tier</s-table-header>
              <s-table-header listSlot="labeled">Actions</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {customers.map((customer) => (
                <s-table-row key={customer.id}>
                  <s-table-cell>
                    <s-link href={`/app/customers/${customer.id}`}>
                      {customer.displayName || customer.email || customer.shopifyCustomerId}
                    </s-link>
                    {customer.displayName && customer.email ? (
                      <>
                        <br />
                        <s-text color="subdued">{customer.email}</s-text>
                      </>
                    ) : null}
                  </s-table-cell>
                  <s-table-cell>{customer.pointsBalance.toLocaleString()}</s-table-cell>
                  <s-table-cell>{customer.tierName ?? "—"}</s-table-cell>
                  <s-table-cell>
                    <s-button variant="tertiary" onClick={() => openAdjust(customer)}>
                      Adjust points
                    </s-button>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
        {customers.length > 0 ? (
          <s-box paddingBlockStart="base">
            <s-stack direction="inline" gap="small-200">
              <s-button
                disabled={page <= 1}
                href={page <= 1 ? undefined : membersHref(page - 1, q)}
              >
                Previous
              </s-button>
              <s-button disabled={!hasNext} href={!hasNext ? undefined : membersHref(page + 1, q)}>
                Next
              </s-button>
            </s-stack>
          </s-box>
        ) : null}
      </s-section>

      <s-modal id={ADJUST_MODAL_ID} ref={modalRef} heading={`Adjust points${target ? ` — ${target.label}` : ""}`}>
        <s-stack direction="block" gap="base">
          <s-number-field
            key={`amount-${modalSession}`}
            label="Points to add (use a negative number to subtract)"
            defaultValue={amount}
            error={errors.amount}
            step={1}
            onInput={(e: any) => {
              const value = e.currentTarget?.value ?? "";
              amountRef.current = value;
              setAmount(value);
            }}
          />
          <s-text-field
            key={`reason-${modalSession}`}
            label="Reason"
            defaultValue={reason}
            error={errors.reason}
            details="Shown in the member's ledger history."
            onInput={(e: any) => {
              const value = e.currentTarget?.value ?? "";
              reasonRef.current = value;
              setReason(value);
            }}
          />
        </s-stack>
        <s-button slot="secondary-actions" commandFor={ADJUST_MODAL_ID} command="--hide">
          Cancel
        </s-button>
        <s-button slot="primary-action" variant="primary" onClick={handleAdjust}>
          Save adjustment
        </s-button>
      </s-modal>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
