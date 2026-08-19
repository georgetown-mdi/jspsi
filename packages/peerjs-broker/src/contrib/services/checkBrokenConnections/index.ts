import type { IConfig } from "../../config/index.ts";
import type { IClient } from "../../models/client.ts";
import type { IRealm } from "../../models/realm.ts";

const DEFAULT_CHECK_INTERVAL = 300;

type CustomConfig = Pick<IConfig, "alive_timeout" | "unconfirmed_timeout">;

export class CheckBrokenConnections {
  public readonly checkInterval: number;
  private timeoutId: NodeJS.Timeout | null = null;
  private readonly realm: IRealm;
  private readonly config: CustomConfig;
  private readonly onClose?: (client: IClient) => void;

  constructor({
    realm,
    config,
    checkInterval = DEFAULT_CHECK_INTERVAL,
    onClose,
  }: {
    realm: IRealm;
    config: CustomConfig;
    checkInterval?: number;
    onClose?: (client: IClient) => void;
  }) {
    this.realm = realm;
    this.config = config;
    this.onClose = onClose;
    this.checkInterval = checkInterval;
  }

  public start(): void {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
    }

    this.timeoutId = setTimeout(() => {
      this.checkConnections();

      this.timeoutId = null;

      this.start();
    }, this.checkInterval);
  }

  public stop(): void {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }

  private checkConnections(): void {
    const clientsIds = this.realm.getClientsIds();

    const now = new Date().getTime();
    const {
      alive_timeout: aliveTimeout,
      unconfirmed_timeout: unconfirmedTimeout,
    } = this.config;

    for (const clientId of clientsIds) {
      const client = this.realm.getClientById(clientId);

      if (!client) continue;

      // A client that has never sent an inbound frame since registering has not
      // established a real session, so it is reaped on the short unconfirmed
      // window rather than squatting a slot for the full alive_timeout. Once it
      // has shown liveness (its first frame sets `confirmed`) it keeps the
      // generous window, refreshed by each heartbeat, so a slow-but-live exchange
      // is never cut short -- the reap is tied to liveness, not a flat wall-clock.
      const timeout = client.isConfirmed() ? aliveTimeout : unconfirmedTimeout;
      const timeSinceLastPing = now - client.getLastPing();

      if (timeSinceLastPing < timeout) continue;

      try {
        client.getSocket()?.close();
      } finally {
        this.realm.clearMessageQueue(clientId);
        this.realm.removeClientById(clientId);

        client.setSocket(null);

        this.onClose?.(client);
      }
    }
  }
}
