import { expect, test } from "vitest";

import PSI from "@openmined/psi.js";

import { EncryptedMessageConnection } from "../../src/connection/encryptedMessageConnection";
import {
  MESSAGE_TYPE_BINARY,
  serializeFileSyncMessage,
} from "../../src/connection/fileSyncFraming";
import { MAX_FRAME_SIZE_BYTES } from "../../src/connection/frameSize";
import { createMessagePipe } from "../../src/connection/messageConnection";
import {
  PSI_ENCODED_ELEMENT_BYTES,
  PSI_SET_MAX_FRAMING_BYTES,
} from "../../src/connection/webrtcOutboundBound";
import { fileSyncMaxRoundSetValues } from "../../src/exchange";
import { serializeSetup } from "../../src/psi/psiChunks";

// The file-sync first-round ceiling at its real size: a server setup of the
// ceiling's values, sealed by the real cipher and framed as a message file,
// stays within the frame bound every file-sync receiver applies. The setup is
// the largest first-round message; its element list's length prefix is 5 bytes
// at this size. About 2 GB of heap, which is why it is the opt-in tier.

test("a setup file of the ceiling's values fits the frame bound", async () => {
  const values = fileSyncMaxRoundSetValues();
  const element = new Uint8Array(PSI_ENCODED_ELEMENT_BYTES - 2).fill(7);
  const setup = serializeSetup(
    await PSI(),
    new Array<Uint8Array>(values).fill(element),
  );
  expect(setup.length - values * PSI_ENCODED_ELEMENT_BYTES).toBe(
    PSI_SET_MAX_FRAMING_BYTES,
  );
  const [local, peer] = createMessagePipe();
  const sender = await EncryptedMessageConnection.create(
    local,
    new Uint8Array(32).fill(0x42),
    "initiator",
  );
  await sender.send(setup);
  const envelope = (await peer.receive()) as Uint8Array;
  const file = serializeFileSyncMessage(MESSAGE_TYPE_BINARY, 1, envelope);
  expect(file.length).toBeLessThanOrEqual(MAX_FRAME_SIZE_BYTES);
  expect(file.length + PSI_ENCODED_ELEMENT_BYTES).toBeGreaterThan(
    MAX_FRAME_SIZE_BYTES,
  );
}, 300_000);
