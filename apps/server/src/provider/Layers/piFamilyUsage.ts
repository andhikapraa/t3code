import type { ThreadTokenUsageSnapshot } from "@t3tools/contracts";

export interface PiFamilyUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly reasoning: number;
  readonly totalTokens: number;
  readonly costTotalUsd: number;
  readonly durationMs: number | undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function asFiniteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function piFamilyUsageFromEvent(event: unknown): PiFamilyUsage | undefined {
  const record = asRecord(event);
  const message = asRecord(record?.message);
  const usage = asRecord(message?.usage);
  if (usage === undefined) {
    return undefined;
  }

  const totalTokens = asNonNegativeInteger(usage.totalTokens);
  const input = asNonNegativeInteger(usage.input);
  const output = asNonNegativeInteger(usage.output);
  if (
    totalTokens === undefined ||
    totalTokens <= 0 ||
    input === undefined ||
    output === undefined
  ) {
    return undefined;
  }

  const cost = asRecord(usage.cost);
  const reasoning =
    asNonNegativeInteger(usage.reasoning) ?? asNonNegativeInteger(usage.reasoningTokens) ?? 0;
  const duration = asFiniteNonNegative(record?.duration);

  return {
    input,
    output,
    cacheRead: asNonNegativeInteger(usage.cacheRead) ?? 0,
    reasoning,
    totalTokens,
    costTotalUsd: asFiniteNonNegative(cost?.total) ?? 0,
    durationMs: duration !== undefined ? Math.round(duration) : undefined,
  };
}

export function piFamilyContextWindowTable(data: unknown): ReadonlyMap<string, number> {
  const table = new Map<string, number>();
  const payload = asRecord(data);
  const models = Array.isArray(data) ? data : payload?.models;
  if (!Array.isArray(models)) {
    return table;
  }

  for (const entry of models) {
    const model = asRecord(entry);
    if (model === undefined) {
      continue;
    }
    const provider = typeof model.provider === "string" ? model.provider : undefined;
    const id = typeof model.id === "string" ? model.id : undefined;
    const contextWindow = asNonNegativeInteger(model.contextWindow);
    if (provider && id && contextWindow !== undefined && contextWindow > 0) {
      table.set(`${provider}/${id}`, contextWindow);
    }
  }

  return table;
}

export function makePiFamilyTokenUsageSnapshot(input: {
  readonly usage: PiFamilyUsage;
  readonly processedInputTokens: number;
  readonly processedOutputTokens: number;
  readonly contextWindow: number | undefined;
}): ThreadTokenUsageSnapshot {
  const { usage, processedInputTokens, processedOutputTokens, contextWindow } = input;
  return {
    usedTokens: usage.totalTokens,
    totalProcessedTokens: processedInputTokens + processedOutputTokens,
    ...(contextWindow !== undefined && contextWindow > 0 ? { maxTokens: contextWindow } : {}),
    inputTokens: usage.input,
    cachedInputTokens: usage.cacheRead,
    outputTokens: usage.output,
    reasoningOutputTokens: usage.reasoning,
    ...(usage.durationMs !== undefined ? { durationMs: usage.durationMs } : {}),
    compactsAutomatically: true,
  };
}
