# Contributing

Thanks for looking. One person maintains this project, so here is how to make your time count.

## Issues first

**Issues are welcome:** bugs, confusing cards, forms where the extension gets something wrong, and ideas. For a bug, say the browser and version, the extension version, which mode you were in (Lite or connected), and the table and column. Never paste field values, record IDs or full URLs from your environment. Table and column names are enough.

**Pull requests by discussion first.** Open an issue and agree the change before you write it. A pull request that arrives without one may be closed, however good it is, simply because there is no time to review work nobody planned. Small fixes to typos and docs are the exception.

**How a merged change lands.** This repository is published from the maintainer's development repository, one commit per update. An agreed pull request is applied there and comes back here with the next update, so GitHub shows it as closed rather than merged. Your change and your sign-off are kept, and the changelog credits you.

Security problems go to the address in [`SECURITY.md`](SECURITY.md), never to a public issue.

## Sign off your commits (DCO)

Every commit must carry a `Signed-off-by` line. It certifies the [Developer Certificate of Origin](https://developercertificate.org/): that you wrote the change, or have the right to submit it under the project's license (Apache 2.0, see [`LICENSE`](LICENSE)).

```bash
git commit -s
```

The name and email in the line must be your real ones. To sign off commits you already made on your branch:

```bash
git rebase --signoff main
```

## Build and check

Run all four before every commit. CI runs the same steps on every pull request.

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

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `test:`, `chore:`.

Read [`DESIGN.md`](DESIGN.md) before you change behavior.

## The rules

These hold in every change. A pull request that breaks one will not be merged, and an issue is the place to argue for changing one.

### Privacy

- **Names, never values.** Code in the Dynamics 365 page reads logical names: table, column, control, form ID, organization ID. It never reads field values, the record ID, or the URL beyond its host, and nothing else crosses the page bridge. Three tests hold this: `test/messages.test.ts`, `test/form-snapshot.test.ts` and `test/page-source.test.ts`. Never weaken them. If you add a page-side read, extend them in the same change.
- **Metadata only, in both modes.** Lite queries Dataverse metadata tables and functions only. It never reads business records, audit data or plugin-trace logs. Every Lite request goes through one client with an allowlist, and a test pins the allowlist.
- **The page script makes no network calls.** The script that runs in the page's own JavaScript world calls nothing. Calls to Pathix come from the service worker. Lite's Dataverse calls come from the content script, on the same origin.
- **No telemetry.** The extension talks only to the user's own Dataverse, their organization's Pathix and Microsoft Entra.

### What the extension claims

- **Absence is not evidence.** A failed, forbidden or missing answer shows as unknown. It never shows as zero or "nothing found".
- **Authorship comes from the publisher.** To separate Microsoft-shipped components from the customer's own, the only valid signal is the publisher of the owning solution. Managed or unmanaged is packaging state, never authorship. If the publisher is not cheap to get, do not separate them.
- **Lite and connected say different things.** Lite counts in platform terms: "tracked dependencies", "registered to fire", "form scripts". It never says "writers", which is a claim only Pathix can make. It never counts or lists writers, and never shows a Pathix number or result. A footer line may say what Pathix does.

### What the project accepts

- **No new manifest permissions or host patterns** without the maintainer's approval. If your change needs one, say why in the issue first.
- **No new npm dependencies** unless agreed in the issue first.
- **Fixtures are real.** The files in `contract/dataverse/` are real Dataverse responses, scrubbed. Build against them, not against guessed shapes. If you need a response that is not there, add the query to `contract/dataverse/queries.json`, build against a clearly marked hand-written stand-in, and say so in the pull request.
- **The Pathix API contract is generated.** Do not edit `contract/pathix-api.slice.json` by hand.
- **Never commit an extension key.** `manifest.json` carries none. Put yours in `manifest.key.local.json`, which git ignores.

### Wording

- US English. Short sentences. No em dashes in text the user sees.
- Write "Pathix™", never "®". Use no Microsoft logos. Wherever the product is described, say that it is not affiliated with Microsoft.
- One footer line per card names what that card cannot see and what Pathix does about it, with the word "Pathix" as the link. No banners, popups or "upgrade" buttons.

## Your fork

The license covers the code, not the Pathix name or mark. If you ship your own version, ship it under your own name. See [`NOTICE`](NOTICE).
