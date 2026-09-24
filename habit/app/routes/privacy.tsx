import { redirect } from "react-router";
import { PRIVACY_URL } from "../lib/brand";

// Reviewers and crawlers try /privacy on the app host; the page lives on the
// marketing/docs site.
export const loader = () => redirect(PRIVACY_URL, 301);
