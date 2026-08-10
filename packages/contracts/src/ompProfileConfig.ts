import * as Schema from "effect/Schema";
import { ProviderInstanceId } from "./providerInstance.ts";

export const OMP_PROFILE_CONFIG_MAX_CHARS = 1_000_000;

export const OmpProfileConfigSnapshot = Schema.Struct({
  instanceId: ProviderInstanceId,
  profile: Schema.String,
  configPath: Schema.String,
  exists: Schema.Boolean,
  content: Schema.String.check(Schema.isMaxLength(OMP_PROFILE_CONFIG_MAX_CHARS)),
  revision: Schema.NullOr(Schema.String),
  overlayPaths: Schema.Array(Schema.String),
  binaryPath: Schema.String,
  guidance: Schema.Array(Schema.String),
});
export type OmpProfileConfigSnapshot = typeof OmpProfileConfigSnapshot.Type;

export const OmpProfileConfigReadInput = Schema.Struct({
  instanceId: ProviderInstanceId,
});
export type OmpProfileConfigReadInput = typeof OmpProfileConfigReadInput.Type;

export const OmpProfileConfigWriteInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  content: Schema.String.check(Schema.isMaxLength(OMP_PROFILE_CONFIG_MAX_CHARS)),
  expectedRevision: Schema.NullOr(Schema.String),
});
export type OmpProfileConfigWriteInput = typeof OmpProfileConfigWriteInput.Type;

export class OmpProfileConfigError extends Schema.TaggedErrorClass<OmpProfileConfigError>()(
  "OmpProfileConfigError",
  {
    stage: Schema.Literals(["resolve", "read", "parse", "conflict", "write"]),
    configPath: Schema.optional(Schema.String),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const location = this.configPath ? ` at ${this.configPath}` : "";
    return `Unable to ${this.stage} OMP profile configuration${location}: ${this.detail}`;
  }
}
