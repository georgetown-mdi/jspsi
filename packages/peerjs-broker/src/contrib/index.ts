import { CreateInstanceWSOnly } from "./instance.ts";
import defaultConfig from "./config/index.ts";

import type { PeerServerInstance } from "./instance.ts";

import type { IClient } from "./models/client.ts";
import type { IConfig } from "./config/index.ts";
import type { IMessage } from "./models/message.ts";

import type { Server as HttpServer } from "node:http";
import type { Http2SecureServer as HttpsServer } from "node:http2";

export type { MessageType } from "./enums.ts";
export type { IConfig, IClient, IMessage };

export function CreatePeerServerWSOnly(
  server: HttpServer | HttpsServer,
  options?: Partial<IConfig>,
): PeerServerInstance {
  const newOptions: IConfig = {
    ...defaultConfig,
    ...options,
  };

  return CreateInstanceWSOnly({ server, options: newOptions });
}
