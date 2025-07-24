import type { Peer, DataConnection } from 'peerjs';

import type { Session } from './sessions'
import type { ProtocolStage } from '../components/Status';
import { ShowStatusElements } from '../components/Status';

export const stages: ProtocolStage[] = [
  ['before start', 'Stopped', ShowStatusElements.None],
  ['waiting for peer', 'Waiting for peer', ShowStatusElements.Spinner],
  ['sending startup message', 'Sending my encrypted data', ShowStatusElements.ProgressBar],
  ['waiting for client request', 'Waiting for partner\'s encrypted data', ShowStatusElements.ProgressBar],
  ['sending response', 'Sending partner\'s doubly-encrypted data', ShowStatusElements.ProgressBar],
  ['waiting for results', 'Waiting for results', ShowStatusElements.ProgressBar],
  ['done', 'Done', ShowStatusElements.Completion]
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
      console.log('received association table');
      const associationTable = data as number[][];

      for (var i = 0; i < associationTable[1].length; i++) {
        this.result.push(this.data[this.sortingPermutation[associationTable[1][i]]]);
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
        'sdpSemantics': 'unified-plan'
      }
    });

    peer.on('open', (_id) => {
      const conn = peer.connect(peerId);
      resolve([peer, conn]);
    });

    peer.on('error', (err) => reject(err));
  });
}