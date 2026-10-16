// The lazy Platform chunk's one entry (platform-lazy.ts loads it): the superadmin area's views and its
// controller, so nobody but a superadmin downloads either.
export { platformView, platformOrgView, platformDialogs, platformPage } from "./platform";
export { createPlatform } from "./platform-actions";
