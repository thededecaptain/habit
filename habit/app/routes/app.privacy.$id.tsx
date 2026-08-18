import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const requestRow = await db.privacyRequest.findFirst({
    where: { id: params.id, shop: session.shop },
  });

  if (!requestRow?.exportData) {
    throw new Response("Not found", { status: 404 });
  }

  return new Response(JSON.stringify(requestRow.exportData, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="habit-customer-export-${requestRow.id}.json"`,
    },
  });
};
