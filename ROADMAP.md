# Roadmap

**Progress and checklists: [tracking issue #14](https://github.com/different-ai/mac-sandbox-control/issues/14).**

These are planned items, not implemented features. Each issue has acceptance criteria and dependencies. This roadmap does not enable automatic cleanup, change a VM, or commit to a delivery date.

## Existing baseline

- Single-host lifecycle and conservative persisted jobs.
- API, MCP, dashboard, and CLI adapters.
- Buffered guest command execution with exit codes.
- Explicit `ls` / `ps` state, including unknown states.
- A stopped starter template and per-clone credentials.
- Optional remote desktop with documented limitations.

The next steps should improve reliability and reuse existing infrastructure before growing a custom fleet platform.

## P0 — foundations and a backend decision

| Issue | Outcome |
| --- | --- |
| [#1 Evaluate Cua and Orchard](https://github.com/different-ai/mac-sandbox-control/issues/1) | Compare existing SDKs/controllers, licensing, macOS 27 compatibility, host-access permissions, and a two-Mac proof before choosing what to build. |
| [#2 Lifecycle and deletion reliability](https://github.com/different-ai/mac-sandbox-control/issues/2) | Idempotent requests, observed/desired state, crash recovery, and verified cleanup of partial creations/deletions. |
| [#3 Versioned starter images and cold snapshots](https://github.com/different-ai/mac-sandbox-control/issues/3) | Immutable image catalog, selected starter versions, cold captures, promotion, rollback, and base dependency tracking. |
| [#4 Clean reset/rebuild](https://github.com/different-ai/mac-sandbox-control/issues/4) | One tracked, explicitly destructive reset to a chosen starter, with fresh credentials and defined failure/persistence behavior. |
| [#5 Ownership and exclusive reservations](https://github.com/different-ai/mac-sandbox-control/issues/5) | Server-enforced scoped permissions, claim/renew/release, administrator override, and session/credential revocation. |
| [#6 Network and credential boundaries](https://github.com/different-ai/mac-sandbox-control/issues/6) | Encrypted access, actual listener restrictions, and validated host-enforced guest network policy before broader trust. |

### Two different kinds of “refresh”

1. **Reset a workspace:** discard its disposable OS state and recreate it from a selected starter, preserving only explicitly retained data.
2. **Refresh the starter image:** build/test a new immutable base version and promote it for future VMs without silently changing existing workspaces.

A single starter template works today; neither workflow is a complete versioned image/reset product yet.

## P1 — fleet and developer workflows

| Issue | Outcome |
| --- | --- |
| [#7 Coordinator and per-Mac workers](https://github.com/different-ai/mac-sandbox-control/issues/7) | One endpoint, authenticated enrollment, capacity/health heartbeats, placement, durable leases/fencing, node drain, and connection routing. |
| [#8 Image distribution and caching](https://github.com/different-ai/mac-sandbox-control/issues/8) | Verified private artifacts, compatibility checks, resumable transfer, prefetch, cache GC, and safe promotion across hosts. |
| [#9 Warm pools](https://github.com/different-ai/mac-sandbox-control/issues/9) | Atomically claim clean VMs; discard dirty instances and replenish verified replacements in the background. |
| [#10 Optional expiry and keepalive](https://github.com/different-ai/mac-sandbox-control/issues/10) | Explicit TTL/idle policies, deadlines, persistent-workspace opt-outs, and activity semantics that do not unexpectedly reap builds. |
| [#11 Execution, sessions, files, and persistence](https://github.com/different-ai/mac-sandbox-control/issues/11) | Streaming/background commands, cancellation, PTY, file transfer, artifact export, and scoped persistent workspace data. |
| [#12 Operational and real-Mac evidence](https://github.com/different-ai/mac-sandbox-control/issues/12) | Distinct host/guest/desktop health, crash diagnosis, redacted metrics, backups, clean-install testing, and staged upgrades. |

The working limit remains **two active macOS guests per Mac with this stack**. Warm guests and template builders consume slots too. Scaling means adding compatible Apple hardware and coordinating it—not removing the limit from one Studio.

## P2 — runtime feasibility, not promises

| Issue | Outcome |
| --- | --- |
| [#13 Hot snapshots, pause/resume, forks, and migration](https://github.com/different-ai/mac-sandbox-control/issues/13) | Establish exact runtime/OS/hardware support with a disposable proof, or explicitly document unsupported capabilities. |

Cold disk snapshots are not running-memory snapshots. An OCI registry does not make different hypervisor image formats interchangeable. Cross-host restore must preserve and validate the required base and compatibility metadata.

## Suggested sequence

1. Evaluate reuse and establish lifecycle, access, and network foundations.
2. Add immutable starter versions and a safe reset workflow.
3. Validate a coordinator/worker design on two physical Macs.
4. Add image distribution, warm capacity, and opt-in lifecycle policies.
5. Extend developer tools and investigate advanced snapshots only with evidence.

An existing backend may replace substantial custom work if issue #1 supports that decision. See [SECURITY.md](SECURITY.md) and [the real-Mac verification checklist](docs/verification.md) for boundaries that additional features do not automatically solve.
