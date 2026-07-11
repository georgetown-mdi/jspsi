#!/bin/sh
# Dispatch between the two roles this image serves. `serve` (as the first
# argument) starts the web console appliance's Nitro server; any other argument
# vector runs the headless CLI, byte-for-byte as the CLI-only image did, so
# existing `docker run vdorie/psi-link <cli-args>` callers are unaffected.
#
# `exec` replaces this shell with node so node becomes PID 1 and receives
# container signals (SIGTERM/SIGINT) directly -- the server's graceful shutdown
# and the CLI's interrupt handling both depend on that.
set -e

if [ "$1" = "serve" ]; then
  shift
  exec node /app/apps/web/.output/server/index.mjs "$@"
fi

exec node --expose-gc /app/apps/cli/dist/index.js "$@"
