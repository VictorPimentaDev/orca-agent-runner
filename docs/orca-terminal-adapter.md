# Running workers in Orca terminals

`OrcaTerminalAdapter` implements the [`TerminalAdapter` contract](orca-adapter.md) with
the `orca terminal` CLI. Each worker gets its own visible Orca tab. Verified against
Orca 1.4.247 on macOS.

```ts
import {configuration, gestor, OrcaTerminalAdapter} from 'orca-agent-runner';

const {config} = await configuration(process.argv.slice(2));
await gestor(config, new OrcaTerminalAdapter({workspace: 'path:/projects/acme'}));
```

The `oar` CLI still uses the local adapter; this one is library-only for now.

`workspace` is the Orca worktree selector that hosts the tab. Set it when running
through `gestor`: the runner creates worktrees with plain `git worktree add`, Orca does
not know about them, and the default `path:<cwd>` fails with `selector_not_found`. The
tab lives in the registered workspace while the worker runs in `request.cwd`. Prefer
`path:`; `active` follows whatever the user focuses.

## How it maps

| Contract | CLI | Notes |
| --- | --- | --- |
| `start` | `terminal create --worktree … --title … --command …` | Types `exec node entrypoint.mjs session.json receipt.json` into the login shell |
| `wait` | `terminal wait --for exit --timeout-ms 30000`, repeated | Exit code comes from the receipt file |
| `isIdle` | `terminal show`, then `terminal wait --for exit --timeout-ms 1` | Also checks the `incarnationId` returned by `create` |
| `close` | `terminal close --terminal <handle>` | After a fresh `isIdle`. Never `--tab` or `--all` |

The entrypoint is generated into a private `mkdtemp` directory. It reads argv, env and
SPEC from a `0600` file, deletes that file, spawns the worker without a shell, copies its
output to both the terminal and `logPath`, and writes the receipt atomically. Nothing but
temporary paths appears on the visible command line. `close` removes the directory.

## CLI behavior this depends on

Observed on 1.4.247; recheck after an Orca upgrade with the smoke test below.

- `terminal wait` returned `exitCode: 0` with `exitCause: host_status_unavailable` for a
  process that exited with 7. That field is never used. A terminal that exits with no
  receipt fails the run.
- `terminal close` returns `ptyKilled: true` and succeeds on any handle, including one
  already closed. It does not protect running work, so the adapter checks first.
- `terminal show` reported `orphaned: true` on a running terminal, so neither that field
  nor `connected` is used to decide idleness.
- A wait that runs out of time answers `ok: false`, code `timeout`, and exits 1. It is the
  only error read as "still running". Anything else, such as `terminal_handle_stale`,
  propagates and the terminal stays open.
- `--worktree path:` needs the exact workspace root. Subdirectories and unregistered
  repositories give `selector_not_found`.

## Ownership

Handles live in memory, and object identity is checked as in the local adapter, so an ID
from elsewhere or a rebuilt handle is refused before any CLI call. The adapter never
calls `terminal list`, never chooses a terminal by title, and never closes in bulk.

## Limits

- macOS and Linux only; `start` refuses Windows.
- Local Orca host only. The receipt is a local file, so `--environment` and SSH-routed
  hosts are not supported.
- Workers get pipes, not a PTY, as with the local adapter. Interactive TUIs will not work;
  use a headless agent mode that reads stdin or `OAR_SPEC_PATH`.
- Workers inherit the terminal's login-shell environment, including Orca's `ORCA_*`
  variables, rather than the runner's environment.
- No timeout, persistence or resume. If Orca restarts mid-run, `wait` fails and the
  terminal is left for you to inspect. A shell startup file that blocks hangs `wait`.
- Closing the tab sends SIGHUP to the worker, and the run fails. A worker that ignores
  SIGHUP can outlive the tab.

## Testing

`test/orca-terminal.test.ts` needs no Orca. `test/fixtures/fake-orca.mjs` mimics the
responses above and runs the typed command through a real `/bin/sh`.

The live smoke is opt-in. It opens tabs in the workspace you name and closes only those:

```bash
OAR_ORCA_SMOKE_WORKSPACE=path:/projects/acme npx vitest run test/orca-terminal.smoke.test.ts
```

It uses `examples/mock-worker.mjs`, which proves the terminal lifecycle and not that a
coding agent can do the work.
