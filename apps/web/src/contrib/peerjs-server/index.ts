// import express from "express";

// import { CreateInstanceWSOnly, createInstance } from "./instance.ts";
import { CreateInstanceWSOnly } from "./instance.ts";
import defaultConfig from "./config/index.ts";

// import type { PeerServerEvents, PeerServerInstance } from "./instance.ts";
import type { PeerServerInstance } from "./instance.ts";

import type { IClient } from "./models/client.ts";
import type { IConfig } from "./config/index.ts";
import type { IMessage } from "./models/message.ts";

import type { Server as HttpServer } from "node:http";
import type { Http2SecureServer as HttpsServer } from "node:http2";

export type { MessageType } from "./enums.ts";
// export type { IConfig, PeerServerEvents, IClient, IMessage };
export type { IConfig, IClient, IMessage };

/* export interface TanstackPeerServer {
  app: express.Express & PeerServerEvents
  instance: PeerServerInstance
} */


export function CreatePeerServerWSOnly(
  server: HttpServer | HttpsServer,
  options?: Partial<IConfig>,
): PeerServerInstance {
  const newOptions: IConfig = {
	  ...defaultConfig,
	  ...options,
  };

  return CreateInstanceWSOnly({server, options: newOptions})
}

/* export default function CreatePeerServer(
	server: HttpServer | HttpsServer,
	options?: Partial<IConfig>,
): TanstackPeerServer {
	const app = express();

	const newOptions: IConfig = {
		...defaultConfig,
		...options,
	};

  if (newOptions.proxied) {
   	app.set(
			"trust proxy",
			newOptions.proxied === "false" ? false : !!newOptions.proxied,
		);
  }

	// app.on("mount", () => {
		// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
		if (!server) {
			throw new Error(
				"Server is not passed to constructor - " + "can't start PeerServer",
			);
		}

	const instance = createInstance({ app, server, options: newOptions });
	// });

	return {
		instance,
		app: app as express.Express & PeerServerEvents
	}
} */
