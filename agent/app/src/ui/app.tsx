import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { Box } from "pixel-react";
import type { EngineInfo, NodeHandle } from "pixel-react";

import { useSessionLog } from "../db/hooks";
import { store } from "../session";
import type { Session } from "../session";
import { makeTheme, type Ctx } from "../theme";
import { transcript } from "../transcript";
import { Composer } from "./composer";
import { Message } from "./message";
import { Palette } from "./palette";
import { Settings } from "./settings";
import { Sidebar } from "./sidebar";
import { AskBox, WorkingStatus } from "./status";

export function App({ info }: { info: EngineInfo }) {
  useSyncExternalStore(store.subscribe, store.snapshot);
  const theme = useMemo(() => makeTheme(info.colors), [info]);
  const rem = info.basePx;
  const ctx = { theme, rem };
  const session = store.active();
  const log = useSessionLog(session.dbId);
  const items = transcript(session.dbId, log);

  const list = useRef<NodeHandle | null>(null);
  const input = useRef<NodeHandle | null>(null);
  const follow = useRef(true);
  const lastOffset = useRef(0);

  useEffect(() => {
    follow.current = true;
    list.current?.scrollTo(1e9);
  }, [store.at]);
  useEffect(() => {
    if (follow.current) list.current?.scrollTo(1e9, true);
  });
  useEffect(() => {
    if (session.ask || store.palette) input.current?.blur();
    else input.current?.focus();
  }, [session.ask, store.palette]);

  return (
    <Box
      style={{
        width: "100%",
        height: "100%",
        background: theme.bg,
        color: theme.fg,
        fontSize: rem,
      }}
    >
      {store.sidebar && <Sidebar ctx={ctx} />}
      <Box style={{ flexDirection: "column", flexGrow: 1, flexBasis: 0, overflow: "hidden" }}>
        <Header ctx={ctx} session={session} />
        <Box
          ref={list}
          style={{
            flexDirection: "column",
            flexGrow: 1,
            flexBasis: 0,
            overflow: "scroll",
            padding: rem,
            gap: rem * 0.75,
            selectionMode: "unified",
          }}
          onScroll={(e) => {
            if (e.offset < lastOffset.current - 1) follow.current = false;
            if (e.offset >= e.max - 2) follow.current = true;
            lastOffset.current = e.offset;
          }}
        >
          {items.map((item, i) => (
            <Message key={i} ctx={ctx} item={item} />
          ))}
        </Box>
        {session.ask && <AskBox ctx={ctx} ask={session.ask} />}
        {session.working && <WorkingStatus ctx={ctx} session={session} />}
        <Composer ctx={ctx} inputRef={input} />
      </Box>
      {store.palette && <Palette ctx={ctx} />}
      {store.settings && <Settings ctx={ctx} />}
    </Box>
  );
}

function Header({ ctx, session }: { ctx: Ctx; session: Session }) {
  const { theme, rem } = ctx;
  return (
    <Box
      style={{
        alignItems: "center",
        gap: rem * 0.5,
        padding: { left: rem, right: rem, top: rem * 0.5, bottom: rem * 0.5 },
      }}
    />
  );
}
