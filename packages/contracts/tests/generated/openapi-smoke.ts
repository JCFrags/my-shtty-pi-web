import {
  publicOperations,
  type PublicApiCanonicalSchema,
  type PublicApiClient,
  type PublicApiOperationId,
  type PublicApiServerHandlers,
} from '../../generated/openapi/typescript/public-api.js';
import {
  workerOperations,
  type WorkerApiCanonicalSchema,
  type WorkerApiClient,
  type WorkerApiOperationId,
  type WorkerApiServerHandlers,
} from '../../generated/openapi/typescript/worker-api.js';

type Assert<T extends true> = T;
type Includes<T, U> = U extends T ? true : false;

type _PublicFetch = Assert<Includes<PublicApiOperationId, 'createFetch'>>;
type _PublicConfig = Assert<Includes<PublicApiOperationId, 'validateConfig'>>;
type _WorkerComplete = Assert<Includes<WorkerApiOperationId, 'completeAttempt'>>;
type _PublicJobSchema = Assert<
  PublicApiCanonicalSchema<'./schemas/job.json'> extends { job_id: string } ? true : false
>;
type _WorkerNormalizedSchema = Assert<
  WorkerApiCanonicalSchema<'./schemas/normalized-content-result.json'> extends {
    trust: 'untrusted_external_source';
  }
    ? true
    : false
>;

export type GeneratedOpenApiSmoke =
  | _PublicFetch
  | _PublicConfig
  | _WorkerComplete
  | _PublicJobSchema
  | _WorkerNormalizedSchema
  | PublicApiClient
  | PublicApiServerHandlers
  | WorkerApiClient
  | WorkerApiServerHandlers;

if (publicOperations.length !== 86 || workerOperations.length !== 10) {
  throw new Error('generated OpenAPI operation count differs');
}
