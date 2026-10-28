import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

const FORK_MIGRATION_NAME = "ScheduledTasksLastRunThread";

type MigrationEntry<E> = readonly [number, string, Effect.Effect<unknown, E, SqlClient.SqlClient>];

// Upstream syncs keep taking the fork migration's id (57, 61, 62, 63, 65, 68), and
// the migrator skips ids at or below the latest recorded one. Run upstream's
// migration under that id instead; the fork migration reruns at its new id and
// finds last_run_thread_id already present.
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
        if (upstream === undefined || upstream[1] === FORK_MIGRATION_NAME) continue;
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
