# Privacy policy: Pathix™ for Dynamics 365 browser extension

Last updated: [publish date]

This policy covers the browser extension "Pathix for Dynamics 365" for Google Chrome and Microsoft Edge. Pathix L.L.C. publishes it. The extension is not affiliated with, endorsed by, or sponsored by Microsoft.

## The short version

- The extension reads the names of things on Dynamics 365 pages: tables, columns, controls and forms. It does not read the values in your records.
- It sends data to three places only: your organization's own Dynamics 365 (Dataverse), your organization's own Pathix, if you connect one, and Microsoft Entra ID, to sign you in to that Pathix.
- It sends nothing to Pathix L.L.C. It has no telemetry, no analytics and no ads.
- It keeps a few settings on your device. They are listed below, with when each is removed.

## How the extension works

The extension runs in one of two modes.

- **Lite** is the default. It needs no server. It reads Dataverse metadata (how your environment is configured) as you, the signed-in Dynamics 365 user, and shows it on the form.
- **Connected** starts when you enter your organization's Pathix address on the options page and sign in. Pathix is a separate product that your organization runs in its own Azure subscription. Cards then show what your organization's Pathix found in its scans. Some cards also read your own access live from Dataverse.

An optional **admin center overlay** adds Pathix information to the security role and application user pages of the Power Platform admin center. It is off until you turn it on.

## What the extension reads

### On Dynamics 365 forms (both modes)

The extension acts only on Dynamics 365 organization pages, whose address has the form `<org>.crm.dynamics.com` or `<org>.crm<N>.dynamics.com`. The browser loads its scripts on every dynamics.com site, but on any other one, such as Business Central or Finance and Operations, they check the address and stop at once. They set nothing, listen for nothing and send nothing.

On those pages it reads:

- the host name of the page (for example `contoso.crm.dynamics.com`);
- the organization ID and the ID of the form definition (not the ID of the record);
- the logical name of the table, and the names of the controls on the form and the columns they show;
- whether the form would create or update a record (the form type);
- the names of the columns you have edited and not saved yet (the names only, never what you typed);
- the names of the controls the form shows as read-only;
- the names of the columns the form sends on every save;
- which field your pointer rests on or your keyboard focus is in, so it knows which field to describe.

It never reads field values, record IDs or record names, and it reads no text from the page. From the page address it uses only the host name, and it never stores or sends the rest. (The toolbar window and the extension's background worker may be handed the tab's full address by the browser. They take the host name from it and discard the rest.)

### From your Dataverse (Lite, and connected mode's live checks)

The extension asks your organization's Dataverse for configuration data only. It never asks for business records, audit history or plugin trace logs. It asks with your own Dynamics 365 session, so it sees only what you are allowed to see. It reads:

- **Configuration:** column definitions, the open table's privilege definitions, Dataverse's list of components that depend on a column, plugin step registrations and their images, classic workflows and business rules, form definitions, and the names of forms, views, charts, relationships, solutions and publishers.
- **Column security:** the names of all column security profiles in the organization, and the column permissions those profiles set on the open table.
- **About you:** your Dataverse user ID and business unit ID (from Dataverse's "who am I" request), the names, IDs and types of the teams you belong to and their business units, the names of your column security profiles and your teams' profiles, your teams' security roles and the write privilege and depth those roles hold on the open table, and the depth of your own privileges on the open table (write) and on workflows, teams and roles (read).
- **Change dates:** when a plugin step, workflow, business rule, view or chart was last modified, and when a form was last published.

### From your organization's Pathix (connected mode)

The extension reads what your Pathix found in its scans: which components write or read a column, when they run, open findings, column security, a form's event handlers, recent changes, what a save is registered to fire, and security role and application user summaries. Pathix holds metadata only.

### On the Power Platform admin center (overlay, only if you turn it on)

On `admin.powerplatform.microsoft.com` the overlay reads:

- the organization ID and security role ID from the page address path (not its query or fragment);
- the role IDs in the links of the security role list;
- the Application IDs shown in the application user list. It looks at the text of the list's cells and keeps only a cell that is exactly one Application ID. Any other text, such as a name or an email address, is discarded at once, never stored or sent.

It reads no cookies, tokens or page storage, and the overlay's page script makes no network request of its own.

### From your Microsoft Entra ID sign-in (connected mode)

When you sign in, Microsoft Entra ID gives the extension an access token for your Pathix. Microsoft Entra issues the token, and it may carry claims such as your name and the IP address you signed in from. The extension reads only two things from it: the access it grants and your account's sign-in name. It learns when the token expires from Entra's answer, not from the token. It reads your sign-in name (for example `jane@contoso.com`) and shows it on the options page. It also keeps the account's sign-in name, or the account hint Entra puts in the token in its place, so that renewing your sign-in asks for the same account.

## Where the extension sends data

| Destination | When | What it receives |
|---|---|---|
| **Your organization's Dynamics 365 (Dataverse)**, on the same address as the page you are on | Lite, and connected mode's live checks of your own access and of change dates | Requests for the configuration data above. They name the table, column, form, components, your user ID, your team and role IDs and privilege names. They carry your existing Dynamics 365 session. |
| **Your organization's Pathix**, at the one address you enter | Connected mode only | The open table's name. The column name of the field you point at or focus, and of every field on the form while X-ray is on. The form definition ID (event map and save preview). While the save preview is open: whether the save creates or updates a record, and the names of edited columns and of columns the form always sends. From the admin center overlay: the Application IDs the page shows, and Pathix's own IDs for the security roles the page shows (the page's role IDs are matched on your device and are not sent). Your Pathix access token. The page's organization ID and host are compared on your device with the list of environments Pathix returns. They are not sent. |
| **Microsoft Entra ID** (Microsoft's sign-in service) | When you sign in, and when the extension renews your sign-in | A standard sign-in request: the extension's client ID, the permission it asks for (read-only access to Pathix), its sign-in return address and one-time security codes. When it renews your sign-in without asking you, it also sends your stored sign-in name, so Entra picks the right account. |

The extension sends nothing to Pathix L.L.C. or to anyone else. There is no telemetry, analytics, crash reporting or advertising. Your organization controls its own Dataverse and Pathix. Microsoft's own privacy statement covers Dataverse and Entra ID.

If you select a link on a card, the browser opens that page as it does for any link. Links go to `pathix.app` or to your organization's Pathix, and the extension adds none of your data to them. If you select **Copy as brief**, the extension writes a text summary of the card to your clipboard. It never reads your clipboard.

## What the extension stores, and when it is removed

All of this stays in your browser's extension storage on your device. Removing the extension deletes all of it.

**Local storage** (kept across browser restarts):

| Item | What it holds | Removed when |
|---|---|---|
| Pathix address | The address you entered | You remove or change the address |
| Confirmed sign-in | The Pathix address, the Entra sign-in host, tenant ID, the extension's client ID and the permission it asks for, all of which you confirmed by selecting Sign in, plus your sign-in name | You sign out, or remove or change the address. Also when Entra answers for a different account. |
| Admin center overlay | Whether you turned the overlay on | You turn it off (it is then kept as "off") |
| Overlay request time | The time you asked to turn the overlay on, so the browser's permission prompt can finish the job. After one minute it is ignored. | It is used, or you turn the overlay off. Turning the overlay on again replaces it. If you refuse the prompt after the toolbar window closed, it stays, ignored, until one of those. |
| Hide tips | Whether you turned off the tip line on cards | You turn the tip line back on (it is then kept as "on") |
| Older client ID | A setting an earlier version of the extension kept. It is never read. | The extension updates, you save an address, or you remove the address |

**Session storage** (held in memory, never written to disk; cleared when the browser closes, and when the extension is updated, reloaded or turned off):

| Item | What it holds | Also removed when |
|---|---|---|
| Access token | Your Pathix access token, which lasts about an hour, with the Pathix address and sign-in settings it was issued for | You sign out, or remove or change the address |
| Refused sign-in | If Pathix's sign-in setup grants more than read-only access, the extension refuses the token and keeps a note: the Pathix address, sign-in settings, reason and time | You open the options page, or remove or change the address. It stops counting after five minutes. |

**The admin center overlay's script registration.** When you turn the overlay on, the extension registers its script with the browser for `admin.powerplatform.microsoft.com` only. The browser keeps that registration across restarts. Turning the overlay off, or removing the extension's access to the admin center, removes it.

**Memory only.** To avoid asking the same question twice, the extension keeps answers from Dataverse for up to five minutes and from Pathix for up to ten minutes, in memory. They are never written to storage, and they are gone when the tab closes or the browser stops the extension's background worker.

The extension keeps no refresh token, no browsing history and no record data.

## Permissions, in plain words

- **Sign in with Microsoft (identity):** opens the Microsoft Entra ID sign-in window for your Pathix.
- **Storage:** keeps the settings listed above.
- **Scripting:** registers the admin center overlay's script when you turn it on. It is used for nothing else.
- **Access to `https://*.dynamics.com/*`:** lets the extension run on Dynamics 365 forms. The browser loads its scripts on every dynamics.com page; they check the address first and stop at once unless the page is a Dynamics 365 organization page. The pattern is broad so that a new Microsoft region works without a new permission.
- **Access to your Pathix address (optional):** asked for when you save your Pathix address, for that one address only. The extension refuses addresses that contain a wildcard and addresses of Dynamics 365, the admin center or Microsoft sign-in.
- **Access to the Power Platform admin center (optional):** asked for only when you turn on the admin center overlay, and given back when you turn it off.

All of the extension's code ships in the package. It loads no code from anywhere else.

## Clouds that are not supported

The extension works in the commercial Dynamics 365 cloud and in GCC (US Government Community Cloud). It does not support GCC High, DoD or the China cloud (operated by 21Vianet) yet. It does nothing on those sites.

## Settings your organization can manage

Your organization's IT department can set the extension's managed policy (`chrome.storage.managed`) to turn off the tip line on cards for everyone. The extension only reads that setting. It stores nothing there.

## Children

The extension is a tool for people who administer and build Dynamics 365 systems at work. It is not directed at children, and it does not knowingly handle information about children.

## Your choices

- Use Lite only: do not enter a Pathix address. The extension then talks only to your Dataverse.
- Sign out on the options page to remove your token and your confirmed sign-in.
- Remove the Pathix address to go back to Lite and remove everything the extension kept about your sign-in.
- Turn the admin center overlay off at any time.
- Remove the extension to delete everything it stored.

Your organization's Pathix and Dataverse keep their own data, under your organization's control. Ask your organization's administrator about that data.

## Changes to this policy

When this policy changes, the new version is published at this address with a new "Last updated" date. If a change affects what the extension reads, sends or stores, the extension's store listing and release notes say so too.

## Contact

Questions about this policy: extension@pathix.app

Pathix™ is a trademark of Pathix L.L.C. Microsoft, Dynamics 365, Dataverse, Power Apps and Microsoft Entra are trademarks of the Microsoft group of companies.
