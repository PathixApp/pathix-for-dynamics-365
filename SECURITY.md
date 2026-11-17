# Security

## Report a vulnerability

Email **security@pathix.app**. Please do not open a public issue for a security problem.

Include what you can of the following:

- What the problem is and what an attacker could do with it.
- Steps to reproduce it, or a proof of concept.
- The extension version (from `manifest.json` or the browser's extensions page) and the browser and version.
- Whether it needs a connected Pathix, or happens in Lite with no backend.

One person maintains this project. You will get a reply as soon as they can read your report, normally within a week. They will tell you whether they can reproduce it, what they plan to do, and when a fix ships. Please give them a reasonable time to ship a fix before you disclose. If you want credit in the changelog, say so and say how to name you.

## What counts

The extension makes a few promises that are security promises. A way to break any of them is in scope:

- **Names, never values.** Code in the Dynamics 365 page reads logical names only. It never reads field values, the record ID, or the URL beyond its host, and nothing else crosses the page bridge. See [`DESIGN.md`](DESIGN.md#names-never-values).
- **Metadata only.** Lite reads Dataverse metadata tables and functions only, never business records, audit data or plugin-trace logs.
- **Three destinations.** The extension talks only to the user's own Dataverse, their organization's Pathix and Microsoft Entra. It sends no telemetry.
- **The token.** The Pathix access token lives in the service worker and in session storage. It never reaches the D365 page or the content script, and the extension keeps no refresh token. It is requested for Pathix's read-only scope, `Pathix.Read`, and never for `Pathix.Access`. A token that grants any other scope is discarded. A token is sent only to the Pathix address it was requested for, and never follows a redirect. The extension signs in silently only to the address, tenant, authority, client and scope the user confirmed by selecting Sign in on the options page, and only through a Microsoft Entra sign-in host. The confirmation also keeps the signed-in account's sign-in name, read from the token. It is sent only to Microsoft Entra's authorize endpoint, as `login_hint` on a silent sign-in for the confirmed settings, so a browser signed in to several Entra accounts renews the right one. Sign out and a new address remove that confirmation, the name included. See [`DESIGN.md`](DESIGN.md#sign-in-is-confirmed-by-the-user).
- **Only Dynamics 365 org pages.** The content scripts are declared for `https://*.dynamics.com/*`, but both check the page's host first and do nothing unless it is a Dynamics 365 org (`*.crm*.dynamics.com`). On Business Central, Finance and Operations, Commerce or any other dynamics.com page, nothing of the extension runs or can be seen. GCC (`crm9.dynamics.com`) is covered; the GCC High, DoD and China clouds are not supported yet.
- **No script on Pathix.** The Pathix address is the Pathix web app's own origin, so a script there would act as the signed-in user. The `scripting` permission registers the admin center overlay on `https://admin.powerplatform.microsoft.com/*` and nothing else. The extension never injects a script or a stylesheet, and no content script, static or registered, matches a Pathix address.

Other examples in scope: a page or another extension driving the extension to make requests it should not, cross-site scripting in a card or the options page, and a weakness in the sign-in flow (authorization code with PKCE).

## Known residual risk

The Pathix address (`pathixUrl`) and the confirmed sign-in (`signInBinding`, which includes the signed-in account's sign-in name) live in `chrome.storage.local`. The service worker's own token lives in `chrome.storage.session`, which content scripts cannot read. Local storage is the extension's, not the page's, but a content-script renderer that an attacker has already compromised could write it, and so point the extension at another address and a binding that matches it. This was true of the address before the binding existed, so the binding makes it no worse. The binding is not kept in session storage because it must survive a browser restart: otherwise every restart would ask the user to confirm Sign in again. Reports that lower this risk are welcome.

## What does not

- Vulnerabilities in Dynamics 365, Dataverse, Microsoft Entra or the browser itself. Report those to their vendors.
- Problems that need an attacker who already controls the user's browser profile or machine.
- Findings from automated scanners with no shown impact.

The Pathix server is a separate product. If you find a problem in it, the same address reaches the same person.

## Supported versions

Only the latest release, and `main`, get security fixes.
