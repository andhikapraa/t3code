import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";

const assertUpgradedSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  assert.deepStrictEqual(yield* runMigrations(), []);
  const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
  assert.deepStrictEqual(
    history.map((row) => [row.migration_id, row.name] as const),
    migrationManifest,
  );
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(scheduled_tasks)`;
  for (const column of ["last_run_thread_id", "webhook_token", "webhook_secret"]) {
    assert.ok(
      columns.some((candidate) => candidate.name === column),
      column,
    );
  }
});

it.effect("adds last_run_thread_id to a fresh database without a migration row", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    yield* assertUpgradedSchema;
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

// Each id is one an earlier fork build recorded the column under.
it.effect.each([57, 61, 62, 63, 65, 68, 73])(
  "upgrades a fork database that recorded last_run_thread_id as migration %s",
  (forkId) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: forkId - 1 });
      yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN last_run_thread_id TEXT`;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${forkId}, 'ScheduledTasksLastRunThread')
      `;

      const expected = migrationManifest.filter(([id]) => id >= forkId);
      assert.deepStrictEqual(yield* runMigrations(), expected);
      yield* assertUpgradedSchema;
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
