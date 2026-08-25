import net from "node:net";
import tls from "node:tls";

import type { LoopbackTlsCert } from "@psilink/testkit/loopbackTlsCert";
import type { Socket } from "node:net";
import type { Server, TLSSocket } from "node:tls";

/**
 * A TLS front end for the broker `brokerProcess.ts` spawns: a loopback `wss://`
 * address that terminates TLS and pipes the raw stream to the broker's
 * plaintext port.
 *
 * Why a party needs one at all. An invitation's connection endpoint is a
 * credential-free locator -- channel, host, port, path -- with no scheme field
 * (`WebRTCEndpointSchema` in `packages/core/src/config/invitation.ts`), so an
 * acceptance that seeds its connection from one gets a `server` block with no
 * `secure`, which `brokerLocationFromConnection` resolves to TLS. An acceptance
 * that runs the exchange in one command therefore always dials `wss://`, and it
 * has no configuration file for an operator to set `secure: false` on first:
 * that is what `psilink invite` warns about when its own coordination-server URL
 * is `ws://`. So a plaintext broker cannot be the far end of a live one-command
 * acceptance, and a leg that drives one needs a `wss://` coordination server.
 *
 * Why a terminator rather than TLS on the broker itself: this suite exists to
 * drive the REAL vendored broker, spawned through the same standalone entry
 * point a deployment runs. A transparent TCP terminator leaves that entry point
 * and every byte the broker sees unchanged -- it sees the same plaintext
 * WebSocket upgrade on the same loopback socket -- so what the leg adds is a
 * scheme in front of it, not a second broker configuration to keep true.
 *
 * The certificate is the throwaway one `@psilink/testkit/loopbackTlsCert` mints,
 * trusted by nobody: a party that dials this front is started with
 * `NODE_EXTRA_CA_CERTS` pointed at it, which trusts this one certificate in that
 * process alone rather than disabling verification anywhere.
 */

/** A running TLS front, and the handle to stop it. */
export interface TlsBrokerFront {
  /** Loopback port the front is listening on, for a `wss://` dial. */
  port: number;
  /** Close the listener and every stream through it. Idempotent. */
  stop: () => Promise<void>;
}

/**
 * Listen on a loopback port that terminates TLS with `credentials` and pipes
 * each accepted stream to `brokerPort`.
 *
 * The pipe is byte-for-byte in both directions and carries no HTTP awareness:
 * the WebSocket upgrade, the frames after it, and the close all cross unread,
 * so the broker behind it answers exactly as it does on its own port.
 */
export function startTlsBrokerFront(
  credentials: LoopbackTlsCert,
  brokerPort: number,
): Promise<TlsBrokerFront> {
  // Every stream this front has open, so `stop` can drop them: a half-open pipe
  // to a party that has already gone would otherwise keep the listener from
  // closing and hold the suite's teardown.
  const streams = new Set<Socket>();

  const server: Server = tls.createServer(
    { key: credentials.key, cert: credentials.cert },
    (downstream: TLSSocket) => {
      const upstream = net.connect(brokerPort, "127.0.0.1");
      streams.add(downstream);
      streams.add(upstream);
      downstream.pipe(upstream);
      upstream.pipe(downstream);
      const drop = (): void => {
        streams.delete(downstream);
        streams.delete(upstream);
        downstream.destroy();
        upstream.destroy();
      };
      // Both halves are torn down together on either end's close or error. An
      // error listener on each is what keeps a party's abrupt exit (an
      // ECONNRESET on one half) from surfacing as an unhandled socket error in
      // the test process.
      downstream.on("error", drop);
      upstream.on("error", drop);
      downstream.on("close", drop);
      upstream.on("close", drop);
    },
  );

  return new Promise<TlsBrokerFront>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("the TLS broker front reported no loopback port"));
        return;
      }
      resolve({
        port: address.port,
        stop: () =>
          new Promise<void>((done) => {
            for (const stream of streams) stream.destroy();
            streams.clear();
            server.close(() => done());
          }),
      });
    });
  });
}
