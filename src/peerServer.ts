import { lazy } from '@utils/lazy'

import { CreatePeerServerWSOnly } from '@peerjs-server/index'

import { getServer as getHttpServer } from './httpServer'

import type { AddressInfo } from "node:net";

import type { PeerServerInstance } from '@peerjs-server/instance';

function createPeerServer(): PeerServerInstance {
  const server = getHttpServer()!;

  const addressInfo = server.address() as AddressInfo;
  // @ts-ignore performs type guard
  const protocol = server.setSecureContext === undefined ? 'http' : 'https'

  let origin: boolean | string | Array<string | RegExp> = true;

  if (typeof addressInfo !== "string") {
    if (
      (addressInfo.family === "IPv6" && addressInfo.address == '::1')
      || (
        addressInfo.family === 'IPv4'
        && (
          addressInfo.address == 'localhost'
          || addressInfo.address.startsWith('127.0.0')
        )
      )
    ) {
      // on a loopback interface, so allow all loopbacks
      origin = [
        `${protocol}://localhost:${addressInfo.port}`,
        RegExp(`${protocol}://127\\.0\\.0\\.[0-9]:${addressInfo.port}`),
        `${protocol}://[::1]${addressInfo.port}`,
      ]
    } else if (
      (addressInfo.family === "IPv6"
        && (
          addressInfo.address == '::'
          || addressInfo.address == '0:0:0:0:0:0:0:0'
        )
      )
      || (addressInfo.family === "IPv4" && addressInfo.address == '0.0.0.0')
    ) {
      // listening to all, so disable cors
      origin = '*'
    }
  }


  return CreatePeerServerWSOnly(
    server,
    {
      corsOptions: { origin: origin },
      port: 3000,
      path: "/api",
    },
  )
}

export const usePeerServer = lazy(createPeerServer);
