import type { Visibility } from "../../../packages/sdk/src/index.js";

export interface AuthorityActor {
  readonly principalId: string;
  readonly agentId: string;
  readonly scopes: ReadonlySet<string>;
}

export interface IndexedSource {
  readonly hitId: string;
  readonly ownerPrincipalId: string;
  readonly title: string;
  readonly url: string;
  readonly content: string;
  readonly visibility: Visibility;
}

export interface AuthorityClock {
  now(): string;
}

export interface AuthorityIdSource {
  next(prefix: string): string;
}
