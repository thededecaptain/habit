import { redirect } from "react-router";
import { TERMS_URL } from "../lib/brand";

// Reviewers and crawlers try /terms on the app host; the page lives on the
// marketing/docs site.
export const loader = () => redirect(TERMS_URL, 301);
