export interface CachePolicy {
  readonly memoryEntries: number;
  readonly memoryBytes: number;
  readonly diskEntries: number;
  readonly diskBytes: number;
  readonly maxEntryBytes: number;
}

export interface AuditPolicy {
  readonly maxAgeDays: number;
  readonly maxAgeMs: number;
  readonly maxBytes: number;
  readonly maxRecordBytes: number;
  readonly maxPruneFiles: number;
  readonly automaticPruneIntervalMs: number;
}

export const CACHE_POLICY: Readonly<CachePolicy>;
export const AUDIT_POLICY: Readonly<AuditPolicy>;
export function storagePolicyReport(): { cache: CachePolicy; audit: AuditPolicy };
