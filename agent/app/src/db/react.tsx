import { useEffect, useState, type ReactNode } from "react";

import { createKyjuReact } from "@pixel/db/react";

import { getDb, getDbSync, type DbConnection } from "./index";
import type { AppShape } from "./schema";

const kyju = createKyjuReact<AppShape>();

export const useDb = kyju.useDb;
export const useCollection = kyju.useCollection;

export function DbProvider({
  children,
  fallback = null,
}: {
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const [conn, setConn] = useState<DbConnection | null>(getDbSync);

  useEffect(() => {
    let live = true;
    void getDb().then((c) => {
      if (live) setConn(c);
    });
    return () => {
      live = false;
    };
  }, []);

  if (!conn) return <>{fallback}</>;
  return (
    <kyju.KyjuProvider client={conn.client} replica={conn.replica}>
      {children}
    </kyju.KyjuProvider>
  );
}
