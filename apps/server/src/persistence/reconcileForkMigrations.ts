import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

const FORK_MIGRATION_NAME = "ScheduledTasksLastRunThread";

type MigrationEntry<E> = readonly [number, string, Effect.Effect<unknown, E, SqlClient.SqlClient>];

/**
 * The fork's only schema change. It runs after the migrator, outside the migration table,
 * so upstream can keep adding migration ids without colliding with the fork.
 */
export const ensureForkSchema = Effect.fn("ensureForkSchema")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(scheduled_tasks)`;
  if (columns.length === 0 || columns.some((column) => column.name === "last_run_thread_id")) {
    return;
  }
  yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN last_run_thread_id TEXT`;
});

// Older fork builds recorded the column as a migration under ids upstream later took
// (57, 61, 62, 63, 65, 68, 73), and the migrator skips ids at or below the latest one.
// Run upstream's migration under that id, or drop the row while upstream has no such id.
export const reconcileForkMigrations = Effect.fn("reconcileForkMigrations")(function* <E>(
  entries: ReadonlyArray<MigrationEntry<E>>,
  throughId?: number,
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const tables = yield* sql`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
      `;
      if (tables.length === 0) return [];
      const forkRows = yield* sql<{ readonly migration_id: number }>`
        SELECT migration_id FROM effect_sql_migrations WHERE name = ${FORK_MIGRATION_NAME}
      `;
      const reconciled: Array<readonly [number, string]> = [];
      for (const { migration_id: id } of forkRows) {
        if (throughId !== undefined && id > throughId) continue;
        const upstream = entries.find(([entryId]) => entryId === id);
        if (upstream === undefined) {
          yield* sql`
            DELETE FROM effect_sql_migrations
            WHERE migration_id = ${id} AND name = ${FORK_MIGRATION_NAME}
          `;
          continue;
        }
        const [, name, migration] = upstream;
        yield* migration.pipe(
          Effect.mapError(
            (cause) =>
              new Migrator.MigrationError({
                kind: "Failed",
                message: `Migration "${id}_${name}" failed while reconciling a fork migration id`,
                cause,
              }),
          ),
        );
        yield* sql`
          UPDATE effect_sql_migrations SET name = ${name}
          WHERE migration_id = ${id} AND name = ${FORK_MIGRATION_NAME}
        `;
        reconciled.push([id, name] as const);
      }
      return reconciled;
    }),
  );
});
