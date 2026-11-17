# Pathix™ for Dynamics 365

A Chrome and Edge extension that explains Dynamics 365 model-driven forms in context. Rest the pointer on a field and a card tells you what is behind it. Turn on X-ray and a short line of counts appears under each field's label.

Pathix is not affiliated with, endorsed by, or sponsored by Microsoft.

It works on Dynamics 365 org pages (`*.crm*.dynamics.com`) and does nothing on other dynamics.com pages, such as Business Central or Finance and Operations. The US Government (GCC High, DoD) and China clouds are not supported yet.

The extension is published on the Chrome Web Store. Connected mode's hover card and X-ray are built. Lite's platform dependencies, "registered to fire" and "why can't I edit this field?" cards are built, and a demo and a smoke test are in place. The principles the code relies on are in [`DESIGN.md`](DESIGN.md).

## Two modes

One extension, two answers. Every card says which question it is answering.

- **Lite** needs no backend. It reads Dataverse metadata as you, the signed-in user, and shows what is *registered* or *declared*: the components Dataverse tracks as depending on a column, the plugin steps and workflows registered to fire when it changes, and why you might not be able to edit it. It counts in platform terms, never "writers". *The platform dependencies, "registered to fire" and "why can't I edit this field?" cards are built.*
- **Connected** is for organizations that run Pathix, the forensics platform for Dynamics 365 and Dataverse that runs in your own Azure subscription. You enter your organization's Pathix address and sign in. Cards then show what Pathix found *actually writes* a field, parsed from plugin code, scripts and flows, as of the latest completed scan.

With no Pathix address set, the extension runs in Lite. Entering an address on the options page moves it to connected cards with no reinstall, and **Remove address** moves it back. Connected cards also carry one line contrasting the two: "Dataverse tracks N dependencies. Pathix found M writers."

## Privacy

- **Names, never values.** On a Dynamics 365 page, the extension reads logical names only: the table, the columns, the controls, the form ID and the organization ID. It also passes on which columns have unsaved edits, which controls are read-only and which columns the form submits on every save, as lists of names, and whether a save would create or update. The content script finds which field the pointer or focus is on from the page's element ids. It never reads field values, the record ID, or the URL beyond its host. Three tests fail the build if that breaks:
  - `test/messages.test.ts`: the bridge schema rejects anything that is not a logical name or a known ID.
  - `test/form-snapshot.test.ts`: a fake `Xrm` full of values produces a snapshot with none of them.
  - `test/page-source.test.ts`: fails if page-side code calls a value-reading `Xrm` API, reads the full URL, or opens a network connection.
- **Metadata only.** Lite queries Dataverse metadata tables and functions only, never business records, audit data or plugin-trace logs. Every Lite request goes through one client in `src/dataverse/` with an allowlist, and `test/dataverse-client.test.ts` pins that allowlist. Lite's requests go to the D365 page's own origin with your own session, so Lite sees exactly what you may see. Connected mode reads Pathix, which holds metadata only too.
- **Three destinations, no telemetry.** The extension talks only to your own Dataverse, your organization's Pathix and Microsoft Entra for sign-in. Nothing goes to the makers of Pathix, and there are no analytics.
- **Your token stays put.** The Pathix sign-in token lives in browser memory, is cleared when the browser closes, and never reaches the Dynamics 365 page. The extension asks for no refresh token.
- **What it keeps on your device.** Local storage holds the Pathix address, the sign-in you confirmed (the address, Entra sign-in host, tenant, client ID and scope, and your sign-in name, sent only to Entra to renew the same account), the admin center overlay switch and the tips switch. Sign out removes the confirmed sign-in and the token; removing or changing the address removes them too. Removing the extension removes everything. The full list is in [`store/privacy-policy.md`](store/privacy-policy.md).

- **The admin center overlay is opt-in.** The manifest holds the admin center host as an optional permission and no admin center script. Turning the overlay on asks the browser for that one host and registers the page script for it; turning it off unregisters it. The page script reads ids from the address path and the role list's links, and Application IDs from a grid, and `test/admin-page.test.ts` fails the build if it opens a network connection, reads a token, storage or cookies, reads any other text from the page, or changes one of the admin center's own elements.

To report a way around any of this, see [`SECURITY.md`](SECURITY.md).

## Build and test

CI uses Node.js 22. Run these from the repository root:

```bash
npm ci
```

```bash
npm test
```

```bash
npm run typecheck
```

```bash
npm run build
```

The build writes the unpacked extension to `dist/`. `npm run watch` rebuilds on every change; after a rebuild, reload the extension on the extensions page. CI runs the same four steps on every pull request.

### Smoke test

The smoke test loads the build into Chromium against a fake model-driven page served from the fixtures, and checks that the cards render and X-ray toggles. A second smoke file drives the X-ray line in a fake form: where it lands, that it comes back after a re-render, and that off removes it. Another opens the options page against a fake Pathix: the address is the only field, the page says why when Pathix offers the extension no sign-in, sign-in asks Entra for the extension's own client ID and the `Pathix.Read` scope, and a token that grants more is discarded. It needs a build first:

```bash
npm run build
```

```bash
npx playwright install chromium
```

```bash
npm run smoke
```

To use a Chromium you already have, set `PATHIX_SMOKE_CHROMIUM` to its path instead of installing one. CI runs the smoke test on every pull request (`.github/workflows/smoke.yml`).

## Load it unpacked in Edge

1. Run `npm run build`.
2. Open `edge://extensions`.
3. Turn on **Developer mode**.
4. Select **Load unpacked**.
5. Choose the `dist` folder.
6. Open a record form in a model-driven app in your Dynamics 365 environment.
7. Open the browser developer tools (F12) and select the **Console** tab.
8. Find the lines that start with `[pathix]`: `content script loaded`, then a line naming the table and listing the form's columns. They log at the Info level.

After you reload the extension, reload any open D365 tab too, or open a new one.

Chrome works the same way, from `chrome://extensions`. To see the service worker's log, select **service worker** on the extension's card.

### The extension ID

Sign-in redirects to `https://<extension-id>.chromiumapp.org/`. Pathix's setup script, `New-PathixEntraApps.ps1`, ships with the Pathix server deployment and creates the extension's app registration in Microsoft Entra. Its redirect addresses must include the ID your build runs under. The extensions page shows the ID on the extension's card.

- `manifest.json` carries no `key`. Without one, the browser derives the extension ID from the folder you load, so the ID changes if the folder moves.
- To keep the ID fixed, create `manifest.key.local.json` next to `manifest.json`, shaped `{ "key": "<base64 public key>" }`. The build adds the key to `dist/manifest.json` and says so in its output. The file is ignored by git. Never commit it.

## Try the demo

The demo is a page inside the extension: a sample account form with the real Lite cards, answered from sample data built into the extension. It reads no environment and makes no network call.

1. Select the extension's toolbar icon, then **Open demo**. Or open the extension's options and select **Open the demo**.
2. Rest the pointer on a field's label, such as **Credit Limit**, to open its card.
3. **Legal Officer** is read-only on the sample form, so its card opens on **Why locked?**.
4. Type in a field to see what your unsaved edits are registered to fire.

## Connect to Pathix

Your Pathix administrator registers the extension with Pathix's setup script, `New-PathixEntraApps.ps1`, which ships with the Pathix server deployment, and gives you your Pathix address. Pathix tells the extension its client ID and the read-only scope to ask for, so the address is all you enter. The extension keeps only the address's origin, so Pathix must answer at the root of its host: Pathix behind a path prefix, such as an application proxy at `https://contoso.com/pathix`, is not supported.

1. On the extension's card in `edge://extensions`, select **Details**, then **Extension options**.
2. In **Pathix address**, enter your Pathix address, for example `https://pathix.contoso.com`.
3. Select **Save and connect**.
4. Allow the extension to reach your Pathix when the browser asks.
5. Select **Sign in**. A Microsoft sign-in window opens.
6. Sign in. Entra may ask you to consent to the extension reading Pathix on your behalf.
7. Reload a D365 form in an environment your Pathix scans.
8. In the console, find `[pathix] connected: <environment name>, latest Completed scan <date>`.

The extension asks Entra for the `Pathix.Read` scope only. It keeps a token only when the token grants `Pathix.Read` and nothing else, and it only reads from Pathix.

If your Pathix cannot sign the extension in, the options page says why and shows no **Sign in** button:

- **Sign-in is off** on this Pathix. Ask your administrator to set it up.
- **An older Pathix** that does not offer sign-in for the extension. Ask your administrator to update Pathix.
- **No browser extension registration** on this Pathix. Ask your administrator to set one up.
- **A registration that looks wrong.** Ask your administrator to check it.
- **A registration that grants more than read access.** The extension discards the token. Ask your administrator to remove the other permissions and their consent.

Removing a permission from the registration does not revoke consent already granted for it. A registration that once had `Pathix.Access` keeps granting it until the consent is revoked too. To fix it, an administrator does both of these in Microsoft Entra:

1. On the extension's app registration, under **API permissions**, remove every permission other than `Pathix.Read`.
2. On the extension's enterprise application, under **Permissions**, revoke the grant for every scope other than `Pathix.Read`.

The extension then asks Entra again when you open its options, or within five minutes.

If Pathix does not answer, the options page says it could not reach Pathix. It does not say a sign-in failed.

The token lasts about an hour and lives only in memory. When it expires, the extension renews it silently. If renewal needs you, the console says `signed out` and you sign in again from the options page.

## Open a feature

Every feature opens with a click. Keyboard shortcuts do the same thing faster, and you never need them.

1. Open a record form, for example an account.
2. Select the extension's toolbar icon. A small window opens under it.
3. Read the top line. It says Lite, or the environment you are connected to and how old its latest Completed scan is. While the extension asks Pathix it says "Checking Pathix…"; the form's buttons work meanwhile. If you are signed out or Pathix is not set up, it says so, and **Open options** takes you to the fix.
4. Under **This form**, turn **X-ray** on or off, or select **Event map**, **What changed** or **Save preview**. The window closes and the panel opens on the form. Each button shows its current keyboard shortcut under its name, or "No shortcut".
5. Under **Power Platform admin center overlay**, turn the overlay on or off. It is the same switch as on the options page. Turning it on asks the browser for access to the admin center; if that prompt closes the window, the overlay still turns on once you allow it.
6. Select **Options** or **Open demo** at the bottom.

On a page that is not a Dynamics 365 record form, the form controls stay visible but are turned off, and the window says to open a record form. If the page does not answer, the window also says to reload it if a record form is open: after the extension is reloaded or updated, an open Dynamics 365 page needs a reload. **X-ray** and **Save preview** use your organization's Pathix, so in Lite they are turned off and say so, with one line pointing to Options.

### Keyboard shortcuts

The shortcuts belong to the browser, not to the page. The extension sets one default shortcut, Alt+Shift+Q (Control+Shift+Q on a Mac), which opens the Pathix window. Every other shortcut is yours to choose, and you can change or clear the default:

1. Select the extension's toolbar icon, then **Change keyboard shortcuts**. Or open `edge://extensions/shortcuts` in Edge, or `chrome://extensions/shortcuts` in Chrome.
2. Find **Pathix for Dynamics 365** and set the keys you want.

| Command | Default key | The same as |
|---|---|---|
| Open the Pathix window | Alt+Shift+Q (Mac: Control+Shift+Q) | Selecting the toolbar icon |
| Turn X-ray on or off | None | The **X-ray** switch |
| Open the form event map | None | **Event map** |
| Open what changed on this table | None | **What changed** |
| Open the save preview | None | **Save preview** |
| Open the card for the field that has focus | None | Resting the pointer on the field's label |

A shortcut you set works in every tab, not only on Dynamics 365 pages, so pick keys that do not type characters you need. On a keyboard with AltGr, or on a Mac with Option, a letter key with those modifiers may type a character: binding it to a command takes that character away everywhere. The browser does not give the default key when another extension or the browser already uses it; the shortcuts page shows what each command really has. The extension listens for no keys on the page itself. A command's key opens its panel; Escape closes it.

## Use the hover card in Lite

1. Make sure no Pathix address is saved on the options page.
2. Open a record form, for example an account.
3. Rest the pointer on a field's label for a moment. The card carries a **Lite** chip and says **Live from Dataverse**.
4. Read the **Fires on change** tab: what is registered to fire when this column changes. Plugin steps are grouped by stage and mode, from their filtering attributes. Steps with no filtering attributes fire on every update and have their own group. Classic workflows and business rules follow. Steps from Microsoft publishers are folded behind one line; select it to list them.
5. If you have unsaved edits on the form, **Your unsaved edits** shows what saving them is registered to fire. Select the line to list it.
6. Select the **Dependencies** tab. It says how many components Dataverse tracks as depending on the column, grouped by type. Select a group, such as **4 plugin steps**, to list their names.
7. To see what a tab is based on, select **?**.
8. The footer line names what the tab cannot see and what Pathix does about it. To turn it off for good, select its **×**, or check **Don't show tips** on the options page.

If Dataverse refuses or fails a read, the card says so. It never shows zero for an answer it did not get.

When a card cannot show anything, it says why and what to do next: Pathix is not set up, you are signed out, Pathix refused your account, Pathix has no environment that matches this organization, there is no Completed scan yet, Pathix or Dataverse could not be reached. X-ray uses the same wording.

### Why can't I edit this field?

1. Rest the pointer on the label of a field the form shows read-only.
2. The card opens on the **Why locked?** tab, a checklist. ✓ means Lite read the answer and it does not lock the field. ✗ means it does. ? means Lite can see something there but cannot read its logic, or could not read it at all.
3. Read the lines: the platform, column security, the form definition, business rules, your access to the table, form scripts and the record. Business rules and scripts are named, never claimed.
4. The checklist covers only your own access. Pathix maps everyone's.

### Turn tips off for your organization

Administrators can turn the footer line off for everyone through the extension's managed policy (`chrome.storage.managed`), with the key `hideTips` set to `true`. The schema is `static/managed_schema.json`. In Edge or Chrome, set it under the `3rdparty` extension policy for the extension's ID. Users then cannot turn the line back on.

## Use the hover card when connected

1. Open a record form, for example an account.
2. Rest the pointer on a field's label for a moment. Pointing at the input itself does nothing, so typing and picking values are not interrupted.
3. Read the card. It counts the column's writers, readers and conditional writers, then lists the writers: logic first with when it runs, then forms. The dot is the confidence: green is deterministic, ✦ is AI-derived and unverified. Under a logic writer, the trigger lines say when it runs and what scopes it: the filtering columns ("Fires when creditlimit changes"), "Fires on every update", and for a cloud flow whether a row filter is set. A plugin step also lists its images. The line "Dataverse tracks N dependencies" is Dataverse's own count, measured when Pathix scanned.
4. To see what the card is based on, select **?**. It shows the scan, who can change records of the table, and what the card cannot see.
5. On a field the form shows read-only, the card opens with **Why can't I edit this field?** above the counts. The form line comes from Pathix's scan of the open form, matched to the control by its id. A control Pathix does not list is marked ?. Column security names the profiles that grant update. Your own profiles and your own access to the table are read live from Dataverse, as you, and carry a **live** tag. Nothing else on the card is read from Dataverse live, except the "changed since scan" badges.
6. To close the card, press Escape, select the close button, or move the pointer away.
7. To open the card without a mouse, give **Open the card for the field that has focus** a key on the browser's shortcuts page (see "Keyboard shortcuts"), move focus into a field and press it.
8. To see the full picture, select **Open in Pathix**.

## Use X-ray mode

1. Open a record form.
2. Select the extension's toolbar icon and turn on **X-ray**. Or press the keyboard shortcut you set for it (see "Keyboard shortcuts").
3. Read the line under each label, for example `W: 7 +1✦  R: 8  F: 5  [flag] 0`. W is the writes to the column and R the reads of it, forms that carry the column left out, Microsoft components included as on the card. A form whose sub-grid filters on the column reads it without carrying it, so it counts in R. `+N✦` after W or R counts the AI-derived ones (unverified) apart; there is no marker when there are none. F is the forms that carry the column, including forms that show it read-only. The flag is the open findings. "?" means Pathix did not answer for that count. If a visible field has no place for a line that would not squeeze the form, it gets none, and the X-ray panel says how many visible fields could not be marked. Hidden fields and fields on tabs you have not opened are not counted. The line has its own row under the field, left-aligned with the label, so a side label keeps its width and a chip another extension adds beside the label (such as Level Up's logical name) does not move it.
4. Select a line, or tab to it and press Enter, to open that field's card.
5. To turn X-ray off, turn off **X-ray** in the toolbar window, press its shortcut again, or close the legend. Every line is removed.

X-ray needs your organization's Pathix. In Lite it says so and writes nothing into the form.

The line is the extension's own element with a closed shadow root. It never changes Dynamics 365's own elements. It reads names only, never values, and no text from any D365 element: it finds its place from the label's id and the page's layout (DESIGN.md, "Names, never values").

## Use the form event map

1. Open a record form.
2. Select the extension's toolbar icon, then **Event map**. Or press the keyboard shortcut you set for it. The map opens at the top right.
3. Read the groups. Each one is an event on one target: OnLoad, OnSave, OnChange for a column, a tab's events, a control's events. Under each are the function and its library. A handler that is turned off in the form is struck through and tagged **disabled**. Handlers the platform loads itself are tagged **internal** and are not hidden.
4. To see what the map cannot show, select **?**.
5. To close it, press Escape or select the close button.

In Lite, the map reads the open form's definition from Dataverse as you. It is live. When connected, it shows what Pathix's latest completed scan read from the same definition, "As of" the scan's date. Pathix numbers the handlers under each event only when the scan recorded their order. When it did not, the panel says so and the rows are sorted by name, not in the order the form lists them. A handler whose enabled flag the form did not state is tagged **enabled not stated**. If Pathix cannot say what the form registers, because the scan did not read its definition or holds no handler data, or because the form is not in the latest scan, the map says so and never shows an empty list in its place.

The map lists what the definition registers. A handler that a script adds while the form runs is not in the definition and is not listed. If the definition cannot be read, the map says so and never shows an empty list in its place.

## See what changed on a table

1. Open a record form.
2. Select the extension's toolbar icon, then **What changed**. Or press the keyboard shortcut you set for it. The panel opens at the top right.
3. In Lite, read the list. It is the table's plugin steps, classic workflows, business rules and forms, newest first. A modified date moves when a plugin step, workflow or business rule is saved, imported with a solution, or turned on or off. It does not say what changed. Dataverse keeps no modified date for a form, so a form row says **Published** and shows when the form was last published. An edit that is not published does not show, and publishing again with no change does.
4. When connected, read the groups. Each is a scan, and each row is a change Pathix found that it ties to this table: a component that now writes or reads a column, a column added or removed, column security. A badge reading **changed since scan** is live from Dataverse. The component's modified date (for a form, its published date) is newer than Pathix's last scan, so what Pathix shows may be out of date.
5. To see what the panel cannot show, select **?**.
6. To close it, press Escape or select the close button.

The same live badge appears on the hover card's writer rows when connected. A component the live check cannot read is counted as "could not be checked", never as unchanged. The check reads each component's modified date (a form's published date) from Dataverse as you. It reads no field values and sends nothing to Pathix.

## Use the Power Platform admin center overlay

The overlay is off until you turn it on. It adds Pathix's view of a security role to the new Power Platform admin center, at `admin.powerplatform.microsoft.com`. It needs your organization's Pathix, so it does nothing in Lite.

1. Select the extension's toolbar icon and turn on **Show Pathix in the admin center**. Or select it on the extension's options page.
2. Allow the browser's request. It asks for access to `admin.powerplatform.microsoft.com` and nothing else.
3. Reload any admin center tab that was already open.
4. Open an environment's security roles. Each role in the list carries a badge: how many principals hold the role directly (users, application users and teams) and how many open findings name it. The tooltip splits the holders by kind. A role's business unit copies are counted with it, so the numbers are the role's whole.
   A role with no open findings reads "No open findings name this role (system noise and suppressed types hidden, as in Pathix)". Open findings are the ones Open or Reviewing in your triage, as on Pathix's findings page.
5. Open a role. A banner under the breadcrumb reads, for example, "Assigned to 3 humans and 1 integration", with the role's open findings, the scan the numbers come from and a link to the role in Pathix. Users the platform manages, such as Power Pages site users and agents, are counted apart as "platform-managed users", never as humans. A team that holds the role is mentioned apart; its members are not counted. When the numbers include business unit copies, the banner says how many. When nothing about the role itself is known, no banner is drawn.
6. Open the environment's application users. Each row whose Application ID Pathix knows carries a chip at the start of the Application ID cell: how many roles the application user holds directly. The cell is narrow, so the end of the Application ID may be cut off. A row Pathix looked up in its latest scan and did not find reads "Not in Pathix's latest scan".
7. To turn it off, clear the option. The extension unregisters the script, gives the permission back and removes what it drew.

What the overlay does and does not do:

- A page that is not one of those three, an environment your Pathix does not scan, a role that is not in the latest scan, or a Pathix that does not answer all leave the admin center exactly as it was. There is no banner and no error. A part of the banner that did not load reads "unknown", never "0".
- It reads the ids in the page address and the role ids in the role list's links. It looks at the text of the application user grid's cells and keeps only a cell that is exactly one Application ID; any other text, such as a name or an email, is discarded at once, never stored or sent. It reads no cookies, tokens or page storage, and the page script makes no network call. The extension's service worker asks your Pathix, with the extension's own sign-in.
- Every number is from Pathix's latest completed scan, and the banner says when that was. None of it is live.
- It matches the admin center's host and no other, and never a sign-in page. The script is registered when you turn the overlay on and unregistered when you turn it off.
- On a scan taken before Pathix recorded which roles are business unit copies, the overlay cannot fold the copies in. A role that shares its name with other roles then shows "N+ assigned" (or "? assigned" when the role itself has no direct holders), marks a findings count above zero as "N+", and reads its findings as "?" when none name it. The banner reads "Assigned to at least ..." (or "Assignments: unknown"), starts the findings line with "At least", names the severity as "highest seen", and says the other roles are not counted. A scan taken since Pathix records copies has none of these hedges.

## Preview a save

1. Open a record form. Edit a field if you want to see how the edits narrow the answer.
2. Select the extension's toolbar icon, then **Save preview**. Or press the keyboard shortcut you set for it. The panel opens at the top right.
3. Read it from the top. First come the form's own OnSave handlers, which run in the browser before the request is sent. Then the server pipeline as one timeline, a group per stage present, in the platform's stage order: pre-validation, pre-operation, **the record is saved** (the main operation, with whatever is registered there under it), post-operation. Microsoft's internal stages and the deprecated post-operation stage are groups too, each tagged with its stage number, so nothing is set aside; a group that holds only Microsoft entries is one line with its count. Asynchronous work is listed last and marked **unordered**: it is not a sequence. Entity business rules are listed apart, and so are entries whose stage or mode Pathix does not know (**Position unknown**).
4. Look for the markers. **Order unknown** and **tied order** mean the platform does not guarantee the sequence. **Row filter set** and **row filter unknown** mean a cloud flow may be skipped. **All tables** marks a step registered for the message on every table. A line under each entry names the edited columns that matched it, or says it fires on any update. The headline ends with how many components are disabled.
5. Entries from Microsoft publishers are folded behind one line per list. Pathix decides that by the publisher of the owning solution, never by managed state.
6. Read "What this does not show" at the bottom. It lists every limit Pathix reports for the answer.
7. To close it, press Escape or select the close button.

The preview is Pathix's answer from its latest Completed scan, so it needs your organization's Pathix. In Lite the panel says so. It shows what is **registered to fire**, one hop, and never says anything "writes" or "will run": a plugin can return early, and a workflow can skip its steps on its own conditions. If Pathix cannot answer, the panel says it does not know, and never that nothing fires.

It sends names only: the table, Create or Update, the form's definition id, and, for an update, the names of the columns you edited plus the columns the form always submits. It never sends a value or the record id (DESIGN.md, "Names, never values").

## How the code is laid out

| Path | Runs in | Job |
|---|---|---|
| `src/page/` | The D365 page's own JavaScript world | Reads `Xrm` and posts a snapshot of names |
| `src/admin/` | The extension's isolated world on the admin center, once the user turns the overlay on | The overlay's page script: route parsing, the places it draws, and the banner, badge and chip |
| `src/content/` | The extension's isolated world on the page | Validates snapshots and relays them, and renders the hover card and X-ray |
| `src/dataverse/` | The extension's isolated world on the page | Lite's one Dataverse client, its allowlist, and one function per query |
| `src/lite/` | The extension's isolated world on the page | Loads Lite cards through the Dataverse client |
| `src/background/` | The service worker | The only part that calls Pathix or Entra, and the only one that reads the token |
| `src/options/`, `static/` | The options page | Pathix address, sign-in, tips; `static/managed_schema.json` is the policy schema |
| `src/popup/` | The toolbar popup | Connection state, the form features, the admin overlay switch, and links to the options and the demo |
| `src/auth/` | Service worker, options page | Auth code + PKCE against Entra; no refresh tokens |
| `src/pathix/` | Service worker, options page | Pathix API calls, settings parsing, environment matching |
| `src/card/` | Service worker, content script | The cards' wording, built from Pathix's or Dataverse's answers (no DOM) |
| `src/bridge/` | Shared | The page-facing message schema and its validator |
| `src/runtime/` | Shared | Messages between the extension's own parts |
| `contract/` | Tests | The Pathix API slice the extension reads, and scrubbed Dataverse fixtures |
| `scripts/` | Node, by hand and in CI | The manifest build step, the release zip check, the API slicer and the Dataverse fixture capture |

### Contract and fixtures

- `contract/pathix-api.slice.json` is the part of the Pathix OpenAPI spec the extension calls: its paths and the schemas they reference. `test/contract.test.ts` fails if a response field the extension reads is missing from it. Regenerate it from a full spec with `node scripts/slice-openapi.mjs <openapi.json> contract/pathix-api.slice.json`. Never edit it by hand.
- `contract/dataverse/` holds real Dataverse metadata responses, scrubbed. `contract/dataverse/queries.json` lists the requests. To capture them, sign in with the Azure CLI (`az login`) as a user who can read the environment's metadata, then run:

  ```bash
  node scripts/capture-dataverse-fixtures.mjs --org https://<org>.crm.dynamics.com
  ```

  Files that carry a `_standIn` key are hand-written until someone captures them; the capture overwrites them.

  The script sends only GET requests to metadata tables and functions on its allowlist. Before it writes a file, it replaces the org host with `contoso.crm.dynamics.com`, maps every GUID to a synthetic one, and replaces user names, emails and domain names. Read every file it writes before you commit it.

## Release

A release is cut by pushing a tag. The tag names the version, for example `v0.1.0`.

1. Make sure `main` is green and holds what you want to release. The workflow refuses a tag on a commit that is not on `main`.
2. Tag the commit and push the tag:

   ```bash
   git tag -a v0.1.0 -m "v0.1.0"
   ```

   ```bash
   git push origin v0.1.0
   ```

3. Watch the **Release** workflow on the repository's **Actions** tab.
4. Open the draft release on the repository's **Releases** page. Download the zip, load it unpacked and check it. Then publish the draft.

The workflow, `.github/workflows/release.yml`, has two jobs. The **build** job can only read the repository:

1. Fails unless the tagged commit is on `main`.
2. Checks the tag. It must be `v` followed by one to four numbers separated by dots, each 0 to 65535, with no leading zeros. Browsers do not accept suffixes such as `-beta`, so the workflow refuses those tags.
3. Installs, typechecks and tests, as CI does.
4. Builds with `node build.mjs --release <tag>`. The built manifest takes its version from the tag. `manifest.json` in the repository keeps its own version. A release build never carries a key: it refuses to run if `manifest.key.local.json` exists.
5. Zips `dist/` into `pathix-extension-<version>.zip`, with `manifest.json` at the root of the zip.
6. Checks the zip: `scripts/check-release.mjs` fails unless the packaged manifest has the tag's version and no `key`, and the zip carries `LICENSE` and `NOTICE` at its root.
7. Uploads the zip as a workflow artifact.

The **release** job can write the repository's contents. It installs nothing and runs no npm code. It downloads the zip, checks it again with `scripts/check-release.mjs`, and creates a draft GitHub release for the tag, with generated notes and the zip attached. The workflow uses no secrets.

**Store publishing is not set up yet.** The `publish-stores` job is a switched-off placeholder. It will run in a protected `release` environment with required reviewers, and its comments name the store credentials it will need. Until then, upload the zip to the Chrome Web Store and Edge Add-ons by hand.

To build a release zip locally, with no `manifest.key.local.json` present:

```bash
node build.mjs --release v0.1.0
```

```bash
cd dist && zip -r -X ../pathix-extension-0.1.0.zip . && cd ..
```

```bash
node scripts/check-release.mjs pathix-extension-0.1.0.zip v0.1.0
```

## Contributing

**Issues are welcome.** Pull requests by discussion first: open an issue and agree the change before you write it. One person maintains this project, so replies can take a few days and unplanned pull requests may be closed. [`CONTRIBUTING.md`](CONTRIBUTING.md) has the details, the rules every change keeps, and the DCO sign-off every commit needs.

Changes are listed in [`CHANGELOG.md`](CHANGELOG.md).

## License and trademark

The code is licensed under the [Apache License 2.0](LICENSE). The license grants no rights to the Pathix™ name or mark. If you ship a fork, ship it under your own name. See [`NOTICE`](NOTICE).

Microsoft, Dynamics 365, Dataverse and Power Apps are trademarks of the Microsoft group of companies.
