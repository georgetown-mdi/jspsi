import { Server as HttpServer } from "node:http";
import { Server as HttpsServer } from "node:https";


import {
  setupGracefulShutdown,
  startScheduleRunner,
  trapUnhandledNodeErrors,
// @ts-ignore available at runtime
} from "nitropack/runtime/internal"; 

// @ts-ignore available at runtime
import "#nitro-internal-pollyfills";

import { useNitroApp, useRuntimeConfig } from "nitropack/runtime";
import { toNodeListener } from "h3";
import wsAdapter from "crossws/adapters/node";

import logLibrary from "loglevel";

import { ConfigManager } from '../src/utils/serverConfig';
import { registerServer } from "../src/httpServer";


import type { AddressInfo } from "node:net";

const { getLogger } = logLibrary;

const log = getLogger('server-entry')

const configManager = new ConfigManager();
const config = await configManager.load();

const cert = process.env.NITRO_SSL_CERT;
const key = process.env.NITRO_SSL_KEY;

log.setLevel(config.LOG_LEVEL);

const nitroApp = useNitroApp();

const server =
  cert && key
// @ts-ignore part of preset
    ? new HttpsServer({ key, cert }, toNodeListener(nitroApp.h3App))
// @ts-ignore part of preset
    : new HttpServer(toNodeListener(nitroApp.h3App));

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
const port = (config.PORT || 3000) as number;
const host = process.env.NITRO_HOST || process.env.HOST;

const path = process.env.NITRO_UNIX_SOCKET;

// @ts-ignore part of preset
const listener = server.listen(path ? { path } : { port, host }, (err) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  const protocol = cert && key ? "https" : "http";
  const addressInfo = listener.address() as AddressInfo;
  if (typeof addressInfo === "string") {
    log.info(`Listening on unix socket ${addressInfo}`);
    return;
  }
  const baseURL = (useRuntimeConfig().app.baseURL || "").replace(/\/$/, "");
  const url = `${protocol}://${
    addressInfo.family === "IPv6"
      ? `[${addressInfo.address}]`
      : addressInfo.address
  }:${addressInfo.port}${baseURL}`;
  log.info(`Listening on ${url}`);
});

// Trap unhandled errors
trapUnhandledNodeErrors();

// Graceful shutdown
setupGracefulShutdown(listener, nitroApp);

// Websocket support
// https://crossws.unjs.io/adapters/node
if (import.meta._websocket) {
  const { handleUpgrade } = wsAdapter(nitroApp.h3App.websocket);
  server.on("upgrade", handleUpgrade);
}

// Scheduled tasks
if (import.meta._tasks) {
  startScheduleRunner();
}

registerServer(
  server)

export default {};
