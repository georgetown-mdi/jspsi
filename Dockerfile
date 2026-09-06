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
FROM node:26-alpine@sha256:2d984a15c9b54fd0aeb608b8e0d0d83529eb34d2966db27a1fb4f1edc3d298a3 AS builder

WORKDIR /build

COPY .npmrc package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/peerjs-broker/package.json packages/peerjs-broker/
COPY apps/cli/package.json apps/cli/
COPY apps/web/package.json apps/web/
COPY lib lib
# npm ci resolves nothing: it installs exactly the committed lockfile (including
# each registry package's integrity hash) and fails if a manifest disagrees with
# it, so an image rebuild cannot drift from the tree CI tested. apps/web is in
# scope with its dev deps because `vite build` (and the nitro plugin) are
# devDependencies; what keeps those out of the shipped image is the production
# rebuild at the end of this stage rather than anything about this scope, the
# runtime stage taking apps/web's self-contained .output/ and none of this tree.
# The root .npmrc copied in above puts the install-script policy in force here as
# it is locally and in CI; what that does and does not reach is in
# docs/spec/DEPENDENCY_PINS.md.
RUN --mount=type=cache,target=/root/.npm \
  npm ci -w packages/core -w packages/peerjs-broker -w apps/cli -w apps/web

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
# (TanStack Start generates the document), so none is copied. The signaling
# broker is a source-only workspace the web build bundles into its server output
# (no build step of its own), so its source is a build input here too.
COPY packages/peerjs-broker/tsconfig.json packages/peerjs-broker/
COPY packages/peerjs-broker/src packages/peerjs-broker/src/
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
# The release version reaches the client bundle the same way, so the `docker run`
# lines the console's partner accept kit prints name this image rather than the
# floating tag. It is read from the apps/cli manifest copied above -- the
# canonical release version this image is tagged with (docs/RELEASES.md) --
# rather than taken as a build argument, which could disagree with it. Scoped to
# this RUN because it is a build input for the client bundle, not runtime
# configuration like the profile above.
#
# The read is gated rather than carried as an assignment prefix on the build
# command: a prefix gives the RUN the BUILD's exit status, so a reader that
# fails, or a manifest carrying no version, bakes an empty value and ships an
# image whose kit quietly names the floating tag instead
# (apps/web/src/bench/acceptKit.ts). `set -e` fails the layer on the reader,
# `test -n` on the empty value, and the build runs only past both.
RUN set -eu; \
  VITE_PSILINK_VERSION="$(node -p "require('/build/apps/cli/package.json').version ?? ''")"; \
  test -n "$VITE_PSILINK_VERSION"; \
  export VITE_PSILINK_VERSION; \
  npm run build -w apps/web

# The tree the runtime stage ships: the same lockfile-exact resolution as above
# with the build's own dependencies left out. Both halves of the command are
# load-bearing, and each answers a measurement rather than an expectation -- the
# numbers, and the npm the measurement ran on, are in
# docs/spec/CONTAINER_IMAGES.md.
#
# The wipe is explicit because `npm ci` empties node_modules only when it is
# unscoped. Under the -w scoping here it reifies in place instead, keeping every
# package the install above put there that this scope does not name, dev
# dependencies of this repository's own root included.
#
# --omit=optional rides beside --omit=dev because npm drops a package flagged
# `dev` outright and keeps one flagged `devOptional`: optional peer edges reach
# apps/web's vite -- with rolldown and esbuild under it -- so omitting dev alone
# still installs the web build toolchain. The only optional edge inside this
# scope is ssh2's `cpu-features` native addon, which ssh2 declares optional and
# completes a handshake without.
RUN --mount=type=cache,target=/root/.npm \
  rm -rf node_modules \
  && npm ci --omit=dev --omit=optional -w packages/core -w apps/cli

FROM node:26-alpine@sha256:2d984a15c9b54fd0aeb608b8e0d0d83529eb34d2966db27a1fb4f1edc3d298a3

# The runtime stage resolves no npm dependency: it copies the builder's
# production node_modules and mirrors the workspace layout around it so the
# node_modules/@psilink/core and node_modules/psilink workspace links resolve.
# Every runtime dependency and transitive is thereby frozen to the committed
# package-lock.json -- re2js in particular runs partner-supplied transform
# regexes and must behave byte-identically on both parties or PSI keys silently
# mismatch.
#
# Exactly one OS package is fetched from the Alpine mirror while this stage
# builds, at whatever version that mirror carries: samba-client, for the Windows
# file-drop setup scripts (support/windows-network-filedrop/), which run their
# SMB probe inside this image. The networks that probe exists to diagnose are the
# ones where a container cannot reach the Alpine mirror at all, so the tool has
# to be in the image rather than fetched when the probe runs. Why it floats
# rather than being version-pinned, and what the float costs:
# docs/spec/DEPENDENCY_PINS.md, which also holds the residual npm float.
RUN apk add --no-cache samba-client

# samba-client pulls in linux-pam, whose /usr/sbin/unix_chkpwd lands setgid
# `shadow`. Neither role authenticates a Unix account, so the bit buys the image
# nothing, and taking it off makes the helper a non-boundary outright rather than
# one whose reach rests on what /etc/shadow happens to carry. image_smoke.yaml
# measures the built image's whole setuid/setgid inventory against the empty set
# this leaves, so a second bit cannot arrive unremarked; see
# docs/spec/CONTAINER_IMAGES.md.
RUN chmod g-s /usr/sbin/unix_chkpwd

# The base image's package manager, taken out of the runtime stage. Neither role
# runs npm, npx or corepack -- the entrypoint execs node directly, and the
# console server spawns the CLI entry the same way -- while the npm CLI brings a
# bundled dependency tree of its own that the image vulnerability scan reads and
# that no pin in this repository moves. Taking it out leaves that scan two
# remedies, both of them this repository's: a system package moves with the base
# digest, a package under /app with the lockfile. `rm -rf` on a path the base
# does not hold is a no-op, so this stands whichever of these the pinned base
# ships; image_smoke.yaml asserts none of the three resolves in the built image.
RUN rm -rf \
  /usr/local/lib/node_modules/npm \
  /usr/local/lib/node_modules/corepack \
  /usr/local/bin/npm \
  /usr/local/bin/npx \
  /usr/local/bin/corepack

WORKDIR /app
# npm links the workspaces its install names, so the tree copied here carries
# links to packages/core and apps/cli alone and both link targets are copied
# below. A link to a workspace this image does not ship would dangle, and
# image_smoke.yaml's symlink containment measurement refuses a dangling link
# under /app; see docs/spec/CONTAINER_IMAGES.md.
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

# Everything the container must WRITE, created and handed to the unprivileged
# account the USER below drops to. /app is deliberately not among them: it stays
# root-owned and world-readable, so the running process reads and executes its
# own code without being able to rewrite it.
#
#   /work is the default working directory, so a run with no bind mount still
#   has somewhere to write. A bind mount replaces it and carries the HOST
#   directory's ownership instead -- what an operator has to do about that is in
#   docs/DEPLOYMENT.md.
#
#   /run/psilink is the console's pasted-credential scratch directory
#   (apps/web/src/jobs/sftpScratch.ts). Its parent /run is root-owned, so an
#   unprivileged server cannot create it at boot -- and that boot fails closed
#   rather than starting without it.
RUN mkdir -p /work /run/psilink/sftp-credentials \
  && chown -R node:node /work /run/psilink \
  && chmod -R 700 /run/psilink

# Stated rather than left to the runtime's passwd lookup: the CLI derives its
# default signing-identity directory from the home directory while its module
# loads, ahead of any command, so an operator who overrides the account with
# `docker run --user` gets a resolvable home rather than a startup failure.
ENV HOME=/home/node

# Drop to the base image's `node` account (uid 1000, gid 1000) for both roles.
# Nothing the entrypoint dispatches to needs privilege: the CLI writes only into
# the operator's mounted working directory, and the console server binds an
# unprivileged port. Placed after every COPY and RUN above so those still build
# as root, and before the WORKDIR below so the ENTRYPOINT inherits it.
USER node

WORKDIR /work

# --expose-gc lets @psilink/core release the single-pass linkage's transient
# allocation peak at the phase boundaries (relieveTransientMemory in
# packages/core/src/link.ts), lowering the receiver's peak RSS; a no-op for every
# other command. Node consumes the flag, so it does not reach the CLI's argv. The
# entrypoint script applies this flag to the CLI role and dispatches `serve` to
# the web server; see docker-entrypoint.sh.
ENTRYPOINT ["/app/docker-entrypoint.sh"]
