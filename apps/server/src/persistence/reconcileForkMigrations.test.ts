import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";
import LastRunThread from "./Migrations/061_ScheduledTasksLastRunThread.ts";

it.effect("upgrades a fork database that recorded last_run_thread_id as migration 57", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 56 });
    yield* Migrator.make({})({
      loader: Migrator.fromRecord({ "57_ScheduledTasksLastRunThread": LastRunThread }),
    });

    assert.deepStrictEqual(yield* runMigrations(), [
      [57, "ScheduledTaskWebhooks"],
      [58, "WebhookRelayDeliveries"],
      [59, "McpAppModelContext"],
      [60, "ThreadSnapshotWindowIndexes"],
      [61, "ScheduledTasksLastRunThread"],
    ]);
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
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
