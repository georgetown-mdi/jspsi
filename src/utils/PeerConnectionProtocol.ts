import type { DataConnection, Peer } from 'peerjs';

export type ConnectionHandler = (conn: DataConnection) => void;
export type MessageHandler = (conn: DataConnection, data: any) => void;

export class PeerConnectionProtocol {
  peer: Peer
  conn: DataConnection
  /** Function to run when the connection's 'open' event is received. */
  connectionHandler?: ConnectionHandler;
  /** Functions to run sequentially as data are received. */
  messageHandlers: Array<MessageHandler>;
  /** Function to run when the connection's 'close' event is received. */
  closeHandler?: ConnectionHandler;
  firstMessage = true;
  
  constructor(
    peer: Peer,
    conn: DataConnection,
    connectionHandler: ConnectionHandler | undefined,
    messageHandlers: Array<MessageHandler>,
    closeHander: ConnectionHandler | undefined
  ) {
    this.peer = peer;
    this.conn = conn;
    this.connectionHandler = connectionHandler;
    this.messageHandlers = messageHandlers;
    this.closeHandler = closeHander;
  }

  runProtocol(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.connectionHandler) {
        this.conn.on('open', () => { this.connectionHandler!(this.conn); });
      }
      this.conn.on('data', (data) => {
        if (this.firstMessage) {
          console.log('disconnecting from peer server');
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
      if (this.closeHandler) {
        this.conn.on('close', () => { this.closeHandler!(this.conn); });
      }
    })
  }
}
