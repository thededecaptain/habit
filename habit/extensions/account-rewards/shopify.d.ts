import '@shopify/ui-extensions';

//@ts-ignore
declare module './src/Profile.jsx' {
  const shopify:
    | import('@shopify/ui-extensions/customer-account.profile.block.render').Api
    | import('@shopify/ui-extensions/customer-account.profile.addresses.render-after').Api;
  const globalThis: { shopify: typeof shopify };
}
