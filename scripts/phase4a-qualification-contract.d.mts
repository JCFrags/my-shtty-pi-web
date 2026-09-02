export type QualificationFailure = Readonly<{
  stage: string;
  code: string;
  status: number;
  count: number;
}>;

export function safeQualificationToolCode(value: unknown): string;
export function makeQualificationFailure(stage: unknown, code: unknown, status?: unknown, count?: unknown): QualificationFailure;
export function validateQualificationFailure(value: unknown): Readonly<{
  schemaVersion: 1;
  ok: false;
  failure: QualificationFailure;
}> | undefined;
export function validateAuthorityRefresh(value: unknown, identity: unknown): Readonly<{
  browserSessionId: string;
  tabId: string;
  controlEpoch: number;
}> | undefined;
