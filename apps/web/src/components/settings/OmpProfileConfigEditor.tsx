"use client";

import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  OmpProfileConfigSnapshot,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { LoaderIcon, RefreshCwIcon, SaveIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";

function failureMessage(failure: unknown): string {
  const error = squashAtomCommandFailure(failure as Parameters<typeof squashAtomCommandFailure>[0]);
  return error instanceof Error ? error.message : "The OMP profile configuration request failed.";
}

const OMP_PROFILE_RESOLUTION_ENV_NAMES = new Set([
  "HOME",
  "OMP_PROFILE",
  "PI_CONFIG_DIR",
  "PI_CONFIG_FILES",
  "PI_CODING_AGENT_DIR",
  "PI_PROFILE",
  "XDG_DATA_HOME",
]);

export function getOmpProfileResolutionKey(input: {
  readonly config: unknown;
  readonly environment: ReadonlyArray<{ readonly name: string; readonly value: string }>;
}): string {
  const configRecord =
    input.config !== null && typeof input.config === "object"
      ? (input.config as Record<string, unknown>)
      : {};
  const environment = input.environment
    .filter(({ name }) => OMP_PROFILE_RESOLUTION_ENV_NAMES.has(name))
    .map(({ name, value }) => [name, value] as const);
  return JSON.stringify({
    launchArgs: typeof configRecord.launchArgs === "string" ? configRecord.launchArgs : "",
    profile: typeof configRecord.profile === "string" ? configRecord.profile : "",
    environment,
  });
}

export function OmpProfileConfigEditor(props: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly profileResolutionKey: string;
}) {
  const getProfile = useAtomCommand(serverEnvironment.getOmpProfileConfig, {
    reportFailure: false,
  });
  const updateProfile = useAtomCommand(serverEnvironment.updateOmpProfileConfig, {
    reportFailure: false,
  });
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const loadGeneration = useRef(0);
  const [snapshot, setSnapshot] = useState<OmpProfileConfigSnapshot | null>(null);
  const [draft, setDraft] = useState("");
  const [loadedResolutionKey, setLoadedResolutionKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    const resolutionKey = props.profileResolutionKey;
    setLoading(true);
    setErrorMessage(null);
    setLoadedResolutionKey(null);
    const result = await getProfile({
      environmentId: props.environmentId,
      input: { instanceId: props.instanceId },
    });
    if (generation !== loadGeneration.current) return;
    setLoading(false);
    if (result._tag === "Success") {
      setSnapshot(result.value);
      setDraft(result.value.content);
      setLoadedResolutionKey(resolutionKey);
      return;
    }
    if (!isAtomCommandInterrupted(result)) setErrorMessage(failureMessage(result));
  }, [getProfile, props.environmentId, props.instanceId, props.profileResolutionKey]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(async () => {
    if (!snapshot || loadedResolutionKey !== props.profileResolutionKey || saving) return;
    setSaving(true);
    setErrorMessage(null);
    const result = await updateProfile({
      environmentId: props.environmentId,
      input: {
        instanceId: props.instanceId,
        content: draft,
        expectedRevision: snapshot.revision,
      },
    });
    setSaving(false);
    if (result._tag === "Success") {
      setSnapshot(result.value);
      setDraft(result.value.content);
      const probeResult = await refreshProviders({
        environmentId: props.environmentId,
        input: { instanceId: props.instanceId },
      });
      const probeFailed = probeResult._tag === "Failure" && !isAtomCommandInterrupted(probeResult);
      toastManager.add({
        type: probeFailed ? "warning" : "success",
        title: "OMP profile configuration saved",
        description: probeFailed
          ? "The profile was saved, but the fresh provider probe failed. Use reload or refresh provider status to retry."
          : "A fresh provider probe has loaded the selected profile.",
      });
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const message = failureMessage(result);
    setErrorMessage(message);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Could not save OMP profile configuration",
        description: message,
      }),
    );
  }, [
    draft,
    props.environmentId,
    props.instanceId,
    props.profileResolutionKey,
    refreshProviders,
    saving,
    snapshot,
    loadedResolutionKey,
    updateProfile,
  ]);

  return (
    <div className="grid gap-2 rounded-lg border border-border/70 bg-muted/20 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-foreground">OMP profile configuration</p>
          <p className="truncate font-mono text-[11px] text-muted-foreground">
            {snapshot?.configPath ?? "Resolving selected profile…"}
          </p>
        </div>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="Reload OMP profile configuration"
          disabled={loading || saving}
          onClick={() => void load()}
        >
          {loading ? <LoaderIcon className="animate-spin" /> : <RefreshCwIcon />}
        </Button>
      </div>

      {snapshot ? (
        <>
          <Textarea
            aria-label="OMP profile YAML"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="# OMP config.yml"
            className="min-h-56 resize-y bg-background font-mono text-xs"
            spellCheck={false}
          />
          <div className="grid gap-1 text-[11px] text-muted-foreground">
            {snapshot.guidance.map((guidance) => (
              <p key={guidance}>{guidance}</p>
            ))}
            {snapshot.overlayPaths.map((overlayPath) => (
              <p key={overlayPath} className="truncate font-mono">
                Overlay: {overlayPath}
              </p>
            ))}
          </div>
          <div className="flex justify-end">
            <Button
              type="button"
              size="sm"
              disabled={
                saving ||
                loading ||
                loadedResolutionKey !== props.profileResolutionKey ||
                draft === snapshot.content
              }
              onClick={() => void save()}
            >
              {saving ? <LoaderIcon className="animate-spin" /> : <SaveIcon />}
              {saving ? "Saving" : "Save profile"}
            </Button>
          </div>
        </>
      ) : null}

      {errorMessage ? <p className="text-xs text-destructive">{errorMessage}</p> : null}
    </div>
  );
}
