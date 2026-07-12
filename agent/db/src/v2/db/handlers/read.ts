import * as Effect from "effect/Effect";
import type { ServerEvent } from "../../shared";
import {
  makeAck,
  makeErrorAck,
  paths,
  readCollectionItemRange,
  sendAck,
} from "../helpers";
import { type DbHandlerContext, validateSession } from "../helpers";

type ReadEvent = Extract<ServerEvent, { kind: "read" }>;

export const handleRead = (ctx: DbHandlerContext, event: ReadEvent) =>
  Effect.gen(function* () {
    const session = yield* validateSession(ctx, event.sessionId, event.requestId, event.replicaId);
    const readOp = event.op;

    switch (readOp.type) {
      case "collection.fetch-range": {
        yield* ctx.collectionMutex.withPermits(1)(
          Effect.gen(function* () {
            const collectionDir = paths.collection({
              config: ctx.config,
              collectionId: readOp.collectionId,
            });
            const exists = yield* ctx.fs.exists(collectionDir);
            if (!exists) {
              sendAck({
                session,
                ack: makeErrorAck({
                  requestId: event.requestId,
                  sessionId: event.sessionId,
                  _tag: "NotFoundError",
                  message: `Collection ${readOp.collectionId} not found`,
                }),
              });
              return;
            }

            const { items, totalCount } = yield* readCollectionItemRange({
              fs: ctx.fs,
              config: ctx.config,
              collectionId: readOp.collectionId,
              start: readOp.range.start,
              end: readOp.range.end,
            });

            sendAck({
              session,
              ack: makeAck({
                requestId: event.requestId,
                sessionId: event.sessionId,
                data: { items, totalCount },
              }),
            });
          }),
        );
        return;
      }

      case "blob.read": {
        yield* ctx.blobMutex.withPermits(1)(
          Effect.gen(function* () {
            const exists = yield* ctx.fs.exists(
              paths.blob({ config: ctx.config, blobId: readOp.blobId }),
            );
            if (!exists) {
              sendAck({
                session,
                ack: makeErrorAck({
                  requestId: event.requestId,
                  sessionId: event.sessionId,
                  _tag: "NotFoundError",
                  message: `Blob ${readOp.blobId} not found`,
                }),
              });
              return;
            }

            const data = yield* ctx.fs.readFile(
              paths.blobData({ config: ctx.config, blobId: readOp.blobId }),
            );

            sendAck({
              session,
              ack: makeAck({
                requestId: event.requestId,
                sessionId: event.sessionId,
                data: { data },
              }),
            });
          }),
        );
        return;
      }
    }
  });
