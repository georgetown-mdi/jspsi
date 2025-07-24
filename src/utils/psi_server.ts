import type { Peer, DataConnection } from 'peerjs';

import type { Session } from './sessions'
import type { ProtocolStage } from '../components/Status';

export const stages: ProtocolStage[] = [
  ['before start', 'Stopped', false, false],
  ['waiting for peer', 'Waiting for peer', true, false],
  ['sending startup message', 'Sending my encrypted data', true, true],
  ['waiting for client request', 'Waiting for partner\'s encrypted data', true, true],
  ['sending response', 'Sending partner\'s doubly-encrypted data', true, true],
  ['waiting for results', 'Waiting for results', true, true],
  ['done', 'Done', false, true]
];

export class PSIAsServer {
  psi: any;
  data: string[];
  server: any;
  result: string[];
  sortingPermutation: number[]
  setStage: (name: string) => void;

  startupHandler = (conn: DataConnection) => {
    console.log('creating server setup message for new connection');
    this.setStage('sending startup message')
    this.server = this.psi.server.createWithNewKey(true);

    const serverSetup = this.server.createSetupMessage(
      0.0,
      -1,
      this.data,
      this.psi.dataStructure.Raw,
      this.sortingPermutation
    );

    conn.send(serverSetup.serializeBinary());

    this.setStage('waiting for client request');
  }
  messageHandlers = [
    (conn: DataConnection, data) => {
      console.log('responding to client request with server response');
      this.setStage('sending response')
      const clientRequest = this.psi.request.deserializeBinary(data);
      const serverResponse = this.server.processRequest(clientRequest);

      conn.send(serverResponse.serializeBinary());

      this.setStage('waiting for results');
    },
    (_conn: DataConnection, data) => {
      console.log('received results')
      const associationTable = data as number[][];

      for (var i = 0; i < associationTable[0].length; i++) {
        this.result.push(this.data[associationTable[1][this.sortingPermutation[i]]]);
      }
    }
  ]
  closeHandler = (_conn: DataConnection) => {
    this.setStage('done');
  }

  constructor(psi, data: Array<string>, setStage: (name: string) => void) {
    this.psi = psi;
    this.data = data;
    this.server = psi.server.createWithNewKey(true);
    this.result = []
    this.sortingPermutation = []
    this.setStage = setStage;
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