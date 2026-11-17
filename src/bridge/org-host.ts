// Which pages the extension acts on.
//
// The manifest's content scripts match https://*.dynamics.com/*, which also
// covers Business Central, Finance and Operations, Commerce storefronts and
// other Microsoft products that are not Dataverse orgs. Both scripts check the
// page's host first and do nothing at all anywhere else: no global, no
// listener, no message, no timer, so nothing of the extension can be seen
// there.
//
// A Dynamics 365 (Dataverse) org is `<org>.crm.dynamics.com` or
// `<org>.crm<N>.dynamics.com`, one label per org. Regions are not listed, so a
// new one works without a release. GCC is a region of dynamics.com
// (crm9.dynamics.com) and is supported. GCC High and DoD
// (crm.microsoftdynamics.us, crm.appsplatform.us) and China (crm.dynamics.cn)
// are not supported yet.
//
// No imports: the page script stays small and calls nothing.

const ORG_HOST = /^[a-z0-9-]+\.crm\d*\.dynamics\.com$/i;

/** Whether `host` (location.host: no port is expected) is a Dynamics 365 org the extension acts on. */
export function isDynamicsOrgHost(host: string): boolean {
  return ORG_HOST.test(host);
}
