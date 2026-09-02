export type QualificationDiagnosticRecord = Readonly<Record<string, unknown>>;
export type QualificationDiagnosticsErrorCode = "unsafe" | "replaced" | "truncated" | "invalid" | "cursor-expired";

export class QualificationDiagnosticsError extends Error {
  readonly code: QualificationDiagnosticsErrorCode;
  constructor(code: QualificationDiagnosticsErrorCode);
}

export class QualificationDiagnosticsReader {
  constructor(path: string, options?: {
    maxBytes?: number;
    maxRecords?: number;
    maxRing?: number;
    maxLineBytes?: number;
    kinds?: ReadonlySet<string>;
  });
  records(): Promise<QualificationDiagnosticRecord[]>;
  index(): Promise<number>;
  find(predicate: (record: QualificationDiagnosticRecord) => boolean, from: number): Promise<QualificationDiagnosticRecord | undefined>;
}
