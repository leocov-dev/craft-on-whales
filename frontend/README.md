# Minecraft Server Manager — frontend

The [Vue 3](https://vuejs.org) + [Quasar](https://quasar.dev) single-page app for Minecraft Server
Manager. It talks to the [`backend/`](../backend/README.md) NestJS API over HTTP and WebSockets —
this package has no server of its own beyond the Vite dev server.

See the [top-level README](../README.md) for what the panel does, and
[`docs/architecture.md`](../docs/architecture.md) for how the two packages fit together.

## Install the dependencies

```bash
npm install
```

## Start the app in development mode (HMR, error reporting, etc.)

```bash
npm run dev
```

This proxies `/api` and `/ws` requests to the backend, so start `backend/` first (see its README).

## Format & lint the files

```bash
npm run lint
```

...or just check formatting & linting without fixing:

```bash
npm run lint:check
```

## Type-check

```bash
npm run typecheck
```

## Build for production

```bash
npm run build
```

Outputs a static SPA to `dist/spa/`.

### Customize the configuration

See [Configuring quasar.config.js](https://v2.quasar.dev/quasar-cli-vite/quasar-config-file).
