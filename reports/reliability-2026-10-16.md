# Real-Mac reliability acceptance — 2026-10-16

## Result

**Passed the tested acceptance scenario.** The measured window was 2,727.78 seconds (45.46 minutes), following preflight validation. Total runner duration, including preflight and final cleanup, was 3,144.14 seconds (52.40 minutes).

Environment: Apple-silicon Mac Studio, macOS 27.0.1, Lume 0.6.1. Two disposable macOS guests, each configured with 8 vCPUs, 14 GiB RAM, and a 150 GiB virtual disk. A second guest retained the same runtime generation throughout the measured window while the primary guest was stopped, restarted, forcibly stopped, deleted, and recreated.

This validates the private deployment used for this run, not a fresh installation of the public reference implementation. Subsequent public-source changes add an exclusive relay-owner lock, downstream viewer-resize handling, and a performance revision (incremental frames, negotiated compression, independent input handling). Those additions require their own real-Mac acceptance run and are not covered by this result. The performance revision must not be described as deployed or soak-validated based on this report.

## Observed operations

Counts include preflight and final cleanup; they are not all confined to the measured window.

| Operation | Successful count |
| --- | ---: |
| Create from starter | 4 |
| Start existing guest | 12 |
| Graceful stop | 12 |
| Explicit forced stop | 3 |
| Delete, with disk/credential/port cleanup checked | 4 |
| Guest command checks | 118 |
| Desktop captures / viewer connections | 83 |
| Incorrect or superseded desktop password rejection | 3 |
| Runtime/state checks | 125 |
| Viewer-free intervals followed by reconnect during soak | 3 |
| Scratch file write and hash checks | 9 |
| Deliberate hypervisor process exit injection | 1 |

Preflight also verified keyboard input by creating a guest file through a terminal opened over the desktop connection, a viewer-free interval of at least 90 seconds, and recovery of a persistent home-directory fixture after deliberate runtime termination. Dead-runtime detection was observed after 2.213 seconds. New credentials were checked after deletion/recreation; superseded desktop passwords were rejected.

Final read-only inspection found zero active relay sessions, zero recorded relay upstream failures, and eight Lume crash reports—the same count as the baseline. Both guests from the successful run were deleted. The user's original workspaces were left stopped and unchanged. A stopped disposable VM from an earlier failed test was retained for diagnosis.

## Fixes under test

- Persistent single graphical upstream connection, with human viewer connections terminating at a separate RFB relay. Arbitrary viewer encoding negotiation does not reach Apple's private VNC implementation.
- Upstream connection loss quarantines that runtime generation; no automatic reconnect into the same VM process.
- Unknown process inspection does not tear down the persistent console owner.
- Independent process/config ownership checks prevent stale Lume inventory from proving that a runtime is running.
- Startup requires guest SSH and console readiness before releasing the boot reservation.
- Lume informational stdout lines are handled without repeating completed lifecycle mutations.
- Guest desktop resize and unchanged-screen handling are accounted for.

## Earlier failures and limitations

An earlier relay timed out on a refresh after a display change/static screen; that defect was fixed before this acceptance run. Another preflight incorrectly expected a file in `/tmp` to survive reboot. Its failure was not counted as a pass; the corrected acceptance test used a home-directory path and verified recovery.

The runner emitted deferred `AuthenticationError: Incorrect desktop password` warnings associated with its three intentional wrong/old-password checks. The tests verified rejection and continued successful authorized connections. These warnings remain a test-client reporting issue; they are not evidence that arbitrary unexpected authentication failures are safe to ignore. Legacy crypto/dependency warnings also remain.

This is a bounded soak, not a guarantee of indefinite uptime or a service-level objective. It does not establish host-reboot recovery, sleep/wake behavior, arbitrary viewer compatibility, guest/LAN security isolation, cross-host scheduling, backup recovery, or snapshot/custom-workspace-clone reliability. No raw-only live upstream VNC test was performed; protocol-level viewer isolation was unit-tested separately. Local saved disks are not off-host backups.

## Related automated verification

The public reference integration passed 109 JavaScript tests and 14 Python relay tests. The Python relay suite also passed on the deployment's Python 3.12 runtime. This does not substitute for testing a clean installation of the public integration.

Raw reports, screenshots, credentials, identity configuration, and deployment-specific network addresses are intentionally excluded from this report.
