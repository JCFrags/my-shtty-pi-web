import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { nanoid } from "nanoid";
import type { ServerEvent } from "../../shared";
import { VERSION } from "../../shared";
import type { Session } from "../helpers";
import { makeAck, makeErrorAck, sendAck } from "../helpers";
import type { DbHandlerContext } from "../helpers";

type ConnectEvent = Extract<ServerEvent, { kind: "connect" }>;

export const handleConnect = (
  ctx: DbHandlerContext,
  event: ConnectEvent,
  latch: Effect.Latch,
) =>
  latch.whenOpen(
    Effect.gen(function* () {
      const msg = event.message;
      const { replicaId } = msg;

      if (msg.version !== VERSION) {
        ctx.dbSend({
          kind: "db-update",
          replicaId,
          message: makeErrorAck({
            requestId: msg.requestId,
            _tag: "VersionMismatchError",
            message: `Expected version ${VERSION}, got ${msg.version}`,
          }),
        });
        return;
      }

      const sessionId = nanoid();
      // Read from the in-memory cache, not disk: a connecting/reconnecting
      // replica must observe in-flight writes that haven't flushed yet.
      const root = yield* ctx.rootCache.read();

      const session: Session = {
        sessionId,
        replicaId,
        subscriptions: new Set(),
        send: (event) => ctx.dbSend({ ...event, replicaId }),
      };
      yield* Ref.update(ctx.sessionsRef, (sessions) => {
        const next = new Map(sessions);
        next.set(sessionId, session);
        return next;
      });

      sendAck({
        session,
        ack: makeAck({
          requestId: msg.requestId,
          sessionId,
          data: { root },
        }),
      });
    }),
  );
