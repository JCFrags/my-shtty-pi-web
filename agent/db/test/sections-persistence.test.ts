/**
 * Repro tests for the "notes don't persist across full process restart" bug
 * the framework dev surfaced. We isolate the kyju-level question:
 *
 *   "If I open a sectioned DB, mutate a section, then reopen with the
 *    same / a new migrations array, is the section data preserved?"
 *
 * Three paths to cover:
 *   1. Reopen with the SAME migrations array (no schema change between
 *      restarts). Should always preserve. This is the "every-restart wipe"
 *      scenario the user is reporting.
 *   2. Reopen with migrations array that GAINED a v1 entry (the user just
 *      ran `zen db generate` over a section that already had user data
 *      written under the v0 schema-bootstrap defaults).
 *   3. Reopen with NO migrations (matches first dev iteration before
 *      `zen db generate` is run).
 *
 * Each test does: openSectionedDb → mutate → db.flush() → re-open →
 * assert. We never tear down the kyju runtime explicitly because there's
 * no close API, but `db.flush()` synchronously drains the coalesced disk
 * writer so the next `createDb` can read consistent state.
 */
import { describe, it, expect, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import zod from "zod";
import { nanoid } from "nanoid";
import { createDb } from "../src/v2/db/db";
import { createReplica } from "../src/v2/replica/replica";
import { createClient } from "../src/v2/client/client";
import { createSchema, f, type SchemaShape } from "../src/v2/db/schema";
import type { KyjuMigration, SectionConfig } from "../src/v2/migrations";
import { VERSION } from "../src/v2/shared";

function tmpDbPath() {
  return path.join(os.tmpdir(), `kyju-sections-persist-${nanoid()}`);
}

async function openSectionedDb(dbPath: string, sections: SectionConfig[]) {
  let db: Awaited<ReturnType<typeof createDb>>;
  const replica = createReplica({
    send: (event) => db.postMessage(event),
    maxPageSizeBytes: 1024 * 1024,
  });
  db = await createDb({
    path: dbPath,
    sections,
    send: (event) => replica.postMessage(event),
  });
  await replica.postMessage({ kind: "connect", version: VERSION });
  return { db, replica };
}

const notesSchema = createSchema({
  notes: f
    .array(zod.object({ id: zod.string(), text: zod.string() }))
    .default([]),
});

let cleanupPath: string | null = null;
afterEach(() => {
  if (cleanupPath) {
    fs.rmSync(cleanupPath, { recursive: true, force: true });
    cleanupPath = null;
  }
});

describe("section persistence across restarts", () => {
  it("preserves user data when reopening with the SAME migrations array (no version bump)", async () => {
    const dbPath = tmpDbPath();
    cleanupPath = dbPath;

    const migrations: KyjuMigration[] = [
      {
        version: 1,
        operations: [
          {
            op: "add",
            key: "notes",
            kind: "data",
            hasDefault: true,
            default: [],
          },
        ],
      },
    ];
    const section: SectionConfig = {
      name: "notes-view",
      schema: notesSchema,
      migrations,
    };

    // First boot: bootstrap section, run migration v0→v1, write user data.
    {
      const { db, replica } = await openSectionedDb(dbPath, [section]);
      const client = createClient<SchemaShape>(replica);
      await client.update((root: any) => {
        root["notes-view"].notes = [
          { id: "n1", text: "hello" },
          { id: "n2", text: "world" },
        ];
      });
      await db.flush();
    }

    // Second boot: same migrations array. Should be a no-op (v1 >= v1).
    {
      const { replica } = await openSectionedDb(dbPath, [section]);
      const client = createClient<SchemaShape>(replica);
      const root = client.readRoot() as Record<string, any>;
      expect(root["notes-view"].notes).toEqual([
        { id: "n1", text: "hello" },
        { id: "n2", text: "world" },
      ]);
      expect(root._plugins.sectionMigrator["notes-view"].version).toBe(1);
    }
  });

  it("preserves user data when migrations are added AFTER the section already has writes (zen db generate scenario)", async () => {
    const dbPath = tmpDbPath();
    cleanupPath = dbPath;

    // Boot 1: no migrations yet (user hasn't run `zen db generate`).
    // Schema-bootstrap path (`buildSchemaRoot`) populates notes: [].
    {
      const { db, replica } = await openSectionedDb(dbPath, [
        { name: "notes-view", schema: notesSchema, migrations: [] },
      ]);
      const client = createClient<SchemaShape>(replica);
      await client.update((root: any) => {
        root["notes-view"].notes = [{ id: "n1", text: "hello" }];
      });
      await db.flush();
    }

    // Boot 2: user has now run `zen db generate`. The migration adds the
    // same key with the same default. The migrator sees currentVersion 0
    // < targetVersion 1 and applies the v1 migration. The expected
    // semantics: don't clobber user data that already lives under that
    // key. The current code DOES clobber — this test pins the bug.
    {
      const migrations: KyjuMigration[] = [
        {
          version: 1,
          operations: [
            {
              op: "add",
              key: "notes",
              kind: "data",
              hasDefault: true,
              default: [],
            },
          ],
        },
      ];
      const { replica } = await openSectionedDb(dbPath, [
        { name: "notes-view", schema: notesSchema, migrations },
      ]);
      const client = createClient<SchemaShape>(replica);
      const root = client.readRoot() as Record<string, any>;
      expect(root["notes-view"].notes).toEqual([
        { id: "n1", text: "hello" },
      ]);
      expect(root._plugins.sectionMigrator["notes-view"].version).toBe(1);
    }
  });

  it("preserves data on reopen when MULTIPLE sections each have v1 migrations (template-smoke layout)", async () => {
    const dbPath = tmpDbPath();
    cleanupPath = dbPath;

    const appSchema = createSchema({
      count: f.number().default(0),
    });
    const overlaySchema = createSchema({
      color: f.string().default("#0ea5e9"),
      pulses: f.number().default(0),
    });

    const appMigrations: KyjuMigration[] = [
      {
        version: 1,
        operations: [
          {
            op: "add",
            key: "count",
            kind: "data",
            hasDefault: true,
            default: 0,
          },
        ],
      },
    ];
    const overlayMigrations: KyjuMigration[] = [
      {
        version: 1,
        operations: [
          {
            op: "add",
            key: "color",
            kind: "data",
            hasDefault: true,
            default: "#0ea5e9",
          },
          {
            op: "add",
            key: "pulses",
            kind: "data",
            hasDefault: true,
            default: 0,
          },
        ],
      },
    ];
    const notesMigrations: KyjuMigration[] = [
      {
        version: 1,
        operations: [
          {
            op: "add",
            key: "notes",
            kind: "data",
            hasDefault: true,
            default: [],
          },
        ],
      },
    ];

    const sections: SectionConfig[] = [
      { name: "app", schema: appSchema, migrations: appMigrations },
      {
        name: "clock-overlay",
        schema: overlaySchema,
        migrations: overlayMigrations,
      },
      { name: "notes-view", schema: notesSchema, migrations: notesMigrations },
    ];

    // Boot 1: bootstrap and migrate everything to v1, then write user data
    // into all three sections.
    {
      const { db, replica } = await openSectionedDb(dbPath, sections);
      const client = createClient<SchemaShape>(replica);
      await client.update((root: any) => {
        root.app.count = 37;
        root["clock-overlay"].color = "#d1da65";
        root["clock-overlay"].pulses = 235;
        root["notes-view"].notes = [{ id: "n1", text: "testing" }];
      });
      await db.flush();
    }

    // Boot 2: nothing changed in the migrations array. Data must survive.
    {
      const { replica } = await openSectionedDb(dbPath, sections);
      const client = createClient<SchemaShape>(replica);
      const root = client.readRoot() as Record<string, any>;
      expect(root.app.count).toBe(37);
      expect(root["clock-overlay"].color).toBe("#d1da65");
      expect(root["clock-overlay"].pulses).toBe(235);
      expect(root["notes-view"].notes).toEqual([
        { id: "n1", text: "testing" },
      ]);
    }
  });

  it("preserves user data across many reopens with the same migrations array (every-restart wipe)", async () => {
    const dbPath = tmpDbPath();
    cleanupPath = dbPath;

    const migrations: KyjuMigration[] = [
      {
        version: 1,
        operations: [
          {
            op: "add",
            key: "notes",
            kind: "data",
            hasDefault: true,
            default: [],
          },
        ],
      },
    ];
    const section: SectionConfig = {
      name: "notes-view",
      schema: notesSchema,
      migrations,
    };

    // Initial boot, write data.
    {
      const { db, replica } = await openSectionedDb(dbPath, [section]);
      const client = createClient<SchemaShape>(replica);
      await client.update((root: any) => {
        root["notes-view"].notes = [{ id: "n1", text: "persistent" }];
      });
      await db.flush();
    }

    // Re-open three times. Data should survive every reopen.
    for (let i = 0; i < 3; i++) {
      const { db, replica } = await openSectionedDb(dbPath, [section]);
      const client = createClient<SchemaShape>(replica);
      const root = client.readRoot() as Record<string, any>;
      expect(
        root["notes-view"].notes,
        `iteration ${i}: notes should still be present`,
      ).toEqual([{ id: "n1", text: "persistent" }]);
      // Don't mutate; just close (flush no-op since nothing changed).
      await db.flush();
    }
  });
});
