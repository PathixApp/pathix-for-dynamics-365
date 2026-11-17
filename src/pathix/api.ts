// The Pathix calls the extension makes, all from the service worker.
//
// Requests go to <pathix-url>/api/..., the same path the web app uses: the
// web app proxies /api to the internal API container. The service worker
// holds a host permission for the Pathix origin, so CORS does not apply.
//
// Response types are the narrow slice this file reads. The contract they are
// checked against is contract/pathix-api.slice.json (test/contract.test.ts).

import { isEntraAuthority } from "../auth/authority";
import type { AuthSettings, GrantRefusal } from "../auth/authorize";

/**
 * What the extension signs in with, from Pathix's anonymous /config. The
 * tenant and its authority come from `azureAd`. The client ID and the scope
 * are the extension's own, from `extension`: the Pathix Browser
 * Extension app registration and the read-only scope. The web app's client ID
 * and its Pathix.Access scope, also in `azureAd`, are never used.
 */
export interface RuntimeAuthConfig {
  tenantId: string;
  /** e.g. https://login.microsoftonline.com/<tenant-id> */
  authority: string;
  /** The Pathix Browser Extension app registration's client ID. */
  clientId: string;
  /** api://<api-client-id>/Pathix.Read: the read-only scope, the only one the extension requests. */
  apiScope: string;
}

/**
 * Why a Pathix offers the extension no sign-in. For the first four, read from
 * /config, the extension makes no request to Entra. The last two can also
 * come from the token Entra grants, which is then discarded (GrantRefusal in
 * src/auth/authorize.ts).
 *
 * - `signInOff`: this Pathix has no Entra sign-in (`msalEnabled` is false,
 *   or `azureAd` names no tenant or authority).
 * - `olderPathix`: /config has no `extension` key, so this Pathix predates
 *   extension sign-in.
 * - `notRegistered`: `extension` is null. This Pathix has no app registration
 *   for the extension.
 * - `invalidRegistration`: `extension` is there but fails the checks
 *   (extensionRegistration below), the authority is not an Entra cloud's
 *   sign-in host with the tenant's GUID as its path (isEntraAuthority in
 *   src/auth/authority.ts), or Entra granted a token that names no scope.
 * - `grantsMoreThanRead`: Entra granted a token with a scope other than
 *   Pathix.Read, such as a Pathix.Access consented to the registration earlier.
 */
export type SignInUnavailable = "signInOff" | "olderPathix" | "notRegistered" | GrantRefusal;

export type AuthConfigResult = { ok: true; config: RuntimeAuthConfig } | { ok: false; unavailable: SignInUnavailable };

export interface EnvironmentSummary {
  id: string;
  name: string;
  url: string;
  /** Despite the name, the Dataverse ORGANIZATION id, which the page reports. */
  dataverseEnvironmentId: string;
  /** Tables the environment's scans leave out, by logical name. Absent on an older Pathix: unknown, so nothing is taken as excluded. */
  excludedEntities?: string[];
}

export interface ScanSummary {
  id: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
}

/** GET /findings/field-writers: one row per component that writes the column. */
export interface FieldWriter {
  componentId: string;
  componentName: string;
  componentType: string;
  /**
   * Pathix marks the component Microsoft-shipped: by publisher identity, with
   * three narrow exceptions (Microsoft's `cc_` script bundles, the Copilot
   * knowledge fallback, and the Microsoft-provisioned catalog), so copy does
   * not say how Pathix decides (DESIGN.md, "Authorship comes from the
   * publisher").
   */
  isSystem: boolean;
  isConditional: boolean;
  /** A user editing the column through this component (a form), not logic writing it. */
  isHumanDriven: boolean;
  confidence: string;
  actionTypes: string[];
  /** The component's Dataverse id: what a live read of its modifiedon asks for (M11). Absent on older Pathix. */
  sourceId?: string | null;
  /**
   * Every trigger the component has. null: it has none (a form, a
   * script), a person's action starts it. undefined: an older Pathix that does
   * not serve the list, which is unknown, never "no trigger".
   */
  triggers?: TriggerSummary[] | null;
}

/**
 * One trigger of a component, from field-writers rows and the registration.
 * Names only. The filter facts (filteringColumns, firesOnEveryUpdate,
 * hasRowFilter) are newer; an older Pathix omits them.
 */
export interface TriggerSummary {
  /** The SDK message. null for a trigger Pathix does not model (a flow started by a schedule, a button). Never "Custom". */
  message: string | null;
  stage: string | null;
  executionMode: string | null;
  /** The table the trigger fires on; null when it names none. */
  table: string | null;
  /**
   * The column logical names that scope the trigger. Empty on a Create or Delete
   * trigger. Empty on an update trigger means none were recorded: read it with
   * firesOnEveryUpdate.
   */
  filteringColumns?: string[];
  /** An update-family trigger with no filtering columns. Column scope only. */
  firesOnEveryUpdate?: boolean;
  /** A cloud flow's "Filter rows" setting. null: not a flow row-change trigger, or a scan that predates the flag. Unknown, never "no filter". */
  hasRowFilter?: boolean | null;
}

/**
 * GET /findings/field-dependents: the readers. The card counts rows, as the
 * Pathix UI does. X-ray's R leaves out the rows whose componentType is Form,
 * which it counts as F, and counts AiDerived rows apart.
 */
export interface FieldDependents {
  results: FieldDependent[];
  /** A sentence about reads the scan could not see, composed by Pathix. null: none. */
  coverageWarning?: string | null;
  /**
   * The column's Dataverse dependency records, measured at scan time. Usually
   * the count in Dataverse's Show dependencies view, but it can differ: that
   * view groups some records differently. null or absent: not measured, which is never zero.
   */
  platformDependentCount?: number | null;
}

export interface FieldDependent {
  componentId: string;
  componentName?: string;
  componentType: string;
  confidence: string;
  /** Display for a form's own read of the column. Absent on older Pathix. */
  referenceKind?: string;
  /** The component's Dataverse id; a form's is the form id the page reports. */
  sourceId?: string | null;
  /**
   * On a form's Display row: one entry per control that binds the
   * column. null or absent: unknown. A control id that is not listed is unknown
   * too, so never fall back to a form-level answer for it.
   */
  formControls?: FormControlSummary[] | null;
}

/** One control a form binds the column through, as the form declares it. */
export interface FormControlSummary {
  /** The control's id in the form definition, the name the page reports. null when the definition gives none. */
  controlId: string | null;
  /** Does not accept input: disabled, a quick view, or a form component host. */
  locked: boolean;
  hidden: boolean;
  /** body, header or footer. */
  location: string;
  /** quickView or formComponent when the control displays an embedded form; null for a plain field. */
  embed: string | null;
}

/**
 * GET /components/{id}: the slice the card reads, its registration. Present for
 * plugin steps, classic workflows, flows and actions; null for components with
 * no trigger (forms, scripts, canvas apps).
 */
export interface ComponentDetail {
  registration: ComponentRegistration | null;
}

export interface ComponentRegistration {
  /** Absent on an older Pathix. */
  triggers?: TriggerSummary[] | null;
  /**
   * A plugin step's images. null or absent: unknown, never "no
   * images"; an empty list was captured with none.
   */
  images?: StepImage[] | null;
  message: string | null;
  /** PreValidation, PreOperation, PostOperation, MainOperation, or null outside plugins. */
  stage: string | null;
  /** Synchronous or Asynchronous; classic workflows carry it too (real-time or background). */
  executionMode: string | null;
  primaryEntity: string | null;
}

export interface StepImage {
  /** Pre, Post, Both or Unknown. */
  imageType: string;
  name: string | null;
  entityAlias: string | null;
  /** Column logical names. Empty means all columns. */
  columns: string[];
}

/**
 * GET /findings/open-counts?fieldKey=table.column: open findings per column, the
 * read behind the Pathix UI popover's findings line. fieldKey repeats, so one
 * call serves many columns (X-ray batches). Ints can ride as strings.
 *
 * roleId repeats the same way, for the admin center overlay.
 * "Open" is Open or Reviewing in the admin's triage, without system noise and
 * suppressed finding types: the population of Pathix's findings page. A role
 * that is not in the latest scan is left out of `roles`, never zeroed, so a
 * missing role is unknown. fieldKey, componentId and roleId share a cap of 500
 * subjects per request (above it Pathix answers 400).
 */
export interface OpenFindingCounts {
  fields: Array<{ subjectKey: string; openCount: number | string; maxOpenSeverity: string | null }>;
  /** Absent on an older Pathix, which is unknown for every role. */
  roles?: RoleOpenFindingCount[];
  /**
   * null: the environment has no Completed scan, so every subject is left out.
   * Absent: a Pathix older than readiness (2026-09-23), where a positive count
   * is still real and a zero is unknown.
   */
  readiness?: {
    findings: { status: string; failedDetectorFindingTypes: string[] };
  } | null;
}

export interface RoleOpenFindingCount {
  /** The role's Pathix id in the latest scan (RoleSummary.id), never its Dataverse id. */
  roleId: string;
  openCount: number | string;
  /** Set exactly when openCount is above zero. */
  maxOpenSeverity: string | null;
}

/** GET /findings/field-permissions: column-level security for the column. */
export interface FieldPermissions {
  isSecured: boolean;
  grants: Array<{
    /** The profile's Dataverse fieldsecurityprofileid. Match on this; the name can change or repeat. */
    profileId: string;
    profileName: string;
    canUpdate: boolean;
    userCount: number;
    teamCount: number;
  }>;
  /**
   * Principals some record shares the column's value with, by per-record field
   * sharing, which bypasses column security profiles. Zero is
   * "none found", never "none exist": the scanner sees few or none of the
   * shares, a capped read stops short, and a scan that predates it has none
   * (shareCoverageIncomplete says when the count is a floor). Absent on an
   * older Pathix: unknown.
   */
  sharePrincipalCount?: number;
  /** How many record shares those add up to: grants, not distinct records. */
  shareRecordCount?: number;
  /**
   * The share counts are a floor, and zero is "not measured". A current Pathix
   * sets this on every secured or granted column, because Dataverse
   * shows Pathix's scanner role few or none of a secured column's record
   * shares. That is a standing limit, not a failed scan. An earlier Pathix
   * set it only when the scan's share read came back short (failed,
   * capped, truncated or dropped buckets). One flag covers both
   * causes, so the card cannot tell them apart. Absent on an older Pathix,
   * which did not say.
   */
  shareCoverageIncomplete?: boolean;
}

/** GET /findings/security-writers: the slice the card reads. */
export interface SecurityWritersSummary {
  scopeBreakdown: { totalPrincipals: number };
  tableResolved: boolean;
  withheldPrincipalCount: number;
  /**
   * Pathix's sentences about what the answer does not cover, such as group
   * teams it does not expand or inherited rows it truncated. Empty when
   * nothing applies; absent on an older Pathix.
   */
  coverageNotes?: string[];
}

/**
 * GET /changes/field: the scan-diff ledger filtered to one column, newest first.
 * The card reads only counts and dates, never the entries' names or transitions.
 * Pathix caps `entries` (500 at the time of writing), so `totalCount` can be
 * larger than `entries.length`.
 */
export interface FieldHistory {
  /** When Pathix began tracking changes in this environment; null when it has no diffs yet. */
  historySince: string | null;
  /** Ledger rows for the column, across every scan pair. */
  totalCount: number;
  entries: Array<{
    /** The scan whose diff recorded the row; absent or null on older rows. */
    scanId?: string | null;
    detectedAt: string;
    /**
     * Set when the row came from a Pathix update, not the org:
     * ParserRevised or FamilyIntroduced. Null or absent: an ordinary row, all
     * history from before the marker, or an older Pathix.
     */
    pathixChange?: string | null;
  }>;
}

/**
 * GET /changes: Pathix's change ledger for an environment, newest first, one
 * row per change a scan found. The extension asks for one table and the
 * default window (the last 30 days). Pathix caps `entries` (2,000 at the time
 * of writing); `totalCount` is the true count in the window. A row is tied to
 * a table only when it names one (a write or read of a column, a column
 * change, column security). Since a Pathix update of 2026-10-08, a component
 * added, renamed or changed in source carries its table too, from the next
 * scan on; earlier rows are not backfilled. In a newer Pathix, a form's
 * source version is its publishedon, so a form published again between two
 * scans is a SourceChanged row with its table, from the second scan after the
 * update (the first has no earlier date to compare). An unpublished edit makes
 * no row. A row with no table is not returned by a table filter. The extension
 * sends includePathixChanges=false, so rows from a Pathix update
 * are left out of the entries and of totalCount.
 */
export interface EnvironmentChanges {
  /** The window the answer covers. */
  from: string;
  to: string;
  totalCount: number;
  entries: ChangeEntry[];
  /**
   * The scan the latest one was compared with. null: there is no earlier scan
   * to compare, so no rows is "nothing compared yet", never "no changes".
   * Absent on an older Pathix: not known.
   */
  baselineScanNumber?: number | null;
  /**
   * Whether the latest diff compared findings: NotCompared, Compared or
   * ComparedWithExclusions. Anything but Compared means finding changes are
   * missing or partial. null or absent: not said.
   */
  findingDeltaGate?: string | null;
  /**
   * How every scan in the window was compared. The gate above
   * speaks for the latest scan only; "no changes" has to vouch for them all.
   * null or absent (an older Pathix): not known, and the panel falls back to
   * the latest scan's gate.
   */
  windowCoverage?: ChangeWindowCoverage | null;
}

/**
 * Counts of the window's scans, from Pathix's scan observations. The finding
 * counts are over scans whose change comparison completed, so a scan is never
 * counted as two gaps. "Not recorded" is a scan from before Pathix kept that
 * outcome, and never reads as compared. Pathix does not count the
 * environment's first scan as a gap: it had nothing to compare with.
 */
export interface ChangeWindowCoverage {
  scanCount: number;
  diffNotComparedCount: number;
  diffNotRecordedCount: number;
  findingsNotComparedCount: number;
  findingsWithExclusionsCount: number;
  findingGateNotRecordedCount: number;
}

export interface ChangeEntry {
  /** A ScanDeltaKind name, e.g. WriteAdded. A name the extension does not know is shown as written. */
  changeKind: string;
  /** Component, Field, FieldSecurityProfile and others. */
  subjectKind: string;
  /** For a Component row, the component's Dataverse id. */
  subjectId: string;
  subjectName: string;
  targetColumn: string | null;
  /** When the scan that found the change detected it. */
  detectedAt: string;
  scanId?: string | null;
  scanSequenceNumber?: number | null;
  /** For a Component row, its ComponentType name. */
  subjectComponentType?: string | null;
  /** Pathix marks it Microsoft-shipped. Null is "not recorded", never Microsoft-shipped. */
  subjectIsSystem?: boolean | null;
}

/**
 * GET /tables/{logicalName}/save-pipeline: what is
 * registered to fire when one record of the table is saved, single hop, in
 * execution order. A registration fact, never "writes": no entry has a
 * confidence tier. Names only.
 */
export interface SavePipeline {
  table: string;
  /** Create or Update. */
  message: string;
  /** The changed columns Pathix matched against, lower case. null on Create and in browse mode. */
  columns: string[] | null;
  /** Update with no columns: everything registered for the message, each entry showing its own filter. */
  browseMode: boolean;
  scope: { environmentId: string; scanId: string; scannedAt: string | null };
  /**
   * ONE timeline, in execution order: a lane per stage present (the platform's stage order), then Asynchronous.
   * PreValidation, PreOperation, MainOperation, PostOperation and Asynchronous are always there, empty or not;
   * any other stage only when it has entries. The save itself is the MainOperation lane.
   */
  lanes: SavePipelineLane[];
  /** Only entries whose position is genuinely unknown: a synchronous entry with no stage, or an entry with no execution mode. */
  unplaced: SavePipelineEntry[];
  /** Entity-scoped business rules. Their place among the steps is not documented, so they have no lane. */
  serverBusinessRules: Array<{ componentId: string; componentName: string; isSystem: boolean }>;
  /** Disabled components that would otherwise be in the pipeline. */
  excludedDisabled: number;
  /**
   * Enabled plugin steps for the message, passing the column rule, bound to one table the platform does not
   * name: often a table no longer in the environment. Counted, never
   * listed, since Pathix cannot say they fire for this table; `unresolvedTableStepsNotListed` rides with a
   * non-zero count. Absent on an older Pathix, which listed them as "all tables" instead.
   */
  unresolvedTableSteps?: number;
  /** Present only when a formId was sent. */
  clientLayer: SavePipelineClientLayer | null;
  /** Codes the response must be read with. A code the extension does not know is shown as written. */
  disclosures: string[];
}

export interface SavePipelineLane {
  /** PreValidation, PreOperation, MainOperation, PostOperation, Asynchronous, or the platform's own stage name (InternalPreOperationBeforeExternalPlugins, PostOperationDeprecated, ...). An unrecognized stage n is "Stage{n}". */
  lane: string;
  /** The platform's stage number. null only for Asynchronous. */
  stage: number | null;
  /** pipeline (10, 20, 40), mainOperation (30), platformInternal (5, 15, 25, 35, 45, 55, 80, 90), deprecated (50), unrecognized (any other stage), asynchronous. */
  kind: string;
  /** false for Asynchronous: never a sequence. */
  ordered: boolean;
  entries: SavePipelineEntry[];
}

export interface SavePipelineEntry {
  componentId: string;
  componentName: string;
  componentType: string;
  /** Pathix marks it Microsoft-shipped (DESIGN.md, "Authorship comes from the publisher"). */
  isSystem: boolean;
  trigger: TriggerSummary;
  /** The changed columns that matched the trigger's filter. null: it fires on any change, on Create, or in browse mode. */
  matchedColumns: string[] | null;
  executionOrder: number | null;
  /** The order is not known; the entry is listed after the ordered ones. */
  orderUnknown: boolean;
  /** Another entry in the lane has the same order, so their relative order is not guaranteed. */
  tiedOrder: boolean;
  /** A plugin step registered for the message on every table. */
  allTables: boolean;
  /** A cloud flow's row filter can skip the entry. */
  conditional: boolean;
  /** A cloud flow whose row filter is not known (a scan that predates the flag). */
  rowFilterUnknown: boolean;
}

/** The form's OnSave handlers. */
export interface SavePipelineClientLayer {
  formId: string;
  /** modeled, or notModeled: Pathix cannot say what the form registers, and `handlers` is null. */
  coverage: string;
  /** formNotFound, handlersNotRecorded or formNotParsed when coverage is notModeled. */
  notModeledReason: string | null;
  /** false: the handler order is not kept, so the list is not a sequence. */
  ordered: boolean;
  handlers: SavePipelineHandler[] | null;
}

export interface SavePipelineHandler {
  library: string | null;
  function: string | null;
  /** null: the form definition did not say. */
  isEnabled: boolean | null;
  /** The platform wired it, not a maker. Tagged, never hidden. */
  isPlatformLoaded: boolean;
  scriptComponentId: string | null;
}

/**
 * The non-empty JSON string body of a 404, or undefined when it has none (an empty body, HTML, an
 * object). Pathix's typed NotFound<string> carries one; a route miss answers with an empty body.
 * The wording is never compared, so a reworded message cannot change what the extension says.
 */
async function notFoundDetail(response: Response): Promise<string | undefined> {
  try {
    const body: unknown = await response.json();
    return typeof body === "string" && body.trim() !== "" ? body : undefined;
  } catch {
    return undefined;
  }
}

/**
 * GET /environments/{id}/forms/{formId}/handlers: the script handlers a form
 * registers, read from the formxml on the environment's latest Completed scan.
 * formId is the systemform id the page reports. 404: the form
 * is not in that scan, which is not "no handlers".
 */
export interface FormHandlers {
  formId: string;
  /**
   * The form's name and its table's logical name on the scan,
   * under "modeled" and "notModeled" alike. null when the scan does not know
   * the form; absent on an older Pathix. The extension refuses an answer whose
   * table is not the open form's.
   */
  formName?: string | null;
  table?: string | null;
  /** The scan this answer came from. */
  scope: { environmentId: string; scanId: string; scannedAt: string | null };
  /** "modeled", or "notModeled" when Pathix cannot say what the form registers. */
  coverage: string;
  /**
   * Under "notModeled": "handlersNotRecorded" (the scan holds no handler rows
   * for any form) or "formNotParsed" (this form's formxml was not read). null
   * under "modeled".
   */
  notModeledReason: string | null;
  /**
   * true: every handler carries its formxml position and the list is in that
   * order. false: the scan predates the position, so the list is a sort by name
   * and must not be read as a sequence; also false under "notModeled".
   */
  ordered: boolean;
  /** null under "notModeled", never an empty list that reads as "no script runs". */
  handlers: FormHandler[] | null;
}

/** One handler a form registers. A null flag means the formxml did not say; it is never a default. */
export interface FormHandler {
  /** The event as the form writes it: onload, onsave, onchange, TabStateChange, OnRecordSelect. */
  event: string | null;
  /** Form, Tab or Control: what the event belongs to. */
  scope: string;
  /** The tab's name or the control's id. null on Form scope, and when the formxml names neither. */
  scopeName: string | null;
  /** The column an onchange is attached to; null for an event not tied to a column. */
  column: string | null;
  function: string | null;
  /** The web resource the function lives in, as the form names it. */
  library: string | null;
  /** The scanned script the library resolved to; null when it resolved to none. */
  scriptComponentId: string | null;
  isEnabled: boolean | null;
  passExecutionContext: boolean | null;
  hasParameters: boolean;
  /** The platform wired the handler, not a maker (InternalHandlers). Tagged, never hidden. */
  isPlatformLoaded: boolean;
  /** 0-based position in the form's handler list; null on a scan that predates it. */
  ordinal: number | null;
}

/**
 * GET /roles: one row per security role in the latest Completed scan, one per
 * role per business unit (a copy has its own sourceId and its own holders).
 * `assignmentCount` is direct assignments of every kind: users, application
 * users and teams. A team's members are not counted.
 *
 * The parent root role and the split by kind are newer additions.
 * Each is optional here: a Pathix older than those changes leaves them out,
 * which is unknown, never "no copies" or "no humans".
 */
export interface RoleSummary {
  /** Pathix's id for the role in this scan; what the Pathix UI and /findings/open-counts take. */
  id: string;
  /** The role's Dataverse id: the id in the admin center's address. */
  sourceId: string;
  name: string;
  assignmentCount: number;
  /**
   * The Dataverse id of the root role this row is a business unit copy of:
   * compare it with another row's sourceId, never its id. null for a root
   * role. Also null on every row of a scan taken before Pathix read the
   * column, so no row having one is not evidence of a single business unit.
   */
  parentRootRoleId?: string | null;
  /** Users the platform does not manage. */
  humanAssignmentCount?: number;
  /** Application users the platform does not manage. */
  integrationAssignmentCount?: number;
  /** Teams. Their members are not counted. */
  teamAssignmentCount?: number;
  /**
   * Users and application users the platform manages: Power Pages site users,
   * agents, unlicensed activity parties. Decided before the principal type, so
   * none of them is a human or an integration. The four counts sum to
   * assignmentCount.
   */
  platformManagedAssignmentCount?: number;
}

/**
 * GET /principals/by-app-id?appId=...&appId=...: the principals
 * whose Entra Application ID is one of those asked, matched without regard to
 * case. At most 100 ids per request (more is a 400).
 */
export interface PrincipalsByAppId {
  /** The ids asked, de-duplicated, in request order. An id in this list with no principal is a miss. */
  requestedAppIds: string[];
  /** The scan that answered. null when the environment has no Completed scan: nothing was looked up, so nothing is a miss. */
  scope: { environmentId: string; scanId: string; scannedAt: string | null } | null;
  /** Every match, ordered by name. One Application ID can match several rows. */
  principals: PrincipalRow[];
}

/** A principal row, the shape GET /principals and GET /principals/by-app-id share. */
export interface PrincipalRow {
  id: string;
  principalType: string;
  /** An application user's Entra application (client) id; null for a user or a team. */
  appId: string | null;
  isEnabled: boolean;
  /** Roles assigned to the principal directly. */
  roleCount: number;
}

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; kind: "signedOut" }
  | { ok: false; kind: "unauthorized"; status: number }
  /**
   * `status` is the HTTP status when Pathix answered, absent when the request itself failed.
   * `detail` is the non-empty JSON string body of a 404 (Pathix's typed NotFound), kept so a caller can tell
   * "Pathix has no such record" from "Pathix has no such route"; absent for any other answer.
   */
  | { ok: false; kind: "failed"; message: string; status?: number; detail?: string };

/**
 * Pathix's typed 404 (NotFound<string>): a non-empty JSON string body, "no such
 * record in the latest scan". A 404 with an empty body is a route miss, a
 * Pathix older than the route, which says nothing about the scan. The wording
 * is never compared.
 */
export function isTypedNotFound(result: ApiResult<unknown>): boolean {
  return !result.ok && result.kind === "failed" && result.status === 404 && (result.detail ?? "").trim() !== "";
}

/** A 404 with no body: Pathix has no such route, so it is probably older than this extension. */
export function isRouteMiss(result: ApiResult<unknown>): boolean {
  return !result.ok && result.kind === "failed" && result.status === 404 && (result.detail ?? "").trim() === "";
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One scope, with no spaces, that ends in /Pathix.Read. A space would let a
 * second scope, such as Pathix.Access, ride along in the same request.
 */
const READ_SCOPE = /^\S+\/Pathix\.Read$/;

const ACCESS_SUFFIX = "/Pathix.Access";
const READ_SUFFIX = "/Pathix.Read";

/**
 * How long one Pathix request may take, its answer and its body together.
 * Past it the request is aborted and reads as failed ("Pathix did not answer
 * in time"), never as an empty answer (DESIGN.md, "Absence is not evidence").
 */
export const PATHIX_TIMEOUT_MS = 15_000;

/** Why a Pathix request failed when Pathix did not answer within PATHIX_TIMEOUT_MS. */
export const PATHIX_TIMEOUT_TEXT = "Pathix did not answer in time.";

/**
 * Why a Pathix answer could not be used when it was a web page: a proxy, a
 * gateway's sign-in page or a captive portal answered 200 with HTML. Without
 * this the card showed the parser's "Unexpected token '<'".
 */
export const PATHIX_WEB_PAGE_TEXT = "Pathix answered with a web page, not data. A proxy or sign-in page may be in the way.";

/** Why a Pathix answer could not be used when its body was not JSON, and not a web page either. */
export const PATHIX_NOT_DATA_TEXT = "Pathix answered with something that is not data. A proxy or sign-in page may be in the way.";

/** Whether the answer says it is a web page. Only the header is read, never the body. */
export function isWebPage(response: Pick<Response, "headers">): boolean {
  const type = response.headers?.get?.("content-type") ?? "";
  return /\btext\/html\b|\bapplication\/xhtml\+xml\b/i.test(type);
}

/** A fresh abort deadline per request, which aborts after PATHIX_TIMEOUT_MS. Injected so tests need no real clock. */
export type Deadline = () => AbortSignal;

export const pathixTimeout: Deadline = () => AbortSignal.timeout(PATHIX_TIMEOUT_MS);

/**
 * Anonymous: the same bootstrap call the web app makes before signing in.
 * Throws when Pathix does not answer, or answers with something that is not
 * its settings (a proxy's `{}`, say): that is unknown, never "sign-in is
 * off". A Pathix that answers but offers the extension no sign-in is a
 * result, not an error. A Pathix that does not answer in time throws
 * PATHIX_TIMEOUT_TEXT.
 */
export async function fetchAuthConfig(pathixUrl: string, fetchFn: typeof fetch, timeout: Deadline = pathixTimeout): Promise<AuthConfigResult> {
  // Never a cached answer: an administrator's change to the registration must show.
  // A redirect is a failed read, never followed: the answer must come from this address.
  const deadline = timeout();
  let response: Response;
  try {
    response = await fetchFn(`${pathixUrl}/api/config`, { cache: "no-store", redirect: "error", signal: deadline });
  } catch (error) {
    if (deadline.aborted) throw new Error(PATHIX_TIMEOUT_TEXT);
    if (await answersWithRedirect(pathixUrl, fetchFn, timeout)) throw new Error(REDIRECT_TEXT);
    throw error;
  }
  if (!response.ok) throw new Error(`Pathix /config answered ${response.status}.`);
  if (isWebPage(response)) throw new Error(PATHIX_WEB_PAGE_TEXT);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    if (deadline.aborted) throw new Error(PATHIX_TIMEOUT_TEXT);
    throw new Error(PATHIX_NOT_DATA_TEXT);
  }
  if (!isRecord(body) || typeof body.msalEnabled !== "boolean" || !isRecord(body.azureAd)) {
    throw new Error("Pathix /config did not answer with its settings.");
  }
  return readAuthConfig(body, body.msalEnabled, body.azureAd);
}

/**
 * Why /config could not be read when the address redirects. Where it
 * redirects is not known ("manual" hides it), and it is often a sign-in
 * gateway, so the text never calls the target Pathix. Shown on its own.
 */
export const REDIRECT_TEXT =
  "Pathix answered with a redirect, for example to a sign-in gateway. The extension needs an address that answers /api/config directly.";

/**
 * After a failed /config read, whether the address answers with a redirect,
 * so the options page can say so instead of "Failed to fetch". One more
 * anonymous request, with no credentials and no token, and the redirect is
 * never followed: "manual" only reports that there was one.
 */
async function answersWithRedirect(pathixUrl: string, fetchFn: typeof fetch, timeout: Deadline): Promise<boolean> {
  try {
    const probe = await fetchFn(`${pathixUrl}/api/config`, { cache: "no-store", redirect: "manual", credentials: "omit", signal: timeout() });
    return probe.type === "opaqueredirect";
  } catch {
    return false;
  }
}

function readAuthConfig(body: Record<string, unknown>, msalEnabled: boolean, azureAd: Record<string, unknown>): AuthConfigResult {
  const { tenantId, authority } = azureAd;
  if (!msalEnabled || !isFilled(tenantId) || !isFilled(authority)) return unavailable("signInOff");

  // An older Pathix leaves the key out; a Pathix with no registration sends null.
  if (!("extension" in body)) return unavailable("olderPathix");
  if (body.extension === null) return unavailable("notRegistered");

  const registration = extensionRegistration(body.extension, azureAd);
  if (!registration || !isEntraAuthority(authority, tenantId)) return unavailable("invalidRegistration");
  return { ok: true, config: { tenantId, authority, ...registration } };
}

/**
 * The extension's client ID and scope, or null when they fail the checks. The
 * client ID is a GUID and not the web app's. The scope is one space-free
 * .../Pathix.Read, and exactly the web app's Pathix.Access scope with
 * Pathix.Read in its place, which is how Pathix derives it.
 */
function extensionRegistration(extension: unknown, azureAd: Record<string, unknown>): { clientId: string; apiScope: string } | null {
  if (!isRecord(extension)) return null;
  const { clientId, apiScope } = extension;
  if (typeof clientId !== "string" || !GUID.test(clientId)) return null;
  if (typeof azureAd.clientId === "string" && clientId.toLowerCase() === azureAd.clientId.toLowerCase()) return null;
  if (typeof apiScope !== "string" || !READ_SCOPE.test(apiScope)) return null;
  if (apiScope !== readScopeFor(azureAd.apiScope)) return null;
  return { clientId, apiScope };
}

/** The read scope Pathix derives from the web app's scope, or null when that does not end in /Pathix.Access. */
function readScopeFor(accessScope: unknown): string | null {
  if (typeof accessScope !== "string" || !accessScope.endsWith(ACCESS_SUFFIX)) return null;
  return `${accessScope.slice(0, -ACCESS_SUFFIX.length)}${READ_SUFFIX}`;
}

/** The sign-in request's settings: this Pathix, the tenant's authority, and the extension's own client ID and read-only scope. */
export function authSettingsFrom(config: RuntimeAuthConfig, target: { pathixUrl: string; redirectUri: string }): AuthSettings {
  return {
    pathixUrl: target.pathixUrl,
    authority: config.authority,
    clientId: config.clientId,
    apiScope: config.apiScope,
    redirectUri: target.redirectUri,
  };
}

function unavailable(reason: SignInUnavailable): AuthConfigResult {
  return { ok: false, unavailable: reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFilled(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Supplies a bearer token. `renew` asks for a fresh one after a 401; null
 * means the user is signed out.
 */
export type TokenSource = (renew: boolean) => Promise<string | null>;

/**
 * GET with one re-auth attempt: a 401 triggers one silent renewal
 * and one retry, never a loop. A second 401 or a 403 means the account is not
 * allowed (for example, not assigned to the Pathix API), not that the token
 * is stale. Each attempt has PATHIX_TIMEOUT_MS to answer, body included; one
 * that does not is a failed read (PATHIX_TIMEOUT_TEXT), which no cache keeps.
 */
export async function apiGet<T>(
  pathixUrl: string,
  path: string,
  getToken: TokenSource,
  fetchFn: typeof fetch,
  timeout: Deadline = pathixTimeout,
): Promise<ApiResult<T>> {
  const timedOut: ApiResult<T> = { ok: false, kind: "failed", message: PATHIX_TIMEOUT_TEXT };
  for (const renew of [false, true]) {
    const token = await getToken(renew);
    if (!token) return { ok: false, kind: "signedOut" };

    const deadline = timeout();
    let response: Response;
    try {
      // redirect "error": the bearer token never follows a redirect, and a redirect reads as a failed request.
      response = await fetchFn(`${pathixUrl}/api${path}`, { headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: deadline });
    } catch (error) {
      if (deadline.aborted) return timedOut;
      return { ok: false, kind: "failed", message: error instanceof Error ? error.message : String(error) };
    }

    if (response.status === 401 && !renew) continue;
    if (response.status === 401 || response.status === 403) {
      return { ok: false, kind: "unauthorized", status: response.status };
    }
    if (!response.ok) {
      const failed: ApiResult<T> = { ok: false, kind: "failed", message: `Pathix answered ${response.status}.`, status: response.status };
      const detail = response.status === 404 ? await notFoundDetail(response) : undefined;
      if (deadline.aborted) return timedOut;
      return detail === undefined ? failed : { ...failed, detail };
    }
    // A 200 web page is a proxy or a sign-in page in the way, not Pathix's answer.
    if (isWebPage(response)) return { ok: false, kind: "failed", message: PATHIX_WEB_PAGE_TEXT, status: response.status };
    try {
      return { ok: true, data: (await response.json()) as T };
    } catch {
      if (deadline.aborted) return timedOut;
      return { ok: false, kind: "failed", message: PATHIX_NOT_DATA_TEXT, status: response.status };
    }
  }
  return { ok: false, kind: "unauthorized", status: 401 };
}
