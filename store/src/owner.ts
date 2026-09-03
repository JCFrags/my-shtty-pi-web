import path from "node:path";

export const BROWSER_OWNER_ENV = {
  workspaceId: "TERMINAL_BROWSER_OWNER_WORKSPACE_ID",
  tabId: "TERMINAL_BROWSER_OWNER_TAB_ID",
  paneId: "TERMINAL_BROWSER_OWNER_PANE_ID",
  sessionId: "TERMINAL_BROWSER_OWNER_SESSION_ID",
  projectDir: "TERMINAL_BROWSER_OWNER_PROJECT_DIR",
} as const;

export interface BrowserOwner {
  workspaceId: string;
  tabId: string;
  paneId: string;
  sessionId: string | null;
  projectDir: string;
}

export interface BrowserOwnerColumns {
  ownerWorkspaceId: string | null;
  ownerTabId: string | null;
  ownerPaneId: string | null;
  ownerSessionId: string | null;
  ownerProjectDir: string | null;
}

const HERDR_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const SESSION_ID = /^[^\u0000-\u001f\u007f]{1,512}$/u;

function requiredId(value: string | undefined, name: string): string {
  if (!value || !HERDR_ID.test(value)) throw new Error(`missing or invalid browser owner ${name}`);
  return value;
}

export function parseBrowserOwner(environment: NodeJS.ProcessEnv): BrowserOwner | null {
  const values = Object.values(BROWSER_OWNER_ENV).map((name) => environment[name]);
  if (values.every((value) => value === undefined)) return null;
  const workspaceId = requiredId(environment[BROWSER_OWNER_ENV.workspaceId], "workspace id");
  const tabId = requiredId(environment[BROWSER_OWNER_ENV.tabId], "tab id");
  const paneId = requiredId(environment[BROWSER_OWNER_ENV.paneId], "pane id");
  const projectDir = environment[BROWSER_OWNER_ENV.projectDir];
  if (!projectDir || !path.isAbsolute(projectDir) || projectDir.includes("\0")) {
    throw new Error("missing or invalid browser owner project directory");
  }
  const sessionId = environment[BROWSER_OWNER_ENV.sessionId] || null;
  if (sessionId !== null && !SESSION_ID.test(sessionId)) {
    throw new Error("invalid browser owner session id");
  }
  return { workspaceId, tabId, paneId, sessionId, projectDir: path.resolve(projectDir) };
}

export function requireHerdrBrowserOwner(
  environment: NodeJS.ProcessEnv,
  projectDir: string,
  sessionId?: string | null,
): BrowserOwner {
  return parseBrowserOwner({
    ...environment,
    [BROWSER_OWNER_ENV.workspaceId]: environment.HERDR_WORKSPACE_ID,
    [BROWSER_OWNER_ENV.tabId]: environment.HERDR_TAB_ID,
    [BROWSER_OWNER_ENV.paneId]: environment.HERDR_PANE_ID,
    [BROWSER_OWNER_ENV.sessionId]: sessionId ?? environment.PI_SESSION_ID,
    [BROWSER_OWNER_ENV.projectDir]: projectDir,
  })!;
}

export function browserOwnerEnvironment(owner: BrowserOwner): NodeJS.ProcessEnv {
  return {
    [BROWSER_OWNER_ENV.workspaceId]: owner.workspaceId,
    [BROWSER_OWNER_ENV.tabId]: owner.tabId,
    [BROWSER_OWNER_ENV.paneId]: owner.paneId,
    ...(owner.sessionId ? { [BROWSER_OWNER_ENV.sessionId]: owner.sessionId } : {}),
    [BROWSER_OWNER_ENV.projectDir]: owner.projectDir,
  };
}

export function browserOwnerColumns(owner: BrowserOwner | null): BrowserOwnerColumns {
  return {
    ownerWorkspaceId: owner?.workspaceId ?? null,
    ownerTabId: owner?.tabId ?? null,
    ownerPaneId: owner?.paneId ?? null,
    ownerSessionId: owner?.sessionId ?? null,
    ownerProjectDir: owner?.projectDir ?? null,
  };
}

export function browserOwnerFromColumns(columns: BrowserOwnerColumns): BrowserOwner | null {
  if (!columns.ownerWorkspaceId || !columns.ownerTabId || !columns.ownerPaneId || !columns.ownerProjectDir) {
    return null;
  }
  return {
    workspaceId: columns.ownerWorkspaceId,
    tabId: columns.ownerTabId,
    paneId: columns.ownerPaneId,
    sessionId: columns.ownerSessionId,
    projectDir: columns.ownerProjectDir,
  };
}

export function sameBrowserOwner(left: BrowserOwner | null, right: BrowserOwner | null): boolean {
  return left !== null && right !== null &&
    left.workspaceId === right.workspaceId &&
    left.tabId === right.tabId &&
    left.paneId === right.paneId;
}
