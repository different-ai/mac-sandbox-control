# Connect an agent over MCP

The HTTP endpoint is `/mcp` on the configured MCP service, normally `127.0.0.1:8788` behind HTTPS/Tailscale Serve. Use a token for each person. This server uses bearer credentials, **not OAuth**.

## OpenCode V2

Use the V2 MCP configuration shape under `mcp.servers`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "mac-sandboxes": {
        "type": "remote",
        "url": "https://mac-host.example-tailnet.ts.net/mcp",
        "oauth": false,
        "headers": {
          "Authorization": "Bearer {env:MAC_SANDBOX_TOKEN}"
        }
      }
    }
  }
}
```

Replace the example hostname with your actual endpoint. Provide the token through the client's approved environment/secret mechanism, not a committed JSON value. A desktop application does not necessarily inherit your terminal's shell profile.

Check with `opencode mcp list` or `/mcps`. The setup instructions here target OpenCode V2; do not copy a legacy top-level `mcp.<server>` example into a native V2 config.

Official reference: https://opencode.ai/v2/docs/mcp-servers

## Claude Code

With a token already loaded privately into the process environment:

```sh
claude mcp add --transport http mac-sandboxes \
  https://mac-host.example-tailnet.ts.net/mcp \
  --header "Authorization: Bearer $MAC_SANDBOX_TOKEN"
```

Be aware that the shell expands this argument: the client may persist the expanded credential, and the header can be briefly visible to local process inspection. Use the client's available secret-management practices. Do not paste a real token into shared instructions or screenshots.

## SSH stdio instead of network HTTP

A trusted host operator can configure a local MCP process using:

```text
ssh -T operator@mac-host.local .local/bin/sandbox-mcp
```

This uses host SSH permissions. Do not give every colleague a host admin shell just to use MCP; encrypted, token-authenticated HTTP is usually the cleaner team interface.

## Everyday agent prompts

- “List my Mac sandboxes and show which are running.”
- “Start space-1, wait for startup, then run sw_vers.”
- “Run the tests in space-1 and report the exit code.”
- “Stop space-2 but keep its files.”
- “Give me space-1's desktop URL.”

For a person who explicitly needs to sign in, call `get_login` and distinguish **desktopPassword** from **macPassword**. The former opens the VNC connection; the latter is the guest account password used inside a lock screen or sudo prompt. Neither is the host administrator password.

## Create a workspace and open Screen Sharing

1. Call `list_sandboxes` before changing anything. Only two guests may run at once; coordinate with other users rather than stopping their workspace.
2. For a new name, call `create_sandbox({name: "space-example"})`. For an existing stopped, provisioned workspace, use `start_sandbox` instead.
3. Observe the returned job using `wait_for_job({job_id: "<returned-id>"})` or `get_job`. Verify `state=running` and `canExec=true` afterward; a queued response is not readiness.
4. If the optional [desktop relay](desktop-relay.md) is enabled, call `connection_info` and `get_login` for the workspace. Check console readiness independently of compute.
5. On your Mac, open Finder → Go → Connect to Server (⌘K) and paste the returned relay URL. Alternatively run `open 'vnc://<reachable-host>:<returned-relay-port>'`. Use an operator-approved tailnet hostname or encrypted tunnel; do not assume a LAN `.local` name resolves remotely.
6. Enter **desktopPassword**, not **macPassword**. The relay uses password-only VNC authentication; no username is needed. Never use the internal native upstream ports 15901–15949.
7. Keep persistent work in the guest's home directory, not `/tmp`. Stop the guest to free a running slot; its disk remains. Starting boots macOS again rather than restoring RAM or live connections. Delete permanently removes the workspace.

Named checkpoints and custom-workspace cloning are not exposed by this service yet. Ordinary stop/start persistence does not require a snapshot, and local VM disks are not off-host backups.

## Tool semantics

`create_sandbox`, `start_sandbox`, `stop_sandbox`, `kill_sandbox`, and `delete_sandbox` return jobs. Use `wait_for_job`, and inspect actual VM state afterward. Do not report a queued request as complete.

`list_sandboxes` accepts `{status: "all"}`, `active`, `running`, or `stopped`. Its `ready` flag describes provisioning, while `active`, `running`, and `canExec` describe current eligibility. Unknown inventory is reported explicitly.

`run_command` is non-interactive, returns stdout/stderr/exit status, and is limited to 600 seconds per call. Guest processes may survive a network failure or timeout. Never repeat a side-effecting command solely because the client lost the reply.

MCP tokens currently have all-VM administrator privileges. There is no token-scoped VM ownership, user quota, lock tool, or credential-sharing approval gate. Client-side model permissions can reduce accidental use but are not a server-side isolation boundary.

## Troubleshooting

- **401:** missing, revoked, unreadable, or invalid token. Creating another OAuth login will not fix a bearer token server.
- **429:** too many invalid-token attempts from the client/proxy address; inspect credentials before retrying.
- **503 busy:** authenticated request concurrency is bounded. Inspect already-dispatched operations; do not blindly replay them.
- **Cannot resolve `.local`:** use the correct tailnet/HTTPS hostname or an SSH tunnel.
- **Connection timeout between Tailscale devices:** check membership/sharing and ACLs, not just whether both apps are installed.
- **Stopped/not ready:** start a provisioned VM or inspect the failed provisioning job. Do not bypass the credential gate.
- **Browser origin rejected:** the MCP endpoint is for native MCP clients. The localhost dashboard calls the private API instead.
