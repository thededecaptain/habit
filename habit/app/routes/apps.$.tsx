import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { parseRequestUrl } from "../lib/request-url.server";

/** Shopify sometimes loads the iframe at /apps/{handle} after a charge. */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = parseRequestUrl(request);
  throw redirect(`/app${url.search}`);
};
