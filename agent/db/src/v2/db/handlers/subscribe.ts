import * as Effect from "effect/Effect";
import type { ServerEvent } from "../../shared";
import {
  createCollection,
  makeAck,
  paths,
  readCollectionItemRange,
  sendAck,
} from "../helpers";
import { type DbHandlerContext, validateSession } from "../helpers";

type SubscribeEvent = Extract<ServerEvent, { kind: "subscribe-collection" }>;

export const handleSubscribe = (ctx: DbHandlerContext, event: SubscribeEvent) =>
  Effect.gen(function* () {
    const session = yield* validateSession(ctx, event.sessionId, event.requestId, event.replicaId);

    yield* ctx.collectionMutex.withPermits(1)(
      Effect.gen(function* () {
        const collectionDir = paths.collection({
          config: ctx.config,
          collectionId: event.collectionId,
        });
        const exists = yield* ctx.fs.exists(collectionDir);
        if (!exists) {
          yield* createCollection({
            fs: ctx.fs,
            config: ctx.config,
            collectionId: event.collectionId,
          });
        }

        session.subscriptions.add(event.collectionId);

        const { items, totalCount } = yield* readCollectionItemRange({
          fs: ctx.fs,
          config: ctx.config,
          collectionId: event.collectionId,
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
  });
