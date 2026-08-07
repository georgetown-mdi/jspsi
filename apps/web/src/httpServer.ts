import type * as http from "node:http";
import type * as http2 from "node:http2";

declare global {
  var httpServer: http.Server | http2.Http2SecureServer | undefined;
}

export function registerServer(server: http.Server | http2.Http2SecureServer) {
  globalThis.httpServer = server;
}

export function getServer() {
  return globalThis.httpServer;
}
