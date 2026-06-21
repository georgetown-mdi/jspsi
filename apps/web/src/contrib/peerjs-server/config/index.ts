import type { WebSocketServer, ServerOptions } from "ws";
import type { CorsOptions } from "cors";

export interface IConfig {
  readonly host: string;
  readonly port: number;
  readonly expire_timeout: number;
  readonly alive_timeout: number;
  // Shorter reap window for a client that has registered but not yet sent any
  // inbound frame. A real peer heartbeats within seconds of opening and graduates
  // to alive_timeout, so only a socket that registers and then goes silent (an
  // abandoned or junk registration) is cut at this bound, well before the
  // generous alive_timeout.
  readonly unconfirmed_timeout: number;
  readonly key: string;
  readonly path: string;
  readonly concurrent_limit: number;
  readonly allow_discovery: boolean;
  readonly proxied: boolean | string;
  readonly cleanup_out_msgs: number;
  readonly ssl?: {
    key: string;
    cert: string;
  };
  readonly generateClientId?: () => string;
  readonly createWebSocketServer?: (options: ServerOptions) => WebSocketServer;
  readonly corsOptions: CorsOptions;
}

const defaultConfig: IConfig = {
  host: "::",
  port: 9000,
  expire_timeout: 5000,
  alive_timeout: 90000,
  unconfirmed_timeout: 20000,
  key: "peerjs",
  path: "/",
  concurrent_limit: 5000,
  allow_discovery: false,
  proxied: false,
  cleanup_out_msgs: 1000,
  corsOptions: { origin: true },
};

export default defaultConfig;
