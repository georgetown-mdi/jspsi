import net from "node:net";
import tls from "node:tls";

import type { LoopbackTlsCert } from "@psilink/testkit/loopbackTlsCert";
import type { Socket } from "node:net";
import type { Server, TLSSocket } from "node:tls";

/**
 * A TLS front end for the broker `brokerProcess.ts` spawns: a loopback
 * `wss://` address that terminates TLS and pipes the raw stream to the
 * broker's plaintext port.
 *
 * An invitation's connection endpoint has no scheme, so an acceptance
 * seeded from one resolves to TLS by default and a live one-command
 * acceptance always dials `wss://` -- a plaintext broker cannot be the far
 * end of one. A transparent terminator, rather than TLS on the broker
 * itself, keeps driving the real vendored broker's own standalone entry
 * point unchanged; the leg only adds a scheme in front of it.
 *
 * The certificate is the throwaway one `@psilink/testkit/loopbackTlsCert`
 * mints; a party dialing this front trusts only this one certificate, via
 * `NODE_EXTRA_CA_CERTS` in that process alone.
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
 * The pipe is byte-for-byte in both directions and has no HTTP awareness:
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
      // ECONNRESET on one half) from showing up as an unhandled socket error in
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
