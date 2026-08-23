# Panel image. The panel drives the HOST's Docker daemon and creates Minecraft
# servers as SIBLING containers — run it with the Docker socket mounted and
# DATA_DIR_HOST set to the host path of the /data mount (see docker-compose.yml).
#
# Two packages, built separately: frontend/ (Vue 3 + Quasar SPA, static
# output) and backend/ (NestJS API + WS gateways). The backend serves the
# SPA build itself at runtime (ServeStaticModule, see backend/src/app.module.ts)
# — there's no separate web server or reverse proxy inside this image.

# Build stage: both packages get their own npm ci (separate lockfiles,
# separate dependency graphs), then their own build.
FROM node:24-alpine AS build
WORKDIR /app
# shared/types/*.d.ts is imported by both packages via relative paths
# (../../../shared/types/...) — it has to land at the same sibling position
# here as it occupies in the repo, before either package builds.
COPY shared ./shared
# Quasar's postinstall (quasar prepare) needs the project's own config/source
# present to run, so — unlike backend's manifest-first layering below —
# frontend's full source has to be copied before `npm ci`, not after.
COPY frontend ./frontend
RUN npm --prefix frontend ci
RUN npm --prefix frontend run build
COPY backend/package.json backend/package-lock.json ./backend/
RUN npm --prefix backend ci
COPY backend ./backend
RUN npm --prefix backend run build

# Runtime stage: backend's production deps + its compiled dist/, with the
# SPA build laid out as a sibling directory — backend/src/app.module.ts's
# ServeStaticModule resolves it via path.join(__dirname, '..', '..',
# 'frontend', 'dist', 'spa'), i.e. two levels up from backend/dist/.
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PANEL_HOST=0.0.0.0 \
    PANEL_PORT=3000
COPY backend/package.json backend/package-lock.json ./backend/
RUN npm --prefix backend ci --omit=dev
COPY --from=build /app/backend/dist ./backend/dist
# The generated Drizzle migration SQL lives alongside src/, not inside
# dist/ — db/migrate.ts resolves it relative to __dirname at runtime, so
# it has to ship as a real sibling directory, not get bundled into dist/.
# drizzle-pg is the same thing for the optional Postgres path (DB_DRIVER=postgres).
COPY --from=build /app/backend/drizzle ./backend/drizzle
COPY --from=build /app/backend/drizzle-pg ./backend/drizzle-pg
COPY --from=build /app/frontend/dist/spa ./frontend/dist/spa
EXPOSE 3000
VOLUME /data
# Runs as root: the mounted Docker socket needs it (the host's docker-group GID
# is unknowable at build time), and a socket-holding container is already
# root-equivalent on the host — dropping privileges here would only pretend.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PANEL_PORT}/healthz" || exit 1
CMD ["node", "backend/dist/main.js"]
