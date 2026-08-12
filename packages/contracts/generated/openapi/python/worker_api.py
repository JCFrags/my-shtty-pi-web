# Generated from worker OpenAPI. Do not edit.
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping, Protocol, TypedDict


class OperationRequest(TypedDict, total=False):
    path: Mapping[str, str | int]
    query: Mapping[str, str | int | bool | tuple[str, ...]]
    headers: Mapping[str, str]
    body: Any


class OperationResponse(TypedDict, total=False):
    status: int
    headers: Mapping[str, str]
    body: Any


@dataclass(frozen=True)
class OperationDescriptor:
    operation_id: str
    method: str
    path: str
    scopes: tuple[str, ...]
    request_schema: str | None
    response_schemas: tuple[str, ...]


_raw_operations: list[dict[str, Any]] = [{'method': 'POST',
  'operationId': 'authorizeEgressDestination',
  'path': '/egress/authorize',
  'requestSchema': '#/components/schemas/EgressAuthorizationRequest',
  'responseSchemas': ['200:application/json:#/components/schemas/EgressAuthorizationDecision',
                      'default:#/components/responses/Problem'],
  'scopes': ['internal.egress']},
 {'method': 'POST',
  'operationId': 'claimLease',
  'path': '/leases/claim',
  'requestSchema': 'inline',
  'responseSchemas': ['200:application/json:#/components/schemas/AttemptLease',
                      'default:#/components/responses/Problem'],
  'scopes': ['internal.worker']},
 {'method': 'POST',
  'operationId': 'completeAttempt',
  'path': '/attempts/{attempt_id}/complete',
  'requestSchema': '#/components/schemas/AttemptCompletion',
  'responseSchemas': ['200:application/json:inline', 'default:#/components/responses/Problem'],
  'scopes': ['internal.worker']},
 {'method': 'GET',
  'operationId': 'downloadAttemptInput',
  'path': '/attempts/{attempt_id}/inputs/{input_id}',
  'requestSchema': None,
  'responseSchemas': ['200:application/octet-stream:inline',
                      'default:#/components/responses/Problem'],
  'scopes': ['internal.worker']},
 {'method': 'POST',
  'operationId': 'failAttempt',
  'path': '/attempts/{attempt_id}/fail',
  'requestSchema': 'inline',
  'responseSchemas': ['default:#/components/responses/Problem'],
  'scopes': ['internal.worker']},
 {'method': 'POST',
  'operationId': 'heartbeatAttempt',
  'path': '/attempts/{attempt_id}/heartbeat',
  'requestSchema': 'inline',
  'responseSchemas': ['200:application/json:inline', 'default:#/components/responses/Problem'],
  'scopes': ['internal.worker']},
 {'method': 'POST',
  'operationId': 'heartbeatWorker',
  'path': '/workers/{worker_id}/heartbeat',
  'requestSchema': 'inline',
  'responseSchemas': ['default:#/components/responses/Problem'],
  'scopes': ['internal.worker']},
 {'method': 'POST',
  'operationId': 'registerWorker',
  'path': '/workers/register',
  'requestSchema': '#/components/schemas/WorkerRegistration',
  'responseSchemas': ['201:application/json:#/components/schemas/WorkerSession',
                      'default:#/components/responses/Problem'],
  'scopes': ['internal.worker']},
 {'method': 'POST',
  'operationId': 'reportAttemptProgress',
  'path': '/attempts/{attempt_id}/progress',
  'requestSchema': 'inline',
  'responseSchemas': ['default:#/components/responses/Problem'],
  'scopes': ['internal.worker']},
 {'method': 'PUT',
  'operationId': 'uploadAttemptOutput',
  'path': '/attempts/{attempt_id}/outputs/{slot}',
  'requestSchema': 'inline',
  'responseSchemas': ['201:application/json:#/components/schemas/OutputHandle',
                      'default:#/components/responses/Problem'],
  'scopes': ['internal.worker']}]
OPERATIONS = tuple(
    OperationDescriptor(
        operation_id=value["operationId"],
        method=value["method"],
        path=value["path"],
        scopes=tuple(value["scopes"]),
        request_schema=value["requestSchema"],
        response_schemas=tuple(value["responseSchemas"]),
    )
    for value in _raw_operations
)


class WorkerApiClient(Protocol):
    async def authorizeEgressDestination(self, request: OperationRequest) -> OperationResponse: ...
    async def claimLease(self, request: OperationRequest) -> OperationResponse: ...
    async def completeAttempt(self, request: OperationRequest) -> OperationResponse: ...
    async def downloadAttemptInput(self, request: OperationRequest) -> OperationResponse: ...
    async def failAttempt(self, request: OperationRequest) -> OperationResponse: ...
    async def heartbeatAttempt(self, request: OperationRequest) -> OperationResponse: ...
    async def heartbeatWorker(self, request: OperationRequest) -> OperationResponse: ...
    async def registerWorker(self, request: OperationRequest) -> OperationResponse: ...
    async def reportAttemptProgress(self, request: OperationRequest) -> OperationResponse: ...
    async def uploadAttemptOutput(self, request: OperationRequest) -> OperationResponse: ...
