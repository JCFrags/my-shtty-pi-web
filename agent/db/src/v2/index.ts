export {
  createDb,
  type Db,
  type CreateDbConfig,
  type SectionConfig,
} from "./db/db";

export {
  createClient,
  type ClientProxy,
  type CollectionNode,
  type BlobNode,
  type FieldNode,
  type ArrayFieldNode,
  type EffectFieldNode,
  type EffectCollectionNode,
  type EffectClientProxy,
  type EffectArrayFieldNode,
} from "./client/client";

export { createReplica, type CreateReplicaArgs } from "./replica/replica";

export {
  createSchema,
  f,
  type Schema,
  type SchemaShape,
  type InferSchema,
  type InferRoot,
  type InferSchemaRoot,
} from "./db/schema";

export {
  applyOperations,
  type KyjuMigration,
  type MigrationOp,
} from "./migrations";

export { sectionMigrationPlugin } from "./core-plugins/migration";

export { createRouter, connectReplica } from "./transport";

export {
  VERSION,
  type KyjuJSON,
  type KyjuError,
  type ErrorTag,
  type InvalidSessionError,
  type VersionMismatchError,
  type NotFoundError,
  type ReferenceExistsError,
  type ClientState,
  type ClientEvent,
  type DbSendEvent,
  type ServerEvent,
} from "./shared";
