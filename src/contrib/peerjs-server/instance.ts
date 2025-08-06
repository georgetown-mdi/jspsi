import path from "node:path";

import { CheckBrokenConnections } from "./services/checkBrokenConnections/index.ts";
import { MessageHandler } from "./messageHandler/index.ts";
import { MessagesExpire } from "./services/messagesExpire/index.ts";
import { Realm } from "./models/realm.ts";
import { WebSocketServer } from "./services/webSocketServer/index.ts";

import defaultConfig from "./config/index.ts";

// import type express from "express";

import type { IMessagesExpire } from "./services/messagesExpire/index.ts";
import type { IRealm } from "./models/realm.ts";
import type { IWebSocketServer } from "./services/webSocketServer/index.ts";

import type { Http2SecureServer as Http2Server } from "node:http2";
import type { Server as HttpServer } from "node:http";
import type { Server as HttpsServer } from "node:https";

import type { IClient } from "./models/client.ts";
import type { IConfig } from "./config/index.ts";
import type { IMessage } from "./models/message.ts";


/* export interface PeerServerEvents {
	on:
		((event: "connection", listener: (client: IClient) => void) => this)
		& ((event: "message", listener: (client: IClient, message: IMessage) => void) => this)
	    & ((event: "disconnect", listener: (client: IClient) => void) => this)
	    & ((event: "error", listener: (client: Error) => void) => this)
} */

export interface PeerServerInstance {
	config: IConfig
	realm: IRealm
}

export function CreateInstanceWSOnly(
	{ server, options } :
	{ server: HttpServer | Http2Server, options?: Partial<IConfig> }
): PeerServerInstance
{
	const config: IConfig = {
		...defaultConfig,
		...options,
	};
	const realm: IRealm = new Realm();
	const messageHandler = new MessageHandler(realm);

	const messagesExpire: IMessagesExpire = new MessagesExpire({
		realm,
		config,
		messageHandler,
	});
	const checkBrokenConnections = new CheckBrokenConnections({
		realm,
		config,
		onClose: (client) => {
			console.log("disconnect", client);
		},
	});

	const customConfig = {
		...config,
		path: path.posix.join(config.path, "/"),
	};

	const wss: IWebSocketServer = new WebSocketServer({
		server: server as HttpServer | HttpsServer,
		realm: realm,
		config: customConfig,
	});

	wss.on("connection", (client: IClient) => {
		const messageQueue = realm.getMessageQueueById(client.getId());

		if (messageQueue) {
			let message: IMessage | undefined;

			while ((message = messageQueue.readMessage())) {
				messageHandler.handle(client, message);
			}
			realm.clearMessageQueue(client.getId());
		}
        
        // emit("connection", client)
		// console.log();
	});

	wss.on("message", (client: IClient, message: IMessage) => {
		// console.log("message", client, message);
		messageHandler.handle(client, message);
	});

	wss.on("close", (_client: IClient) => {
		// console.log("disconnect", client);
	});

	wss.on("error", (_error: Error) => {
		// console.log("error", error);
	});

	messagesExpire.startMessagesExpiration();
	checkBrokenConnections.start();

	return { config, realm };
}

/* export const createInstance = ({
	app,
	server,
	options,
}: {
	app: express.Application;
	server: HttpServer | Http2Server;
	options: IConfig;
}): PeerServerInstance => {
	const config = options;
	const realm: IRealm = new Realm();
	const messageHandler = new MessageHandler(realm);

	// const api = Api({ config, realm, corsOptions: options.corsOptions });
	const messagesExpire: IMessagesExpire = new MessagesExpire({
		realm,
		config,
		messageHandler,
	});
	const checkBrokenConnections = new CheckBrokenConnections({
		realm,
		config,
		onClose: (client) => {
			app.emit("disconnect", client);
		},
	});

	// app.use(options.path, api);

	// use mountpath for WS server
	const customConfig = {
		...config,
		path: path.posix.join(app.path(), options.path, "/"),
	};

	const httpServer = server as HttpServer | HttpsServer;
	const wss: IWebSocketServer = new WebSocketServer({
		server: httpServer,
		realm: realm,
		config: customConfig,
	});

	wss.on("connection", (client: IClient) => {
		const messageQueue = realm.getMessageQueueById(client.getId());

		if (messageQueue) {
			let message: IMessage | undefined;

			while ((message = messageQueue.readMessage())) {
				messageHandler.handle(client, message);
			}
			realm.clearMessageQueue(client.getId());
		}

		app.emit("connection", client);
	});

	wss.on("message", (client: IClient, message: IMessage) => {
		app.emit("message", client, message);
		messageHandler.handle(client, message);
	});

	wss.on("close", (client: IClient) => {
		app.emit("disconnect", client);
	});

	wss.on("error", (error: Error) => {
		app.emit("error", error);
	});

	messagesExpire.startMessagesExpiration();
	checkBrokenConnections.start();

	return { config, realm }
}; */
