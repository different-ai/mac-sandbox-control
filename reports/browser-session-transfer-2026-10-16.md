# Real-Mac browser-session transfer acceptance — 2026-10-16

## Result

**Passed the controlled Chrome A → encrypted export → A shutdown → fresh B restore scenario.** The destination used the same existing server-side authenticated session without a second successful login or session issuance. This is an independently implemented cookie/localStorage transfer feature, not a test of Cua Teleport itself.

Environment: two macOS VMs on an Apple-silicon Mac Studio, actual GUI Google Chrome from Google's official stable macOS DMG (code signature verified), Node.js 24.22.0. An unrelated colleague's VM continued running during the transfer test. The source VM was stopped gracefully and its disk preserved. The destination was created from the clean starter—not from the source disk or a source snapshot.

## Authentication service and evidence

A dedicated private HTTPS test service ran on the VM host, independent of both VMs' lifecycles. It used a generated test-only username/password, an unpredictable opaque cookie token, and a separate non-secret server session-record identifier. It issued a persistent `Secure; HttpOnly; SameSite=Lax; Path=/` cookie with the `__Host-` prefix. The service did not refresh tokens, perform OAuth, auto-login, or silently issue new sessions on reads.

The same opaque token was accepted by the server from both browsers: its non-secret session record remained identical. Only the test identity was used; no real account, personal Chrome profile, password database, macOS login Keychain or passkey was copied.

| Stage | Authenticated | Cookie count | Saved localStorage marker | Successful logins / sessions issued |
| --- | --- | ---: | --- | --- |
| Source A before login | No | 0 | Test setup marker only | 0 / 0 |
| A after one successful GUI form login | Yes, record R1 | 1 | Present | 1 / 1 |
| Export durably encrypted outside A, then A stopped | Session retained on server | 1 exported | 1 exported item | 1 / 1 |
| Fresh B before import | No | 0 | Absent | 1 / 1 |
| B after import | Yes, same record R1 | 1 | Same value as A | 1 / 1 |
| B after Chrome close/reopen | Yes, same record R1 | Persisted | Persisted | 1 / 1 |

In both authenticated browsers, page JavaScript could not read the HttpOnly cookie through `document.cookie`. The test marker was non-secret and did not authenticate the account; the server cookie did. The destination was demonstrated signed out before restoration, and its real Chrome window was shown signed in afterward. Private screenshot captures are retained outside the repository; raw cookies, vault ciphertext/key, test credentials, session identifiers and deployment addresses are not published here.

## Export/import implementation

- Explicit operator consent and HTTPS origin allowlist; guest-local CDP on loopback, using a dedicated non-default browser profile.
- Host transport uses each managed VM's own pinned SSH key; no shared administrator browser profile or source disk access.
- Capture obtains cookies (including HttpOnly) and approved-origin localStorage from the source Chrome context.
- Authenticated AES-256-GCM envelope is fsynced and atomically published outside the source VM, bound to origins, schema and TTL.
- Restoration uses CDP to write into destination Chrome, not manual copying/decryption of Chrome's disk database or its OS encryption key.
- The host vault's encryption key is an owner-only file in a separate private directory, **not Keychain/hardware-bound protection**. It protects copied export artifacts, not a fully compromised VM host.
- The successful test's encrypted export was deleted after restoration and browser-restart verification. The destination demo and service are temporarily retained for inspection, with a one-hour server-side session expiry. No permanent public endpoint or Funnel was introduced.

## Setup issues that were resolved, not counted as passes

The first form submissions were rejected before any session issuance because the fixture's `Referrer-Policy: no-referrer` caused Chrome to send a null Origin for its form POST. While counters were still zero, only the fixture was restarted with `same-origin` referrer policy; its exact-origin check remained intact. Acceptance starts with the one successful login after that correction. No existing authenticated session was replaced to manufacture the result.

Remote installation of a test certificate into the OS trust store was denied. The dedicated disposable Chrome profile instead used a pin for **only that generated certificate's SPKI**, without a broad `--ignore-certificate-errors` setting. Chrome displayed a test-flag warning. This is a test-only TLS arrangement, not verification of a publicly trusted production certificate or an OS trust-policy change.

A Chrome for Testing archive failed code-signature resource verification and was not executed. The actual test used the official Google Chrome DMG whose installed application passed signature verification.

## Limits and remaining work

This proves one controlled, portable cookie-based session with localStorage. It does not prove portability for Google/Microsoft/banking accounts, device-bound sessions, passkeys, client certificates, MFA, IndexedDB, sessionStorage, service workers, hardware keys, browser extensions, arbitrary signed-in desktop apps, RAM or running processes. Real services may reject or revoke transferred cookies; reauthenticating is not a successful same-session transfer.

The feature is operator-only CLI today, not a self-service dashboard/MCP permission model. Existing all-VM MCP administration is not per-workspace ownership. Restores are additive and nontransactional; use a dedicated fresh profile. Profile selection is operator-attested, not automatically verified. A broader product release needs profile attestation, access policy, revocation/cleanup UX and more actual-service tests with the account owner's explicit consent.

Validation before this acceptance: **126 JavaScript tests passed**, including 15 vault/CDP security and correctness tests, and publication hygiene passed. The desktop performance revision has separate unit/benchmark evidence; this test is not a new 45-minute desktop reliability soak.
