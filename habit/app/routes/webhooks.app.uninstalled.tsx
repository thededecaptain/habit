import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { authenticateWebhookSafe } from "../lib/webhook-auth.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticateWebhookSafe(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Always delete by shop domain. With expiring offline tokens the session may
  // still exist after uninstall while refresh is already revoked — do not gate
  // cleanup on authenticate.webhook()'s session object.
  await db.session.deleteMany({ where: { shop } });

  return new Response();
};
