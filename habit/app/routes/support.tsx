import { redirect } from "react-router";
import { docsHref } from "../lib/brand";

// Reviewers and crawlers try /support on the app host; the page lives on the
// marketing/docs site.
export const loader = () => redirect(docsHref("support"), 301);
