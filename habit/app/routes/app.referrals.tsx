import { useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useSearchParams } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { Prisma } from "@prisma/client";
import { PointTransactionType, ReferralCodeStatus } from "@prisma/client";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  createReferralCode,
  getOrCreateShopSettings,
  ReferralError,
} from "../lib/ledger.server";
import { syncCustomersFromShopify } from "../lib/loyalty.server";
import type { ShopifyCustomerOption } from "../lib/loyalty.server";
import { parseRequestUrl } from "../lib/request-url.server";
import type { loader as customerSearchLoader } from "./app.customer-search";

const PAGE_SIZE = 50;
const MAX_EXPIRY_DAYS = 3650;
const STATUS_FILTERS = ["all", "active", "redeemed", "expired", "revoked"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

// A code past its expiry date stays ACTIVE in the database until someone tries
// to use it, so "active" and "expired" are decided by the date as well.
function statusWhere(filter: StatusFilter, now: Date): Prisma.ReferralCodeWhereInput {
  switch (filter) {
    case "active":
      return {
        status: ReferralCodeStatus.ACTIVE,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      };
    case "expired":
      return {
        OR: [
          { status: ReferralCodeStatus.EXPIRED },
          { status: ReferralCodeStatus.ACTIVE, expiresAt: { lte: now } },
        ],
      };
    case "redeemed":
      return { status: ReferralCodeStatus.REDEEMED };
    case "revoked":
      return { status: ReferralCodeStatus.REVOKED };
    default:
      return {};
  }
}

function referralsHref(page: number, q: string, status: StatusFilter) {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (status !== "all") params.set("status", status);
  if (page > 1) params.set("page", String(page));
  const qs = params.toString();
  return qs ? `/app/referrals?${qs}` : "/app/referrals";
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = parseRequestUrl(request);
  const q = url.searchParams.get("q")?.trim() ?? "";
  const rawStatus = url.searchParams.get("status") ?? "all";
  const status: StatusFilter = (STATUS_FILTERS as readonly string[]).includes(rawStatus)
    ? (rawStatus as StatusFilter)
    : "all";
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);
  const now = new Date();

  const where: Prisma.ReferralCodeWhereInput = {
    shop,
    AND: [
      statusWhere(status, now),
      q
        ? {
            OR: [
              { code: { contains: q, mode: "insensitive" } },
              { owner: { email: { contains: q, mode: "insensitive" } } },
              { owner: { displayName: { contains: q, mode: "insensitive" } } },
            ],
          }
        : {},
    ],
  };

  const [settings, rows, activeCount, redeemedCount, bonusPoints] = await Promise.all([
    getOrCreateShopSettings(shop),
    db.referralCode.findMany({
      where,
      include: { owner: true, redeemedByCustomer: true },
      orderBy: { createdAt: "desc" },
      take: PAGE_SIZE + 1,
      skip: (page - 1) * PAGE_SIZE,
    }),
    db.referralCode.count({ where: { shop, ...statusWhere("active", now) } }),
    db.referralCode.count({ where: { shop, status: ReferralCodeStatus.REDEEMED } }),
    db.pointTransaction.aggregate({
      where: { shop, type: PointTransactionType.REFERRAL_BONUS },
      _sum: { points: true },
    }),
  ]);

  const memberLabel = (c: { displayName: string | null; email: string | null; shopifyCustomerId: string }) =>
    c.displayName || c.email || `Customer ${c.shopifyCustomerId}`;

  return {
    q,
    status,
    page,
    hasNext: rows.length > PAGE_SIZE,
    stats: {
      active: activeCount,
      redeemed: redeemedCount,
      bonusPoints: bonusPoints._sum.points ?? 0,
    },
    settings: {
      referrerBonusPoints: settings.referrerBonusPoints,
      refereeBonusPoints: settings.refereeBonusPoints,
      referralCodeExpiryDays: settings.referralCodeExpiryDays,
    },
    codes: rows.slice(0, PAGE_SIZE).map((c) => {
      const expired =
        c.status === ReferralCodeStatus.EXPIRED ||
        (c.status === ReferralCodeStatus.ACTIVE && c.expiresAt != null && c.expiresAt <= now);
      return {
        id: c.id,
        code: c.code,
        status: expired ? "EXPIRED" : c.status,
        owner: { id: c.owner.id, label: memberLabel(c.owner) },
        redeemedBy: c.redeemedByCustomer
          ? { id: c.redeemedByCustomer.id, label: memberLabel(c.redeemedByCustomer) }
          : null,
        redeemedAt: c.redeemedAt?.toISOString() ?? null,
        createdAt: c.createdAt.toISOString(),
        expiresAt: c.expiresAt?.toISOString() ?? null,
      };
    }),
  };
};

type ActionErrors = Partial<Record<"customer" | "code" | "expiresInDays", string>>;

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "revoke") {
    const codeId = String(formData.get("codeId") ?? "");
    const result = await db.referralCode.updateMany({
      where: { id: codeId, shop, status: ReferralCodeStatus.ACTIVE },
      data: { status: ReferralCodeStatus.REVOKED },
    });
    return { revoked: result.count > 0 };
  }

  if (intent === "create") {
    const errors: ActionErrors = {};
    const shopifyCustomerId = String(formData.get("shopifyCustomerId") ?? "").trim();
    const code = String(formData.get("code") ?? "").trim();
    const rawExpiry = String(formData.get("expiresInDays") ?? "").trim();

    if (!/^\d+$/.test(shopifyCustomerId)) {
      errors.customer = "Choose the customer who will share this code.";
    }
    let expiresInDays: number | null = null;
    if (rawExpiry) {
      const days = Number(rawExpiry);
      if (!Number.isInteger(days) || days <= 0 || days > MAX_EXPIRY_DAYS) {
        errors.expiresInDays = `Enter a whole number of days from 1 to ${MAX_EXPIRY_DAYS}, or leave blank for no expiry.`;
      } else {
        expiresInDays = days;
      }
    }
    if (Object.keys(errors).length) return { errors };

    // Pull the customer's name and email so the code's owner is recognisable
    // even if they have never ordered.
    try {
      await syncCustomersFromShopify(shop, admin, [shopifyCustomerId]);
    } catch (error) {
      console.warn("Could not sync referral owner from Shopify", error);
    }

    try {
      const created = await createReferralCode(shop, shopifyCustomerId, {
        code: code || undefined,
        expiresInDays,
        createdByMerchant: true,
      });
      return { created: created.code };
    } catch (error) {
      if (error instanceof ReferralError) {
        return { errors: { code: error.message } satisfies ActionErrors };
      }
      throw error;
    }
  }

  return null;
};

const STATUS_TONE: Record<string, "success" | "info" | "critical" | "neutral"> = {
  ACTIVE: "info",
  REDEEMED: "success",
  EXPIRED: "neutral",
  REVOKED: "critical",
};

const STATUS_LABEL: Record<string, string> = {
  ACTIVE: "Active",
  REDEEMED: "Used",
  EXPIRED: "Expired",
  REVOKED: "Revoked",
};

function customerLabel(customer: ShopifyCustomerOption) {
  return customer.displayName || customer.email || `Customer ${customer.id}`;
}

function CreateReferralCode({ defaultExpiryDays }: { defaultExpiryDays: number }) {
  const shopify = useAppBridge();
  const searchFetcher = useFetcher<typeof customerSearchLoader>();
  const createFetcher = useFetcher<typeof action>();
  const [selected, setSelected] = useState<ShopifyCustomerOption | null>(null);
  const [code, setCode] = useState("");
  const [expiry, setExpiry] = useState(String(defaultExpiryDays));
  // Bumped after a successful create so the uncontrolled fields reset.
  const [formSession, setFormSession] = useState(0);

  const errors: ActionErrors =
    (createFetcher.data && "errors" in createFetcher.data ? createFetcher.data.errors : null) ?? {};
  const creating = createFetcher.state !== "idle";

  // Load recent customers up front so the picker is never empty.
  useEffect(() => {
    if (searchFetcher.state === "idle" && !searchFetcher.data) {
      searchFetcher.load("/app/customer-search");
    }
  }, [searchFetcher]);

  useEffect(() => {
    if (createFetcher.state === "idle" && createFetcher.data && "created" in createFetcher.data) {
      shopify.toast.show(`Referral code ${createFetcher.data.created} created`);
      setSelected(null);
      setCode("");
      setExpiry(String(defaultExpiryDays));
      setFormSession((s) => s + 1);
    }
  }, [createFetcher.state, createFetcher.data, shopify, defaultExpiryDays]);

  const results = searchFetcher.data?.customers ?? [];

  return (
    <s-section heading="Create a referral code">
      <s-stack direction="block" gap="base">
        <s-paragraph color="subdued">
          Give a code to a customer to share with friends. When a friend uses it on their first
          order, both earn bonus points.
        </s-paragraph>

        {selected ? (
          <s-stack direction="block" gap="small-200">
            <s-text color="subdued">Referrer</s-text>
            <s-stack direction="inline" gap="small-200" alignItems="center">
              <s-text type="strong">{customerLabel(selected)}</s-text>
              {selected.displayName && selected.email ? (
                <s-text color="subdued">{selected.email}</s-text>
              ) : null}
              <s-button variant="tertiary" onClick={() => setSelected(null)}>
                Change
              </s-button>
            </s-stack>
          </s-stack>
        ) : (
          <s-stack direction="block" gap="small-200">
            <s-search-field
              key={`search-${formSession}`}
              label="Referrer"
              placeholder="Search customers by name or email"
              error={errors.customer}
              onInput={(e: any) => {
                const value = e.currentTarget?.value ?? "";
                searchFetcher.load(`/app/customer-search?q=${encodeURIComponent(value)}`);
              }}
            />
            {searchFetcher.data?.error ? (
              <s-text tone="critical">{searchFetcher.data.error}</s-text>
            ) : results.length === 0 ? (
              <s-text color="subdued">
                {searchFetcher.state === "loading" ? "Searching…" : "No customers found."}
              </s-text>
            ) : (
              <s-box border="base" borderRadius="base">
                {results.map((customer, index) => (
                  <s-box key={customer.id}>
                    {index > 0 ? <s-divider /> : null}
                    <s-clickable
                      onClick={() => setSelected(customer)}
                      paddingBlock="small-200"
                      paddingInline="small-100"
                      accessibilityLabel={`Choose ${customerLabel(customer)}`}
                    >
                      <s-stack direction="inline" gap="small-200">
                        <s-text>{customerLabel(customer)}</s-text>
                        {customer.displayName && customer.email ? (
                          <s-text color="subdued">{customer.email}</s-text>
                        ) : null}
                      </s-stack>
                    </s-clickable>
                  </s-box>
                ))}
              </s-box>
            )}
          </s-stack>
        )}

        <s-grid gridTemplateColumns="1fr 1fr" gap="base">
          <s-text-field
            key={`code-${formSession}`}
            label="Code"
            placeholder="e.g. FRIEND10"
            details="Leave blank to generate one."
            defaultValue={code}
            error={errors.code}
            onInput={(e: any) => setCode(e.currentTarget?.value ?? "")}
          />
          <s-number-field
            key={`expiry-${formSession}`}
            label="Expires after (days)"
            details="Leave blank for no expiry."
            defaultValue={expiry}
            min={1}
            max={MAX_EXPIRY_DAYS}
            step={1}
            error={errors.expiresInDays}
            onInput={(e: any) => setExpiry(e.currentTarget?.value ?? "")}
          />
        </s-grid>

        <s-stack direction="inline">
          <s-button
            variant="primary"
            loading={creating}
            onClick={() =>
              createFetcher.submit(
                {
                  intent: "create",
                  shopifyCustomerId: selected?.id ?? "",
                  code,
                  expiresInDays: expiry,
                },
                { method: "POST" },
              )
            }
          >
            Create code
          </s-button>
        </s-stack>
      </s-stack>
    </s-section>
  );
}

export default function Referrals() {
  const { q, status, page, hasNext, stats, settings, codes } = useLoaderData<typeof loader>();
  const revokeFetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const [, setSearchParams] = useSearchParams();

  useEffect(() => {
    if (revokeFetcher.state === "idle" && revokeFetcher.data && "revoked" in revokeFetcher.data) {
      shopify.toast.show(revokeFetcher.data.revoked ? "Referral code revoked" : "Code was already inactive");
    }
  }, [revokeFetcher.state, revokeFetcher.data, shopify]);

  const setFilter = (next: { q?: string; status?: string }) => {
    const params = new URLSearchParams();
    const nextQ = next.q ?? q;
    const nextStatus = next.status ?? status;
    if (nextQ) params.set("q", nextQ);
    if (nextStatus !== "all") params.set("status", nextStatus);
    setSearchParams(params);
  };

  const copyCode = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      shopify.toast.show(`Copied ${value}`);
    } catch {
      shopify.toast.show("Couldn't copy — select the code instead", { isError: true });
    }
  };

  return (
    <s-page heading="Referrals">
      <s-section>
        <s-grid gridTemplateColumns="repeat(3, 1fr)" gap="base">
          <s-stack direction="block" gap="small-200">
            <s-text color="subdued">Active codes</s-text>
            <s-heading>{stats.active.toLocaleString()}</s-heading>
          </s-stack>
          <s-stack direction="block" gap="small-200">
            <s-text color="subdued">Successful referrals</s-text>
            <s-heading>{stats.redeemed.toLocaleString()}</s-heading>
          </s-stack>
          <s-stack direction="block" gap="small-200">
            <s-text color="subdued">Bonus points awarded</s-text>
            <s-heading>{stats.bonusPoints.toLocaleString()}</s-heading>
          </s-stack>
        </s-grid>
      </s-section>

      <CreateReferralCode defaultExpiryDays={settings.referralCodeExpiryDays} />

      <s-section heading="Referral codes">
        <s-stack direction="block" gap="base">
          <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="end">
            <s-search-field
              label="Search referral codes"
              labelAccessibilityVisibility="exclusive"
              placeholder="Search by code, name, or email"
              value={q}
              onChange={(e: any) => setFilter({ q: e.currentTarget?.value ?? "" })}
            />
            <s-select
              label="Status"
              labelAccessibilityVisibility="exclusive"
              value={status}
              onChange={(e: any) => setFilter({ status: e.currentTarget?.value ?? "all" })}
            >
              <s-option value="all">All statuses</s-option>
              <s-option value="active">Active</s-option>
              <s-option value="redeemed">Used</s-option>
              <s-option value="expired">Expired</s-option>
              <s-option value="revoked">Revoked</s-option>
            </s-select>
          </s-grid>

          {codes.length === 0 ? (
            <s-paragraph color="subdued">
              {q || status !== "all"
                ? "No referral codes match these filters."
                : "No referral codes yet. Create one above, or customers can get their own from the rewards widget and their account page."}
            </s-paragraph>
          ) : (
            <s-table variant="auto">
              <s-table-header-row>
                <s-table-header listSlot="primary">Code</s-table-header>
                <s-table-header listSlot="labeled">Referrer</s-table-header>
                <s-table-header listSlot="inline">Status</s-table-header>
                <s-table-header listSlot="labeled">Used by</s-table-header>
                <s-table-header listSlot="labeled">Expires</s-table-header>
                <s-table-header listSlot="labeled">Actions</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {codes.map((c) => (
                  <s-table-row key={c.id}>
                    <s-table-cell>
                      <s-text type="strong">{c.code}</s-text>
                    </s-table-cell>
                    <s-table-cell>
                      <s-link href={`/app/customers/${c.owner.id}`}>{c.owner.label}</s-link>
                    </s-table-cell>
                    <s-table-cell>
                      <s-badge tone={STATUS_TONE[c.status] ?? "neutral"}>
                        {STATUS_LABEL[c.status] ?? c.status}
                      </s-badge>
                    </s-table-cell>
                    <s-table-cell>
                      {c.redeemedBy ? (
                        <s-link href={`/app/customers/${c.redeemedBy.id}`}>{c.redeemedBy.label}</s-link>
                      ) : (
                        "—"
                      )}
                    </s-table-cell>
                    <s-table-cell>
                      {c.expiresAt ? new Date(c.expiresAt).toLocaleDateString() : "Never"}
                    </s-table-cell>
                    <s-table-cell>
                      <s-stack direction="inline" gap="small-200">
                        <s-button variant="tertiary" onClick={() => copyCode(c.code)}>
                          Copy
                        </s-button>
                        {c.status === "ACTIVE" ? (
                          <s-button
                            variant="tertiary"
                            tone="critical"
                            loading={
                              revokeFetcher.state !== "idle" &&
                              revokeFetcher.formData?.get("codeId") === c.id
                            }
                            onClick={() =>
                              revokeFetcher.submit({ intent: "revoke", codeId: c.id }, { method: "POST" })
                            }
                          >
                            Revoke
                          </s-button>
                        ) : null}
                      </s-stack>
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          )}

          {codes.length > 0 ? (
            <s-stack direction="inline" gap="small-200">
              <s-button
                disabled={page <= 1}
                href={page <= 1 ? undefined : referralsHref(page - 1, q, status)}
              >
                Previous
              </s-button>
              <s-button
                disabled={!hasNext}
                href={!hasNext ? undefined : referralsHref(page + 1, q, status)}
              >
                Next
              </s-button>
            </s-stack>
          ) : null}
        </s-stack>
      </s-section>

      <s-section heading="How referrals work" slot="aside">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            The referrer earns <s-text type="strong">{settings.referrerBonusPoints.toLocaleString()} points</s-text>{" "}
            and their friend earns{" "}
            <s-text type="strong">{settings.refereeBonusPoints.toLocaleString()} points</s-text> when the
            friend's first paid order uses the code.
          </s-paragraph>
          <s-paragraph>Customers enter a code in either place:</s-paragraph>
          <s-unordered-list>
            <s-list-item>
              The cart: "Have a referral code?" under the cart's checkout button (needs the "Redeem
              points in cart" app embed on).
            </s-list-item>
            <s-list-item>
              Checkout: the Habit block under the discount field (Shopify Plus).
            </s-list-item>
          </s-unordered-list>
          <s-paragraph color="subdued">
            Each customer can use one referral code, and not their own. Customers can also get
            their own code from the rewards widget or their account page.
          </s-paragraph>
          <s-link href="/app/settings">Change bonus amounts and expiry</s-link>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
