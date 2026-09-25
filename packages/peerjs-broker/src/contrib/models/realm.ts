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

  /** Remove `client`'s registration only if the realm still maps its id to
   * that same client, so a stale holder of an id never removes the client that
   * registered it since. */
  removeClient(client: IClient): boolean;

  getMessageQueueById(id: string): IMessageQueue | undefined;

  /** Hold `message` for the unregistered destination `id`, answering whether
   * it was held; a frame past any queue bound is not. */
  addMessageToQueue(id: string, message: IMessage): boolean;

  clearMessageQueue(id: string): void;

  generateClientId(generateClientId?: () => string): string;
}

// Bounds on the relay's hold-for-reconnect queues. A registered client can
// address signaling messages to an arbitrary, unregistered `dst` id; each such
// id would otherwise allocate a queue and grow it without limit. These cap the
// number of distinct queued destinations, the depth of any one queue, and the
// total buffered bytes of any one queue, so an unconnected-destination spray
// cannot exhaust memory. All three are far above any legitimate rendezvous (a
// handful of queued frames for a momentarily-absent peer). A message past any
// bound is not held, and the relay answers its sender EXPIRE at once, as the
// expiry sweep would have for a held one.
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
// The number of distinct destinations one sender may hold frames for at once,
// so no one sender takes more than this share of MAX_OUTSTANDING_QUEUES. A
// rendezvous addresses the one partner it is waiting for. A destination
// stops counting against its senders when its queue is drained or expires.
// See docs/spec/CHANNEL_SECURITY.md.
export const MAX_QUEUED_DESTINATIONS_PER_SENDER = 8;

export class Realm implements IRealm {
  private readonly clients = new Map<string, IClient>();
  private readonly messageQueues = new Map<string, IMessageQueue>();
  // The senders holding frames in each queue, and the number of queues each
  // sender holds frames in, released together when a queue is cleared.
  private readonly queueSenders = new Map<string, Set<string>>();
  private readonly queuedDestinationCounts = new Map<string, number>();

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

  public removeClient(client: IClient): boolean {
    if (this.clients.get(client.getId()) !== client) return false;

    return this.clients.delete(client.getId());
  }

  public getMessageQueueById(id: string): IMessageQueue | undefined {
    return this.messageQueues.get(id);
  }

  public addMessageToQueue(id: string, message: IMessage): boolean {
    // Serialize the frame before allocating anything: the queue holds this
    // form, so the bytes checked against the caps below are the bytes it goes
    // on to retain. A frame carrying a non-string id field, or a payload with
    // no JSON form, throws here (and is dropped upstream) so it never keys a
    // queue or consumes a slot in one.
    const frame = serializeFrame(message);
    const sender = frame.message.src;

    const queue = this.getMessageQueueById(id);
    const senders = this.queueSenders.get(id);
    const senderIsNew = senders?.has(sender) !== true;

    if (
      senderIsNew &&
      (this.queuedDestinationCounts.get(sender) ?? 0) >=
        MAX_QUEUED_DESTINATIONS_PER_SENDER
    ) {
      return false;
    }
    if (!queue && this.messageQueues.size >= MAX_OUTSTANDING_QUEUES) {
      return false;
    }
    // Cap the depth of any one queue by message count and by total buffered
    // bytes -- the byte check keeps the resident ceiling far below the count
    // cap times the max frame size.
    if ((queue?.size() ?? 0) >= MAX_MESSAGES_PER_QUEUE) return false;
    if ((queue?.byteSize() ?? 0) + frame.byteSize > MAX_QUEUE_BYTES) {
      return false;
    }

    const heldBy = queue ?? new MessageQueue();
    heldBy.addMessage(frame);
    if (!queue) this.messageQueues.set(id, heldBy);

    if (senderIsNew) {
      if (senders) senders.add(sender);
      else this.queueSenders.set(id, new Set([sender]));
      this.queuedDestinationCounts.set(
        sender,
        (this.queuedDestinationCounts.get(sender) ?? 0) + 1,
      );
    }

    return true;
  }

  public clearMessageQueue(id: string): void {
    for (const sender of this.queueSenders.get(id) ?? []) {
      const remaining = (this.queuedDestinationCounts.get(sender) ?? 1) - 1;
      if (remaining > 0) this.queuedDestinationCounts.set(sender, remaining);
      else this.queuedDestinationCounts.delete(sender);
    }
    this.queueSenders.delete(id);
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
