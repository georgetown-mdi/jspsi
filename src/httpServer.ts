import type * as http from 'node:http';
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

function isSecure(server: http.Server | http2.Http2SecureServer): server is http2.Http2SecureServer {
  // @ts-ignore performs type guard
  return server.setSecureContext === undefined
}

export function getHostname() {
  const server = getServer()!;

  const addressInfo = server.address();

  if (typeof(addressInfo) === 'string') {
    // running on a unix socket
    return addressInfo; 
  }

  const protocol = isSecure(server) ? 'https' : 'http';

  // no clue what is happening if we don't have an address
  if (!addressInfo) throw Error('no address information available for getHostname');
  
  const port = protocol === 'http'
    ? (addressInfo.port !== 80 ? addressInfo.port.toString() : undefined)
    : (addressInfo.port !== 443 ? addressInfo.port.toString() : undefined);

  const onLoopback =
    (addressInfo.family === 'IPv6' && addressInfo.address === '::1')
    || (
       addressInfo.family === 'IPv4'
       && (
        addressInfo.address === 'localhost'
        || addressInfo.address.startsWith('127.0.0.')
       )
    );
  const listeningEverywhere = 
    (addressInfo.family === 'IPv6' && addressInfo.address === '::')
    || (addressInfo.family === 'IPv4' && addressInfo.address === '0.0.0.0');

  const hostname = (
    onLoopback ? addressInfo.address : (
      listeningEverywhere ? 'localhost' : addressInfo.address
    )
  );
  
  return `${protocol}://${hostname}${port ? ':' + port : ''}`;
}

