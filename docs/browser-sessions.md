# Operator-controlled browser sessions (v1)

This is a narrow, opt-in **Chrome cookies + localStorage** transfer, not a VM,
Chrome profile, password-manager, or Keychain migration. It is a host-local CLI;
there are intentionally no session-vault MCP tools. Existing VM-admin tokens do
not provide per-session ownership boundaries.

## Prerequisites and consent

- Node 24 on the host and in each guest. Install the guest runtime at
  `$HOME/.local/share/browser-session-runtime/bin/node` for its provisioned account.
- A managed, securely provisioned `space-*` VM must be running with no queued or
  running lifecycle job. The CLI checks the existing loopback controller API,
  then uses its provisioned account, private SSH identity, and pinned known-hosts
  file directly. It never opens the controller database.
- In **each** guest, run Chrome with a dedicated **non-default** user-data directory
  and remote debugging on **127.0.0.1:9222 only**, e.g. Chrome's
  `--user-data-dir="$HOME/.local/share/browser-session-profile"`,
  `--remote-debugging-address=127.0.0.1`, and `--remote-debugging-port=9222` flags.
  Do not enable debugging on a personal/default browser profile. Use the actual
  Chrome binary with these flags, not an already-running default-profile window.
  Chrome's debugging API controls the entire selected browser profile.
- The operator must independently verify this dedicated profile and loopback
  binding. This v1 does not attest Chrome's launch flags/profile path. Guest CDP
  discovery is restricted to 127.0.0.1, and its browser WebSocket must match the
  same host and port. Do not forward/expose that port.
- All selected origins must be HTTPS, with certificates trusted by guest Chrome.
  There is **no** insecure TLS or HTTP localhost exception. Supply exact
  `https://host[:port]` origins, optionally ending in `/`; paths, credentials,
  queries, fragments, and duplicate origins are rejected.

`--ack-sensitive` is required on **every capture, restore, and inspect**. It means
that you authorize handling bearer session material for the listed origins,
have verified the dedicated profile, understand that cookies are **not port
isolated**, and consent to navigating these origins in temporary browser tabs.
Only use accounts/sites you are authorized to transfer.

## Login once on A, restore on fresh B

Run commands on the controller host, from this repository. For a trusted HTTPS
fixture at `192.168.64.1:8791`:

```sh
# Log in normally through the dedicated Chrome profile on VM A first.
node session-vault.mjs capture --sandbox space-openwork \
  --origin https://192.168.64.1:8791 --ack-sensitive --ttl-seconds 3600
# stdout: one JSON metadata object containing snapshotId, origins, createdAt, expiresAt.

# Record the opaque snapshotId. Shut down A using the normal VM control flow.
# Start fresh B, install the guest runtime, and launch its dedicated Chrome profile.
node session-vault.mjs restore --snapshot SNAPSHOT_UUID --sandbox space-teleport-b \
  --origin https://192.168.64.1:8791 --ack-sensitive
# stdout: snapshotId, origins, cookieCount, localStorageCount only.

node session-vault.mjs inspect --sandbox space-teleport-b \
  --origin https://192.168.64.1:8791 --ack-sensitive
node session-vault.mjs list
node session-vault.mjs delete --snapshot SNAPSHOT_UUID
```

Replace `SNAPSHOT_UUID` with the exact UUID returned by capture. Multiple
`--origin` flags are allowed (maximum 16). Restore must repeat the snapshot's
**entire exact** origin set; order is irrelevant. No arbitrary snapshot/key paths
are accepted. Unknown flags and commands fail. Capture TTL defaults to one hour;
`--ttl-seconds` accepts 1–86400 seconds. Expired snapshots and expired persistent
cookies cannot be imported. Listing includes authenticated metadata for expired
snapshots so the operator can delete them. Deletion removes the encrypted blob;
it is not guaranteed physical secure erasure on SSDs/backups.

The CLI uses `SANDBOX_STATE_ROOT` (default `~/.local/state/mac-sandboxes`) and
`SANDBOX_API` (default `http://127.0.0.1:8787`). The API override must remain HTTP
on 127.0.0.1 with no credentials/path/query/fragment. List and delete do not need
a VM or API connection. Host-local access is privileged operator access, not an
untrusted multi-user service.

A restore does not itself prove authentication. Open the site in B and verify it
against the application's server. To prove the **same** session was reused, a
controlled fixture should record a server-side opaque session identifier from
A, shut A down, import into a fresh profile in B, and compare it server-side.
Do not print raw cookies/tokens as test evidence. An empty/logged-out capture is
valid and inspect will report zero counts; inspect cannot infer logged-in state.

## Supported data and fail-closed scope

- CDP `Storage.getCookies` reads cookies including HttpOnly. Only exact-host,
  host-only cookies for approved hostnames are accepted. Relevant `.domain` or
  parent-domain cookies cause the **whole capture to fail**, rather than silently
  producing an incomplete session. Cookies for unrelated hosts are ignored.
- Cookies are scoped by hostname/path, not TCP port. Selecting one HTTPS origin
  permits its host-only cookies to affect other ports on that host. This is not
  strict origin isolation. localStorage **is** isolated by full HTTPS origin.
- Name/value, path, secure, HttpOnly, SameSite, priority, and persistent expiration
  are preserved. Session cookies omit expiration when restored. Host-only
  cookies are set with an approved URL, never a domain attribute.
- Partitioned cookies, opaque partition keys, SameParty cookies, and unknown
  cookie attributes fail closed. There is no claim to support CHIPS or arbitrary
  future cookie formats. A relevant unsupported cookie blocks capture/import.
- localStorage is read/written through the temporary target's attached CDP
  session for the requested origin in the actual default browser context.
  Capture and restore open approved pages, wait for committed origin/readiness,
  and close only their own targets in `finally`. Scripts on those pages may run.
- Restore sets the captured cookies/items without clearing unrelated cookies or
  localStorage. It overwrites matching entries; stale destination entries not in
  the capture remain. Prefer a fresh destination profile. Restore is **not an
  atomic browser transaction**: a later error can leave partial changes. Inspect
  the target before retrying; do not assume rollback.

No IndexedDB, sessionStorage, service workers, extensions, saved passwords,
client certificates, device-bound credentials, hardware keys, Keychains, or
profile files are exported. Sites may revoke, rotate, expire, device-bind, or
otherwise reject copied sessions. This cannot bypass MFA or guarantee login
portability. Capturing or opening a page may itself refresh server-side state.

## Encryption and local storage

Encrypted snapshots are private `0600` files at
`ROOT/session-vault/<opaque-UUID>.json`, in a private `0700` directory. A separate
random 32-byte `0600` key is stored at
`ROOT/session-vault-keys/master.key`. Keep this root **outside the repository**;
the CLI refuses roots inside its source directory. Do not commit, publish, or
indiscriminately back up either directory. Restrict the root/credentials/keys
directories to their owner. Symlinks, foreign-owner files, hard-linked sensitive
files, broad private-file permissions, and non-regular files are rejected.
Pinned public known-hosts files may be `0644` but not group/world writable.

Encryption is AES-256-GCM with a fresh random 96-bit nonce per snapshot. Schema,
UUID, creation/expiry timestamps, and the sorted origin allowlist are authenticated
additional data. Tampering, truncation, bad tags, wrong origins, missing/invalid
keys, and expiry fail closed. The metadata itself is visible in the encrypted
file; account identifiers are not added to it. Payloads are bounded to 8 MiB.
Writes encrypt in memory, fsync the encrypted temporary file, atomically rename
it to the random final snapshot name, and fsync its directory. Initial key
publication is atomic and no-clobber. A missing key is not regenerated while
snapshot files remain.

The host key is **not Keychain-backed, OS-bound, or hardware-bound**. Encryption
protects a copied blob when the key is not also copied. It does **not** protect
against compromise of the host/account, an administrator, a malicious debugging
client, process memory inspection, or backups that contain both key and blobs.

Plaintext capture/restore JSON stays in process memory and SSH stdin/stdout
pipes; it is never written as an intermediate disk file, passed in argv, or
placed in environment variables. The helper source code (not the request) is
passed as a constant SSH command. SSH is batch/key-only with a pinned host key;
config/agent forwarding are disabled. CLI stdout is allowlisted metadata/counts,
and errors are generic: no raw provider errors, stdout/stderr, tokens, or traces.
Node/JavaScript cannot guarantee erasure of immutable strings or every memory
copy, even though encryption key/plaintext buffers are cleared when possible.

## Test boundary

`node --test session-vault.test.mjs` exercises encryption, TTL, authenticated
scope, corruption, permissions/symlinks, strict consent/arguments, fake CDP
capture/restore, unsupported cookies, target cleanup, logged-out inspection,
loopback discovery validation, and injected SSH transport without contacting any
real host. Real Chrome/HTTPS-fixture integration and VM A/B lifecycle proof are
separate operator-run tests, not a capability asserted by these unit tests.
