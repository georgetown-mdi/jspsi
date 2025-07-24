import {
  createStartHandler,
  defaultStreamHandler,
} from '@tanstack/react-start/server'
import { createRouter } from './router'
import { PeerServer } from 'peer';

import * as http from 'http';
import * as https from 'https';

export default createStartHandler({
  createRouter,
})(defaultStreamHandler)

let peerServerServer: http.Server | https.Server;

export const peerServer = PeerServer(
  {
    port: 3001,
    path: "/api",
    corsOptions: { origin: ['http://localhost:3000'] }
  },
  (server) => {
    peerServerServer = server;
  }
);

// see: https://github.com/vitest-dev/vitest/issues/2334
if (import.meta.hot) {
  import.meta.hot.on("vite:beforeFullReload", () => {
    if (peerServerServer !== undefined)
       peerServerServer.close();
  })

  import.meta.hot.dispose(() => {
    if (peerServerServer !== undefined)
      peerServerServer.close()
  });
}

