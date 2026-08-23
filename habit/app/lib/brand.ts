export const SUPPORT_EMAIL = "support@gethabitloyalty.com";
export const SUPPORT_MAILTO = `mailto:${SUPPORT_EMAIL}`;
export const DOCS_URL = "https://docs.gethabitloyalty.com";
export const PRIVACY_URL = "https://gethabitloyalty.com/privacy";
export const TERMS_URL = "https://gethabitloyalty.com/terms";
export const MARKETING_URL = "https://gethabitloyalty.com/";

export function docsHref(path = "") {
  return path ? `${DOCS_URL}/${path.replace(/^\//, "")}` : `${DOCS_URL}/`;
}
