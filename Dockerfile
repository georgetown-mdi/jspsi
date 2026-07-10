FROM node:26-alpine AS builder

WORKDIR /build

COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/cli/package.json apps/cli/
COPY lib lib
# npm ci resolves nothing: it installs exactly the committed lockfile (including
# each registry package's integrity hash) and fails if a manifest disagrees with
# it, so an image rebuild cannot drift from the tree CI tested.
RUN --mount=type=cache,target=/root/.npm \
  npm ci -w packages/core -w apps/cli

COPY tsconfig.base.json tsconfig.json ./
COPY packages/core/*.ts packages/core/tsconfig.json packages/core/
COPY packages/core/src packages/core/src/
COPY apps/cli/tsconfig.json apps/cli/*.ts apps/cli/
COPY apps/cli/src apps/cli/src/
RUN npm run build -w packages/core -w apps/cli

# Rebuild node_modules production-only (npm ci empties it first): the identical
# lockfile-exact resolution minus devDependencies, ready to ship as-is.
RUN --mount=type=cache,target=/root/.npm \
  npm ci --omit=dev -w packages/core -w apps/cli

FROM node:26-alpine

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

WORKDIR /work

# --expose-gc lets @psilink/core release the single-pass linkage's transient
# allocation peak at the phase boundaries (relieveTransientMemory in
# packages/core/src/link.ts), lowering the receiver's peak RSS; a no-op for every
# other command. Node consumes the flag, so it does not reach the CLI's argv.
ENTRYPOINT ["node", "--expose-gc", "/app/apps/cli/dist/index.js"]
