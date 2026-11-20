/**
 * `@claude-bot/agent-data-view` — the generic data modules.
 *
 * ── What they are for ───────────────────────────────────────────────────────
 *
 * Every Agentic App projects state and declares actions. Until now, rendering
 * that meant writing components: a list here, a facts panel there, a form beside
 * it, each one knowing its own App's field names. These four modules do it from
 * DATA instead — a composition instance says which projection path it renders
 * and which fields carry which role, and one implementation becomes 收件箱,
 * 归档箱 and a detail pane without a line of App code.
 *
 * That is the direct consumer of decision 7's instance config, and it is what
 * "a simple App is pure data" means in practice.
 *
 * ── The whole public surface ────────────────────────────────────────────────
 *
 * A port plus an adapter for it, a provider and a hook, four module entries,
 * four presentational components, the pure manifests, and the readers. Every
 * omission is deliberate:
 *
 *  · no client, no channel, no transport — the App owns the channel;
 *  · no owner, scope, instance handle or capability — the View is never told;
 *  · no action ids — the only one that exists comes from a composition.
 *
 * A consumer wires it in three lines: adapt the channel with
 * `createAppDataPort`, wrap the tree in `<AppDataProvider port={…}>`, and
 * register `DATA_MODULES`.
 */

import "./data-view.css";

export {
  APP_DATA_CONTRACT,
  APP_DATA_LIMITS,
  READ_ONLY_REFUSAL,
  createAppDataPort,
  type AppDataChannel,
  type AppDataPhase,
  type AppDataPort,
  type AppDataProposal,
  type AppDataReply,
  type AppDataSnapshot,
  type AppProjection,
} from "./port.js";

export {
  AppDataProvider,
  useAppData,
  type AppDataController,
  type AppDataProviderProps,
} from "./context.js";

export { appDataAdapter, type AppDataAdapter } from "./adapter.js";

export {
  CONFIG_KEYS_READ,
  DATA_ACTIONS_MODULE,
  DATA_DETAIL_MODULE,
  DATA_FORM_MODULE,
  DATA_LIST_MODULE,
  DATA_MODULES,
} from "./modules.js";

export { DataActions, type DataActionsProps } from "./components/DataActions.js";
export { DataDetail, type DataDetailProps } from "./components/DataDetail.js";
export { DataForm, type DataFormProps, type FormNotice } from "./components/DataForm.js";
export { DataList, type DataListProps } from "./components/DataList.js";

export {
  DATA_ACTIONS_CONFIG,
  DATA_ACTIONS_MANIFEST,
  DATA_ACTIONS_MODULE_ID,
  DATA_DETAIL_CONFIG,
  DATA_DETAIL_MANIFEST,
  DATA_DETAIL_MODULE_ID,
  DATA_FORM_CONFIG,
  DATA_FORM_MANIFEST,
  DATA_FORM_MODULE_ID,
  DATA_FORM_RESOURCE_KIND,
  DATA_LIST_CONFIG,
  DATA_LIST_MANIFEST,
  DATA_LIST_MODULE_ID,
  DATA_MANIFESTS,
  DATA_RECORD_RESOURCE_KIND,
} from "./manifests.js";

export {
  displayValue,
  findRecord,
  initialFieldValue,
  readActionSpecs,
  readFacts,
  readFieldSpecs,
  readRecord,
  readRows,
  selectPath,
  type ActionSet,
  type ActionSetStatus,
  type ActionSpec,
  type CollectionStatus,
  type DataRow,
  type DeclarationStatus,
  type Fact,
  type FieldSet,
  type FieldSpec,
  type FieldType,
  type RecordLookup,
  type RecordStatus,
  type RowKeys,
  type RowSet,
  type Tone,
} from "./lib/select.js";
