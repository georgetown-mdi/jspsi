import { CreatePeerServerWSOnly } from "@peerjs-server/index";

import { getServer as getHttpServer } from "./httpServer";

import type { AddressInfo } from "node:net";

import type { PeerServerInstance } from "@peerjs-server/instance";

function createPeerServer(): PeerServerInstance {
  const server = getHttpServer()!;

  const addressInfo = server.address() as AddressInfo;
  // @ts-ignore setSecureContext is only on the secure server side of the union
  const protocol = server.setSecureContext === undefined ? "http" : "https";

  let origin: boolean | string | Array<string | RegExp> = true;
  let port = 3000;

  if (typeof addressInfo !== "string") {
    if (
      (addressInfo.family === "IPv6" && addressInfo.address == "::1") ||
      (addressInfo.family === "IPv4" &&
        (addressInfo.address == "localhost" ||
          addressInfo.address.startsWith("127.0.0")))
    ) {
      // on a loopback interface, so allow all loopbacks
      origin = [
        `${protocol}://localhost:${addressInfo.port}`,
        RegExp(`${protocol}://127\\.0\\.0\\.[0-9]:${addressInfo.port}`),
        `${protocol}://[::1]:${addressInfo.port}`,
      ];
    } else if (
      (addressInfo.family === "IPv6" &&
        (addressInfo.address == "::" ||
          addressInfo.address == "0:0:0:0:0:0:0:0")) ||
      (addressInfo.family === "IPv4" && addressInfo.address == "0.0.0.0")
    ) {
      // listening to all, so disable cors
      origin = "*";
    }

    port = addressInfo.port;
  }

  return CreatePeerServerWSOnly(server, {
    corsOptions: { origin: origin },
    port,
    path: "/api",
  });
}

// Memoize on globalThis, not in module scope. In dev, Vite can re-evaluate this
// server module on HMR; a module-scoped memo would reset and build a second peer
// server, stacking another `upgrade` listener (and its timers) on the long-lived
// dev HTTP server. A global keeps it to one instance per process.
declare global {
  var peerServerInstance: PeerServerInstance | undefined;
}

export function usePeerServer(): PeerServerInstance {
  return (globalThis.peerServerInstance ??= createPeerServer());
}
