# Verification: what is tested and what is not

## Normal test suite

```sh
pnpm test
pnpm check:public
```

These tests exercise injected/fake Lume commands, temporary SQLite state, state formatting, capacity reservations, credential gates, command construction, API/MCP authentication, audit redaction, token revocation, and CLI exit codes. They must not read a developer's private token, connect to a personal host, install macOS, or stop a VM.

Linux CI proves JavaScript behavior, not Apple Virtualization or a real macOS account.

## Real-Mac smoke checklist

Run this on a **dedicated test host and disposable guests**, not a colleague's active workspace. No step is permission to destroy unrelated VMs.

### Host and factory

- [ ] Record Apple-silicon model, host macOS version, Node version, Lume version, RAM and free space, without identifying private users/networks.
- [ ] Verify host configuration and runtime state are outside the checkout.
- [ ] Confirm ordinary services default to loopback and desktop is disabled.
- [ ] Run the template factory on a trusted bootstrap network; observe any upstream temporary listeners.
- [ ] Independently authenticate the intended account, check administrator access, and verify the incomplete bootstrap account no longer accepts its default credential.
- [ ] Confirm key-only SSH and pinned host-key access survive a reboot.
- [ ] Ensure the final template is stopped before its readiness marker appears.
- [ ] Do not claim a fresh-install path works solely because unit tests passed.

### Lifecycle and command execution

- [ ] Create `space-smoke-1`; wait for its returned job to succeed.
- [ ] Check that it is running, setup-ready, active, and eligible for exec.
- [ ] Run `sw_vers` and `whoami` through MCP and the client CLI; verify they identify the guest, not the host.
- [ ] Verify guest stdout and stderr stay separate, and `exit 7` produces CLI exit status 7.
- [ ] Test a deliberately short read-only timeout and observe `124` / `timedOut`; inspect the guest process before repeating it.
- [ ] Confirm each clone gets distinct VM/MAC identity, guest account password, client key, and SSH host key.
- [ ] Verify the template password no longer authenticates in the clone.
- [ ] Create a second default guest, then verify a third cannot become active.
- [ ] Stop a guest gracefully; observe its job and actual stopped state. Restart and check its files persist.
- [ ] Force kill only a disposable guest; verify that the disk is retained.
- [ ] Confirm delete without the exact name is refused; intentionally delete only the disposable guest and verify managed credentials are removed.

### Restart and failure

- [ ] Restart the controller during a disposable queued/active operation and inspect conservative recovery. Do not assume incomplete work was cancelled or retried.
- [ ] Kill a guest's runtime outside the API; verify inventory reports the actual result rather than trusting an old successful start job.
- [ ] Make inventory unavailable; confirm `UNKNOWN`, `active=null`, `canExec=false`, not a false stopped state.
- [ ] Confirm unrelated Lume VMs count toward capacity but cannot be manipulated as managed sandboxes.

### Team/network access

- [ ] Test from a second computer over the intended encrypted path.
- [ ] No token → 401. Correct token → tool call succeeds. Revoked token → next request rejected.
- [ ] Audit output contains only approved metadata, not commands, arbitrary arguments, passwords, or tokens.
- [ ] Check actual tailnet membership/sharing and ACLs. Two running Tailscale apps alone prove nothing.
- [ ] Verify dashboard/loopback API are not unintentionally published.
- [ ] Do not label the deployment “LAN isolated”: no such policy ships in this repo.

### Optional desktop

- [ ] Explicitly enable desktop, restrict host network access, and start a disposable guest.
- [ ] Confirm the actual listening interfaces—not just the advertised hostname.
- [ ] Authenticate with the **desktop** password; test wrong-password rejection.
- [ ] Retrieve a full frame using a maintained compatible client, and verify the VM remains running afterward.
- [ ] Test the real human viewer too. Banner/authentication success alone is not proof it displays or controls the desktop.
- [ ] Verify auto-login reaches `spaceuser`, not a repeated Setup Assistant pane or root-owned login window.

An optional framebuffer test with `vncdotool` (not bundled):

```sh
python3 -m venv "$HOME/.cache/mac-sandbox-vncenv"
"$HOME/.cache/mac-sandbox-vncenv/bin/python3" -m pip install vncdotool
"$HOME/.cache/mac-sandbox-vncenv/bin/python3" - <<'PY'
import getpass
import os
from pathlib import Path
from vncdotool import api
os.umask(0o077)
out = Path.home() / '.cache/mac-sandbox-control'
out.mkdir(parents=True, exist_ok=True, mode=0o700)
# Use the actual protected/tunneled desktop address. This example assumes an SSH tunnel.
client = api.connect('127.0.0.1::15901', password=getpass.getpass('Desktop password: '), timeout=30)
try:
    client.captureScreen(str(out / 'desktop.png'))
finally:
    client.disconnect()
print('Captured a frame. Independently check the VM is still running.')
PY
```

Never commit that capture: it can contain private files or credentials. Do not substitute the prototype's minimal hand-written VNC clients; some raw-frame requests were observed shutting down the VM.

## Reporting results

Use a redacted summary with versions, exact behavior, pass/fail, and what remains unverified. Do not upload runtime state, private keys, passwords, complete commands containing secrets, or a raw VM image. Keep security-sensitive findings out of public issues until reviewed.
