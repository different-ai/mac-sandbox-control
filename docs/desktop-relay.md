# Optional persistent desktop relay

Desktop access remains **off by default**. A private deployment of the relay mitigation passed a [45.46-minute, two-VM acceptance run](../reports/reliability-2026-10-16.md). That is bounded evidence, not an uptime guarantee or verification of a clean installation of this public reference implementation. Unit tests use fake processes, local RFB sockets and generated images, not Apple Virtualization.

## Why a relay

On macOS 27 with Lume 0.6.1, Apple's private VNC server has asserted after the last graphical client disconnected and a client reconnected. The relay admits **one persistent vncdotool upstream connection per Lume process generation**. Human clients talk standard RFB to the relay; their encoding lists never reach Apple's implementation. The client shim retains resized request dimensions, valid empty-update handling and one outstanding asynchronous framebuffer request, so a static desktop is not mistaken for a dead connection.

- Public relay ports: **5901–5949**, with the human password in `credentials/NAME.vnc`.
- Native upstream ports: **15901–15949** (public port + 10000), with a different password in `credentials/NAME.vnc-upstream`.
- Never connect a viewer or screenshot tool directly to the upstream. Neither password belongs in a URL.
- Both services may bind all host interfaces. **Firewall the native ports from all remote clients**, and restrict relay ports to approved trusted clients. Neither an advertised hostname nor an SSH tunnel closes a direct listener. No verified firewall policy is installed here.
- Legacy VNC authentication is eight characters and does not encrypt the session. Use approved network restrictions and encrypted tunnels; this is not hostile-user isolation.

## Operator setup (optional)

Use a separately installed Python **3.12**. `host:install` never downloads Python or installs Python packages:

```sh
python3.12 -m venv ~/.local/share/mac-sandbox-control/desktop-venv
~/.local/share/mac-sandbox-control/desktop-venv/bin/python -m pip install -r requirements-desktop.txt
```

The reference dependency pins are vncdotool 1.4.2, cryptography 50.0.2, Pillow 13.0.0 and Twisted 26.4.0. The TripleDES compatibility alias intentionally uses cryptography's legacy/decrepit implementation for vncdotool's VNC authentication. This does not make VNC modern cryptography.

After restricting the listeners, set `SANDBOX_DESKTOP_ENABLED=1` in `~/.config/mac-sandbox-control/host.env`. Optionally set an absolute `SANDBOX_DESKTOP_PYTHON`; otherwise the venv path above is used. Run `pnpm host:install` to install the optional relay LaunchAgent, then `pnpm host:start`. Existing loaded services are not restarted. Drain before changing a running service's configuration. Review private logs and verify health, rather than treating LaunchAgent loading as readiness.

`desktop-relay.mjs` uses the normal host.env/config loader and configured Node launcher, then passes `SANDBOX_STATE_ROOT`, `SANDBOX_STATE_DIR`, `SANDBOX_VM_STORAGE` and `SANDBOX_API` to Python. The optional private `vnc-relay-policy.json` defaults to prefix `space-`; no policy file is required.

## Performance revision (requires deployment and real-Mac revalidation)

The old relay returned full raw screen rectangles and could block input while waiting up to ten seconds for an incremental update. The revised path separates viewer input from frame transmission, tracks per-viewer changed regions, and uses standard RFB zlib encoding only when that viewer advertises support. Other viewers retain raw encoding with incremental regions. Pixel-format changes, partial-region requests and desktop resizing must preserve the viewer's exact framebuffer.

After the first full upstream frame, the persistent graphical connection requests incremental updates with one outstanding request at a time. `SANDBOX_DESKTOP_FPS` sets a target cap (default 15; supported range 1–30), not a promised frame rate. No-change requests can complete with an empty update; no new pixels are invented to imply liveness. There is no H.264/audio streaming or integrated web viewer in this revision.

To run a repeatable **synthetic** bandwidth benchmark, without contacting a VM:

```sh
~/.local/share/mac-sandbox-control/desktop-venv/bin/python scripts/benchmark-desktop.py --source ./vnc_relay.py --samples 30
```

The fixture changes a small rectangle in a generated 1920×1080 image. Its compression ratio is not representative of full-screen video, scrolling, or network latency. The same script can measure an operator-approved live relay using `--host HOST` and `{port, password}` supplied privately on stdin; never put the password in command arguments or logs, and never benchmark the native upstream ports.

**Do not hot-restart the relay to apply these changes while VMs are in use.** Coordinate a maintenance window, save guest work, gracefully stop desktop-enabled guests, update and test the relay, then restart guests and validate real Screen Sharing performance, input, reconnects and lifecycle stability. The recorded 45.46-minute soak predates this performance revision. Preparation and synthetic benchmarks do not make the currently running service faster.

## Readiness and failures

A start job succeeds only after runtime verification, **pinned key-based guest SSH** and (when enabled) initialized, connected console health. Runtime and guest/console readiness share a 120-second deadline after the detached run command returns. Missing Python, packages, relay or an upstream fault cannot silently fall back to direct VNC or report success. A partial boot retains its reservation; inspect it before using explicit kill to settle it.

`desktopState` is independent of VM process state. Console failure quarantines only the console; it does **not** kill or automatically restart guest compute or delete data. MCP `connection_info` refuses an unready console; `get_login` withholds the desktop URL/password while unready, and reports console state separately from macOS login credentials.

Health requires a heartbeat younger than five seconds, initialized frames, ready+connected, and a generation matching the owner's PID plus bigint `lstat` mtime in nanoseconds. `lastFrameAt` need not be fresh: unchanged desktops are valid. Only safe health fields cross the API; relay error traces/passwords do not.

Process inspection is tri-state: missing/unreadable metadata, permission errors and `ps` timeouts never drop a live upstream anchor. Cleanup needs explicit exit/zombie/unrelated-PID proof (or an upstream session that has already closed). A closed old session does not block a verified new generation merely because its PID was reused.

A nonblocking OS-level owner lock permits only one relay coordinator for a state root. Viewer resizing is handled independently of the upstream: capable viewers receive a DesktopSize update; unsupported viewers reconnect to the relay rather than the native upstream. These public-source hardening changes are unit-tested but were added after the recorded private-deployment soak.

The private ledger records a generation **before** its first connection. An upstream loss or relay owner crash intentionally forbids reconnection to that same generation. **Do not delete the ledger to force a retry. Do not stop/update the host services while any desktop-enabled VM is alive: drain and stop the VMs first.** `host:stop` unloads a previously loaded relay even if desktop has since been disabled in host.env; it does not stop VMs for you. If the owner crashes, recover through a deliberate VM stop/start after preserving guest work, not by reconnecting to the existing VZ process.

## Local tests

```sh
pnpm test
pnpm check:public
PYTHONDONTWRITEBYTECODE=1 ~/.local/share/mac-sandbox-control/desktop-venv/bin/python -m unittest -v test_vnc_relay
```

Python tests use generated Pillow images and a loopback stub RFB server only. CI is not real-Mac proof. Do not publish local health ledgers, logs, captures, credentials or deployment configuration; sanitized pilot results must be reviewed separately.
