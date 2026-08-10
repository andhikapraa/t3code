# OMP (Oh My Pi)

OMP is a local coding-agent provider. T3 Code launches the configured OMP executable over its headless JSONL RPC interface, keeps the process scoped to the provider instance, and maps OMP output into the normal T3 Code thread, approval, command, model, subagent, and checkpoint surfaces.

For first-time setup, see [Install T3 Code](./install.md).

## Install OMP

T3 Code supports OMP 17.0.9 or newer. Install it through one of the package-manager paths used by T3 Code's provider updater:

```bash
npm install -g @oh-my-pi/pi-coding-agent
```

or:

```bash
brew install can1357/tap/omp
```

Verify that the executable is on `PATH`:

```bash
omp --version
```

If T3 Code cannot find the executable, set an absolute **Binary path** in the OMP provider instance instead of changing the application-wide `PATH`.

## Add an OMP instance

Open **Settings → Providers → Add provider instance**, choose **OMP**, and complete the three steps:

1. **Driver**: choose OMP.
2. **Identity**: set an optional display label, a unique instance ID, and an accent color.
3. **Config**: optionally set the executable path, launch arguments, and profile.

Multiple OMP instances are supported. Instance IDs may contain letters, digits, `-`, and `_`; use stable IDs because threads and sessions route through them.

### Instance configuration

| Field                | Meaning                                                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Binary path**      | OMP executable path. Blank uses `omp` from the process `PATH`.                                                                                         |
| **Launch arguments** | Additional arguments for interactive OMP sessions. T3 Code owns the RPC mode, session directory, model, thinking, approval, profile, and resume flags. |
| **Profile**          | Optional OMP profile name. Blank uses OMP's default profile.                                                                                           |

The web and desktop settings surfaces expose the OMP profile editor. Mobile intentionally does not expose a provider-settings card in this effort; mobile can still run and observe sessions supplied by the configured server environment.

## Profiles, credentials, and environment variables

OMP profiles isolate configuration, authentication, caches, and session metadata. Select the profile in the instance's **Profile** field. T3 Code resolves the selected profile using the provider instance's environment and launch arguments rather than editing the live profile during a test.

Use the provider instance's **Environment variables** section for instance-specific environment values. Mark credentials as sensitive. Sensitive values are stored through T3 Code's server-side secret mechanism and are redacted from settings responses and the profile editor.

Do not paste API keys into project files, `settings.json`, screenshots, or issue reports.

## Models and thinking levels

After OMP status refresh completes, T3 Code discovers OMP models and commands through isolated no-session RPC probes. The model picker groups models under the configured OMP instance and preserves the provider/model identity.

Select a model from the normal thread composer. OMP thinking tiers are surfaced when the selected model advertises them. Supported OMP tier values are:

```text
off, minimal, low, medium, high, xhigh, max
```

Changing the model or thinking tier mid-thread sends the change through the existing session control path. T3 Code scopes model discovery and launch arguments to the selected OMP provider so environment credentials cannot silently choose a different provider's default model.

## Commands and extensions

OMP's built-in, extension, custom, prompt, and skill commands are discovered at provider refresh time and appear in the existing composer command picker. Type `/` in the composer and search by command name or description.

Interactive OMP extension requests are shown through T3 Code's existing user-input surface:

- approval-shaped `select` requests use **Approve** and **Deny**;
- other `select`, `confirm`, `input`, and `editor` requests remain user-input dialogs;
- cancelling an approval is sent to OMP as **Deny**, never as an approval.

## Sessions, subagents, and rewind

T3 Code creates an OMP session in an isolated per-thread session directory and launches OMP in `rpc-ui` mode. A resumed session passes OMP's recorded session file back with `--resume`; the provider's continuation identity controls which instance can resume it.

OMP subagent lifecycle and progress frames are mapped into T3 Code's existing activity and task surfaces. Child identities remain distinct from the parent, and teardown stops remaining child work when the parent session ends.

Checkpoint rewind validates the stored provider cursor and boundary before issuing a rewind. T3 Code removes only post-checkpoint provider messages from the thread projection and resumes from the restored OMP cursor. Rewind is available from the message action menu as **Revert to this message**.

## Updates and status

Use **Settings → Providers → Refresh provider status** to refresh OMP version, authentication, model, and command metadata. T3 Code reports these states separately:

- **Available**: the executable and required probes succeeded;
- **Not found**: the executable is missing or not on `PATH`;
- **Unavailable**: the executable was found but its version or RPC probes failed;
- **Disabled**: the provider instance is disabled.

When an update is available, the provider details identify the package-manager path. T3 Code does not perform a native in-app OMP update because the supported maintenance paths are npm and Homebrew.

## Troubleshooting

### OMP is not listed

Restart the T3 Code server after installing OMP, then refresh provider status. Confirm that the OMP instance is enabled and that its binary path is either blank with `omp` on `PATH` or an existing absolute path.

### OMP is too old

Upgrade through npm or Homebrew, then refresh provider status. The minimum supported version is 17.0.9.

### Models or commands are missing

1. Confirm the provider status is **Available**.
2. Refresh provider status.
3. Check the selected OMP profile and its environment variables.
4. Inspect the server provider log for the isolated RPC probe failure.
5. Avoid putting interactive-only flags in **Launch arguments** if they prevent `rpc-ui` startup.

### A turn stops unexpectedly

Check the provider log for the OMP exit code. Exit code 0 is treated as graceful stdin-EOF shutdown; any other exit while a turn is active is reported as a provider error. Stop and start the thread again after correcting the executable, profile, or launch arguments.

### Mobile does not show OMP settings

This is intentional. OMP configuration is a server/desktop concern in this effort. Mobile uses the existing provider-neutral session and thread surfaces and does not add a mobile-only OMP settings card.
