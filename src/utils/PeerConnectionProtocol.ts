import type { Peer, DataConnection } from "peerjs";

export type ConnectionHandler = (conn: DataConnection) => void;
export type MessageHandler = (conn: DataConnection, data) => void;

export class PeerConnectionProtocol {
  peer: Peer
  conn: DataConnection
  connectionHandler?: ConnectionHandler;
  messageHandlers: Array<MessageHandler>;
  firstMessage: boolean = false;
  
  constructor(
    peer: Peer,
    conn: DataConnection,
    connectionHandler: ConnectionHandler | undefined,
    messageHandlers: Array<MessageHandler>
  ) {
    this.peer = peer;
    this.conn = conn;
    this.connectionHandler = connectionHandler;
    this.messageHandlers = messageHandlers;
  }

  runProtocol(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.connectionHandler !== undefined) {
        this.conn.on('open', () => { this.connectionHandler!(this.conn) });
      }
      this.conn.on('data', (data) => {
        if (this.firstMessage) {
          this.peer.disconnect();
          this.firstMessage = false;
        }
        if (this.messageHandlers.length > 0) {
          const messageHandler = this.messageHandlers.shift()!;
          messageHandler(this.conn, data);
        }
        if (this.messageHandlers.length == 0) {
          resolve(this.conn.close());
        }
      });
      this.conn.on('error', (err) => { reject(err) })
    })
  }
}
