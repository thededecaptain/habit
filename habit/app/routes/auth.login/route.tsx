import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

import { login } from "../../shopify.server";
import { APP_STORE_INSTALL_URL } from "../../lib/brand";
import { loginErrorMessage } from "./error.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const errors = loginErrorMessage(await login(request));
  if (errors.shop) {
    throw redirect(APP_STORE_INSTALL_URL);
  }
  return null;
};

export const action = async () => {
  throw redirect(APP_STORE_INSTALL_URL);
};

export default function Auth() {
  return null;
}
