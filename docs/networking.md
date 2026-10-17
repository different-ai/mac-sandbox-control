# Networking, Tailscale, and colleagues

## Keep the three addresses distinct

| Address | Who should reach it? |
| --- | --- |
| `http://127.0.0.1:8787` | Controller/dashboard on the host; trusted SSH tunnel for remote viewing |
| `http://127.0.0.1:8788/mcp` | Local MCP, or an encrypted reverse proxy/tunnel |
| `vnc://HOST:5901` and later assigned ports | Optional desktop clients, only after desktop is explicitly enabled and network access is restricted |

`localhost` always means the computer running the client. Sending another person your `http://localhost:8787` URL does not give them the host dashboard. `.local` names generally work only on the same local network and are not a remote-access solution.

## Recommended: Tailscale Serve in front of loopback MCP

Install and authenticate Tailscale on the host and each client. Keep MCP bound to `127.0.0.1` in `host.env`.

On the host:

```sh
tailscale status
tailscale serve --bg --https=443 http://127.0.0.1:8788
tailscale serve status
```

Serve prints the actual HTTPS hostname. A client uses that hostname with `/mcp`, for example:

```sh
export MAC_SANDBOX_URL=https://mac-host.example-tailnet.ts.net/mcp
export MAC_SANDBOX_TOKEN_FILE="$HOME/.config/mac-sandbox-control/token"
mac-sandbox ls
```

The hostname above is a placeholder, not a working service. Use the address printed for your own device. Review your existing Serve configuration before changing a port/path; do not reset unrelated routes.

Tailscale **Serve** is tailnet access; **Funnel** is public internet exposure. This guide does not enable Funnel. Tailnet ACLs/grants and a valid MCP bearer token are both required. Do not grant broader network access than needed.

If two Macs use different tailnets, installing Tailscale on both is not enough. Join the same tailnet or explicitly share the host and accept the invitation, then check the applicable ACLs/grants. Test actual connectivity before blaming MCP authentication.

Official reference: https://tailscale.com/kb/1242/tailscale-serve

## Alternative: SSH tunnel

From a trusted client with an appropriate host SSH account:

```sh
ssh -N \
  -L 127.0.0.1:8787:127.0.0.1:8787 \
  -L 127.0.0.1:8788:127.0.0.1:8788 \
  operator@mac-host.local
```

Then use `http://localhost:8787` for the dashboard and `http://localhost:8788/mcp` for MCP. A tunnel does not require rebinding those services to the LAN. Do not hand out the host administrator's SSH account merely to give someone MCP access; prefer the token-authenticated encrypted endpoint.

## Direct binding to a Tailscale interface

An operator may set `SANDBOX_MCP_BIND` to the host's actual Tailscale IPv4 address and restart only the MCP service during a maintenance window. Traffic then uses the overlay, but HTTP has no application TLS of its own. Changing interface addresses can prevent the service from starting, so prefer Serve when practical.

Do not use `0.0.0.0` as a convenience default. If explicitly choosing LAN binding, understand that every reachable device can attempt access and plaintext traffic can disclose tokens and guest passwords.

## Add and revoke colleagues

On the host:

```sh
sandbox-mcp-token add operator-two
sandbox-mcp-token list
sandbox-mcp-token revoke operator-two
```

Deliver the generated token through a private password manager or approved secret-sharing channel. Do not put it in a repository, issue, screenshot, or shared shell command history. Revocation affects new MCP requests; it does not undo commands already executed or terminate a previously authorized desktop session.

Each token currently has the same all-VM privileges. Distinct names are attribution, not role-based access control.

## Optional desktops

Desktop sharing is off by default. Follow [optional Python/relay setup and drain rules](desktop-relay.md) before enabling it. Enabling it requires changing host configuration and starting the chosen stopped VM; it must not silently restart an in-use VM. Public ports 5901–5949 belong to the relay; native ports 15901–15949 are private upstream only, with separate passwords.

```text
SANDBOX_DESKTOP_ENABLED=1
SANDBOX_PUBLIC_HOST=mac-host.example-tailnet.ts.net
```

Use `connection_info` for the assigned desktop address and `get_login` only when the user needs the password. A desktop password is different from the macOS account password. Lume's viewer asks for the desktop password only; a lock screen inside it asks for the macOS account credentials.

**Important:** relay and native upstream may listen on every host interface. Advertising a Tailscale hostname does not bind either listener to Tailscale or remove LAN access. Firewall native ports 15901–15949 from remote access and restrict relay ports 5901–5949 to approved clients before enabling desktops. This repository does not install a verified host policy. Never connect human viewers directly to native upstream.

An SSH desktop tunnel can encrypt the connection:

```sh
ssh -N -L 127.0.0.1:25901:127.0.0.1:5901 operator@mac-host.local
# On the client:
open vnc://localhost:25901
```

But the tunnel does **not** close Lume's original direct listener. Protect that separately. Never include a password in the VNC URL.

## What this does not solve

Tailscale protects permitted traffic in transit. It does not restrict a guest from reaching the host's LAN, make shared MCP tokens tenant-scoped, defend guests from the host administrator, or fix a crashing VNC server. Read [SECURITY.md](../SECURITY.md).
