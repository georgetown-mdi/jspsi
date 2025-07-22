import type { Session } from './sessions'

import type { Peer, DataConnection } from 'peerjs';

export class PSIAsServer {
  psi: any;
  data: Array<string>
  server: any;

  startupHandler = (conn: DataConnection) => {
    console.log('creating server setup message for new connection');
    this.server = this.psi.server.createWithNewKey(true);

    let sortingPermutation: Array<number> = [];
    const serverSetup = this.server.createSetupMessage(
      0.0,
      -1,
      this.data,
      this.psi.dataStructure.Raw,
      sortingPermutation
    );

    conn.send(serverSetup.serializeBinary());
  }
  messageHandlers = [
    (conn: DataConnection, data) => {
      console.log('responding to client request with server response');
      const clientRequest = this.psi.request.deserializeBinary(data);
      const serverResponse = this.server.processRequest(clientRequest);
      conn.send(serverResponse.serializeBinary());
    }
  ]

  constructor(psi, data: Array<string>) {
    this.psi = psi;
    this.data = data;
    this.server = psi.server.createWithNewKey(true);
  }
}

export function waitForPeerId(session: Session): Promise<string> {
  return new Promise((resolve, reject) => {
    console.log('creating event source');
    const eventSource = new EventSource(
      `/api/psi/${session['id']}/wait`,
      { withCredentials: true }
    );

    eventSource.addEventListener('open', () => {
      console.log("SSE connection opened; waiting for peer id");
    });
    
    eventSource.addEventListener('message', (event) => {
      try {
        const messageData = event.data && JSON.parse(event.data);
        if (!("invitedPeerId" in messageData)) {
          console.error("received unexpected message from server:", messageData, "; closing event source");
  
          eventSource.close();
          reject('unexpected message from server: ' + event.data);
        } else {
          const invitedPeerId = messageData["invitedPeerId"];
          console.log(`received peer id ${invitedPeerId}`);
  
          eventSource.close();
          resolve(invitedPeerId);
        }
      } catch (err) {
        console.error('error parsing message:', err);
        eventSource.close();
        reject(err);
      }
    });

    eventSource.addEventListener('error', (event) => {
      console.error ('EventSource error: ', event);
      eventSource.close();
      reject(new Error('EventSource connection error:' + event.type));
    });
  });
}

export function openPeerConnection(peerId: string): Promise<[Peer, DataConnection]> {
  return new Promise((resolve, reject) => {
    // @ts-ignore - Peer is imported in client-side route code
    const peer = new Peer({
      host: "/",
      path: "/api/",
      port: 3001,
      debug: 2
    });

    peer.on('open', (_id) => {
      const conn = peer.connect(peerId);
      resolve([peer, conn]);
    });

    peer.on('error', (err) => reject(err));
  });
}