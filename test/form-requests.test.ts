// A page can post any snapshot. The content script relays it with the tab's
// own host (src/content/page-host.ts), and the worker answers a form request
// only for the sender's host and a few organization ids per tab
// (src/background/form-requests.ts). The service worker's wiring is read as
// text: it is evaluated against a mocked chrome in test/service-worker.test.ts.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { admitFormRequest, MAX_ORGANIZATIONS_PER_TAB, senderHost, TabOrganizations } from "../src/background/form-requests";
import type { FormSnapshot, PageMessage } from "../src/bridge/messages";
import { withPageHost } from "../src/content/page-host";

const ORG = "c0de0000-0000-4000-8000-000000000001";
const HOST = "contoso.crm.dynamics.com";
const SENDER = { origin: `https://${HOST}`, tab: { id: 7 } };

function org(n: number): string {
  return `c0de0000-0000-4000-8000-00000000000${n}`;
}

describe("withPageHost", () => {
  const snapshot = { kind: "formSnapshot", host: "fabrikam.crm.dynamics.com", organizationId: ORG } as unknown as FormSnapshot;

  it("writes the tab's own host over the one the page posted", () => {
    expect(withPageHost(snapshot, "Contoso.crm.dynamics.com")).toEqual({ ...snapshot, host: HOST });
  });

  it("leaves a message that is not a snapshot alone", () => {
    const noForm = { kind: "noForm", reason: "not a form" } as unknown as PageMessage;
    expect(withPageHost(noForm, HOST)).toBe(noForm);
  });
});

describe("senderHost", () => {
  it("reads the sender's origin, else its URL's host", () => {
    expect(senderHost({ origin: "https://Contoso.crm.dynamics.com" })).toBe(HOST);
    expect(senderHost({ url: `https://${HOST}/main.aspx?id=1` })).toBe(HOST);
    expect(senderHost({})).toBeNull();
    expect(senderHost({ origin: "not a url" })).toBeNull();
  });
});

describe("admitFormRequest", () => {
  it("answers a request for the sender's own host", () => {
    expect(admitFormRequest({ organizationId: ORG, host: HOST }, SENDER, new TabOrganizations())).toBe(true);
  });

  it("refuses a request that names another host than the tab it came from", () => {
    expect(admitFormRequest({ organizationId: ORG, host: "fabrikam.crm.dynamics.com" }, SENDER, new TabOrganizations())).toBe(false);
    expect(admitFormRequest({ organizationId: ORG, host: HOST }, { tab: { id: 7 } }, new TabOrganizations())).toBe(false);
  });

  it(`answers for ${MAX_ORGANIZATIONS_PER_TAB} organization ids per tab, then refuses new ones until the tab loads a page`, () => {
    const tabs = new TabOrganizations();
    for (let n = 1; n <= MAX_ORGANIZATIONS_PER_TAB; n += 1) {
      expect(admitFormRequest({ organizationId: org(n), host: HOST }, SENDER, tabs)).toBe(true);
    }
    expect(admitFormRequest({ organizationId: org(9), host: HOST }, SENDER, tabs)).toBe(false);
    expect(admitFormRequest({ organizationId: org(1).toUpperCase(), host: HOST }, SENDER, tabs)).toBe(true);
    expect(admitFormRequest({ organizationId: org(9), host: HOST }, { ...SENDER, tab: { id: 8 } }, tabs)).toBe(true);
    tabs.reset(7);
    expect(admitFormRequest({ organizationId: org(9), host: HOST }, SENDER, tabs)).toBe(true);
  });

  it("refuses a request with no tab", () => {
    expect(admitFormRequest({ organizationId: ORG, host: HOST }, { origin: SENDER.origin }, new TabOrganizations())).toBe(false);
  });
});

describe("the service worker", () => {
  const worker = readFileSync("src/background/service-worker.ts", "utf8");

  it("checks every form request and every snapshot", () => {
    for (const load of ["fieldCardFor", "xrayFor", "tableChangesFor", "eventMapFor", "savePreviewFor"]) {
      expect(worker).toContain(`if (!isFormRequestFrom(message, sender)) return false;\n    void ${load}(message)`);
    }
    expect(worker).toMatch(/message\.kind !== "formSnapshot"\) return false;\s*if \(!isFormRequestFrom\(message, sender\)\) return false;/);
  });

  it("starts a tab's count again when it loads a page or closes", () => {
    expect(worker).toContain("tabOrganizations.reset(tabId);");
    expect(worker).toContain("chrome.tabs.onRemoved.addListener((tabId) => tabOrganizations.reset(tabId));");
  });
});
