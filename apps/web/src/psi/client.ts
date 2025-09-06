import logLibrary from 'loglevel';

import Peer from 'peerjs';

import { ConfigManager } from '@utils/clientConfig';

import type { LinkSession } from '@utils/sessions';

const { getLogger } = logLibrary;
const log = getLogger('client');

const configManager = new ConfigManager();
const config = await configManager.load();


/** Connects to peer server, gets a peer id, and posts to API. Returns Peer. */
export function createAndSharePeerId(session: LinkSession): Promise<Peer> {
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
          },*/
        ],
        sdpSemantics: 'unified-plan',
        iceTransportPolicy: 'all',
      }
    });

    peer.once('open', function(id: string) {
      log.info(`got peer id ${id} from peer server; posting to server`)

      fetch(`/api/psi/${session['uuid']}`, {
        headers: {
          'Content-Type': 'application/json'
        },
        method: 'POST',
        body: JSON.stringify({
          invitedPeerId: id
        })
      }).then((response) => {
        if (!response.ok) {
          log.error(`error posting peer id: ${response.status}, text: ${response.statusText}`)
          reject(new Error(`error posting peer id: ${response.status}, text: ${response.statusText}`));
        } else {
          resolve(peer);
        }
      });
    })

    peer.on('error', function(err: Error) {
      log.error('error getting peer connection:', err);
      reject(err)
    });
  });
}