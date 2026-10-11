import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import ScheduledTaskWebhooks from "./Migrations/057_ScheduledTaskWebhooks.ts";

// Fork builds before the upstream sync recorded ScheduledTasksLastRunThread as
// migration 57, an id upstream later gave ScheduledTaskWebhooks. The migrator
// skips every id at or below the latest recorded one, so those databases would
// never get webhook storage. Apply upstream's 57 under its own name instead;
// migration 61 then finds last_run_thread_id already present.
export const reconcileForkMigrations = Effect.fn("reconcileForkMigrations")(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const tables = yield* sql`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
      `;
      if (tables.length === 0) return [];
      const forkRows = yield* sql`
        SELECT migration_id FROM effect_sql_migrations
        WHERE migration_id = 57 AND name = 'ScheduledTasksLastRunThread'
      `;
      if (forkRows.length === 0) return [];
      yield* ScheduledTaskWebhooks;
      yield* sql`
        UPDATE effect_sql_migrations SET name = 'ScheduledTaskWebhooks'
        WHERE migration_id = 57 AND name = 'ScheduledTasksLastRunThread'
      `;
      return [[57, "ScheduledTaskWebhooks"] as const];
    }),
  );
});
