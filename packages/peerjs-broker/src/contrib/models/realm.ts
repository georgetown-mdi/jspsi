import type { IMessageQueue } from "./messageQueue.ts";
import { MessageQueue, serializeFrame } from "./messageQueue.ts";
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
// MAX_MESSAGES_PER_QUEUE times the worst-case heap residency of one inbound
// frame. A frame is capped at 256 KiB on the wire (the vendored
// MAX_SIGNALING_PAYLOAD_BYTES), but V8 stores its payload as two bytes per
// character once it holds any non-Latin1 character, so one frame can occupy
// ~512 KiB of heap -- ~50 MiB per queue, ~50 GiB across the full
// MAX_OUTSTANDING_QUEUES. This byte cap holds it down directly, in the same
// worst-case resident bytes each frame is accounted at (UTF-16, 2 bytes/char),
// and the queue holds every frame serialized so those accounted bytes are the
// bytes it retains: a flood cannot push one queue past 512 KiB, so the global
// resident ceiling is ~512 MiB. The cap is 2x the wire frame cap, which holds a
// frame whose payload arrived as a string -- held exactly as it arrived --
// exactly up to a 33-character src; src is stamped after the wire cap is
// checked, so a longer legitimate id (e.g. a 36-character UUID) can push the
// same frame past the cap and drop it. A structured payload is held by its
// serialization, whose length the wire cap does not bound, so at the size
// extreme such a frame can account past the cap and be dropped. Real signaling
// frames are KB-scale, so a queue still holds dozens of them and the drop costs
// only that sender's own reconnect hold. See docs/spec/CHANNEL_SECURITY.md.
export const MAX_QUEUE_BYTES = 512 * 1024;

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
    // Serialize the frame before allocating anything: the queue holds this
    // form, so the bytes checked against the cap below are the bytes it goes on
    // to retain. A frame carrying a non-string id field, or a payload with no
    // JSON form, throws here (and is dropped upstream) so it never keys a queue
    // or consumes a slot in one.
    const frame = serializeFrame(message);

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
    // below the count cap times the max frame size.
    if (queue.size() >= MAX_MESSAGES_PER_QUEUE) return;
    if (queue.byteSize() + frame.byteSize > MAX_QUEUE_BYTES) return;

    queue.addMessage(frame);
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
