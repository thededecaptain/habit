import { useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";

const TIER_MODAL_ID = "tier-modal";
const DELETE_MODAL_ID = "delete-tier-modal";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const tiers = await db.vipTier.findMany({
    where: { shop: session.shop },
    orderBy: { sortOrder: "asc" },
  });

  return {
    tiers: tiers.map((tier) => ({
      id: tier.id,
      name: tier.name,
      minSpend: tier.minSpend ? Number(tier.minSpend) : null,
      minOrders: tier.minOrders,
      earnMultiplier: Number(tier.earnMultiplier),
      sortOrder: tier.sortOrder,
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "delete") {
    const id = String(formData.get("id"));
    await db.vipTier.deleteMany({ where: { id, shop } });
    return { ok: true };
  }

  const name = String(formData.get("name") ?? "").trim();
  const minSpendRaw = String(formData.get("minSpend") ?? "").trim();
  const minOrdersRaw = String(formData.get("minOrders") ?? "").trim();
  const earnMultiplier = Number(formData.get("earnMultiplier"));
  const sortOrderRaw = String(formData.get("sortOrder") ?? "").trim();
  const minSpend = minSpendRaw ? Number(minSpendRaw) : null;
  const minOrders = minOrdersRaw ? Number(minOrdersRaw) : null;
  const sortOrder = sortOrderRaw ? Number(sortOrderRaw) : 0;

  // Bounds match the database columns, so bad input gets a field error
  // instead of a failed write.
  const errors: Record<string, string> = {};
  if (!name) errors.name = "Tier name is required.";
  else if (name.length > 50) errors.name = "Keep the tier name to 50 characters or fewer.";
  if (minSpend == null && minOrders == null) {
    errors.minSpend = "Set a minimum spend or minimum order count (or both).";
  } else if (minSpend != null && (!Number.isFinite(minSpend) || minSpend < 0 || minSpend > 99_999_999)) {
    errors.minSpend = "Minimum spend must be a positive amount.";
  }
  if (minOrders != null && (!Number.isInteger(minOrders) || minOrders < 0 || minOrders > 1_000_000)) {
    errors.minOrders = "Minimum orders must be a whole number.";
  }
  if (!Number.isFinite(earnMultiplier) || earnMultiplier <= 0 || earnMultiplier > 10) {
    errors.earnMultiplier = "Earn multiplier must be more than 0 and at most 10.";
  }
  if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 1000) {
    errors.sortOrder = "Sort order must be a whole number from 0 to 1000.";
  }
  if (Object.keys(errors).length > 0) {
    return { errors };
  }

  const id = String(formData.get("id") ?? "");
  const duplicate = await db.vipTier.findFirst({
    where: { shop, name: { equals: name, mode: "insensitive" }, ...(intent === "update" ? { id: { not: id } } : {}) },
  });
  if (duplicate) {
    return { errors: { name: `There's already a tier called ${duplicate.name}.` } };
  }

  const data = {
    shop,
    name,
    minSpend,
    minOrders,
    earnMultiplier: Math.round(earnMultiplier * 100) / 100,
    sortOrder,
  };

  if (intent === "update") {
    await db.vipTier.updateMany({ where: { id, shop }, data });
  } else {
    await db.vipTier.create({ data });
  }

  return { ok: true };
};

type Tier = ReturnType<typeof useLoaderData<typeof loader>>["tiers"][number];

const emptyTier = {
  id: "",
  name: "",
  minSpend: null as number | null,
  minOrders: null as number | null,
  earnMultiplier: 1,
  sortOrder: 0,
};

export default function VipTiers() {
  const { tiers } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const modalRef = useRef<any>(null);
  const deleteModalRef = useRef<any>(null);
  const [editing, setEditing] = useState<Tier | typeof emptyTier>(emptyTier);
  // Mirrors `editing` for reads at save-time. The Save button lives inside
  // `<s-modal slot="primary-action">`, and that slotted button's onClick
  // handler appears to get "frozen" to whatever closure was bound when the
  // modal's content was first committed — it does NOT pick up newer closures
  // from later re-renders (confirmed: onInput's functional setState updates
  // land fine, but handleSave read back the original emptyTier every time).
  // Refs sidestep this entirely: `.current` is always read fresh, regardless
  // of which "version" of the click handler closure ends up bound.
  const editingRef = useRef<Tier | typeof emptyTier>(emptyTier);
  // Bumped every time the modal opens so the (uncontrolled) fields below
  // remount with a fresh defaultValue instead of relying on a controlled
  // `value` prop, which Polaris's number/text field elements don't reliably
  // accept updates to after mount. Fields use onInput (fires per keystroke)
  // rather than onChange (fires on blur), since blur can race with a Save
  // button click inside a modal and lose the last-typed value.
  const [modalSession, setModalSession] = useState(0);
  const pendingDeleteIdRef = useRef<string | null>(null);
  const errors = fetcher.data && "errors" in fetcher.data ? fetcher.data.errors ?? {} : {};

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data && !("errors" in fetcher.data && fetcher.data.errors)) {
      modalRef.current?.hideOverlay?.();
      deleteModalRef.current?.hideOverlay?.();
      shopify.toast.show("Saved");
    }
  }, [fetcher.state, fetcher.data, shopify]);

  const openCreate = () => {
    editingRef.current = emptyTier;
    setEditing(emptyTier);
    setModalSession((s) => s + 1);
    modalRef.current?.showOverlay?.();
  };

  const openEdit = (tier: Tier) => {
    editingRef.current = tier;
    setEditing(tier);
    setModalSession((s) => s + 1);
    modalRef.current?.showOverlay?.();
  };

  const handleSave = () => {
    const current = editingRef.current;
    fetcher.submit(
      {
        intent: current.id ? "update" : "create",
        id: current.id,
        name: current.name,
        minSpend: current.minSpend ?? "",
        minOrders: current.minOrders ?? "",
        earnMultiplier: String(current.earnMultiplier),
        sortOrder: String(current.sortOrder),
      },
      { method: "POST" },
    );
  };

  const confirmDelete = (id: string) => {
    pendingDeleteIdRef.current = id;
    deleteModalRef.current?.showOverlay?.();
  };

  const handleDelete = () => {
    const id = pendingDeleteIdRef.current;
    if (!id) return;
    fetcher.submit({ intent: "delete", id }, { method: "POST" });
  };

  return (
    <s-page heading="VIP tiers">
      <s-button slot="primary-action" variant="primary" onClick={openCreate}>
        Add tier
      </s-button>

      <s-section>
        <s-paragraph color="subdued">
          Tiers are based on lifetime spend and orders and never drop.
        </s-paragraph>
      </s-section>
      <s-section>
        {tiers.length === 0 ? (
          <s-paragraph color="subdued">
            No VIP tiers yet. Members earn the base rate until you add one.
          </s-paragraph>
        ) : (
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header listSlot="primary">Name</s-table-header>
              <s-table-header listSlot="labeled">Min. spend</s-table-header>
              <s-table-header listSlot="labeled">Min. orders</s-table-header>
              <s-table-header listSlot="labeled">Earn multiplier</s-table-header>
              <s-table-header listSlot="labeled">Sort</s-table-header>
              <s-table-header listSlot="labeled">Actions</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {tiers.map((tier) => (
                <s-table-row key={tier.id}>
                  <s-table-cell>{tier.name}</s-table-cell>
                  <s-table-cell>
                    {tier.minSpend != null ? `$${tier.minSpend.toFixed(2)}` : "—"}
                  </s-table-cell>
                  <s-table-cell>{tier.minOrders ?? "—"}</s-table-cell>
                  <s-table-cell>{tier.earnMultiplier}x</s-table-cell>
                  <s-table-cell>{tier.sortOrder}</s-table-cell>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small-200">
                      <s-button variant="tertiary" onClick={() => openEdit(tier)}>
                        Edit
                      </s-button>
                      <s-button
                        variant="tertiary"
                        tone="critical"
                        onClick={() => confirmDelete(tier.id)}
                      >
                        Delete
                      </s-button>
                    </s-stack>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-modal
        id={TIER_MODAL_ID}
        ref={modalRef}
        heading={editing.id ? "Edit VIP tier" : "Add VIP tier"}
      >
        <s-stack direction="block" gap="base">
          <s-text-field
            key={`name-${modalSession}`}
            label="Tier name"
            defaultValue={editing.name}
            error={errors.name}
            onInput={(e: any) => {
              const value = e.currentTarget?.value ?? "";
              editingRef.current = { ...editingRef.current, name: value };
              setEditing((prev) => ({ ...prev, name: value }));
            }}
            required
          />
          <s-money-field
            key={`minSpend-${modalSession}`}
            label="Minimum lifetime spend"
            defaultValue={editing.minSpend != null ? String(editing.minSpend) : ""}
            error={errors.minSpend}
            details="Leave blank to only require a minimum order count."
            onInput={(e: any) => {
              const value = e.currentTarget?.value ? Number(e.currentTarget.value) : null;
              editingRef.current = { ...editingRef.current, minSpend: value };
              setEditing((prev) => ({ ...prev, minSpend: value }));
            }}
          />
          <s-number-field
            key={`minOrders-${modalSession}`}
            label="Minimum lifetime orders"
            defaultValue={editing.minOrders != null ? String(editing.minOrders) : ""}
            error={errors.minOrders}
            min={0}
            step={1}
            onInput={(e: any) => {
              const value = e.currentTarget?.value ? Number(e.currentTarget.value) : null;
              editingRef.current = { ...editingRef.current, minOrders: value };
              setEditing((prev) => ({ ...prev, minOrders: value }));
            }}
          />
          <s-number-field
            key={`earnMultiplier-${modalSession}`}
            label="Earn multiplier"
            defaultValue={String(editing.earnMultiplier)}
            error={errors.earnMultiplier}
            min={0}
            step={0.1}
            details="2x means members in this tier earn double points per dollar."
            onInput={(e: any) => {
              const value = e.currentTarget?.value ? Number(e.currentTarget.value) : 0;
              editingRef.current = { ...editingRef.current, earnMultiplier: value };
              setEditing((prev) => ({ ...prev, earnMultiplier: value }));
            }}
          />
          <s-number-field
            key={`sortOrder-${modalSession}`}
            label="Sort order"
            defaultValue={String(editing.sortOrder)}
            error={errors.sortOrder}
            min={0}
            step={1}
            details="Lower numbers are earlier tiers. Next-tier copy uses this order."
            onInput={(e: any) => {
              const value = e.currentTarget?.value ? Number(e.currentTarget.value) : 0;
              editingRef.current = { ...editingRef.current, sortOrder: value };
              setEditing((prev) => ({ ...prev, sortOrder: value }));
            }}
          />
        </s-stack>
        <s-button slot="secondary-actions" commandFor={TIER_MODAL_ID} command="--hide">
          Cancel
        </s-button>
        <s-button slot="primary-action" variant="primary" onClick={handleSave}>
          Save
        </s-button>
      </s-modal>

      <s-modal id={DELETE_MODAL_ID} ref={deleteModalRef} heading="Delete VIP tier" size="small-100">
        <s-paragraph>
          Members in this tier will revert to the base earn rate. This can't be undone.
        </s-paragraph>
        <s-button slot="secondary-actions" commandFor={DELETE_MODAL_ID} command="--hide">
          Cancel
        </s-button>
        <s-button slot="primary-action" variant="primary" tone="critical" onClick={handleDelete}>
          Delete tier
        </s-button>
      </s-modal>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
