import log from 'loglevel';

import Peer from 'peerjs';

import { ConfigManager } from '@utils/clientConfig';

import type { DataConnection } from 'peerjs';

const configManager = new ConfigManager();
const config = await configManager.load();

export function waitForPeerId(uuid: string): Promise<string> {
  return new Promise((resolve, reject) => {
    log.info(`opening event source at: /api/psi/${uuid}/wait`)
    const eventSource = new EventSource(
      `/api/psi/${uuid}/wait`, { withCredentials: true }
    );
    log.info('created event source at', eventSource.url);

    eventSource.addEventListener('message', (event) => {
      try {
        const messageData = event.data && JSON.parse(event.data);
        if (!("invitedPeerId" in messageData)) {
          log.error("received unexpected message from server:", messageData, "; closing event source");
  
          eventSource.close();
          reject('unexpected message from server: ' + event.data);
        } else {
          const invitedPeerId = messageData["invitedPeerId"];
          log.info(`received peer id ${invitedPeerId}`);
  
          eventSource.close();
          resolve(invitedPeerId);
        }
      } catch (err) {
        log.error('error parsing message:', err);
        eventSource.close();
        reject(err);
      }
    });

    eventSource.addEventListener('error', (event) => {
      log.error('EventSource error: ', event);
      eventSource.close();
      reject(new Error('EventSource connection error:' + event.type));
    });
  });
}

export function openPeerConnection(peerId: string): Promise<[Peer, DataConnection]> {
  return new Promise((resolve, reject) => {
    let host = window.location.hostname;
    if (host === 'localhost') host = '127.0.0.1'
    log.info(`connecting to peer server at ${host} and getting peer id`);
    
    const port = parseInt(window.location.port) || (
      window.location.protocol == 'http' ? 80 : 443
    )

    const peer = new Peer({
      host: host,
      path: "/api/",
      port: port,
      debug: config.PEERJS_DEBUG_LEVEL,
      config: {
        iceServers: [
          {
            urls: [
              "stun:stun.l.google.com:19302",
              "stun:44.247.30.68:443"
            ]
          },
          /* Explicitly disable TURN survers, since they relay data. This is
             mostly semantics since all data is relayed across servers on the
             Internet, but we should look into establishing our own TURN
             servers at some point.
           */
          /* {
            urls: [
              "turn:eu-0.turn.peerjs.com:3478",
              "turn:us-0.turn.peerjs.com:3478",
            ],
            username: "peerjs",
            credential: "peerjsp",
          },
          */
        ],
        'sdpSemantics': 'unified-plan',
        iceTransportPolicy: 'all',
      }
    });

    peer.once('open', (id) => {
      log.info(`got peer id ${id} from peer server; connecting to peer ${peerId}`)
      const conn = peer.connect(peerId, {reliable: true});
      resolve([peer, conn]);
    });

    peer.on('error', (err) => {
      log.error('error getting peer connection:', err);
      reject(err)}
    );
  });
}