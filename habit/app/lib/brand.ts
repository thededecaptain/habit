/** Public client ID (also in shopify.app.toml). Used for App Store install links. */
export const SHOPIFY_CLIENT_ID = "d4f4bcdc36a90b4443c2e6fde31bbd80";

export const APP_STORE_INSTALL_URL = `https://admin.shopify.com/oauth/install?client_id=${SHOPIFY_CLIENT_ID}`;

export const SUPPORT_EMAIL = "support@gethabitloyalty.com";
export const SUPPORT_MAILTO = `mailto:${SUPPORT_EMAIL}`;
export const DOCS_URL = "https://docs.gethabitloyalty.com";
export const PRIVACY_URL = "https://gethabitloyalty.com/privacy";
export const TERMS_URL = "https://gethabitloyalty.com/terms";
export const MARKETING_URL = "https://gethabitloyalty.com/";

export function docsHref(path = "") {
  return path ? `${DOCS_URL}/${path.replace(/^\//, "")}` : `${DOCS_URL}/`;
}
