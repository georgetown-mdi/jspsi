import type { IMessageQueue } from "./messageQueue.ts";
import { MessageQueue, messageByteSize } from "./messageQueue.ts";
import { randomUUID } from "node:crypto";
import type { IClient } from "./client.ts";
import type { IMessage } from "./message.ts";

export interface IRealm {
  getClientsIds(): string[];

  getClientById(clientId: string): IClient | undefined;

  getClientsIdsWithQueue(): string[];

  setClient(client: IClient, id: string): void;

  removeClientById(id: string): boolean;

  getMessageQueueById(id: string): IMessageQueue | undefined;

  addMessageToQueue(id: string, message: IMessage): void;

  clearMessageQueue(id: string): void;

  generateClientId(generateClientId?: () => string): string;
}

// Bounds on the relay's hold-for-reconnect queues. A registered client can
// address signaling messages to an arbitrary, unregistered `dst` id; each such
// id would otherwise allocate a queue and grow it without limit. These cap the
// number of distinct queued destinations, the depth of any one queue, and the
// total buffered bytes of any one queue, so an unconnected-destination spray
// cannot exhaust memory. All three are far above any legitimate rendezvous (a
// handful of queued frames for a momentarily-absent peer); a message dropped
// past any bound is a no-op for the spammer and only loses a frame for a real
// peer that is itself far past needing a reconnect hold.
export const MAX_OUTSTANDING_QUEUES = 1000;
export const MAX_MESSAGES_PER_QUEUE = 100;
// The message-count cap alone leaves a queue's resident ceiling at
// MAX_MESSAGES_PER_QUEUE times the inbound frame cap (256 KiB, the vendored
// MAX_SIGNALING_PAYLOAD_BYTES) -- ~25 MiB per queue, ~25 GiB across the full
// MAX_OUTSTANDING_QUEUES. This byte cap holds it down directly: a flood of
// max-size frames cannot push one queue past 256 KiB, so the global resident
// ceiling is ~256 MiB. It equals one max frame, so any single legal frame is
// always holdable; real signaling frames are KB-scale, so a queue still holds
// dozens of them.
export const MAX_QUEUE_BYTES = 256 * 1024;

export class Realm implements IRealm {
  private readonly clients = new Map<string, IClient>();
  private readonly messageQueues = new Map<string, IMessageQueue>();

  public getClientsIds(): string[] {
    return [...this.clients.keys()];
  }

  public getClientById(clientId: string): IClient | undefined {
    return this.clients.get(clientId);
  }

  public getClientsIdsWithQueue(): string[] {
    return [...this.messageQueues.keys()];
  }

  public setClient(client: IClient, id: string): void {
    this.clients.set(id, client);
  }

  public removeClientById(id: string): boolean {
    const client = this.getClientById(id);

    if (!client) return false;

    this.clients.delete(id);

    return true;
  }

  public getMessageQueueById(id: string): IMessageQueue | undefined {
    return this.messageQueues.get(id);
  }

  public addMessageToQueue(id: string, message: IMessage): void {
    let queue = this.getMessageQueueById(id);

    if (!queue) {
      // Refuse a new queue past the global cap so a spray to many distinct
      // unregistered destinations cannot allocate queues without bound.
      if (this.messageQueues.size >= MAX_OUTSTANDING_QUEUES) return;
      queue = new MessageQueue();
      this.messageQueues.set(id, queue);
    }

    // Cap the depth of any one queue for the same reason, by message count and
    // by total buffered bytes -- the byte check keeps the resident ceiling far
    // below the count cap times the max frame size. Size the frame once and
    // hand it to `addMessage` so the queue does not measure it a second time.
    const messageBytes = messageByteSize(message);
    if (queue.size() >= MAX_MESSAGES_PER_QUEUE) return;
    if (queue.byteSize() + messageBytes > MAX_QUEUE_BYTES) return;

    queue.addMessage(message, messageBytes);
  }

  public clearMessageQueue(id: string): void {
    this.messageQueues.delete(id);
  }

  public generateClientId(generateClientId?: () => string): string {
    const generateId = generateClientId ? generateClientId : randomUUID;

    let clientId = generateId();

    while (this.getClientById(clientId)) {
      clientId = generateId();
    }

    return clientId;
  }
}
