import { CreateInstanceWSOnly } from "./instance.ts";
import defaultConfig from "./config/index.ts";

import type { PeerServerInstance } from "./instance.ts";
import type { SignalingDiagnosticSink } from "../diagnostics.ts";

import type { IClient } from "./models/client.ts";
import type { IConfig } from "./config/index.ts";
import type { IMessage } from "./models/message.ts";

import type { Server as HttpServer } from "node:http";
import type { Http2SecureServer as HttpsServer } from "node:http2";

export type { MessageType } from "./enums.ts";
export type { SignalingDiagnosticSink };
export type { IConfig, IClient, IMessage };

/**
 * Build the signaling server on an HTTP server the caller owns.
 *
 * `diagnosticSink` sits ahead of the options rather than among them because
 * this server has no silent mode: it writes reports an operator needs whether
 * or not anyone configured it, so every embedding states where they go.
 */
export function CreatePeerServerWSOnly(
  server: HttpServer | HttpsServer,
  diagnosticSink: SignalingDiagnosticSink,
  options?: Partial<IConfig>,
): PeerServerInstance {
  const newOptions: IConfig = {
    ...defaultConfig,
    ...options,
  };

  return CreateInstanceWSOnly({
    server,
    diagnosticSink,
    options: newOptions,
  });
}
