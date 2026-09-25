import { Buffer } from "node:buffer";

import { MessageType } from "../../../enums.ts";
import type { IClient } from "../../../models/client.ts";
import type { IMessage } from "../../../models/message.ts";
import type { IRealm } from "../../../models/realm.ts";

// Bound on the bytes the relay leaves queued toward one destination socket
// that has not yet taken them. A destination that stops reading is dropped
// once a relayed frame would take its socket's `bufferedAmount` past this: its
// socket is terminated, its registration removed, and the sender told it left.
// One inbound frame is at most MAX_SIGNALING_PAYLOAD_BYTES, and decoding it can
// triple its size (an invalid UTF-8 byte becomes a three-byte U+FFFD), so 1 MiB
// holds any single relayed frame on an idle socket. See
// docs/spec/CHANNEL_SECURITY.md.
export const MAX_RELAY_BUFFERED_BYTES = 1024 * 1024;

export const TransmissionHandler = ({
  realm,
}: {
  realm: IRealm;
}): ((client: IClient | undefined, message: IMessage) => boolean) => {
  const handle = (client: IClient | undefined, message: IMessage) => {
    const type = message.type;
    const srcId = message.src;
    const dstId = message.dst;

    const destinationClient = realm.getClientById(dstId);

    if (destinationClient) {
      const socket = destinationClient.getSocket();
      let delivered = false;
      try {
        if (socket) {
          const data = JSON.stringify(message);

          if (
            socket.bufferedAmount + Buffer.byteLength(data, "utf8") <=
            MAX_RELAY_BUFFERED_BYTES
          ) {
            socket.send(data);
            delivered = true;
          }
        }
      } catch {
        delivered = false;
      }

      if (!delivered) {
        // The destination has no socket, cannot take a send, or has stopped
        // reading. Terminate rather than close: a peer that is not reading will
        // not answer a close frame either.
        socket?.terminate();
        realm.removeClient(destinationClient);

        handle(client, {
          type: MessageType.LEAVE,
          src: dstId,
          dst: srcId,
        });
      }
    } else {
      // Wait for this client to connect/reconnect (XHR) for important
      // messages.
      const ignoredTypes = [MessageType.LEAVE, MessageType.EXPIRE];

      if (!ignoredTypes.includes(type) && dstId) {
        // A frame the realm will not hold gets the answer a held frame gets
        // when its destination never arrives, without the wait for expiry.
        if (!realm.addMessageToQueue(dstId, message)) {
          handle(client, {
            type: MessageType.EXPIRE,
            src: dstId,
            dst: srcId,
          });
        }
      } else if (type === MessageType.LEAVE && !dstId) {
        // A client that leaves the realm leaves with its socket, so no socket
        // outlives its registration.
        if (client) {
          client.getSocket()?.terminate();
          realm.removeClient(client);
        }
      } else {
        // Unavailable destination specified with message LEAVE or EXPIRE
        // Ignore
      }
    }

    return true;
  };

  return handle;
};
