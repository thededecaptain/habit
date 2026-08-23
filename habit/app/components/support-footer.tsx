import {
  DOCS_URL,
  PRIVACY_URL,
  SUPPORT_EMAIL,
  SUPPORT_MAILTO,
  TERMS_URL,
} from "../lib/brand";

type SupportFooterProps = {
  showLegal?: boolean;
};

export function SupportFooter({ showLegal = false }: SupportFooterProps) {
  return (
    <s-stack alignItems="center">
      <s-text>
        <s-link href={DOCS_URL} target="_blank">
          Help center
        </s-link>
        {" · "}
        <s-link href={SUPPORT_MAILTO}>{SUPPORT_EMAIL}</s-link>
        {showLegal ? (
          <>
            {" · "}
            <s-link href={PRIVACY_URL} target="_blank">
              Privacy
            </s-link>
            {" · "}
            <s-link href={TERMS_URL} target="_blank">
              Terms
            </s-link>
          </>
        ) : null}
      </s-text>
    </s-stack>
  );
}
