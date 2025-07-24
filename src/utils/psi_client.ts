import type { Peer, DataConnection } from 'peerjs';

import type { Session } from './sessions';
import type { ProtocolStage } from '../components/Status';
import { ShowStatusElements } from '../components/Status';

export const stages: ProtocolStage[] = [
  ['before start', 'Stopped', ShowStatusElements.None],
  ['waiting for startup message', 'Waiting for partner\'s encrypted data', ShowStatusElements.ProgressBar],
  ['sending client request', 'Sending my encrypted data', ShowStatusElements.ProgressBar],
  ['waiting for response', 'Waiting for my doubly-encrypted data', ShowStatusElements.ProgressBar],
  ['sending results', 'Sending results', ShowStatusElements.ProgressBar],
  ['done', 'Done', ShowStatusElements.Completion]
];

export class PSIAsClient {
  psi: any;
  data: Array<string>
  client: any;
  serverSetup: any
  result: string[]
  setStage: (name: string) => void;

  messageHandlers = [
    (conn: DataConnection, data) => {
      console.log('responding server setup message with request');
      this.setStage('sending client request');
      this.serverSetup = this.psi.serverSetup.deserializeBinary(data);
      const clientRequest = this.client.createRequest(this.data);

      conn.send(clientRequest.serializeBinary());
      this.setStage('waiting for response');
    },
    (conn: DataConnection, data) => {
      console.log('responding to server response by creating association table');
      const serverResponse = this.psi.response.deserializeBinary(data);
      /** association table is indexes into client data mapped to the indexes
       * given by the server (which are likely permuted).
       */
      const associationTable: number[][] = this.client.getAssociationTable(
        this.serverSetup,
        serverResponse
      );

      this.setStage('sending results');

      conn.send(associationTable);

      for (var i = 0; i < associationTable[0].length; i++) {
        this.result.push(this.data[associationTable[0][i]]);
      }
    }
  ]
  closeHandler = (_conn: DataConnection) => {
    this.setStage('done');
  }

  constructor(psi, data: Array<string>, setStage: (name: string) => void) {
    this.psi = psi;
    this.data = data;
    this.client = psi.client.createWithNewKey(true);
    this.result = [];
    this.setStage = setStage;
  }
}

/** Connects to peer server, gets a peer id, and posts to API. Returns Peer. */
export function createAndSharePeerId(session: Session): Promise<Peer> {
  return new Promise((resolve, reject) => {
    // @ts-ignore - Peer is imported in client-side route code
    const peer = new Peer({
      host: "/",
      path: "/api/",
      port: 3001,
      debug: 2,
      config: {
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
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
          }, */
        ],
        sdpSemantics: 'unified-plan'
      }
    });

    peer.on('open', function(peerId: string) {
      console.log(`got peer id ${peerId} from peer server; posting to server`)
      fetch(`/api/psi/${session['id']}`, {
        headers: {
          'Content-Type': 'application/json'
        },
        method: 'POST',
        body: JSON.stringify({
          invitedPeerId: peerId
        })
      }).then((response) => {
        if (!response.ok) {
          console.error(`error posting peerId: ${response.status}, text: ${response.statusText}`)
          reject(new Error(`error posting peerId: ${response.status}, text: ${response.statusText}`));
        } else {
          resolve(peer);
        }
      });
    })

    peer.on('error', function(err: Error) {
      console.error('error getting peer connection:', err);
      reject(err)
    });
  });
}