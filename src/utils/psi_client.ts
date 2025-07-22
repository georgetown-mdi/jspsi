import type { Session } from './sessions';

import type { Peer, DataConnection } from 'peerjs';

export class PSIAsClient {
  psi: any;
  data: Array<string>
  client: any;
  serverSetup: any

  messageHandlers = [
    (conn: DataConnection, data) => {
      console.log('responding server setup message with request');
      this.serverSetup = this.psi.serverSetup.deserializeBinary(data);
      const clientRequest = this.client.createRequest(this.data);

      conn.send(clientRequest.serializeBinary());
    },
    (conn: DataConnection, data) => {
      console.log('responding to server response by creating association table');
      const serverResponse = this.psi.response.deserializeBinary(data);
      const associationTable = this.client.getAssociationTable(
        this.serverSetup,
        serverResponse
      );
      let commonValues: Array<string> = [];
      for (var i = 0; i < associationTable[0].length; i++) {
        commonValues.push(this.data[associationTable[0][i]]);
      }
    }
  ]

  constructor(psi, data: Array<string>) {
    this.psi = psi;
    this.data = data;
    this.client = psi.client.createWithNewKey(true);
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
      debug: 2
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