import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";
import LastRunThread from "./Migrations/062_ScheduledTasksLastRunThread.ts";

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
  const guides = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pull_request_review_guides'
  `;
  assert.strictEqual(guides.length, 1);
});

it.effect("upgrades a fork database that recorded last_run_thread_id as migration 57", () =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 56 });
    yield* Migrator.make({})({
      loader: Migrator.fromRecord({ "57_ScheduledTasksLastRunThread": LastRunThread }),
    });

    assert.deepStrictEqual(yield* runMigrations(), [
      [57, "ScheduledTaskWebhooks"],
      [58, "WebhookRelayDeliveries"],
      [59, "McpAppModelContext"],
      [60, "ThreadSnapshotWindowIndexes"],
      [61, "PullRequestReviewGuides"],
      [62, "ScheduledTasksLastRunThread"],
    ]);
    yield* assertUpgradedSchema;
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("upgrades a fork database that recorded last_run_thread_id as migration 61", () =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 60 });
    yield* Migrator.make({})({
      loader: Migrator.fromRecord({ "61_ScheduledTasksLastRunThread": LastRunThread }),
    });

    assert.deepStrictEqual(yield* runMigrations(), [
      [61, "PullRequestReviewGuides"],
      [62, "ScheduledTasksLastRunThread"],
    ]);
    yield* assertUpgradedSchema;
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
