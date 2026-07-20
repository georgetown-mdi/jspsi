# The deployment profile is one build-time source of truth shared by both stages:
# the builder bakes it into the client bundle (vite `import.meta.env`), and the
# runtime stage exports the SAME value into the server's process environment so
# the job-API gate reads the identical profile at runtime (apps/web/src/jobs/gate.ts).
# A single ARG keeps the client build and the server gate from drifting. Override
# with --build-arg VITE_DEPLOYMENT_PROFILE=hosted to build a hosted image.
ARG VITE_DEPLOYMENT_PROFILE=console

# Base pinned to node:26-alpine's multi-arch index digest (both stages) so builds
# resolve one exact image; a base bump for a node or musl patch is a deliberate
# digest update, not an automatic float. See docs/spec/DEPENDENCY_PINS.md.
FROM node:26-alpine@sha256:e88a35be04478413b7c71c455cd9865de9b9360e1f43456be5951032d7ac1a66 AS builder

WORKDIR /build

COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/cli/package.json apps/cli/
COPY apps/web/package.json apps/web/
COPY lib lib
# npm ci resolves nothing: it installs exactly the committed lockfile (including
# each registry package's integrity hash) and fails if a manifest disagrees with
# it, so an image rebuild cannot drift from the tree CI tested. apps/web is in
# scope with its dev deps because `vite build` (and the nitro plugin) are
# devDependencies -- the runtime stage ships the self-contained .output/, not
# these, so the dev deps never reach the shipped image.
RUN --mount=type=cache,target=/root/.npm \
  npm ci -w packages/core -w apps/cli -w apps/web

COPY tsconfig.base.json tsconfig.json ./
COPY packages/core/*.ts packages/core/tsconfig.json packages/core/
COPY packages/core/src packages/core/src/
COPY apps/cli/tsconfig.json apps/cli/*.ts apps/cli/
COPY apps/cli/src apps/cli/src/
# @psilink/core must be built before the web build: apps/web consumes it from its
# built dist/ (a file: workspace dependency), so build core and the CLI first.
RUN npm run build -w packages/core -w apps/cli

# apps/web build inputs: its root-level config (vite/nitro/postcss/tsconfig) plus
# the source, server entry, and static assets vite reads. There is no index.html
# (TanStack Start generates the document), so none is copied.
COPY apps/web/vite.config.ts apps/web/nitro.config.ts apps/web/postcss.config.cjs apps/web/tsconfig.json apps/web/
COPY apps/web/src apps/web/src/
COPY apps/web/server apps/web/server/
COPY apps/web/public apps/web/public/
# Build the console-appliance UI: VITE_DEPLOYMENT_PROFILE=console drops the
# browser-only file-assurance copy and routes a filedrop channel to the
# server-side job driver (see apps/web/src/utils/clientConfig.ts). vite build
# produces a self-contained apps/web/.output/ (server entry + bundled
# node_modules + public assets), so the runtime stage copies only that. The
# global ARG is re-declared here and promoted to ENV so vite's
# `import.meta.env.VITE_*` reads it from the build process environment (a bare
# ARG is not exported into the RUN child). This bakes the profile into the client
# bundle; the runtime stage exports the same ARG so the server gate matches it.
ARG VITE_DEPLOYMENT_PROFILE
ENV VITE_DEPLOYMENT_PROFILE=${VITE_DEPLOYMENT_PROFILE}
RUN npm run build -w apps/web

# Rebuild node_modules production-only (npm ci empties it first): the identical
# lockfile-exact resolution minus devDependencies, ready to ship as-is.
RUN --mount=type=cache,target=/root/.npm \
  npm ci --omit=dev -w packages/core -w apps/cli

FROM node:26-alpine@sha256:e88a35be04478413b7c71c455cd9865de9b9360e1f43456be5951032d7ac1a66

# The runtime stage performs no dependency resolution: it copies the builder's
# production node_modules and mirrors the workspace layout around it so the
# node_modules/@psilink/core and node_modules/psilink workspace links resolve.
# Every runtime dependency and transitive is thereby frozen to the committed
# package-lock.json -- re2js in particular runs partner-supplied transform
# regexes and must behave byte-identically on both parties or PSI keys silently
# mismatch. Rationale and residual float: docs/spec/DEPENDENCY_PINS.md.
WORKDIR /app
COPY --from=builder /build/node_modules node_modules
COPY --from=builder /build/packages/core/package.json packages/core/
COPY --from=builder /build/packages/core/dist packages/core/dist/
COPY --from=builder /build/apps/cli/package.json apps/cli/
COPY --from=builder /build/apps/cli/dist/index.js apps/cli/dist/index.js
# The PSI crypto worker entry must sit beside the CLI entry: psiWorkerHost.ts
# resolves it as `<__dirname>/psiWorker.worker.js` (here /app/apps/cli/dist), and
# without it createPsiEngine silently falls back to the in-process engine -- so
# the whole off-thread offload (and the SFTP heartbeat that depends on the event
# loop being free during a round) would not run in the shipped image. Keep its
# name; it is spawned as a worker, never executed, so no shebang/chmod.
COPY --from=builder /build/apps/cli/dist/psiWorker.worker.js apps/cli/dist/psiWorker.worker.js

# The web console appliance: vite build produces a self-contained
# apps/web/.output/ (server entry + bundled node_modules + public assets), so the
# runtime stage copies only that -- no apps/web production `npm ci` is needed.
COPY --from=builder /build/apps/web/.output apps/web/.output

# Export the deployment profile into the runtime environment so the server-side
# job-API gate (apps/web/src/jobs/gate.ts) reads the SAME value the client bundle
# was baked with: a console image enables the job API, a hosted one keeps it
# disabled. The Nitro server has no build-time env baking, so it must come from
# the process environment here; re-declaring the global ARG keeps it in sync with
# the client build rather than hardcoding a value that could drift from it.
ARG VITE_DEPLOYMENT_PROFILE
ENV VITE_DEPLOYMENT_PROFILE=${VITE_DEPLOYMENT_PROFILE}

# The server spawns the CLI as a subprocess; its default binary resolution walks
# up from the server module and would not find the CLI in this image layout, so
# pin it explicitly to the shipped CLI entry (see apps/web/src/jobs/cliDriver.ts).
ENV JOB_CLI_BINARY=/app/apps/cli/dist/index.js

# The entrypoint dispatches: `serve` starts the web console server on this port
# (apps/web default PORT=3000); any other argv runs the CLI unchanged.
EXPOSE 3000

# One script switches between the two roles: `serve` runs the web console server,
# every other argv vector runs the CLI byte-for-byte (backwards compatible with
# existing `docker run vdorie/psi-link <cli-args>` callers). `exec` in the script
# makes node PID 1 so it receives signals directly.
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

WORKDIR /work

# --expose-gc lets @psilink/core release the single-pass linkage's transient
# allocation peak at the phase boundaries (relieveTransientMemory in
# packages/core/src/link.ts), lowering the receiver's peak RSS; a no-op for every
# other command. Node consumes the flag, so it does not reach the CLI's argv. The
# entrypoint script applies this flag to the CLI role and dispatches `serve` to
# the web server; see docker-entrypoint.sh.
ENTRYPOINT ["/app/docker-entrypoint.sh"]
