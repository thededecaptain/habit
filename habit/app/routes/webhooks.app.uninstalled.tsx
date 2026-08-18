import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { log } from "../lib/logger.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic } = await authenticate.webhook(request);
  log("info", "webhook.received", { topic, shop });

  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }

  return new Response();
};
