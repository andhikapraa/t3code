import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import ScheduledTaskWebhooks from "./Migrations/057_ScheduledTaskWebhooks.ts";
import PullRequestReviewGuides from "./Migrations/061_PullRequestReviewGuides.ts";

// Fork builds recorded ScheduledTasksLastRunThread under ids upstream later
// gave to its own migrations: first 57 (ScheduledTaskWebhooks), then 61
// (PullRequestReviewGuides). The migrator skips every id at or below the
// latest recorded one, so those databases would never get upstream's schema.
// Apply upstream's migration under its own name instead; migration 62 then
// finds last_run_thread_id already present.
const forkCollisions = [
  { id: 57, name: "ScheduledTaskWebhooks", migration: ScheduledTaskWebhooks },
  { id: 61, name: "PullRequestReviewGuides", migration: PullRequestReviewGuides },
] as const;

export const reconcileForkMigrations = Effect.fn("reconcileForkMigrations")(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const tables = yield* sql`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
      `;
      if (tables.length === 0) return [];
      const reconciled: Array<readonly [number, string]> = [];
      for (const collision of forkCollisions) {
        const forkRows = yield* sql`
          SELECT migration_id FROM effect_sql_migrations
          WHERE migration_id = ${collision.id} AND name = 'ScheduledTasksLastRunThread'
        `;
        if (forkRows.length === 0) continue;
        yield* collision.migration;
        yield* sql`
          UPDATE effect_sql_migrations SET name = ${collision.name}
          WHERE migration_id = ${collision.id} AND name = 'ScheduledTasksLastRunThread'
        `;
        reconciled.push([collision.id, collision.name] as const);
      }
      return reconciled;
    }),
  );
});
