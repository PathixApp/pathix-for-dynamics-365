// A fake model-driven form for the smoke test: the D365 page the extension
// expects, served by Playwright's request routing under the scrubbed host
// the fixtures were captured from, so the real content scripts inject. Its
// Web API answers from contract/dataverse/ through the same router the unit
// tests and the demo use. Nothing leaves the machine.

import type { BrowserContext, Route } from "@playwright/test";
import { createFixtureRouter } from "../src/demo/fixture-dataverse";
import { allFixtures, capturedQueries } from "../test/fake-dataverse";

export const HOST = "contoso.crm.dynamics.com";
export const FORM_URL = `https://${HOST}/main.aspx?appid=00000000-0000-0000-0000-000000000000&pagetype=entityrecord&etn=account`;
const API = `https://${HOST}/api/data/v9.2/`;

export interface Field {
  control: string;
  column: string;
  label: string;
  locked?: boolean;
}

export const FIELDS: Field[] = [
  { control: "name", column: "name", label: "Account Name" },
  { control: "creditlimit", column: "creditlimit", label: "Credit Limit" },
  { control: "pathix_legalofficer", column: "pathix_legalofficer", label: "Legal Officer", locked: true },
];

/** A record form: the field containers the unified interface renders, and a fake Xrm. */
function formPage(): string {
  const fields = FIELDS.map(
    (field) =>
      `<div data-id="${field.control}-FieldSectionItemContainer" style="display:flex;gap:12px;padding:8px">` +
      `<label id="label-${field.control}" style="width:140px">${field.label}</label>` +
      `<input value="sample value"${field.locked ? " readonly" : ""} /></div>`,
  ).join("");
  // The fake Xrm hands out values too, as the real one does; the extension must never ask.
  const xrm = `
    const fields = ${JSON.stringify(FIELDS)};
    const attribute = (name) => ({ getName: () => name, getIsDirty: () => false, getSubmitMode: () => "dirty", getValue: () => "sample value" });
    window.Xrm = {
      Page: {
        data: { entity: { getEntityName: () => "account", getId: () => "{11111111-2222-4333-8444-555555555555}", attributes: { get: () => fields.map((f) => attribute(f.column)) } } },
        ui: {
          getFormType: () => 2,
          controls: { get: () => fields.map((f) => ({ getName: () => f.control, getAttribute: () => attribute(f.column), getDisabled: () => !!f.locked })) },
          formSelector: { getCurrentItem: () => ({ getId: () => "{5C4A0000-0000-4000-8000-000000000021}" }) },
        },
      },
      Utility: { getGlobalContext: () => ({ organizationSettings: { organizationId: "5c4a0000-0000-4000-8000-000000000003" } }) },
    };`;
  return `<!doctype html><html><head><title>Account: sample</title></head><body><main style="padding:24px">${fields}</main><script>${xrm}</script></body></html>`;
}

/** Serves the form and the Web API. Returns every Web API path requested, decoded. */
export async function serveFakeD365(context: BrowserContext): Promise<string[]> {
  const requests: string[] = [];
  const route = createFixtureRouter(allFixtures(), capturedQueries());
  await context.route(`https://${HOST}/**`, async (request: Route) => {
    const url = request.request().url();
    if (!url.startsWith(API)) return request.fulfill({ status: 200, contentType: "text/html", body: formPage() });
    const path = decodeURIComponent(url.slice(API.length));
    requests.push(path);
    const routed = route(path);
    return request.fulfill({
      status: routed.status,
      contentType: "application/json",
      body: routed.body === undefined ? "" : JSON.stringify(routed.body),
    });
  });
  return requests;
}
