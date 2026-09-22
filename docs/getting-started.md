# Getting started

[← Back to docs index](README.md)

## First-run setup

The first time you open the panel, it asks you to create an administrator account. This is the only account that exists until you add more, and it has full control.

Pick a username and a password of at least 8 characters. That's it — you're signed in and taken straight to the dashboard.

> **Setup PIN:** if the panel is reachable from outside localhost (e.g. `PANEL_HOST=0.0.0.0` or a
> LAN address) during this first-run step, you'll also be asked for a one-time PIN — printed to the
> panel's own server console/log output, never sent anywhere over the network. This stops someone
> who can merely reach the port from claiming the admin account ahead of you. A loopback-only bind
> skips this — check the machine or container's console/logs for a line starting with "First-run
> setup PIN:".

## Signing in

After setup, the panel is protected by a login screen. Enter your username and password to continue.

![Sign in](images/login.png)

If [two-factor authentication](two-factor-authentication.md) is enabled on your account, you'll be asked for a 6-digit code from your authenticator app right after your password.

## Finding your way around

Everything hangs off the left sidebar:

- **Dashboard** — every server at a glance ([details](dashboard.md)).
- **Servers**, **Modpacks**, **Worlds**, **Blueprints** — create and manage servers and their content.
- **Updates**, **Backups**, **Schedules**, **Storage**, **Activity** — the operational side: what's out of date, your snapshots, automation, disk usage, and the audit log.
- **Settings** (bottom) — users, API keys, and panel configuration.

The top bar has the **New server** button, a **theme toggle** (dark/light), and your **account menu**, where you can manage [two-factor authentication](two-factor-authentication.md) or sign out.

## What you need

The panel talks to Docker to run servers, so it needs access to a Docker daemon (Docker Desktop or a Docker Engine socket). When Docker is reachable, the dashboard's Docker tile shows **Connected** and its version. If it's not, the panel still runs — you just can't start servers until the daemon is up.

## Next steps

- [Create your first server →](servers.md)
- [Secure your account with 2FA →](two-factor-authentication.md)
