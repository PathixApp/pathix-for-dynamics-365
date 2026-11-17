// The sandboxed demo: an extension page with a sample form and the real Lite
// cards, answered from the scrubbed fixtures in contract/dataverse/. Store
// reviewers and new users can try the cards without a Dynamics 365
// environment.
//
// It runs only on the extension's own demo.html, never on a customer's form:
// no content script loads it (test/demo.test.ts). Its Dataverse client is the
// real one, allowlist included, but its answers come from the bundled
// fixtures, so the page makes no network call at all.

import { CHANNEL, SNAPSHOT_VERSION, type FormSnapshot } from "../bridge/messages";
import { createDataverseClient, type FetchLike } from "../dataverse/client";
import { loadDependenciesCard } from "../lite/dependencies";
import { loadUserSecurity } from "../lite/user-security";
import { loadLockedCard } from "../lite/locked";
import { loadRegisteredCard } from "../lite/registered";
import { CardView } from "../content/card-view";
import { HoverController } from "../content/hover-controller";
import { createFixtureRouter } from "./fixture-dataverse";
import { DEMO_FIXTURES, DEMO_QUERIES } from "./fixtures";

/** The scrubbed host the fixtures were captured under. Never contacted. */
export const DEMO_ORIGIN = "https://contoso.crm.dynamics.com";
const API = `${DEMO_ORIGIN}/api/data/v9.2/`;
/** The fixtures' main Account form. */
const DEMO_FORM_ID = "5c4a0000-0000-4000-8000-000000000021";
const DEMO_ORGANIZATION_ID = "5c4a0000-0000-4000-8000-000000000003";

const route = createFixtureRouter(DEMO_FIXTURES, DEMO_QUERIES);

/** Answers the client from the fixtures, in place of the network. */
export const serveFromFixtures: FetchLike = async (input) => {
  const routed = input.startsWith(API) ? route(decodeURIComponent(input.slice(API.length))) : { status: 400, body: undefined };
  return new Response(routed.body === undefined ? null : JSON.stringify(routed.body), {
    status: routed.status,
    headers: { "Content-Type": "application/json" },
  });
};

function start(): void {
  const dataverse = createDataverseClient(DEMO_ORIGIN, serveFromFixtures);
  let showTips = true;

  const fields = Array.from(document.querySelectorAll<HTMLElement>("[data-demo-column]"));
  const dirty = new Set<string>();
  const snapshot = (): FormSnapshot => ({
    channel: CHANNEL,
    kind: "formSnapshot",
    version: SNAPSHOT_VERSION,
    organizationId: DEMO_ORGANIZATION_ID,
    host: new URL(DEMO_ORIGIN).host,
    table: "account",
    formId: DEMO_FORM_ID,
    columns: fields.map((field) => ({ control: field.dataset.demoControl!, column: field.dataset.demoColumn! })),
    dirtyColumns: [...dirty],
    lockedControls: fields.filter((field) => field.dataset.demoLocked === "true").map((field) => field.dataset.demoControl!),
    // The demo is Lite and has no save preview.
    saveKind: null,
    alwaysSubmitColumns: [],
    quickViewColumns: [],
  });

  const hover = new HoverController(new CardView(), {
    settings: async () => ({ mode: "lite", showTips }),
    connectedCard: async () => undefined,
    liteCards: async ({ table, column, control, formId, dirtyColumns, locked, showTips: tips }) => {
      const [registered, dependencies, lockedCard] = await Promise.all([
        loadRegisteredCard(dataverse, { table, column, dirtyColumns, showTips: tips }),
        loadDependenciesCard(dataverse, { table, column, showTips: tips }),
        locked ? loadLockedCard(dataverse, { table, column, control, formId, showTips: tips }) : Promise.resolve(null),
      ]);
      return { registered, dependencies, locked: lockedCard };
    },
    userSecurity: (table) => loadUserSecurity(dataverse, table),
    liveModified: async () => new Map(),
    hideTips: async () => {
      showTips = false;
    },
    openOptions: async () => {
      await chrome.runtime.openOptionsPage();
    },
  });

  // Typing marks the column as edited, the way the page bridge reports
  // dirty columns on a real form: by name only.
  for (const field of fields) {
    field.querySelector("input")?.addEventListener("input", () => {
      dirty.add(field.dataset.demoColumn!);
      hover.setSnapshot(snapshot());
      const note = document.getElementById("edits");
      if (note) note.textContent = `Unsaved edits: ${[...dirty].sort().join(", ")}.`;
    });
  }

  hover.setSnapshot(snapshot());
  hover.attach();
  document.getElementById("open-options")?.addEventListener("click", () => void chrome.runtime.openOptionsPage());
}

if (typeof document !== "undefined" && document.getElementById("demo-form")) start();
