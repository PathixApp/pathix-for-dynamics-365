# Pathix for Dynamics 365: browser extension

A Chrome/Edge MV3 extension that explains Dynamics 365 model-driven forms in context. It has two modes in one codebase:

- **Lite:** no backend. It reads Dataverse metadata as the signed-in user and shows what is *registered* or *declared*.
- **Connected:** the user enters their organization's Pathix address and signs in. Cards then show what Pathix found *actually writes* a field, parsed from plugin code, scripts and flows.

Read `DESIGN.md` before changing behavior.

## Rules that are never traded away

- **Names, never values.** Code in the D365 page reads logical names (table, column, control, form id, org id). It never reads field values, the record id, or the URL beyond its host, and nothing like that crosses the page bridge. The fitness tests in `test/messages.test.ts`, `test/form-snapshot.test.ts` and `test/page-source.test.ts` hold this. Never weaken them; extend them when you add a page-side read.
- **Metadata only, in both modes.** Lite queries Dataverse metadata tables and functions only, never business records, audit or plugin-trace data. Every Lite request goes through one client with an allowlist, and a test pins the allowlist.
- **The MAIN-world page script makes no network calls.** Pathix calls come from the service worker. Lite's Dataverse calls come from the content script, same origin.
- **No new manifest permissions or host patterns** without the maintainer's approval. If you need one, stop and say why in the PR.
- **No script ever runs on the Pathix origin.** It is the Pathix web app's own origin, so a script there would act as the signed-in user. `chrome.scripting` only registers the admin center overlay, matching exactly `https://admin.powerplatform.microsoft.com/*`: no `executeScript`, no `insertCSS`, no other match pattern, and static content scripts stay on the Dynamics hosts. `test/admin-overlay.test.ts` and `test/manifest.test.ts` pin this.
- **No new npm dependencies** unless the milestone names one as approved. Otherwise stop and ask in the PR.
- **No telemetry.** The extension talks only to the user's own Dataverse, their organization's Pathix, and Microsoft Entra.
- **Absence is not evidence.** A failed, forbidden or missing answer renders as unknown, never as zero or "nothing found".
- **Authorship comes from the publisher.** If you separate Microsoft-shipped items from the customer's, the only valid signal is the owning solution's publisher. Managed vs unmanaged is packaging state, never authorship. If you cannot get the publisher cheaply, do not separate them.

## Copy rules

- US English. Short sentences. No em dashes in UI strings.
- Lite counts things in platform terms: "tracked dependencies", "registered to fire", "form scripts". Never "writers", which is a Pathix claim.
- Lite never counts or lists writers, and never shows a Pathix number or result. A footer line may say what Pathix does. Numbers from Pathix appear only when connected.
- One footer line per card names what that card cannot see and what Pathix does about it, with the word "Pathix" as the link to pathix.app. No banners, popups or "upgrade" buttons. The line can be dismissed for good, and an org-wide policy setting (`chrome.storage.managed`) turns it off.
- "Pathix™", never "®". No Microsoft logos. "Not affiliated with Microsoft" goes wherever the product is described.

## Working here

- `npm ci`, then `npm test`, `npm run typecheck`, `npm run build`. All four green before every commit.
- Conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`). Sign off every commit (`git commit -s`, DCO).
- One milestone per PR. End the PR description with a **Live check** section: numbered steps the maintainer runs on a real D365 form with the unpacked build. You cannot run D365 yourself, so say exactly what to look for.
- Fixtures in `contract/dataverse/` are real, scrubbed Dataverse responses. Build against them, never against guessed shapes. If you need one that does not exist, add the query to `contract/dataverse/queries.json`, build against a clearly marked hand-written stand-in, and list the query in the PR so the maintainer can capture it.
- `manifest.json` carries no `key`. A local `manifest.key.local.json` (ignored by git) supplies one for a developer's fixed extension ID; `build.mjs` adds it. Never commit a key.
- `contract/pathix-api.slice.json` is the Pathix API contract. Do not change it by hand; it is regenerated from the Pathix server's OpenAPI document.
- When a milestone is done, tick it in the work plan in the same PR.
