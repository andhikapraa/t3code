import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Cloudflare from "alchemy/Cloudflare";
import type { EffectPgDatabase } from "drizzle-orm/effect-postgres";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export class RelayDb extends Context.Service<
  RelayDb,
  EffectPgDatabase & {
    readonly $client: PgClient;
  }
>()("t3code-relay/db/RelayDb") {}

export class RelayTransactions extends Context.Service<
  RelayTransactions,
  {
    readonly withTransaction: RelayDb["Service"]["$client"]["withTransaction"];
  }
>()("t3code-relay/db/RelayTransactions") {
  static readonly layer = Layer.effect(
    RelayTransactions,
    Effect.gen(function* () {
      const db = yield* RelayDb;
      return RelayTransactions.of({
        withTransaction: db.$client.withTransaction,
      });
    }),
  );
}

// Fork: a self-hosted Postgres reached through a Cloudflare Tunnel guarded by an
// Access service token, instead of a PlanetScale database. The database and
// tunnel are provisioned outside this stack, and migrations in
// ./migrations/postgres are applied to it directly before deploying.
export const RelayPostgresOrigin = Effect.gen(function* () {
  return {
    scheme: "postgres" as const,
    host: yield* Config.NonEmptyString("RELAY_DB_HOST"),
    database: yield* Config.NonEmptyString("RELAY_DB_NAME"),
    user: yield* Config.NonEmptyString("RELAY_DB_USER"),
    password: yield* Config.Redacted("RELAY_DB_PASSWORD"),
    accessClientId: yield* Config.Redacted("RELAY_DB_ACCESS_CLIENT_ID"),
    accessClientSecret: yield* Config.Redacted("RELAY_DB_ACCESS_CLIENT_SECRET"),
  };
});

export const RelayHyperdrive = Effect.gen(function* () {
  return yield* Cloudflare.Hyperdrive.Connection("RelayHyperdrive", {
    origin: yield* RelayPostgresOrigin,
    caching: {
      disabled: true,
    },
    originConnectionLimit: 20,
  });
});
