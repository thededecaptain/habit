import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

/** Shopify sometimes loads the iframe at /apps/{handle} after a charge. */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  throw redirect(`/app${url.search}`);
};
