import type { ArtifactCommitIntent } from '../../generated/typescript/artifact-commit-intent.js';
import type { EngineObservation } from '../../generated/typescript/engine-observation.js';
import type { NormalizedContentResult } from '../../generated/typescript/normalized-content-result.js';

type Assert<T extends true> = T;
type HasKey<T, K extends PropertyKey> = K extends keyof T ? true : false;
type Not<T extends boolean> = T extends true ? false : true;

type _NoWorkerAccepted = Assert<Not<HasKey<EngineObservation, 'accepted'>>>;
type _NoWorkerRejectionReasons = Assert<Not<HasKey<EngineObservation, 'rejection_reasons'>>>;
type _NormalizedTrust = Assert<
  NormalizedContentResult['trust'] extends 'untrusted_external_source' ? true : false
>;
type _PublicationKey = Assert<HasKey<ArtifactCommitIntent, 'publication_idempotency_key'>>;
type _QuarantineCode = Assert<HasKey<ArtifactCommitIntent, 'quarantine_reason_code'>>;

export type GeneratedContractSmoke =
  | _NoWorkerAccepted
  | _NoWorkerRejectionReasons
  | _NormalizedTrust
  | _PublicationKey
  | _QuarantineCode;
