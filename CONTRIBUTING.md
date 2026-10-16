# Contributing

This is a small reference project for trusted macOS development VMs. Keep the API as the source of truth and MCP/CLI adapters thin.

## Local checks

Node.js 24+ and pnpm are sufficient for the ordinary tests; no third-party JavaScript runtime dependencies are needed.

```sh
pnpm test
pnpm check:public
```

Do not run host installers or the template factory merely to execute tests. They change a real Mac and may download a large OS image. Test helpers with injected processes and temporary state. Real VM smoke tests require an explicitly authorized dedicated host; publish only a redacted result.

## Changes that need care

- Preserve stdout/stderr and guest exit codes for `exec`.
- Treat startup requests as jobs, not as already-running VMs.
- Preserve unknown inventory states instead of reporting zero running guests.
- Keep unresolved startup reservations conservative after a crash.
- Do not add a host-shell execution tool.
- Do not log arbitrary MCP arguments, command strings, passwords, authorization headers, or complete private diagnostics.
- Do not make network listeners broader by default or enable desktop sharing silently.
- Never add customer names, colleague contact details, private hostnames/tailnets, tokens, logs, screenshots, disks, or personal configuration to fixtures or examples.
- Use generic documentation hostnames and environment/file references for credentials.

## Scope and evidence

A passing fake-process test is not proof that Apple account management, Lume VNC, or a firewall configuration works. If a change touches those paths, document the tested OS/Lume versions and what was not verified. Do not describe a private Apple API or an unmerged upstream proposal as stable supported behavior.

Network containment, per-user VM authorization, reservations, GUI automation, snapshots, and a production root service are separate designs—not hidden small fixes. Discuss their threat model and failure behavior before adding them.

Do not attach raw runtime state to public issues. See [SECURITY.md](SECURITY.md) for reporting sensitive findings.
