FROM node:26-alpine AS builder

WORKDIR /build

COPY package*.json ./
COPY packages/core/package.json packages/core/
COPY apps/cli/package.json apps/cli/
COPY lib lib
RUN --mount=type=cache,target=/root/.npm \
  npm install . -w packages/core -w apps/cli

COPY tsconfig.base.json tsconfig.json ./
COPY packages/core/*.ts packages/core/tsconfig.json packages/core/
COPY packages/core/src packages/core/src/
COPY apps/cli/tsconfig.json apps/cli/*.ts apps/cli/
COPY apps/cli/src apps/cli/src/
RUN npm run build -w packages/core -w apps/cli

FROM node:26-alpine

WORKDIR /app
COPY --from=builder /build/apps/cli/package.json .
COPY --from=builder /build/lib lib
COPY --from=builder /build/packages/core/package.json lib/core/
RUN \
  sed -i -e 's|file:\.\./\.\./lib/|file:../|' lib/core/package.json
COPY --from=builder /build/packages/core/dist lib/core/dist/
RUN \
  sed -i \
    -e 's|file:\.\./\.\./packages/core|file:./lib/core|' \
    -e 's|file:\.\./\.\./lib/|file:./lib/|' \
    package.json
RUN --mount=type=cache,target=/root/.npm \
  npm install --omit=dev

COPY --from=builder /build/apps/cli/dist/index.js ./psi-link
RUN chmod +x ./psi-link
# The PSI crypto worker entry must sit beside the CLI entry: psiWorkerHost.ts
# resolves it as `<__dirname>/psiWorker.worker.js` (here /app), and without it
# createPsiEngine silently falls back to the in-process engine -- so the whole
# off-thread offload (and the SFTP heartbeat that depends on the event loop being
# free during a round) would not run in the shipped image (board item 208035324).
# Keep its name; it is spawned as a worker, never executed, so no shebang/chmod.
COPY --from=builder /build/apps/cli/dist/psiWorker.worker.js ./psiWorker.worker.js

WORKDIR /work

# --expose-gc lets @psilink/core release the single-pass linkage's transient
# allocation peak at the phase boundaries (relieveTransientMemory in
# packages/core/src/link.ts), lowering the receiver's peak RSS; a no-op for every
# other command. Node consumes the flag, so it does not reach the CLI's argv.
ENTRYPOINT ["node", "--expose-gc", "/app/psi-link"]
