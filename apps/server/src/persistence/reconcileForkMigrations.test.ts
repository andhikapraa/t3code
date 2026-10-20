import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";
import LastRunThread from "./Migrations/065_ScheduledTasksLastRunThread.ts";

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
  const schema = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master
    WHERE name IN ('pull_request_review_guides', 'orchestration_v2_projection_turn_items_failed_error_idx')
  `;
  assert.strictEqual(schema.length, 2);
});

// Each case is a fork build that recorded the fork migration at an id upstream later took.
const cases = [
  {
    forkId: 57,
    expected: [
      [57, "ScheduledTaskWebhooks"],
      [58, "WebhookRelayDeliveries"],
      [59, "McpAppModelContext"],
      [60, "ThreadSnapshotWindowIndexes"],
      [61, "PullRequestReviewGuides"],
      [62, "ThreadFailureLookupIndex"],
      [63, "DropUnusedV1Projections"],
      [64, "CanonicalizeThreadPullRequestLinks"],
      [65, "ScheduledTasksLastRunThread"],
    ],
  },
  {
    forkId: 61,
    expected: [
      [61, "PullRequestReviewGuides"],
      [62, "ThreadFailureLookupIndex"],
      [63, "DropUnusedV1Projections"],
      [64, "CanonicalizeThreadPullRequestLinks"],
      [65, "ScheduledTasksLastRunThread"],
    ],
  },
  {
    forkId: 62,
    expected: [
      [62, "ThreadFailureLookupIndex"],
      [63, "DropUnusedV1Projections"],
      [64, "CanonicalizeThreadPullRequestLinks"],
      [65, "ScheduledTasksLastRunThread"],
    ],
  },
  {
    forkId: 63,
    expected: [
      [63, "DropUnusedV1Projections"],
      [64, "CanonicalizeThreadPullRequestLinks"],
      [65, "ScheduledTasksLastRunThread"],
    ],
  },
] as const;

for (const { forkId, expected } of cases) {
  it.effect(
    `upgrades a fork database that recorded last_run_thread_id as migration ${forkId}`,
    () =>
      Effect.gen(function* () {
        yield* runMigrations({ toMigrationInclusive: forkId - 1 });
        yield* Migrator.make({})({
          loader: Migrator.fromRecord({ [`${forkId}_ScheduledTasksLastRunThread`]: LastRunThread }),
        });

        assert.deepStrictEqual(yield* runMigrations(), [...expected]);
        yield* assertUpgradedSchema;
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
}
