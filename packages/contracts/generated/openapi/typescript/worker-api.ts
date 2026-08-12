// Generated from worker OpenAPI. Do not edit.
import type { EngineObservation } from '../../typescript/engine-observation.js';
import type { ProblemDetails } from '../../typescript/error.js';
import type { NormalizedContentResult } from '../../typescript/normalized-content-result.js';

export interface WorkerApiCanonicalSchemas {
  readonly "./schemas/engine-observation.json": EngineObservation;
  readonly "./schemas/error.json": ProblemDetails;
  readonly "./schemas/normalized-content-result.json": NormalizedContentResult;
}

export type WorkerApiCanonicalSchemaRef = keyof WorkerApiCanonicalSchemas;
export type WorkerApiCanonicalSchema<R extends string> =
  R extends WorkerApiCanonicalSchemaRef ? WorkerApiCanonicalSchemas[R] : unknown;

export type WorkerApiOperationId = "authorizeEgressDestination" | "claimLease" | "completeAttempt" | "downloadAttemptInput" | "failAttempt" | "heartbeatAttempt" | "heartbeatWorker" | "registerWorker" | "reportAttemptProgress" | "uploadAttemptOutput";

export interface OperationRequest {
  readonly path?: Readonly<Record<string, string | number>>;
  readonly query?: Readonly<Record<string, string | number | boolean | readonly string[]>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

export interface OperationResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

export interface OperationDescriptor {
  readonly operationId: WorkerApiOperationId;
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly path: string;
  readonly scopes: readonly string[];
  readonly requestSchema: string | null;
  readonly responseSchemas: readonly string[];
}

export const workerOperations = [
  {
    "method": "POST",
    "operationId": "authorizeEgressDestination",
    "path": "/egress/authorize",
    "requestSchema": "#/components/schemas/EgressAuthorizationRequest",
    "responseSchemas": [
      "200:application/json:#/components/schemas/EgressAuthorizationDecision",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "internal.egress"
    ]
  },
  {
    "method": "POST",
    "operationId": "claimLease",
    "path": "/leases/claim",
    "requestSchema": "inline",
    "responseSchemas": [
      "200:application/json:#/components/schemas/AttemptLease",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "internal.worker"
    ]
  },
  {
    "method": "POST",
    "operationId": "completeAttempt",
    "path": "/attempts/{attempt_id}/complete",
    "requestSchema": "#/components/schemas/AttemptCompletion",
    "responseSchemas": [
      "200:application/json:inline",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "internal.worker"
    ]
  },
  {
    "method": "GET",
    "operationId": "downloadAttemptInput",
    "path": "/attempts/{attempt_id}/inputs/{input_id}",
    "requestSchema": null,
    "responseSchemas": [
      "200:application/octet-stream:inline",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "internal.worker"
    ]
  },
  {
    "method": "POST",
    "operationId": "failAttempt",
    "path": "/attempts/{attempt_id}/fail",
    "requestSchema": "inline",
    "responseSchemas": [
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "internal.worker"
    ]
  },
  {
    "method": "POST",
    "operationId": "heartbeatAttempt",
    "path": "/attempts/{attempt_id}/heartbeat",
    "requestSchema": "inline",
    "responseSchemas": [
      "200:application/json:inline",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "internal.worker"
    ]
  },
  {
    "method": "POST",
    "operationId": "heartbeatWorker",
    "path": "/workers/{worker_id}/heartbeat",
    "requestSchema": "inline",
    "responseSchemas": [
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "internal.worker"
    ]
  },
  {
    "method": "POST",
    "operationId": "registerWorker",
    "path": "/workers/register",
    "requestSchema": "#/components/schemas/WorkerRegistration",
    "responseSchemas": [
      "201:application/json:#/components/schemas/WorkerSession",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "internal.worker"
    ]
  },
  {
    "method": "POST",
    "operationId": "reportAttemptProgress",
    "path": "/attempts/{attempt_id}/progress",
    "requestSchema": "inline",
    "responseSchemas": [
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "internal.worker"
    ]
  },
  {
    "method": "PUT",
    "operationId": "uploadAttemptOutput",
    "path": "/attempts/{attempt_id}/outputs/{slot}",
    "requestSchema": "inline",
    "responseSchemas": [
      "201:application/json:#/components/schemas/OutputHandle",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "internal.worker"
    ]
  }
] as const satisfies readonly OperationDescriptor[];

export interface WorkerApiClient {
  authorizeEgressDestination(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  claimLease(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  completeAttempt(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  downloadAttemptInput(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  failAttempt(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  heartbeatAttempt(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  heartbeatWorker(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  registerWorker(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  reportAttemptProgress(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  uploadAttemptOutput(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
}

export type WorkerApiServerHandlers = {
  readonly [K in WorkerApiOperationId]: (
    request: OperationRequest,
    signal: AbortSignal,
  ) => Promise<OperationResponse>;
};
