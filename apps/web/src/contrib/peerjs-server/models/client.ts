import type WebSocket from "ws";

export interface IClient {
  getId(): string;

  getToken(): string;

  getSocket(): WebSocket | null;

  setSocket(socket: WebSocket | null): void;

  getLastPing(): number;

  setLastPing(lastPing: number): void;

  isConfirmed(): boolean;

  confirm(): void;

  resetLiveness(): void;

  send<T>(data: T): void;
}

export class Client implements IClient {
  private readonly id: string;
  private readonly token: string;
  private socket: WebSocket | null = null;
  private lastPing: number = new Date().getTime();
  // Set true once the client shows liveness (sends an inbound frame) on its
  // current socket; reset on each new socket attach (see resetLiveness). The
  // reaper uses it to tell a real, talking peer from a socket that registered and
  // went silent (see config `unconfirmed_timeout`).
  private confirmed: boolean = false;

  constructor({ id, token }: { id: string; token: string }) {
    this.id = id;
    this.token = token;
  }

  public getId(): string {
    return this.id;
  }

  public getToken(): string {
    return this.token;
  }

  public getSocket(): WebSocket | null {
    return this.socket;
  }

  public setSocket(socket: WebSocket | null): void {
    this.socket = socket;
  }

  public getLastPing(): number {
    return this.lastPing;
  }

  public setLastPing(lastPing: number): void {
    this.lastPing = lastPing;
  }

  public isConfirmed(): boolean {
    return this.confirmed;
  }

  public confirm(): void {
    this.confirmed = true;
    // An inbound frame is also an activity signal, so refresh the liveness clock
    // the reaper measures silence against -- not only HEARTBEAT frames advance it.
    this.lastPing = new Date().getTime();
  }

  public resetLiveness(): void {
    // A newly attached socket has not proven liveness yet, so return to the short
    // unconfirmed window measured from now. A reused client on the reconnect path
    // would otherwise carry a prior session's confirmed state into the new socket;
    // and resetting confirmed without refreshing lastPing could reap the
    // reconnecting client instantly against a stale prior-session timestamp.
    this.confirmed = false;
    this.lastPing = new Date().getTime();
  }

  public send<T>(data: T): void {
    this.socket?.send(JSON.stringify(data));
  }
}
