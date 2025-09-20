FROM node:current-slim AS builder

WORKDIR /build

COPY package*.json ./
COPY packages/base-lib/package.json packages/base-lib/
COPY apps/cli/package.json apps/cli/
COPY lib lib
RUN --mount=type=cache,target=/root/.npm \
  npm install . -w packages/base-lib -w apps/cli

COPY tsconfig.base.json tsconfig.json ./
COPY packages/base-lib/*.ts packages/base-lib/tsconfig.json packages/base-lib/
COPY packages/base-lib/src packages/base-lib/src/
COPY apps/cli/tsconfig.json apps/cli/*.ts apps/cli/
COPY apps/cli/src apps/cli/src/
RUN npm run build -w packages/base-lib -w apps/cli

FROM node:current-slim

WORKDIR /app
COPY --from=builder /build/apps/cli/package.json .
COPY --from=builder /build/lib lib
COPY --from=builder /build/packages/base-lib/package.json lib/base-lib/
RUN \
  sed -i -e 's|file:\.\./\.\./lib/openmined-psi.js-2.0.6.tgz|file:../openmined-psi.js-2.0.6.tgz|' lib/base-lib/package.json
COPY --from=builder /build/packages/base-lib/dist lib/base-lib/dist/
RUN \
  sed -i -e 's|file:\.\./\.\./packages/base-lib|file:./lib/base-lib|' package.json
RUN --mount=type=cache,target=/root/.npm \
  npm install --omit=dev

COPY --from=builder /build/apps/cli/dist/index.js ./psi-link
RUN chmod +x ./psi-link

ENTRYPOINT ["./psi-link"]
