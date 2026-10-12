import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // The thread the latest successful run posted into, so clients can open a
  // fresh-thread-per-run task's newest result without searching the sidebar.
  // Earlier fork builds added it as migration 57 or 61, so it may already
  // exist (see reconcileForkMigrations.ts).
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(scheduled_tasks)`;
  if (columns.some((column) => column.name === "last_run_thread_id")) return;
  yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN last_run_thread_id TEXT`;
});
