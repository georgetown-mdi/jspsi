import { createServer } from "node:http";

import { CreatePeerServerWSOnly } from "./contrib/index.ts";

import type { Displayable } from "@psilink/core/untrusted-text";
import type { AddressInfo } from "node:net";

/**
 * The vendored PeerJS broker on a loopback HTTP server of its own, as a process
 * entry point: `npm start -w packages/peerjs-broker`, or spawned under `tsx`.
 *
 * It is what makes the broker startable without an application around it, so a
 * consumer outside the web app drives the REAL signaling wire rather than a
 * stand-in: the CLI's WebRTC transport hand-writes a broker client
 * (apps/cli/src/connection/webrtc/brokerClient.ts) against facts measured here,
 * and its harness (apps/cli/test/signaling/brokerProcess.ts) spawns this file.
 * That is why .github/workflows/cli_build_and_test.yaml filters on this
 * workspace.
 *
 * In-process consumers inside the web app want its
 * `test/utils/signalingHarness.ts` instead: it builds the `WebSocketServer`
 * directly and hands back the realm. This runner deliberately goes through
 * `CreatePeerServerWSOnly`, the same entry point the web app's
 * `src/peerServer.ts` mounts, so what a spawning test sees is the wiring the
 * deployed app has rather than a subset of it.
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

/** What marks this process's lines for an operator reading a stream several
 * processes write to. The same context `@psilink/core`'s prefixed loggers give
 * the broker's diagnostics in the web app, so one line shape serves both
 * embeddings -- an equality apps/cli/test/integration/webrtc/broker.test.ts
 * holds by reading a diagnostic off this runner's stderr and comparing its
 * prefix with what core's prefixer writes for the same instant. */
const DIAGNOSTIC_CONTEXT = "peerjs-broker";

function readFlag(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length
    ? process.argv[index + 1]
    : fallback;
}

/** This runner's diagnostic sink, wired below with no flag in front of it: a
 * broker left unwatched is the case the reports exist for, so there is nothing
 * to switch on. Diagnostics go to stderr because stdout carries the ready-line
 * protocol above and nothing else. The text arrives escaped, capped and rate
 * limited from the diagnostics module, so this writes it as it stands. */
function writeDiagnostic(message: Displayable): void {
  const timestamp = new Date().toISOString();
  process.stderr.write(
    `[${timestamp}] [WARN] [${DIAGNOSTIC_CONTEXT}] ${message}\n`,
  );
}

const server = createServer((_request, response) => {
  // The broker itself only handles WebSocket upgrades; a plain request is not
  // part of any wire this serves, so it is refused rather than 404'd silently.
  response.writeHead(404);
  response.end();
});

CreatePeerServerWSOnly(server, writeDiagnostic, {
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
