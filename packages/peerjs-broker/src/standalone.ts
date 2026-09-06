import { createServer } from "node:http";

import { redactAndSanitizeForDisplay } from "@psilink/core/untrusted-text";

import { CreatePeerServerWSOnly } from "./contrib/index.ts";
import {
  createStandaloneRequestHandler,
  resolveStandaloneOptions,
  StandaloneOptionError,
} from "./standaloneOptions.ts";

import type { StandaloneOptions } from "./standaloneOptions.ts";

import type { Displayable } from "@psilink/core/untrusted-text";
import type { AddressInfo } from "node:net";

/**
 * The vendored PeerJS broker on an HTTP server of its own, as a process entry
 * point: `npm start -w packages/peerjs-broker`, or spawned under `tsx`.
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
 * directly and hands back the realm. This runner goes through
 * `CreatePeerServerWSOnly`, the same entry point the web app's
 * `src/peerServer.ts` mounts, so what a spawning test sees is the wiring the
 * deployed app has rather than a subset of it.
 *
 * Protocol with the parent process: it prints one `psilink-broker <port>` line
 * on stdout once listening, then stays up until it is signalled. Nothing else
 * goes to stdout, so the parent can read the port with a single match. The line
 * reports the port alone -- the address is the operator's own instruction, while
 * the port is what an ephemeral bind leaves for the parent to learn.
 *
 * Its operator surface -- the bind address, the port, the mount, the realm key,
 * and the readiness endpoint -- is resolved in `standaloneOptions.ts` and stated
 * in this workspace's README.
 *
 * It terminates no TLS and applies none of the HTTP upgrade-surface timeouts
 * the web app installs on its own server (apps/web/server/upgradeHardening.ts),
 * so a deployment reachable off the host puts it behind a front that does both.
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

/** Exit code for an option the runner cannot act on, matching the CLI's usage
 * exit (docs/CLI.md). */
const USAGE_EXIT_CODE = 64;

/** Exit code for a bind the operating system refused -- an address that is not
 * this host's, a port already taken, or one this process may not have -- and for
 * a later fault on the listening socket. */
const UNAVAILABLE_EXIT_CODE = 69;

/** Write one line to stderr under this process's context. Diagnostics go to
 * stderr because stdout carries the ready-line protocol above and nothing else;
 * the text arrives escaped and capped, so this writes it as it stands. */
function writeLine(level: "WARN" | "ERROR", message: Displayable): void {
  const timestamp = new Date().toISOString();
  process.stderr.write(
    `[${timestamp}] [${level}] [${DIAGNOSTIC_CONTEXT}] ${message}\n`,
  );
}

/** This runner's diagnostic sink, wired below with no flag in front of it: a
 * broker left unwatched is the case the reports exist for, so there is nothing
 * to switch on. The text arrives escaped, capped and rate limited from the
 * diagnostics module. */
function writeDiagnostic(message: Displayable): void {
  writeLine("WARN", message);
}

/** Report a refusal to start and leave with `code`. The message composes an
 * operator-supplied value raw, so it is escaped once here, at the sink. */
function refuseToStart(message: string, code: number): never {
  writeLine("ERROR", redactAndSanitizeForDisplay(message));
  process.exit(code);
}

function readOptions(): StandaloneOptions {
  try {
    return resolveStandaloneOptions(process.argv.slice(2), process.env);
  } catch (error) {
    if (!(error instanceof StandaloneOptionError)) throw error;
    refuseToStart(error.message, USAGE_EXIT_CODE);
  }
}

const options = readOptions();

const server = createServer(
  createStandaloneRequestHandler(options.readinessPath),
);

CreatePeerServerWSOnly(server, writeDiagnostic, {
  path: options.path,
  key: options.key,
});

// The signaling server's own reports are attached to its WebSocket server, not
// to this one, so what reaches here is the HTTP server's: a bind the operating
// system refused, and an accept-side fault. An `error` with no listener at all
// is thrown, which ends the process either way; this states what happened first.
// A fault after `listen` resolved an ephemeral port reports the bound address,
// not the port-0 request that produced it; a pre-bind refusal has no bound
// address yet, so it falls back to what was requested.
server.on("error", (error: Error) => {
  const bound = server.address();
  const host =
    typeof bound === "object" && bound !== null ? bound.address : options.host;
  const port =
    typeof bound === "object" && bound !== null ? bound.port : options.port;
  refuseToStart(
    `the signaling broker could not serve ${host} port ${port}: ${error.message}`,
    UNAVAILABLE_EXIT_CODE,
  );
});

server.listen(options.port, options.host, () => {
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
