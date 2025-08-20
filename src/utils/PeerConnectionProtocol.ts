import type { DataConnection, Peer } from 'peerjs';

export type ConnectionHandler = (conn: DataConnection) => void;
export type MessageHandler = (
  conn: DataConnection,
  data: any,
  next: (() => void)
) => void;

export class PeerConnectionProtocol {
  /** Functions to run sequentially as data are received. */
  private messageHandlers: Array<MessageHandler>;
  /** Function to run when the connection's 'open' event is received. */
  private connectionHandler?: ConnectionHandler;
  /** Function to run when the connection's 'close' event is received. */
  private closeHandler?: ConnectionHandler;
  private firstMessage = true;

  constructor(
    messageHandlers: Array<MessageHandler>,
    connectionHandler?: ConnectionHandler,
    closeHander?: ConnectionHandler
  ) {
    this.messageHandlers = messageHandlers;
    this.connectionHandler = connectionHandler;
    this.closeHandler = closeHander;
  }

  public runProtocol(peer: Peer, conn: DataConnection): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.connectionHandler) {
        conn.on('open', () => {
          try {
            this.connectionHandler!(conn);
          } catch (error) {
            conn.close();
            reject(error);
          }
        });
      }
      conn.on('data', (data) => {
        if (this.firstMessage) {
          peer.disconnect();
          this.firstMessage = false;
        }
        const next = () => {
          if (this.messageHandlers.length > 0) {
            const currentHandler = this.messageHandlers.shift()!;
            try {
              currentHandler(conn, data, next);
            } catch (error) {
              conn.close();
              reject(error);
            }
          }
        }
        next();
        if (this.messageHandlers.length == 0) {
          resolve(conn.close());
        }
      });
      conn.on('error', (err) => { reject(err) })
      if (this.closeHandler) {
        conn.on('close', () => {
          try {
            this.closeHandler!(conn);
          } catch (error) {
            reject(error);
          }
        });
      }
    })
  }
}
