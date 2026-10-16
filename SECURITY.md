# Security model and limitations

## Intended use

A small group of **mutually trusted developers** operating macOS VMs on a dedicated Mac they control. This is a reference implementation, not an audited service and not a substitute for a hardened sandbox platform.

Do not use it for hostile code execution, anonymous users, customer tenancy, or workloads that must not reach the operator's network.

## Boundaries

| Surface | Actual boundary |
| --- | --- |
| Controller API / dashboard | Loopback interface, trusted host account, browser Host/Origin/CSRF checks |
| MCP HTTP | Per-person bearer tokens; all valid tokens have the same privileges |
| MCP over SSH stdio | The host's SSH account permissions |
| Guest command execution | Pinned SSH host key and per-VM client key; commands run in the guest |
| Desktop | Optional legacy VNC authentication; not a robust network boundary |
| VM networking | Apple's NAT; **not** an internet-only firewall |

The loopback API is not authenticated against other local processes. CSRF checks protect browser-origin requests, not a malicious process on the host. Anyone controlling the host account can invoke Lume directly and read guest disks, private state, credentials, and keys.

Every MCP token can execute commands with guest administrator rights, retrieve logins, and request deletion of **all** managed VMs. Distinct tokens provide audit attribution and revocation—not per-VM authorization. No ownership, reservations, or exclusive locks are implemented.

## Network deployment

Keep `SANDBOX_MCP_BIND=127.0.0.1` and put an SSH tunnel or authenticated HTTPS overlay in front of it. Tailscale Serve is one option; do not confuse it with public Tailscale Funnel.

Do not send bearer tokens, command outputs, or guest passwords over plaintext HTTP on an untrusted LAN. HTTP inside an encrypted, access-controlled overlay is different from HTTP exposed on ordinary Wi-Fi, but access controls still matter.

**No guest-to-host, guest-to-LAN, VPN, IPv6, or peer isolation is implemented.** NAT only translates addresses. A guest administrator can remove a guest firewall, so such a firewall does not solve hostile-guest containment. Host-level networking changes need careful validation, recovery access, anti-spoofing considerations, and restart tests. This repo deliberately does not ship an unverified PF ruleset.

Never forward MCP or VNC ports from a home router to the public internet.

## Remote desktop

Desktop is opt-in (`SANDBOX_DESKTOP_ENABLED=1`). Lume's viewer is independent of permissions inside the guest and can show the boot/login screen. Its private Apple VNC implementation may listen on **all host interfaces** and uses a legacy password limited to eight characters. Do not assume display traffic is encrypted.

An SSH tunnel encrypts the tunnel; it does **not** close Lume's direct listener. Before enabling desktop, restrict access using an appropriate host firewall or dedicated trusted network. This repo does not install those restrictions for you.

The `--vnc-password` value currently has to be supplied to Lume in process arguments, where another sufficiently privileged local process may see it. Failure diagnostics redact that flag but cannot remove OS-level argv exposure. Credentials are not inserted into URLs.

Lume's upstream unattended installer can briefly enable its own VNC during template setup. Disabling normal desktop startup in this repo does not alter that upstream implementation. Bootstrap only on a trusted, isolated setup network.

Minimal/custom VNC clients requesting some frame encodings were observed terminating the Lume process during the prototype. A successful TCP banner or password handshake is not proof of a usable desktop. `vncdotool` captured a full frame successfully; client compatibility and the current Lume/macOS build must be tested.

## Credentials and automatic login

Runtime state lives outside Git, normally under `~/.local/state/mac-sandboxes`:

- controller database and logs;
- the template password and bootstrap key;
- per-VM private SSH keys and pinned host keys;
- **plaintext** guest account/VNC passwords in owner-only files;
- hashed MCP tokens and audit metadata.

File modes (`0700` directories, `0600` secret files) are not encryption. Protect host backups and storage; consider host FileVault and your reboot/unlock requirements. Never commit, publish, or attach this directory to an issue.

The template factory creates a normal account with Apple tools instead of trusting Lume's handcrafted offline record. It disables and removes administrative/SSH rights from the old bootstrap account. That account may remain as the APFS volume owner; do not claim it was deleted or that this factory provides a production-grade cryptographic ownership migration.

Guests are automatically logged in and receive passwordless sudo for agent-driven installation. The auto-login credential file is reversibly encoded, not securely encrypted. These are deliberate development convenience choices. Do not enable them for a VM requiring a locked human session or independent protection from its host administrator.

`get_login` deliberately returns sensitive credentials to authorized callers. Clients may retain tool results in chat history. Prefer giving a human connection instructions without displaying a password unless needed. Rotate credentials and revoke tokens after accidental disclosure; deleting a chat message is not revocation.

## Operations and diagnostics

- Lifecycle jobs are serialized and persisted; interrupted active jobs are not blindly replayed.
- A timeout or broken SSH connection does not prove a guest command stopped. Inspect before retrying side-effecting work.
- Free-space checks are not physical reservations or quotas for sparse disks.
- Two running macOS guests is a host/framework constraint in this implementation, not a scaling strategy.
- There is no guest auto-restart, TTL cleanup, HA, or resource scheduler across hosts.
- Private Apple APIs, macOS account APIs, and login preferences may change between releases.

Audit logs must not contain complete commands, arbitrary arguments, passwords, or tokens. Any diagnostic excerpt still needs manual review before being shared. Tests asserting redaction are not a blanket guarantee that an operator cannot log a secret elsewhere.

## Reporting

Do not file a public issue containing credentials, logs, VM disks, customer data, or internal network details. Use GitHub's private vulnerability reporting if enabled, or contact repository maintainers privately before disclosing security-sensitive details.

## Supported verification

The unit tests use injected fake VM processes and cannot prove real isolation, desktop functionality, cryptographic account state, or compatibility on another Mac. Follow [the real-Mac checklist](docs/verification.md) before allowing anyone else access.
