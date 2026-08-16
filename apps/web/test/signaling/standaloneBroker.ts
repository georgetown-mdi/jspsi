import { createServer } from "node:http";

import { CreatePeerServerWSOnly } from "@peerjs-server/index.ts";

import type { AddressInfo } from "node:net";

/**
 * The vendored PeerJS broker on a loopback HTTP server of its own, as a process
 * entry point.
 *
 * It exists so a test outside this app can drive the REAL signaling wire rather
 * than a stand-in: the CLI's WebRTC transport hand-writes a broker client
 * (apps/cli/src/connection/webrtc/brokerClient.ts) against facts measured here,
 * and apps/cli may not import apps/web (eslint.boundaries.mjs), so the only
 * sanctioned coupling is spawning this file. The CLI harness that does so is
 * apps/cli/test/signaling/brokerProcess.ts, and it is why
 * .github/workflows/cli_build_and_test.yaml filters on this directory.
 *
 * In-process consumers inside this app want `test/utils/signalingHarness.ts`
 * instead: it builds the `WebSocketServer` directly and hands back the realm.
 * This runner deliberately goes through `CreatePeerServerWSOnly`, the same entry
 * point `src/peerServer.ts` mounts, so what a spawning test sees is the wiring
 * the deployed app has rather than a subset of it.
 *
 * Protocol with the parent process: it prints one `psilink-broker <port>` line
 * on stdout once listening, then stays up until it is signalled. Nothing else
 * goes to stdout, so the parent can read the port with a single match.
 *
 * Arguments: `--path <mount>` and `--key <api-key>` override the defaults, so a
 * test can exercise a non-root mount or a wrong-key refusal.
 */

/** The line the parent matches to learn the port. */
const READY_PREFIX = "psilink-broker";

function readFlag(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length
    ? process.argv[index + 1]
    : fallback;
}

const server = createServer((_request, response) => {
  // The broker itself only handles WebSocket upgrades; a plain request is not
  // part of any wire this serves, so it is refused rather than 404'd silently.
  response.writeHead(404);
  response.end();
});

CreatePeerServerWSOnly(server, {
  path: readFlag("path", "/api"),
  key: readFlag("key", "peerjs"),
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address() as AddressInfo;
  process.stdout.write(`${READY_PREFIX} ${address.port}\n`);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    // A live WebSocket keeps `close` from completing, so do not wait on it
    // past the grace window: the parent is already tearing the run down.
    setTimeout(() => process.exit(0), 500).unref();
  });
}
