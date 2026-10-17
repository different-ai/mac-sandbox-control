# Desktop relay performance investigation — 2026-10-16

## Deployment status

**Prepare only; no interruption authorized.** The running relay and both active guest VMs were left unchanged. Results for the revised relay below must not be represented as a deployed improvement or a real-Mac acceptance pass.

The earlier 45.46-minute reliability acceptance applies to the earlier private deployment. It does not validate the performance revision.

## Measured live baseline

A password-authenticated, read-only RFB viewer connected to the human relay over Tailscale. The password was passed in memory, not logged or saved. The viewer advertised zlib, raw and DesktopSize support; the old relay returned raw encoding only.

| Measurement | Existing deployment |
| --- | ---: |
| Framebuffer | 1920 × 1080 |
| Initial update bytes | 8,294,416 |
| Incremental samples | 8 |
| Incremental bytes total | 66,355,328 |
| Mean response time on the static desktop | 10,566.68 ms |
| p95 response time on the static desktop | 13,984.14 ms |
| Mean pixels per incremental reply | 2,073,600 (entire screen) |

These timings combine the existing no-change wait, transfer and client processing. They are not an input-to-photon measurement or a general Tailscale latency measurement.

The original implementation waited for frames in the same thread that read keyboard/pointer messages. A pending screen request could therefore delay input even when the network was otherwise fast. It also requested upstream full frames at approximately a one-second interval and sent downstream full raw rectangles.

## Repeatable synthetic baseline

A loopback stub supplies a generated 1920×1080 image, with one 400×40 rectangle changing at 15 Hz. No VM, real screenshot, guest credentials or Apple Virtualization connection is involved. The stub animation is independent of upstream polling, so this benchmark cannot prove an upstream frame rate improvement.

| Measurement | Old relay (local loopback) | Revised relay (local loopback) |
| --- | ---: | ---: |
| Samples | 15 | 15 |
| Initial update bytes | 8,294,416 | 43,874 |
| Incremental bytes total | 124,416,240 | 5,368 |
| Mean update response | 71.26 ms | 70.42 ms |
| p95 update response | 73.10 ms | 74.26 ms |
| Mean pixels per reply | 2,073,600 | 16,000 |
| Encoding | Raw (0) | Negotiated zlib (6) |

This is a bandwidth and changed-region comparison, **not a latency speedup result**: both stubs receive the same 15 Hz generated frames. Flat-color changes compress particularly well. Full-screen motion, video, arbitrary viewers and real network conditions must be measured separately.

The same revised source was also tested from an isolated preparation directory on the Studio using its existing Python 3.12 environment, without loading or replacing the active relay. All **40 Python tests passed**. The synthetic benchmark returned the same byte and pixel counts, with a 69.99 ms mean and 73.20 ms p95 response. These were loopback stub-server tests on that machine, not guest-VNC performance tests.

JavaScript regression tests: **111 passed**. Publication hygiene and whitespace checks passed. Python dependency deprecation warnings remain.

## Required acceptance before a live claim

- Unit tests for compression stream continuity, raw fallback, pixel formats, partial requests, desktop resize, static updates, and input while a screen update is outstanding.
- Same synthetic fixture and sample count, with pixel correctness checked separately; disclose that small flat-color changes compress unusually well.
- Python 3.12 runtime tests without touching the running service.
- A coordinated maintenance window before replacing the persistent owner, never an automatic disconnect/reconnect into a live VM process.
- Actual macOS Screen Sharing negotiation, scrolling/typing/dragging, latency and bandwidth checks, followed by a new lifecycle/reconnect soak.

This work does not add H.264/audio streaming, a web desktop viewer, Cua workspace ownership/sharing, fleet orchestration, or snapshots.
