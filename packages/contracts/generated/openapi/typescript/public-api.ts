// Generated from public OpenAPI. Do not edit.
import type { ArtifactResult } from '../../typescript/artifact-result.js';
import type { ProblemDetails } from '../../typescript/error.js';
import type { Job } from '../../typescript/job.js';
import type { PageRecord } from '../../typescript/page-record.js';
import type { SearchHit } from '../../typescript/search-hit.js';
import type { VisitRecord } from '../../typescript/visit-record.js';
import type { WikiIntakeEnvelope } from '../../typescript/wiki-intake.js';

export interface PublicApiCanonicalSchemas {
  readonly "./schemas/artifact-result.json": ArtifactResult;
  readonly "./schemas/error.json": ProblemDetails;
  readonly "./schemas/job.json": Job;
  readonly "./schemas/page-record.json": PageRecord;
  readonly "./schemas/search-hit.json": SearchHit;
  readonly "./schemas/visit-record.json": VisitRecord;
  readonly "./schemas/wiki-intake.json": WikiIntakeEnvelope;
}

export type PublicApiCanonicalSchemaRef = keyof PublicApiCanonicalSchemas;
export type PublicApiCanonicalSchema<R extends string> =
  R extends PublicApiCanonicalSchemaRef ? PublicApiCanonicalSchemas[R] : unknown;

export type PublicApiOperationId = "acknowledgeWikiDelivery" | "cancelCrawl" | "cancelJob" | "closeBrowserSession" | "completeUpload" | "createArchiveCapture" | "createArchiveImport" | "createArchiveReplaySession" | "createBackup" | "createBrowserAction" | "createBrowserSession" | "createCorpusExport" | "createCorpusImport" | "createCrawl" | "createDocumentChunk" | "createDocumentConvert" | "createDocumentInspect" | "createDocumentOcr" | "createDocumentScholarly" | "createExtraction" | "createFetch" | "createGalleryAcquisition" | "createIndexRebuild" | "createMediaAcquire" | "createMediaInfo" | "createMediaTranscribe" | "createRestore" | "createStreamRecording" | "createUpload" | "createVerification" | "createWatch" | "createWikiBackfill" | "createWikiLease" | "deleteUpload" | "deleteWatch" | "discoverFeeds" | "drainIndex" | "getArtifact" | "getArtifactContent" | "getArtifactExcerpt" | "getArtifactMetadata" | "getBrowserSession" | "getBrowserSnapshot" | "getCapabilities" | "getCorpusStats" | "getCrawl" | "getEffectiveConfig" | "getEngine" | "getIndexRebuild" | "getIndexStatus" | "getJob" | "getJobResult" | "getLiveness" | "getPage" | "getPageVersion" | "getReadiness" | "getSearchFacets" | "getVersion" | "getVisit" | "getVisitReceipt" | "getWatch" | "getWikiDelivery" | "getWikiDeliveryEnvelope" | "listAuditEvents" | "listBackups" | "listCrawlVisits" | "listEngines" | "listJobs" | "listPageChanges" | "listPageVersions" | "listWatches" | "listWikiDeliveries" | "pauseCrawl" | "probeEngine" | "resumeCrawl" | "retryJob" | "runWatch" | "search" | "searchLocal" | "streamBrowserEvents" | "streamJobEvents" | "tombstonePage" | "updateWatch" | "uploadPart" | "validateConfig" | "verifyBackup";

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
  readonly operationId: PublicApiOperationId;
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly path: string;
  readonly scopes: readonly string[];
  readonly requestSchema: string | null;
  readonly responseSchemas: readonly string[];
}

export const publicOperations = [
  {
    "method": "POST",
    "operationId": "acknowledgeWikiDelivery",
    "path": "/wiki/consumers/{consumer_id}/deliveries/{delivery_id}/ack",
    "requestSchema": "#/components/schemas/WikiAck",
    "responseSchemas": [
      "200:application/json:#/components/schemas/WikiDelivery",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "wiki.write"
    ]
  },
  {
    "method": "POST",
    "operationId": "cancelCrawl",
    "path": "/crawls/{crawl_id}/cancel",
    "requestSchema": null,
    "responseSchemas": [
      "200:application/json:#/components/schemas/OperationResult",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "crawls.write"
    ]
  },
  {
    "method": "POST",
    "operationId": "cancelJob",
    "path": "/jobs/{job_id}/cancel",
    "requestSchema": null,
    "responseSchemas": [
      "200:application/json:./schemas/job.json",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "jobs.write"
    ]
  },
  {
    "method": "DELETE",
    "operationId": "closeBrowserSession",
    "path": "/browser/sessions/{session_id}",
    "requestSchema": null,
    "responseSchemas": [
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "browser.write"
    ]
  },
  {
    "method": "POST",
    "operationId": "completeUpload",
    "path": "/uploads/{upload_id}/complete",
    "requestSchema": "#/components/schemas/UploadCompleteRequest",
    "responseSchemas": [
      "200:application/json:#/components/schemas/OperationResult",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "artifacts.write"
    ]
  },
  {
    "method": "POST",
    "operationId": "createArchiveCapture",
    "path": "/archives/captures",
    "requestSchema": "#/components/schemas/FetchRequest",
    "responseSchemas": [
      "202:#/components/responses/JobAccepted",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "archives.write"
    ]
  },
  {
    "method": "POST",
    "operationId": "createArchiveImport",
    "path": "/archives/imports",
    "requestSchema": "#/components/schemas/InputOperationRequest",
    "responseSchemas": [
      "200:application/json:#/components/schemas/OperationResult",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "archives.write"
    ]
  },
  {
    "method": "POST",
    "operationId": "createArchiveReplaySession",
    "path": "/archives/{archive_id}/replay-sessions",
    "requestSchema": "#/components/schemas/ReplayRequest",
    "responseSchemas": [
      "201:application/json:#/components/schemas/OperationResult",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "archives.write"
    ]
  },
  {
    "method": "POST",
    "operationId": "createBackup",
    "path": "/backups",
    "requestSchema": "#/components/schemas/BackupRequest",
    "responseSchemas": [
      "200:application/json:#/components/schemas/OperationResult",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "admin.write"
    ]
  },
  {
    "method": "POST",
    "operationId": "createBrowserAction",
    "path": "/browser/sessions/{session_id}/actions",
    "requestSchema": "#/components/schemas/BrowserAction",
    "responseSchemas": [
      "200:#/components/responses/ArtifactResult",
      "202:#/components/responses/JobAccepted",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "browser.write"
    ]
  },
  {
    "method": "POST",
    "operationId": "createBrowserSession",
    "path": "/browser/sessions",
    "requestSchema": "#/components/schemas/BrowserSessionRequest",
    "responseSchemas": [
      "201:application/json:#/components/schemas/BrowserSession",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "browser.write"
    ]
  },
  {
    "method": "POST",
    "operationId": "createCorpusExport",
    "path": "/corpus/exports",
    "requestSchema": "#/components/schemas/CorpusExportRequest",
    "responseSchemas": [
      "200:application/json:#/components/schemas/OperationResult",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "corpus.write"
    ]
  },
  {
    "method": "POST",
    "operationId": "createCorpusImport",
    "path": "/corpus/imports",
    "requestSchema": "#/components/schemas/InputOperationRequest",
    "responseSchemas": [
      "200:application/json:#/components/schemas/OperationResult",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "corpus.write"
    ]
  },
  {
    "method": "POST",
    "operationId": "createCrawl",
    "path": "/crawls",
    "requestSchema": "#/components/schemas/CrawlRequest",
    "responseSchemas": [
      "202:#/components/responses/JobAccepted",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "crawls.write"
    ]
  },
  {
    "method": "POST",
    "operationId": "createDocumentChunk",
    "path": "/documents/chunk",
    "requestSchema": "#/components/schemas/FileOperationRequest",
    "responseSchemas": [
      "200:application/json:#/components/schemas/OperationResult",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "documents.write"
    ]
  },
  {
    "method": "POST",
    "operationId": "createDocumentConvert",
    "path": "/documents/convert",
    "requestSchema": "#/components/schemas/FileOperationRequest",
    "responseSchemas": [
      "200:application/json:#/components/schemas/OperationResult",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "documents.write"
    ]
  },
  {
    "method": "POST",
    "operationId": "createDocumentInspect",
    "path": "/documents/inspect",
    "requestSchema": "#/components/schemas/FileOperationRequest",
    "responseSchemas": [
      "200:application/json:#/components/schemas/OperationResult",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "documents.write"
    ]
  },
  {
    "method": "POST",
    "operationId": "createDocumentOcr",
    "path": "/documents/ocr",
    "requestSchema": "#/components/schemas/FileOperationRequest",
    "responseSchemas": [
      "200:application/json:#/components/schemas/OperationResult",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "documents.write"
    ]
  },
  {
    "method": "POST",
    "operationId": "createDocumentScholarly",
    "path": "/documents/scholarly",
    "requestSchema": "#/components/schemas/FileOperationRequest",
    "responseSchemas": [
      "200:application/json:#/components/schemas/OperationResult",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "documents.write"
    ]
  },
  {
    "method": "POST",
    "operationId": "createExtraction",
    "path": "/extractions",
    "requestSchema": "#/components/schemas/ExtractionRequest",
    "responseSchemas": [
      "200:#/components/responses/ArtifactResult",
      "202:#/components/responses/JobAccepted",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "retrieval.write"
    ]
  },
  {
    "method": "POST",
    "operationId": "createFetch",
    "path": "/fetch",
    "requestSchema": "#/components/schemas/FetchRequest",
    "responseSchemas": [
      "200:#/components/responses/ArtifactResult",
      "202:#/components/responses/JobAccepted",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "retrieval.write"
    ]
  },
  {
    "method": "POST",
    "operationId": "createGalleryAcquisition",
    "path": "/galleries/acquire",
    "requestSchema": "#/components/schemas/MediaRequest",
    "responseSchemas": [
      "200:application/json:#/components/schemas/OperationResult",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "media.write"
    ]
  },
  {
    "method": "POST",
    "operationId": "createIndexRebuild",
    "path": "/index/rebuilds",
    "requestSchema": "inline",
    "responseSchemas": [
      "202:#/components/responses/JobAccepted",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "index.write"
    ]
  },
  {
    "method": "POST",
    "operationId": "createMediaAcquire",
    "path": "/media/acquire",
    "requestSchema": "#/components/schemas/MediaRequest",
    "responseSchemas": [
      "200:application/json:#/components/schemas/OperationResult",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "media.write"
    ]
  },
  {
    "method": "POST",
    "operationId": "createMediaInfo",
    "path": "/media/info",
    "requestSchema": "#/components/schemas/MediaRequest",
    "responseSchemas": [
      "200:application/json:#/components/schemas/OperationResult",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "media.write"
    ]
  },
  {
    "method": "POST",
    "operationId": "createMediaTranscribe",
    "path": "/media/transcribe",
    "requestSchema": "#/components/schemas/MediaRequest",
    "responseSchemas": [
      "200:application/json:#/components/schemas/OperationResult",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "media.write"
    ]
  },
  {
    "method": "POST",
    "operationId": "createRestore",
    "path": "/restores",
    "requestSchema": "#/components/schemas/RestoreRequest",
    "responseSchemas": [
      "200:application/json:#/components/schemas/OperationResult",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "admin.write"
    ]
  },
  {
    "method": "POST",
    "operationId": "createStreamRecording",
    "path": "/streams/record",
    "requestSchema": "#/components/schemas/MediaRequest",
    "responseSchemas": [
      "200:application/json:#/components/schemas/OperationResult",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "media.write"
    ]
  },
  {
    "method": "POST",
    "operationId": "createUpload",
    "path": "/uploads",
    "requestSchema": "#/components/schemas/UploadCreateRequest",
    "responseSchemas": [
      "201:application/json:#/components/schemas/OperationResult",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "artifacts.write"
    ]
  },
  {
    "method": "POST",
    "operationId": "createVerification",
    "path": "/verify",
    "requestSchema": "#/components/schemas/VerifyRequest",
    "responseSchemas": [
      "200:#/components/responses/ArtifactResult",
      "202:#/components/responses/JobAccepted",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "retrieval.write"
    ]
  },
  {
    "method": "POST",
    "operationId": "createWatch",
    "path": "/watches",
    "requestSchema": "#/components/schemas/WatchRequest",
    "responseSchemas": [
      "201:application/json:#/components/schemas/Watch",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "monitoring.write"
    ]
  },
  {
    "method": "POST",
    "operationId": "createWikiBackfill",
    "path": "/wiki/consumers/{consumer_id}/backfills",
    "requestSchema": "#/components/schemas/WikiBackfillRequest",
    "responseSchemas": [
      "200:application/json:#/components/schemas/OperationResult",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "wiki.write"
    ]
  },
  {
    "method": "POST",
    "operationId": "createWikiLease",
    "path": "/wiki/consumers/{consumer_id}/leases",
    "requestSchema": "#/components/schemas/WikiLeaseRequest",
    "responseSchemas": [
      "200:application/json:#/components/schemas/OperationResult",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "wiki.write"
    ]
  },
  {
    "method": "DELETE",
    "operationId": "deleteUpload",
    "path": "/uploads/{upload_id}",
    "requestSchema": null,
    "responseSchemas": [
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "artifacts.write"
    ]
  },
  {
    "method": "DELETE",
    "operationId": "deleteWatch",
    "path": "/watches/{watch_id}",
    "requestSchema": null,
    "responseSchemas": [
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "monitoring.write"
    ]
  },
  {
    "method": "POST",
    "operationId": "discoverFeeds",
    "path": "/feeds/discover",
    "requestSchema": "inline",
    "responseSchemas": [
      "200:application/json:inline",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "monitoring.write"
    ]
  },
  {
    "method": "POST",
    "operationId": "drainIndex",
    "path": "/index/drain",
    "requestSchema": "#/components/schemas/DrainRequest",
    "responseSchemas": [
      "200:application/json:#/components/schemas/OperationResult",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "index.write"
    ]
  },
  {
    "method": "GET",
    "operationId": "getArtifact",
    "path": "/artifacts/{artifact_id}",
    "requestSchema": null,
    "responseSchemas": [
      "200:application/json:#/components/schemas/ArtifactMetadata",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "artifacts.read"
    ]
  },
  {
    "method": "GET",
    "operationId": "getArtifactContent",
    "path": "/artifacts/{artifact_id}/content",
    "requestSchema": null,
    "responseSchemas": [
      "200:application/octet-stream:inline",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "artifacts.read"
    ]
  },
  {
    "method": "GET",
    "operationId": "getArtifactExcerpt",
    "path": "/artifacts/{artifact_id}/excerpt",
    "requestSchema": null,
    "responseSchemas": [
      "200:application/json:#/components/schemas/ArtifactExcerpt",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "artifacts.read"
    ]
  },
  {
    "method": "GET",
    "operationId": "getArtifactMetadata",
    "path": "/artifacts/{artifact_id}/metadata",
    "requestSchema": null,
    "responseSchemas": [
      "200:application/json:#/components/schemas/ArtifactMetadata",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "artifacts.read"
    ]
  },
  {
    "method": "GET",
    "operationId": "getBrowserSession",
    "path": "/browser/sessions/{session_id}",
    "requestSchema": null,
    "responseSchemas": [
      "200:application/json:#/components/schemas/BrowserSession",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "browser.read"
    ]
  },
  {
    "method": "GET",
    "operationId": "getBrowserSnapshot",
    "path": "/browser/sessions/{session_id}/snapshot",
    "requestSchema": null,
    "responseSchemas": [
      "200:application/json:#/components/schemas/OperationResult",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "browser.read"
    ]
  },
  {
    "method": "GET",
    "operationId": "getCapabilities",
    "path": "/capabilities",
    "requestSchema": null,
    "responseSchemas": [
      "200:application/json:inline",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "system.read"
    ]
  },
  {
    "method": "GET",
    "operationId": "getCorpusStats",
    "path": "/corpus/stats",
    "requestSchema": null,
    "responseSchemas": [
      "200:application/json:#/components/schemas/OperationResult",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "corpus.read"
    ]
  },
  {
    "method": "GET",
    "operationId": "getCrawl",
    "path": "/crawls/{crawl_id}",
    "requestSchema": null,
    "responseSchemas": [
      "200:application/json:#/components/schemas/Crawl",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "crawls.read"
    ]
  },
  {
    "method": "GET",
    "operationId": "getEffectiveConfig",
    "path": "/config/effective",
    "requestSchema": null,
    "responseSchemas": [
      "200:application/json:#/components/schemas/OperationResult",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "admin.read"
    ]
  },
  {
    "method": "GET",
    "operationId": "getEngine",
    "path": "/engines/{engine_id}",
    "requestSchema": null,
    "responseSchemas": [
      "200:application/json:#/components/schemas/Engine",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "system.read"
    ]
  },
  {
    "method": "GET",
    "operationId": "getIndexRebuild",
    "path": "/index/rebuilds/{job_id}",
    "requestSchema": null,
    "responseSchemas": [
      "200:application/json:#/components/schemas/OperationResult",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "index.read"
    ]
  },
  {
    "method": "GET",
    "operationId": "getIndexStatus",
    "path": "/index/status",
    "requestSchema": null,
    "responseSchemas": [
      "200:application/json:#/components/schemas/IndexStatus",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "index.read"
    ]
  },
  {
    "method": "GET",
    "operationId": "getJob",
    "path": "/jobs/{job_id}",
    "requestSchema": null,
    "responseSchemas": [
      "200:application/json:./schemas/job.json",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "jobs.read"
    ]
  },
  {
    "method": "GET",
    "operationId": "getJobResult",
    "path": "/jobs/{job_id}/result",
    "requestSchema": null,
    "responseSchemas": [
      "200:#/components/responses/ArtifactResult",
      "409:#/components/responses/Problem",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "jobs.read"
    ]
  },
  {
    "method": "GET",
    "operationId": "getLiveness",
    "path": "/health/live",
    "requestSchema": null,
    "responseSchemas": [
      "200:application/json:#/components/schemas/Health",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "system.read"
    ]
  },
  {
    "method": "GET",
    "operationId": "getPage",
    "path": "/pages/{page_id}",
    "requestSchema": null,
    "responseSchemas": [
      "200:application/json:./schemas/page-record.json",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "pages.read"
    ]
  },
  {
    "method": "GET",
    "operationId": "getPageVersion",
    "path": "/pages/{page_id}/versions/{version_id}",
    "requestSchema": null,
    "responseSchemas": [
      "200:application/json:#/components/schemas/OperationResult",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "pages.read"
    ]
  },
  {
    "method": "GET",
    "operationId": "getReadiness",
    "path": "/health/ready",
    "requestSchema": null,
    "responseSchemas": [
      "200:application/json:#/components/schemas/Health",
      "503:#/components/responses/Problem",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "system.read"
    ]
  },
  {
    "method": "GET",
    "operationId": "getSearchFacets",
    "path": "/search/facets",
    "requestSchema": null,
    "responseSchemas": [
      "200:application/json:#/components/schemas/OperationResult",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "search.read"
    ]
  },
  {
    "method": "GET",
    "operationId": "getVersion",
    "path": "/version",
    "requestSchema": null,
    "responseSchemas": [
      "200:application/json:#/components/schemas/Version",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "system.read"
    ]
  },
  {
    "method": "GET",
    "operationId": "getVisit",
    "path": "/visits/{visit_id}",
    "requestSchema": null,
    "responseSchemas": [
      "200:application/json:./schemas/visit-record.json",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "pages.read"
    ]
  },
  {
    "method": "GET",
    "operationId": "getVisitReceipt",
    "path": "/visits/{visit_id}/receipt",
    "requestSchema": null,
    "responseSchemas": [
      "200:application/json:#/components/schemas/ArtifactMetadata",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "pages.read"
    ]
  },
  {
    "method": "GET",
    "operationId": "getWatch",
    "path": "/watches/{watch_id}",
    "requestSchema": null,
    "responseSchemas": [
      "200:application/json:#/components/schemas/Watch",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "monitoring.read"
    ]
  },
  {
    "method": "GET",
    "operationId": "getWikiDelivery",
    "path": "/wiki/consumers/{consumer_id}/deliveries/{delivery_id}",
    "requestSchema": null,
    "responseSchemas": [
      "200:application/json:#/components/schemas/WikiDelivery",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "wiki.read"
    ]
  },
  {
    "method": "GET",
    "operationId": "getWikiDeliveryEnvelope",
    "path": "/wiki/consumers/{consumer_id}/deliveries/{delivery_id}/envelope",
    "requestSchema": null,
    "responseSchemas": [
      "200:application/json:./schemas/wiki-intake.json",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "wiki.read"
    ]
  },
  {
    "method": "GET",
    "operationId": "listAuditEvents",
    "path": "/audit/events",
    "requestSchema": null,
    "responseSchemas": [
      "200:application/json:#/components/schemas/OperationPage",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "admin.read"
    ]
  },
  {
    "method": "GET",
    "operationId": "listBackups",
    "path": "/backups",
    "requestSchema": null,
    "responseSchemas": [
      "200:application/json:#/components/schemas/OperationPage",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "admin.read"
    ]
  },
  {
    "method": "GET",
    "operationId": "listCrawlVisits",
    "path": "/crawls/{crawl_id}/visits",
    "requestSchema": null,
    "responseSchemas": [
      "200:application/json:#/components/schemas/OperationPage",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "crawls.read"
    ]
  },
  {
    "method": "GET",
    "operationId": "listEngines",
    "path": "/engines",
    "requestSchema": null,
    "responseSchemas": [
      "200:application/json:inline",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "system.read"
    ]
  },
  {
    "method": "GET",
    "operationId": "listJobs",
    "path": "/jobs",
    "requestSchema": null,
    "responseSchemas": [
      "200:application/json:#/components/schemas/JobPage",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "jobs.read"
    ]
  },
  {
    "method": "GET",
    "operationId": "listPageChanges",
    "path": "/pages/{page_id}/changes",
    "requestSchema": null,
    "responseSchemas": [
      "200:application/json:#/components/schemas/OperationPage",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "pages.read"
    ]
  },
  {
    "method": "GET",
    "operationId": "listPageVersions",
    "path": "/pages/{page_id}/versions",
    "requestSchema": null,
    "responseSchemas": [
      "200:application/json:#/components/schemas/OperationPage",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "pages.read"
    ]
  },
  {
    "method": "GET",
    "operationId": "listWatches",
    "path": "/watches",
    "requestSchema": null,
    "responseSchemas": [
      "200:application/json:inline",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "monitoring.read"
    ]
  },
  {
    "method": "GET",
    "operationId": "listWikiDeliveries",
    "path": "/wiki/consumers/{consumer_id}/deliveries",
    "requestSchema": null,
    "responseSchemas": [
      "200:application/json:#/components/schemas/WikiDeliveryPage",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "wiki.read"
    ]
  },
  {
    "method": "POST",
    "operationId": "pauseCrawl",
    "path": "/crawls/{crawl_id}/pause",
    "requestSchema": null,
    "responseSchemas": [
      "200:application/json:#/components/schemas/OperationResult",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "crawls.write"
    ]
  },
  {
    "method": "POST",
    "operationId": "probeEngine",
    "path": "/engines/{engine_id}/probe",
    "requestSchema": null,
    "responseSchemas": [
      "202:#/components/responses/JobAccepted",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "system.write"
    ]
  },
  {
    "method": "POST",
    "operationId": "resumeCrawl",
    "path": "/crawls/{crawl_id}/resume",
    "requestSchema": null,
    "responseSchemas": [
      "200:application/json:#/components/schemas/OperationResult",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "crawls.write"
    ]
  },
  {
    "method": "POST",
    "operationId": "retryJob",
    "path": "/jobs/{job_id}/retry",
    "requestSchema": null,
    "responseSchemas": [
      "200:application/json:#/components/schemas/OperationResult",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "jobs.write"
    ]
  },
  {
    "method": "POST",
    "operationId": "runWatch",
    "path": "/watches/{watch_id}/run",
    "requestSchema": null,
    "responseSchemas": [
      "200:application/json:#/components/schemas/OperationResult",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "monitoring.write"
    ]
  },
  {
    "method": "POST",
    "operationId": "search",
    "path": "/search",
    "requestSchema": "#/components/schemas/SearchRequest",
    "responseSchemas": [
      "200:application/json:#/components/schemas/SearchResponse",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "search.write"
    ]
  },
  {
    "method": "POST",
    "operationId": "searchLocal",
    "path": "/search/local",
    "requestSchema": "#/components/schemas/SearchRequest",
    "responseSchemas": [
      "200:application/json:#/components/schemas/SearchResponse",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "search.write"
    ]
  },
  {
    "method": "GET",
    "operationId": "streamBrowserEvents",
    "path": "/browser/sessions/{session_id}/events",
    "requestSchema": null,
    "responseSchemas": [
      "200:application/json:#/components/schemas/OperationResult",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "browser.read"
    ]
  },
  {
    "method": "GET",
    "operationId": "streamJobEvents",
    "path": "/jobs/{job_id}/events",
    "requestSchema": null,
    "responseSchemas": [
      "200:text/event-stream:inline",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "jobs.read"
    ]
  },
  {
    "method": "POST",
    "operationId": "tombstonePage",
    "path": "/pages/{page_id}/tombstone",
    "requestSchema": "#/components/schemas/ReasonRequest",
    "responseSchemas": [
      "200:application/json:#/components/schemas/OperationResult",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "pages.write"
    ]
  },
  {
    "method": "PATCH",
    "operationId": "updateWatch",
    "path": "/watches/{watch_id}",
    "requestSchema": "#/components/schemas/WatchUpdateRequest",
    "responseSchemas": [
      "200:application/json:#/components/schemas/Watch",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "monitoring.write"
    ]
  },
  {
    "method": "PUT",
    "operationId": "uploadPart",
    "path": "/uploads/{upload_id}/parts/{part_number}",
    "requestSchema": "inline",
    "responseSchemas": [
      "201:application/json:#/components/schemas/OperationResult",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "artifacts.write"
    ]
  },
  {
    "method": "POST",
    "operationId": "validateConfig",
    "path": "/config/validate",
    "requestSchema": "#/components/schemas/ConfigValidationRequest",
    "responseSchemas": [
      "200:application/json:#/components/schemas/OperationResult",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "admin.write"
    ]
  },
  {
    "method": "POST",
    "operationId": "verifyBackup",
    "path": "/backups/{backup_id}/verify",
    "requestSchema": null,
    "responseSchemas": [
      "200:application/json:#/components/schemas/OperationResult",
      "default:#/components/responses/Problem"
    ],
    "scopes": [
      "admin.write"
    ]
  }
] as const satisfies readonly OperationDescriptor[];

export interface PublicApiClient {
  acknowledgeWikiDelivery(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  cancelCrawl(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  cancelJob(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  closeBrowserSession(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  completeUpload(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  createArchiveCapture(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  createArchiveImport(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  createArchiveReplaySession(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  createBackup(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  createBrowserAction(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  createBrowserSession(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  createCorpusExport(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  createCorpusImport(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  createCrawl(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  createDocumentChunk(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  createDocumentConvert(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  createDocumentInspect(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  createDocumentOcr(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  createDocumentScholarly(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  createExtraction(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  createFetch(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  createGalleryAcquisition(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  createIndexRebuild(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  createMediaAcquire(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  createMediaInfo(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  createMediaTranscribe(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  createRestore(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  createStreamRecording(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  createUpload(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  createVerification(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  createWatch(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  createWikiBackfill(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  createWikiLease(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  deleteUpload(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  deleteWatch(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  discoverFeeds(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  drainIndex(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  getArtifact(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  getArtifactContent(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  getArtifactExcerpt(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  getArtifactMetadata(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  getBrowserSession(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  getBrowserSnapshot(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  getCapabilities(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  getCorpusStats(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  getCrawl(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  getEffectiveConfig(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  getEngine(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  getIndexRebuild(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  getIndexStatus(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  getJob(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  getJobResult(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  getLiveness(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  getPage(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  getPageVersion(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  getReadiness(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  getSearchFacets(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  getVersion(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  getVisit(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  getVisitReceipt(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  getWatch(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  getWikiDelivery(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  getWikiDeliveryEnvelope(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  listAuditEvents(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  listBackups(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  listCrawlVisits(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  listEngines(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  listJobs(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  listPageChanges(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  listPageVersions(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  listWatches(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  listWikiDeliveries(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  pauseCrawl(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  probeEngine(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  resumeCrawl(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  retryJob(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  runWatch(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  search(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  searchLocal(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  streamBrowserEvents(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  streamJobEvents(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  tombstonePage(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  updateWatch(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  uploadPart(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  validateConfig(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
  verifyBackup(request: OperationRequest, signal?: AbortSignal): Promise<OperationResponse>;
}

export type PublicApiServerHandlers = {
  readonly [K in PublicApiOperationId]: (
    request: OperationRequest,
    signal: AbortSignal,
  ) => Promise<OperationResponse>;
};
