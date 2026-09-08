const MiB = 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1_000;

/** Defaults for the short-lived traffic cache. */
export const CACHE_POLICY = Object.freeze({
  memoryEntries: 256,
  memoryBytes: 32 * MiB,
  diskEntries: 2_048,
  diskBytes: 512 * MiB,
  maxEntryBytes: 4_300_000,
});

/** Defaults for private agent-facing audit history. */
export const AUDIT_POLICY = Object.freeze({
  maxAgeDays: 30,
  maxAgeMs: 30 * DAY_MS,
  maxBytes: 100 * MiB,
  maxRecordBytes: 64 * 1024,
  maxPruneFiles: 8_192,
  automaticPruneIntervalMs: 60 * 60 * 1_000,
});

export function storagePolicyReport() {
  return {
    cache: { ...CACHE_POLICY },
    audit: { ...AUDIT_POLICY },
  };
}
