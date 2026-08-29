import type { ActorIdentity } from "@webx/browser-protocol";

export function actorKey(actor: ActorIdentity): string {
  return `${actor.principalId}\u0000${actor.agentSessionId}`;
}

export function sameActor(left: ActorIdentity, right: ActorIdentity): boolean {
  return left.principalId === right.principalId && left.agentSessionId === right.agentSessionId;
}

export interface NavigationAuthorization {
  authorize(actor: ActorIdentity, url: URL, signal: AbortSignal): Promise<void>;
}

export class DenyNavigationAuthorization implements NavigationAuthorization {
  async authorize(): Promise<void> { throw new Error("Navigation authorization is not configured."); }
}

export class LoopbackFixtureAuthorization implements NavigationAuthorization {
  constructor(private readonly allowedOrigins: ReadonlySet<string>) {}
  async authorize(_actor: ActorIdentity, url: URL): Promise<void> {
    if (!this.allowedOrigins.has(url.origin) || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")) {
      throw new Error("Navigation is outside the fixture allowlist.");
    }
  }
}
