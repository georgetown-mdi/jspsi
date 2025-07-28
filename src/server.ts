import {
  createStartHandler,
  defaultStreamHandler,
} from '@tanstack/react-start/server'
import { PeerServer } from 'peer';
import { createRouter } from '@router'

import type * as http from 'node:http';
import type * as https from 'node:https';

export default createStartHandler({
  createRouter,
})(defaultStreamHandler)

let peerServerServer: http.Server | https.Server | undefined;

export const peerServer = PeerServer(
  {
    port: 3001,
    path: "/api",
    corsOptions: { origin: ['http://localhost:3000', 'http://127.0.0.1:3000'] }
  },
  (server) => {
    peerServerServer = server;
  }
);

// see: https://github.com/vitest-dev/vitest/issues/2334
if (import.meta.hot) {
  import.meta.hot.on("vite:beforeFullReload", () => {
    if (peerServerServer !== undefined) {
       peerServerServer.close();
       peerServerServer = undefined;
    }
  })

  import.meta.hot.dispose(() => {
    if (peerServerServer !== undefined) {
      peerServerServer.close()
      peerServerServer = undefined;
    }
  });
}

