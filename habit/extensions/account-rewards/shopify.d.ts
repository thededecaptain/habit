import '@shopify/ui-extensions';

//@ts-ignore
declare module './src/Profile.jsx' {
  const shopify: import('@shopify/ui-extensions/customer-account.profile.block.render').Api;
  const globalThis: { shopify: typeof shopify };
}

//@ts-ignore
declare module './src/Announcement.jsx' {
  const shopify: import('@shopify/ui-extensions/customer-account.order-index.announcement.render').Api;
  const globalThis: { shopify: typeof shopify };
}
