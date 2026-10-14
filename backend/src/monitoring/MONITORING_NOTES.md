# MonitoringModule notes

Backs the Live tab and the dashboard's resource card (upstream 0.13.0, see
`UPSTREAM_PARITY.md`).

## TPS/MSPT (`TpsService`, `utils/rcon-tps.ts`)

- Vanilla has no tick-rate command, so `null` is a normal answer, not an error.
- Probe order: `tps` (Paper/Purpur), `spark tps`, `forge tps`. The command that
  parsed is remembered per server; Paper's `tps` has no MSPT, so `mspt` is run
  and merged.
- Every probe shows up in the server console, so results are cached: 5 s for a
  reading, 5 min for "server answered but has no TPS command". If every command
  returned nothing (RCON not up yet, container booting) it is cached only 5 s,
  otherwise a server probed during boot would be stuck as "vanilla" for 5 min.
- Concurrent callers share one in-flight probe.
- Delivery: `StatsGateway` emits `{kind:'tps', tps}` every 10 s per socket,
  separate from the Docker stats ticks. No new HTTP endpoint.

## Overview (`OverviewService`)

This fork has no always-warm live cache (`GET /servers/live` does its own
per-request `statsOnce` for CPU/memory and leaves player counts `null`, since
they need an RCON `list` that prints in the console), so
`GET /api/monitoring/overview` also calls `statsOnce` for each running
server the caller may see, in parallel. Docker's one-shot stats take 1-2 s per
container, which is why the dashboard polls every 5 s and no faster. If this
becomes costly, add a shared cache here rather than polling faster.

### Host overlay (`HostStatsService`)

`overview.host` is the raw machine's CPU and memory, drawn as a second line on
the dashboard charts. Inside the container these are the host's numbers (the
Linux VM under Docker Desktop, which is accepted). Memory used is
`total - MemAvailable` from `/proc/meminfo` (`os.freemem()` would count page
cache as used). CPU is the `os.cpus()` busy delta since the previous call,
scaled by core count so it shares the servers' "100% = one core" unit. Readings
under 1 s apart reuse the last value because several users poll concurrently.
It is returned even when no servers are running.

## Health (`HealthService`)

Read-only join of values recorded elsewhere: `inspectStatus`, event counts for
`crashed`/`oom`/`crash-loop`/`startup-stalled` over 7 days, and the newest crash
report. Nothing new is collected.
