import Peer from 'peerjs';

import { ShowStatusElements } from '../components/StatusStages.ts';

import type { DataConnection } from 'peerjs';

import type { ProtocolStage } from '../components/StatusStages.ts';

export const stages: Array<ProtocolStage> = [
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
  data: Array<string>;
  server: any;
  result: Array<string>;
  sortingPermutation: Array<number>
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
    (conn: DataConnection, data: any) => {
      console.log('responding to client request with server response');
      this.setStage('sending response')
      const clientRequest = this.psi.request.deserializeBinary(data);
      const serverResponse = this.server.processRequest(clientRequest);

      conn.send(serverResponse.serializeBinary());

      this.setStage('waiting for results');
    },
    (_conn: DataConnection, data: any) => {
      console.log('received association table');
      const associationTable = data as Array<Array<number>>;

      for (const i of associationTable[1]) {
        this.result.push(this.data[this.sortingPermutation[i]]);
      }
    }
  ]
  closeHandler = (_conn: DataConnection) => {
    this.setStage('done');
  }

  constructor(
    psi: any,
    data: Array<string>,
    setStage: (name: string) => void
  ) {
    this.psi = psi;
    this.data = data;
    this.server = psi.server.createWithNewKey(true);
    this.result = []
    this.sortingPermutation = []
    this.setStage = setStage;
  }
}

export function waitForPeerId(uuid: string): Promise<string> {
  return new Promise((resolve, reject) => {
    console.log(`opening event source at: /api/psi/${uuid}/wait`)
    const eventSource = new EventSource(
      `/api/psi/${uuid}/wait`, { withCredentials: true }
    );
    console.log('created event source at', eventSource.url);

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
    let host = window.location.hostname;
    if (host === 'localhost') host = '127.0.0.1'
    console.log(`connecting to peer server at ${host} and getting peer id`);
    
    const port = parseInt(window.location.port) || (
      window.location.protocol == 'http' ? 80 : 443
    )

    const peer = new Peer({
      host: host,
      path: "/api/",
      port: port,
      debug: 3,
      config: {
        iceServers: [
          {
            urls: [
              "stun:stun.l.google.com:19302",
              "stun:stunserver2024.stunprotocol.org:3478"
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

    peer.on('open', (id) => {
      console.log(`got peer id ${id} from peer server; connecting to peer ${peerId}`)
      const conn = peer.connect(peerId);
      resolve([peer, conn]);
    });

    peer.on('error', (err) => reject(err));
  });
}