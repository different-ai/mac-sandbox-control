# macOS 27 / Golden Gate: the provisioning lessons

This is the part that makes a raw VM into a reusable agent workspace. It is also the least portable, most experimental part of the project.

## Three different success conditions

1. **The hypervisor boots the VM.**
2. **The guest account works for normal account management**, not just SSH authentication.
3. **A graphical login reaches the desktop**, without repeated Setup Assistant screens.

Passing one does not establish the other two. A successful command exit is not sufficient either: some macOS account tools print a failure but return zero.

## What failed in the prototype

With Lume 0.6.1, an Apple macOS 27.0.1 restore image and `--unattended tahoe`, the offline-created `lume` user could authenticate to SSH and sudo. However, changing its password through `dscl`, `passwd`, or the normal `sysadminctl` current-user operation failed with OpenDirectory error `-14915` (`eParameterError`).

The exact missing account state was not proven. It would be incorrect to claim that a password length, one plist field, or macOS 27 alone was conclusively the cause. The useful observation was that **an account subsequently created with Apple's `sysadminctl` authenticated and rotated passwords correctly in the same guest**.

Do not repair this by inventing `accountPolicyData`, rewriting password hashes, modifying authentication-authority records, changing daemon-version numbers, or disabling SIP. The factory keeps the offline account only long enough to create a proper working account.

## The factory flow

`scripts/init-template.mjs` orchestrates these steps on the host:

1. Refuse an existing `macos-template` name; never replace someone's VM automatically.
2. Ask Lume to install a compatible Apple restore image and perform its temporary unattended bootstrap.
3. Start it with normal desktop sharing disabled.
4. Generate a private bootstrap SSH key and pin the new guest's host key on the already trusted host.
5. Use the documented temporary bootstrap credential only to install that key; passwords are read from private files rather than pasted into a shell command.
6. Invoke `build-template.mjs`.

The builder then:

1. Creates the intended `spaceuser` administrator through `sysadminctl`, with a generated private password.
2. Independently verifies that the password authenticates and that the account has administrator access.
3. Installs pinned, key-only SSH for the intended account.
4. Applies the Golden Gate first-login preferences using the **guest's actual** product/build version.
5. Reboots before disabling the incomplete bootstrap account and removing its admin/SSH access.
6. Stops the template, saves private bootstrap state, and establishes the readiness marker only after the required checks succeed.

The old account may remain an APFS volume owner and cannot simply be deleted. It is disabled, hidden, removed from admin/SSH access, and its default authentication is checked as rejected. This is not a production-grade cryptographic ownership migration.

Every sandbox clone gets fresh VM/MAC identities, an independently generated account password and SSH key, regenerated SSH host keys, and new-password acceptance / old-password rejection checks. This is a much stronger gate than checking only that a process booted.

## Golden Gate's repeated setup screens

The upstream investigation in [Lume PR #4027](https://github.com/trycua/cua/pull/4027) found that an offline-created user without a last-login release record is treated as a new user by `UserAccountUpdater`. MiniBuddy then schedules Setup Assistant. Setting a few `DidSee*` preferences is not sufficient.

This project adapts the documented preferences:

- Read `sw_vers` from the guest; do not stamp every image with another macOS version.
- Set the relevant completed Setup Assistant flags.
- Write the per-user `loginwindow.plist` build/product strings and numeric stamps.
- Remove a previously scheduled per-user `MiniBuddyLaunch` preference.

For stable build strings, the reviewed implementation uses:

```text
build stamp   = major << 21 | (train - 'A') << 16 | daily << 5
product stamp = major << 24 | minor << 16 | patch << 8
```

Unrecognized/beta formats must fail or be handled deliberately, not guessed. See `guest.mjs` and the unit tests.

**This is not the same as installing the upstream PR.** The repo invokes released Lume and applies its own guest-level template preparation. The reviewed PR head is recorded in [the notices](../THIRD_PARTY_NOTICES.md). Recheck upstream before upgrading Lume or macOS.

Known cosmetic side effects of skipping new-user initialization can include Dock placeholders for applications that are not installed. Cosmetic issues do not excuse skipping account, desktop, or security checks.

## Automatic login is separate

A GUI login screen uses the **macOS account password**. Lume's VNC connection uses a separate **desktop password**. Neither is the host administrator password.

The prototype also found `sysadminctl -autologin` reporting success without creating `/etc/kcpassword`. Auto-login requires a matching login preference and a correctly generated credential file. That file is reversible encoding, not encryption. Automatic login and passwordless guest sudo are development conveniences; see [the security model](../SECURITY.md).

If you change a guest password outside the controller, update its private stored credential and auto-login state too. Changing the host password does not update guest credentials.

## Recovery rules

- Do not repeat a failed factory blindly. Inspect current VM state and private markers first.
- Keep failed build artifacts private; they can contain bootstrap credentials and user state.
- Use a new explicitly named test clone if further account experiments are needed.
- Do not publish diagnostic account records, password hashes, private keys, or VM images.
- Confirm the Apple tools' real outcome with authentication checks; never trust their exit status alone.

An alternative is a manually prepared template with an account made through Setup Assistant, or a vetted prebuilt image. Those still need password-rotation, desktop, provenance, SIP, and host compatibility checks. A prebuilt image with SIP disabled should not silently replace a normal-security image.
