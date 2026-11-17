// The scrubbed fixtures the demo page answers from, bundled into demo.js.
// test/demo.test.ts checks this list holds every fixture in
// contract/dataverse/, so a new capture cannot be left out.

import queries from "../../contract/dataverse/queries.json";
import attributeAccountCreditlimit from "../../contract/dataverse/attribute-account-creditlimit.json";
import attributeAccountName from "../../contract/dataverse/attribute-account-name.json";
import attributeAccountPathixLegalofficer from "../../contract/dataverse/attribute-account-pathix-legalofficer.json";
import attributeAccountPrimarycontactid from "../../contract/dataverse/attribute-account-primarycontactid.json";
import attributeAccountTelephone1 from "../../contract/dataverse/attribute-account-telephone1.json";
import dependentsAccountCreditlimit from "../../contract/dataverse/dependents-account-creditlimit.json";
import dependentsAccountName from "../../contract/dataverse/dependents-account-name.json";
import dependentsAccountPathixLegalofficer from "../../contract/dataverse/dependents-account-pathix-legalofficer.json";
import dependentsAccountPrimarycontactid from "../../contract/dataverse/dependents-account-primarycontactid.json";
import dependentsAccountTelephone1 from "../../contract/dataverse/dependents-account-telephone1.json";
import entityPrivilegesAccount from "../../contract/dataverse/entity-privileges-account.json";
import fieldPermissionsAccount from "../../contract/dataverse/field-permissions-account.json";
import fieldSecurityProfiles from "../../contract/dataverse/field-security-profiles.json";
import formsAccountMain from "../../contract/dataverse/forms-account-main.json";
import formsModifiedAccount from "../../contract/dataverse/forms-modified-account.json";
import formsAccountEvents from "../../contract/dataverse/forms-account-events.json";
import modifiedFormsAccountName from "../../contract/dataverse/modified-forms-account-name.json";
import myFieldSecurityProfiles from "../../contract/dataverse/my-field-security-profiles.json";
import myPrivilegesAccount from "../../contract/dataverse/my-privileges-account.json";
import myReadPrivileges from "../../contract/dataverse/my-read-privileges.json";
import myTeams from "../../contract/dataverse/my-teams.json";
import nameAttributeAccountName from "../../contract/dataverse/name-attribute-account-name.json";
import nameRelationshipAccountName from "../../contract/dataverse/name-relationship-account-name.json";
import nameRelationshipAccountPathixLegalofficer from "../../contract/dataverse/name-relationship-account-pathix-legalofficer.json";
import namesChartsAccountName from "../../contract/dataverse/names-charts-account-name.json";
import namesFormsAccountName from "../../contract/dataverse/names-forms-account-name.json";
import namesPluginStepsAccountName from "../../contract/dataverse/names-plugin-steps-account-name.json";
import namesProcessesAccountName from "../../contract/dataverse/names-processes-account-name.json";
import namesStepImagesAccountName from "../../contract/dataverse/names-step-images-account-name.json";
import namesViewsAccountName from "../../contract/dataverse/names-views-account-name.json";
import pluginStepsAccount from "../../contract/dataverse/plugin-steps-account.json";
import pluginStepsUpdateAllTables from "../../contract/dataverse/plugin-steps-update-all-tables.json";
import publishers from "../../contract/dataverse/publishers.json";
import publishersUpdateAllTables from "../../contract/dataverse/publishers-update-all-tables.json";
import solutions from "../../contract/dataverse/solutions.json";
import solutionsUpdateAllTables from "../../contract/dataverse/solutions-update-all-tables.json";
import roleWritePrivilegeAccount from "../../contract/dataverse/role-write-privilege-account.json";
import teamProfiles from "../../contract/dataverse/team-profiles.json";
import teamRoles from "../../contract/dataverse/team-roles.json";
import whoami from "../../contract/dataverse/whoami.json";
import workflowsAccount from "../../contract/dataverse/workflows-account.json";
import type { CapturedQuery, Fixtures } from "./fixture-dataverse";

export const DEMO_FIXTURES: Fixtures = {
  "attribute-account-creditlimit": attributeAccountCreditlimit,
  "attribute-account-name": attributeAccountName,
  "attribute-account-pathix-legalofficer": attributeAccountPathixLegalofficer,
  "attribute-account-primarycontactid": attributeAccountPrimarycontactid,
  "attribute-account-telephone1": attributeAccountTelephone1,
  "dependents-account-creditlimit": dependentsAccountCreditlimit,
  "dependents-account-name": dependentsAccountName,
  "dependents-account-pathix-legalofficer": dependentsAccountPathixLegalofficer,
  "dependents-account-primarycontactid": dependentsAccountPrimarycontactid,
  "dependents-account-telephone1": dependentsAccountTelephone1,
  "entity-privileges-account": entityPrivilegesAccount,
  "field-permissions-account": fieldPermissionsAccount,
  "field-security-profiles": fieldSecurityProfiles,
  "forms-account-events": formsAccountEvents,
  "forms-account-main": formsAccountMain,
  "forms-modified-account": formsModifiedAccount,
  "modified-forms-account-name": modifiedFormsAccountName,
  "my-field-security-profiles": myFieldSecurityProfiles,
  "my-privileges-account": myPrivilegesAccount,
  "my-read-privileges": myReadPrivileges,
  "my-teams": myTeams,
  "name-attribute-account-name": nameAttributeAccountName,
  "name-relationship-account-name": nameRelationshipAccountName,
  "name-relationship-account-pathix-legalofficer": nameRelationshipAccountPathixLegalofficer,
  "names-charts-account-name": namesChartsAccountName,
  "names-forms-account-name": namesFormsAccountName,
  "names-plugin-steps-account-name": namesPluginStepsAccountName,
  "names-processes-account-name": namesProcessesAccountName,
  "names-step-images-account-name": namesStepImagesAccountName,
  "names-views-account-name": namesViewsAccountName,
  "plugin-steps-account": pluginStepsAccount,
  "plugin-steps-update-all-tables": pluginStepsUpdateAllTables,
  "publishers": publishers,
  "publishers-update-all-tables": publishersUpdateAllTables,
  "role-write-privilege-account": roleWritePrivilegeAccount,
  "solutions": solutions,
  "solutions-update-all-tables": solutionsUpdateAllTables,
  "team-profiles": teamProfiles,
  "team-roles": teamRoles,
  "whoami": whoami,
  "workflows-account": workflowsAccount,
};

export const DEMO_QUERIES: readonly CapturedQuery[] = queries;
