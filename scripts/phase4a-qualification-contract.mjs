// @ts-check

const TOOL_FAILURE_CODES = Object.freeze([
  "not-found", "CAPABILITY_UNAVAILABLE", "CONTROL_HELD_BY_HUMAN", "BROWSER_RESOURCE_LIMIT", "OPERATION_CONFLICT", "BAD_REQUEST", "UNAUTHORIZED", "FORBIDDEN", "CONFLICT",
  "TIMEOUT", "UNAVAILABLE", "INTERNAL_ERROR", "INVALID_ARGUMENT", "STALE_OBSERVATION", "STALE_FRAME", "BROWSER_DISCONNECTED", "SESSION_NOT_FOUND", "TAB_NOT_FOUND", "AUTHORITY_UNAVAILABLE",
]);
const FAILURE_STAGES = Object.freeze([
  "environment", "fixture", "workspace", "browser", "pi", "authority", "workload", "report", "cleanup", "restoration", "runner", "controller", "unknown",
]);
const FAILURE_CODES = Object.freeze([
  "ENVIRONMENT_INVALID", "RELEASE_BINDING_INVALID", "FIXTURE_FAILED", "WORKSPACE_FAILED", "WORKSPACE_EXITED", "WORKSPACE_DIAGNOSTICS_UNSAFE", "WORKSPACE_DIAGNOSTICS_INVALID",
  "PI_WORKER_FAILED", "PI_WORKER_TIMEOUT", "TOOL_FAILED", "WORKLOAD_FAILED", "TOOL_UNAVAILABLE", "TOOL_TIMEOUT", "AUTHORITY_FAILED", "PROXY_FAILED", "BROWSER_SERVICE_FAILED", "RESOURCE_LIMIT",
  "REPORT_INVALID", "CLEANUP_FAILED", "SERVICE_RESTORE_FAILED", "RUNNER_TIMEOUT", "RUNNER_FAILED", "RUNNER_OUTPUT_INVALID", "UNEXPECTED", ...TOOL_FAILURE_CODES,
]);
const FAILURE_STAGE_SET = new Set(FAILURE_STAGES);
const FAILURE_CODE_SET = new Set(FAILURE_CODES);
const TOOL_FAILURE_CODE_SET = new Set(TOOL_FAILURE_CODES);

/**
 * @param {unknown} value
 * @returns {string}
 */
export function safeQualificationToolCode(value) {
  return typeof value === "string" && TOOL_FAILURE_CODE_SET.has(value) ? value : "TOOL_FAILED";
}

/**
 * @param {unknown} stage
 * @param {unknown} code
 * @param {unknown} status
 * @param {unknown} count
 */
export function makeQualificationFailure(stage, code, status = 0, count = 1) {
  const safeStage = typeof stage === "string" && FAILURE_STAGE_SET.has(stage) ? stage : "unknown";
  const safeCode = typeof code === "string" && FAILURE_CODE_SET.has(code) ? code : "UNEXPECTED";
  const safeStatus = typeof status === "number" && Number.isSafeInteger(status) && status >= 0 && status <= 599 ? status : 0;
  const safeCount = typeof count === "number" && Number.isSafeInteger(count) && count >= 1 && count <= 64 ? count : 1;
  return Object.freeze({ stage: safeStage, code: safeCode, status: safeStatus, count: safeCount });
}

/**
 * @param {unknown} value
 * @returns {{schemaVersion: 1, ok: false, failure: {stage: string, code: string, status: number, count: number}} | undefined}
 */
export function validateQualificationFailure(value) {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.ok !== false || !exactKeys(value, ["schemaVersion", "ok", "failure"])) return undefined;
  const failure = value.failure;
  if (!isRecord(failure) || !exactKeys(failure, ["code", "count", "stage", "status"]) || typeof failure.stage !== "string" || typeof failure.code !== "string"
    || !FAILURE_STAGE_SET.has(failure.stage) || !FAILURE_CODE_SET.has(failure.code) || !Number.isSafeInteger(failure.status) || failure.status < 0 || failure.status > 599
    || !Number.isSafeInteger(failure.count) || failure.count < 1 || failure.count > 64) return undefined;
  return Object.freeze({ schemaVersion: 1, ok: false, failure: makeQualificationFailure(failure.stage, failure.code, failure.status, failure.count) });
}

/**
 * @param {unknown} value
 * @param {unknown} identity
 * @returns {{browserSessionId: string, tabId: string, controlEpoch: number} | undefined}
 */
export function validateAuthorityRefresh(value, identity) {
  if (!isRecord(value) || !Array.isArray(value.sessions) || !isRecord(identity) || typeof identity.browserSessionId !== "string" || typeof identity.tabId !== "string") return undefined;
  const sessions = /** @type {unknown[]} */ (value.sessions).filter((item) => isRecord(item) && item.browserSessionId === identity.browserSessionId);
  if (sessions.length !== 1) return undefined;
  const session = sessions[0];
  if (!isRecord(session) || !Number.isSafeInteger(session.controlEpoch) || session.controlEpoch < 1 || !Array.isArray(session.tabs)) return undefined;
  const tabs = /** @type {unknown[]} */ (session.tabs).filter((item) => isRecord(item) && item.tabId === identity.tabId);
  if (tabs.length !== 1) return undefined;
  const tab = tabs[0];
  if (!isRecord(tab)) return undefined;
  if (tab.address !== undefined) {
    if (!isRecord(tab.address)) return undefined;
    const address = tab.address;
    if (address.browserSessionId !== identity.browserSessionId || address.tabId !== identity.tabId || address.controlEpoch !== session.controlEpoch) return undefined;
  }
  if (tab.controlEpoch !== undefined && tab.controlEpoch !== session.controlEpoch) return undefined;
  return Object.freeze({ browserSessionId: identity.browserSessionId, tabId: identity.tabId, controlEpoch: session.controlEpoch });
}

/**
 * @param {Record<string, unknown>} value
 * @param {string[]} keys
 */
function exactKeys(value, keys) {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}
/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
