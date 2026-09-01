export { BrowserRuntime } from "./registry/runtime.js";
export type { BrowserRuntimeOptions } from "./registry/runtime.js";
export { BrokerNavigationAuthorization, DenyNavigationAuthorization, LoopbackFixtureAuthorization } from "./actor/identity.js";
export type { NavigationAuthorization, NavigationAuthorizationContext } from "./actor/identity.js";
export { acquireOwnershipSocket } from "./os/ownership-socket.js";
export type { OwnershipSocketLease, OwnershipSocketOptions } from "./os/ownership-socket.js";
export { BrowserResourceSupervisor, ProcfsBrowserResourceSampler, DEFAULT_BROWSER_RESOURCE_LIMITS, MIB, parseProcessStat, parseSmapsRollup, profileTreeBytes, validateBrowserResourceLimits } from "./resources/supervisor.js";
export type { BrowserProcessIdentity, BrowserResourceLimits, BrowserResourceSample, BrowserResourceSampler, BrowserResourceSessionHooks, BrowserResourceState, BrowserResourceReason, BrowserResourceStatus, BrowserResourceSummary, BrowserResourceSupervisorOptions, ProcfsBrowserResourceSamplerOptions } from "./resources/supervisor.js";
