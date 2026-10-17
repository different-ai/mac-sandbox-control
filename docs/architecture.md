# Architecture and operational model

## One control plane

- `server.mjs`: private HTTP API plus static dashboard.
- `controller.mjs`: managed VM records, jobs, capacity checks, command execution, lifecycle serialization.
- `mcp.mjs`: MCP tool definitions and API client; stdio entry point.
- `mcp-http.mjs`: token-authenticated network transport over the same MCP handler.
- `cli.mjs`: host-local API client.
- `sandbox-client.mjs`: client-machine CLI using network MCP, not host SSH.
- `sandbox-status.mjs`: shared state vocabulary and `ls` / `ps` table formatting.

There is no separate fake dashboard state or independent MCP lifecycle implementation.

## VM and job ownership

Only registered `space-*` names are managed. A name collision with an existing Lume VM does not establish ownership. A successful clone establishes the claim; successful provisioning establishes command/login eligibility. The fixed template cannot be deleted through ordinary sandbox tools.

Lifecycle work uses a serialized, durable queue. Startup and provisioning hold reservations before spawning a detached VM. Conservative reservations survive controller restarts so a late-starting VM cannot accidentally become a third running macOS guest.

The controller's exclusive instance lock prevents two local workers from manipulating the same database. A definitely dead PID can be recovered; uncertain ownership is refused. Active jobs interrupted by a controller crash become failed and are not replayed automatically. Pending jobs remain durable.

These controls coordinate operations; they are **not** multi-user access permissions. There is no exclusive colleague reservation or lock.

## Provisioning chain

`scripts/init-template.mjs` prepares a fresh template and bootstrap key. `build-template.mjs` creates a normal macOS account and applies Golden Gate first-login preparation. `provision.mjs` handles clones: identity rotation, account password rotation and independent authentication checks, per-VM keys, SSH host-key regeneration, optional auto-login, and graceful shutdown. The controller then starts the verified guest.

`guest.mjs` centralizes host-side SSH helpers and macOS scripts. `guest-tty.exp` drives hidden native password prompts; passwords are private files/stdin, not shell literals. Lume's VNC launch flag remains an exception to the no-secret-in-argv goal; see SECURITY.md.

## Network surfaces

The API binds loopback and validates Host/Origin/CSRF. This protects a browser workflow, not against a malicious local user process. MCP HTTP adds bearer authentication and bounded request processing, and is loopback by default. Audit records are allowlisted metadata, never arbitrary commands or their arguments.

Lume handles Apple Virtualization and optional native desktop upstream. `desktop-relay.mjs` launches the optional Python persistent-owner/RFB relay; see [its setup, readiness and quarantine contract](desktop-relay.md). `forward.mjs` remains only a passive port-map reader, not a service. VNC is not the same service as Apple's Screen Sharing inside a guest.

## Configuration and data

All runtime modules share `config.mjs`. `host.env` lives outside the checkout and is loaded into installed user commands and LaunchAgents. The defaults are:

```text
State root:      ~/.local/state/mac-sandboxes
Controller DB:  <state>/control/control.sqlite
Lume storage:   ~/.lume
Host API:       127.0.0.1:8787
MCP:            127.0.0.1:8788/mcp
Desktop:        disabled
Advertised host: mac-host.local (example; set your actual permitted address)
```

Do not conflate a host's advertised address with its listener binding. Changing a displayed URL does not restrict a service to that interface.

## Capacity and failure behavior

The controller checks actual host RAM/CPU and storage free space. Defaults remain 8 vCPUs, 14 GiB RAM, and a sparse 150 GiB disk per VM. It leaves at least 6 GiB RAM for the host and caps active macOS guests at two, including other Lume VMs and unresolved managed reservations. It is not a scheduler for other hypervisors and cannot account reliably for VM activity outside Lume.

Sparse-disk size is not reserved storage. There is no disk quota/ongoing low-space scheduler. Long builds can exhaust space after a clone passes the initial free-space check.

VMs can stop through a guest action, host reboot, runtime crash, or VNC server failure without a successful controller `stop` job. The next inventory should report the observed state; an inventory failure is unknown, not proof of shutdown. The project does not automatically reboot a guest, reclaim workspaces, or expire them by a timer.

LaunchAgents run after the host user logs in. They are not a root boot-time service and do not bypass FileVault unlock. The host must be powered, awake, authenticated as required, and network-reachable. Starting a user service does not prove it is healthy or that an OS install succeeded.

## Extending it

- Add new operations to the API/controller, then thin MCP/CLI adapters and tests.
- Avoid a generic host-shell tool; guest shell execution already provides full guest administration.
- If adding reservations, enforce them server-side and consider existing desktop sessions and already-known credentials. A lock icon alone is not exclusive access.
- If adding screenshots, connect only to the public relay with a maintained compatible VNC client and recheck VM survival after capture. Never send human/raw-client reconnects or encoding lists directly to Apple's private VNC upstream. Unit tests are not proof of macOS stability. A private deployment passed a [bounded real-Mac acceptance run](../reports/reliability-2026-10-16.md); that does not verify a clean public installation or indefinite uptime.
- Network containment requires a separately designed privileged backend and verification, not a few untested guest firewall commands.
