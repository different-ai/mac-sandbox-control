# REST and CLI reference

## Client CLI (no host SSH required)

Install from a checkout on the client with Node.js 24+:

```sh
pnpm client:install
export PATH="$HOME/.local/bin:$PATH"
export MAC_SANDBOX_URL=https://mac-host.example-tailnet.ts.net/mcp
export MAC_SANDBOX_TOKEN_FILE="$HOME/.config/mac-sandbox-control/token"
```

Provision the private token file through a trusted secret-sharing workflow and make it owner-readable only (`0600`). The URL is a placeholder: use your actual encrypted endpoint.

```sh
mac-sandbox ls                 # all managed VMs, table
mac-sandbox ps                 # active/transitioning; unknown remains visible
mac-sandbox ps -a              # all states
mac-sandbox status space-1     # one VM, with a state explanation
mac-sandbox ls --json          # structured records
mac-sandbox list               # legacy JSON output
mac-sandbox exec space-1 -- sw_vers
mac-sandbox exec space-1 -- ls -la /Users/spaceuser
mac-sandbox exec space-1 -- 'cd /tmp && pwd && whoami'
mac-sandbox exec space-1 --timeout 300 --json -- 'your-test-command'
```

One argument after `--` is an explicit shell expression. Multiple arguments are individually shell-quoted, so spaces/metacharacters inside each argument remain literal. Commands run in the guest, never in a host shell. No interactive TTY is allocated.

`exec` preserves guest stdout, stderr, and exit code. `--json` prints `{exitCode, stdout, stderr, timedOut}` and still preserves the exit status. A timeout exits with `124`; transport/usage errors use `1`. Default timeout is 120 seconds, maximum 600. Output is buffered, not streamed, and capped by the controller. A timed-out remote process may still be running: inspect before retry.

The client uses `MAC_SANDBOX_TOKEN` or `MAC_SANDBOX_TOKEN_FILE`; the default file is `~/.config/mac-sandbox-control/token`. It does not read another application's private config. `MAC_SANDBOX_URL` overrides the default localhost MCP endpoint.

## Host CLI

The installed `sandbox` command talks to the private controller API:

```sh
sandbox ls
sandbox ps -a
sandbox create space-1
sandbox status                         # host, sandboxes and recent jobs
sandbox status space-1
sandbox status JOB_ID
sandbox start space-1
sandbox stop space-1
sandbox kill space-1
sandbox delete space-1 --confirm space-1
sandbox exec space-1 -- sw_vers
```

Lifecycle operations enqueue jobs and return immediately. A returned job is not confirmation of startup, shutdown, or deletion. Inspect it before proceeding. The template is protected and cannot be addressed through managed `space-*` actions.

`stop` is graceful; `kill` powers off immediately and can lose unsaved work. Both retain the disk. `delete` requires an exact confirmation and a stopped VM. It removes managed credentials too. Do not delete a colleague's working VM without authorization.

## State vocabulary

| Field | Meaning |
| --- | --- |
| `state` | Explicit running/stopped/starting/stopping/provisioning/unknown state |
| `active` | Consuming or reserving an active slot; `null` if unverified |
| `running` | Inventory reports the hypervisor running; `null` if unverified |
| `ready` | Credential setup completed; **not** a running indication |
| `canExec` | Running, provisioned, and not still starting; eligibility, not an extra SSH probe |
| `observedAt` | Last inventory verification timestamp |
| `note` | Explanation, including the action needed for stopped/unready VMs |

Unknown entries remain visible in `ps` because they could still be active. Do not convert an inventory failure to “zero running.”

## REST routes

Default base: `http://127.0.0.1:8787`. Host and Origin checks are intentional; this is not the public network interface.

| Method / route | Result |
| --- | --- |
| `GET /api/state` | Inventory, host capacity, managed VMs, recent jobs, per-process CSRF token |
| `GET /api/sandboxes` | Managed VMs and policy |
| `GET /api/sandboxes/:name` | One managed VM and its recent jobs |
| `GET /api/jobs/:id` | One job in recent history |
| `POST /api/sandboxes` | `{name}`; enqueues creation |
| `POST /api/sandboxes/:name/actions` | `{action}`; start/stop/kill/delete |
| `POST /api/sandboxes/:name/exec` | `{command, timeoutSeconds}`; guest output and exit status |
| `POST /api/sandboxes/:name/desktop-password` | `{}`; sensitive `{name, port, password}` for a provisioned, verified-running VM with a ready relay console |

Mutation requests require `Content-Type: application/json` and `X-CSRF-Token` from a current `/api/state` response. Delete additionally needs `confirmation` equal to the exact sandbox name. The loopback API is trusted-local-process access, **not** per-user authentication.

A lifecycle response is HTTP 202 with `{job}`. Jobs are queued/running/succeeded/failed. Failed or interrupted actions are never automatically repeated. An unresolved startup reservation requires inspection or an explicit kill to settle it; it is not silently forgotten after a service restart.

Job read endpoints currently cover the most recent 100 jobs. This is not a complete historical pagination API.

Names must match `space-[a-z0-9][a-z0-9-]{0,30}`. `exec` commands are limited to 16,384 characters and the API body limit still applies. Guest passwords/private keys are not returned by ordinary state routes. The authorized MCP `get_login` tool is intentionally sensitive. The dashboard's explicit POST-only `desktop-password` route is also sensitive: it requires CSRF protection, returns only the human relay password (not the native upstream or macOS account password), sets `Cache-Control: no-store`, and never creates missing credentials. Any remote dashboard gateway must authorize the person before forwarding this route; tailnet reachability alone is not per-user authorization.

## Interactive access

`sandbox-connect space-1` runs a host-side interactive SSH client using that VM's private key and pinned host key. This requires host access; colleagues using only MCP should use `run_command` or the approved desktop path instead of sharing an administrator SSH login.

`sandbox-desktop url space-1` returns an optional desktop address. Its `password` mode deliberately refuses a terminal and is intended only for controlled pipes. It does not make VNC safe to expose on an untrusted network.
