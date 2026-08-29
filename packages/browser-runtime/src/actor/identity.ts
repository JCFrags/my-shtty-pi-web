import { BrowserProtocolError, verifyNavigationAuthorization, type ActorIdentity } from "@webx/browser-protocol";

export function actorKey(actor: ActorIdentity): string {
  return `${actor.principalId}\u0000${actor.agentSessionId}`;
}

export function sameActor(left: ActorIdentity, right: ActorIdentity): boolean {
  return left.principalId === right.principalId && left.agentSessionId === right.agentSessionId;
}

export interface NavigationAuthorizationContext {
  readonly operationId: string;
  readonly authorization?: string;
}

export interface NavigationAuthorization {
  authorize(actor: ActorIdentity, url: URL, signal: AbortSignal, context?: NavigationAuthorizationContext): Promise<void>;
}

export class DenyNavigationAuthorization implements NavigationAuthorization {
  async authorize(actor: ActorIdentity, url: URL, signal: AbortSignal, context?: NavigationAuthorizationContext): Promise<void> { void actor; void url; void context; void signal; throw new BrowserProtocolError("NAVIGATION_DENIED", "Navigation authorization is not configured."); }
}

export class BrokerNavigationAuthorization implements NavigationAuthorization {
  private configuration?: { readonly runtimeInstanceId: string; readonly signingSecret: string; readonly egressBindingId: string };

  configure(configuration: { readonly runtimeInstanceId: string; readonly signingSecret: string; readonly egressBindingId: string }): void {
    if (this.configuration !== undefined) throw new BrowserProtocolError("OPERATION_CONFLICT", "Navigation authorization is already configured.");
    this.configuration = Object.freeze({ ...configuration });
  }

  async authorize(actor: ActorIdentity, url: URL, signal: AbortSignal, context?: NavigationAuthorizationContext): Promise<void> {
    signal.throwIfAborted();
    const configured = this.configuration;
    if (configured === undefined || context?.authorization === undefined) throw new BrowserProtocolError("NAVIGATION_DENIED", "Navigation authorization is required.");
    verifyNavigationAuthorization(context.authorization, {
      runtimeInstanceId: configured.runtimeInstanceId,
      principalId: actor.principalId,
      agentSessionId: actor.agentSessionId,
      operationId: context.operationId,
      normalizedUrl: url.href,
      egressBindingId: configured.egressBindingId,
    }, configured.signingSecret);
  }
}

export class LoopbackFixtureAuthorization implements NavigationAuthorization {
  constructor(private readonly allowedOrigins: ReadonlySet<string>) {}
  async authorize(actor: ActorIdentity, url: URL, signal: AbortSignal, context?: NavigationAuthorizationContext): Promise<void> {
    void actor; void context; signal.throwIfAborted();
    if (!this.allowedOrigins.has(url.origin) || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")) {
      throw new BrowserProtocolError("NAVIGATION_DENIED", "Navigation is outside the fixture allowlist.");
    }
  }
}
