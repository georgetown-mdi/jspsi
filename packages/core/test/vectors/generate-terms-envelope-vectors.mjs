// Regenerates terms-envelope-vectors.json: the field set every terms-exchange
// envelope puts on the wire, captured off a real exchangeTerms run. From the repo
// root:
//
//   npm run build -w packages/core   # the generator imports the built dist below
//   node packages/core/test/vectors/generate-terms-envelope-vectors.mjs > \
//     packages/core/test/vectors/terms-envelope-vectors.json
//   npm run format                   # apply the repo's JSON layout
//
// Purpose: the terms exchange is the one round-trip both parties always perform,
// and every piece of per-party, per-run role and bounds metadata rides its
// envelope beside `linkageTerms` -- the record count, the declared effective key
// count, the protocol version, the save intent, the payload-intent flag, and the
// observed host key (docs/spec/PROTOCOL.md, The counts ride the terms exchange).
// A partner reads that envelope by field name, so adding, renaming, dropping, or
// re-ordering one is a wire-format delta. Nothing pinned it: the suites around it
// assert what a field MEANS, never the whole set a frame holds. This file is
// that set, per frame slot, and packages/core/test/termsEnvelopeVectors.test.ts
// replays each scenario through the real exchangeTerms and holds the frames to it.
//
// The frames are CAPTURED, not authored: each scenario drives a genuine two-party
// exchange over createMessagePipe with every send recorded, so what lands here is
// what exchangeTerms emits rather than a second model of it. The two abort frames
// come from sendAbort directly, the abort slot being reachable only on a failure
// path; their `abortReasons` are fixed literals of this generator's own rather
// than real compatibility copy, so a reworded diagnostic does not move the pin.
// The abort frames hold no separate input block: sendAbort relays the reasons
// verbatim, so the captured `envelope.abortReasons` is also what the replay feeds
// back in.
//
// `linkageTerms` is carried out of the frames into a `linkageTerms` section at the
// top and named per frame by party, so the terms document appears once rather than
// once per frame. Nothing is lost: the consuming suite rebuilds each full frame
// from `fields`, `envelope`, and `carriesLinkageTerms` and compares that against
// the captured send. The terms document's own content is versioned by the
// operator-authored `linkage_terms.version`, a marker distinct from
// PROTOCOL_VERSION (docs/spec/PROTOCOL.md, Protocol-version reconcile at the terms
// exchange), so this file pins the ENVELOPE around it.

import { createMessagePipe } from "../../dist/core.esm.js";
import {
  PROTOCOL_VERSION,
  TERMS_ENVELOPE_FIELDS,
  exchangeTerms,
  sendAbort,
} from "../../dist/testing.esm.js";

// A compatible pair of minimal terms: two linkage keys, so the effective key
// count the envelope holds is clearly the key count rather than colliding with
// the 1 a single-key exchange would advertise. Identity is the only field that
// differs, which validateCompatibility permits.
const partyATerms = {
  version: "1.0.0",
  identity: "Party A",
  date: "2025-01-01",
  algorithm: "psi",
  linkageStrategy: "single-pass",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: [
    { name: "ssn", type: "ssn" },
    { name: "lastName", type: "last_name" },
  ],
  linkageKeys: [
    { name: "SSN", elements: [{ field: "ssn" }] },
    { name: "LN", elements: [{ field: "lastName" }] },
  ],
};

const partyBTerms = { ...partyATerms, identity: "Party B" };

// A third fixture holding no `identity` at all: the field is optional, and a
// party that supplied no name sends the terms with the key absent rather than
// empty. Same terms otherwise, so the scenario driving it differs from the
// others at the identity alone.
const unnamedPartyTerms = { ...partyATerms };
delete unnamedPartyTerms.identity;

const linkageTerms = {
  partyA: partyATerms,
  partyB: partyBTerms,
  unnamedParty: unnamedPartyTerms,
};

// Fixtures for the two fail-soft advertisement fields. The fingerprints are the
// canonical SHA256 shape at its real length; nothing here is a credential.
const initiatorHostKey = {
  fingerprint: "SHA256:" + "a".repeat(43),
  keyType: "ssh-ed25519",
};
const responderHostKey = {
  fingerprint: "SHA256:" + "b".repeat(43),
  keyType: "ecdsa-sha2-nistp256",
};

const scenarios = [
  {
    name: "every-optional-field-advertised",
    description:
      "Both parties advertise every optional envelope field: save intent, the " +
      "payload-intent flag, and an observed SFTP host key. This is the widest " +
      "frame a conforming party emits, so it is the one that names the whole " +
      "field set a partner decoder reads.",
    initiator: {
      terms: "partyA",
      recordCount: 100,
      saveIntent: true,
      hostKey: initiatorHostKey,
      disclosesPayload: true,
    },
    responder: {
      terms: "partyB",
      recordCount: 250,
      saveIntent: true,
      hostKey: responderHostKey,
      // Explicitly false rather than omitted: the flag is spread whenever the
      // caller supplies it, so a no-payload party still has an explicit
      // `disclosesPayload` the partner's withhold gate reads.
      disclosesPayload: false,
    },
  },
  {
    name: "no-optional-field-advertised",
    description:
      "Neither party passes an optional advertisement, so `save`, " +
      "`disclosesPayload`, and `hostKey` are OMITTED from the frame rather than " +
      "sent as null or false. The narrowest conforming frame, and the one that " +
      "pins which fields are mandatory on each slot.",
    initiator: { terms: "partyA", recordCount: 7 },
    responder: { terms: "partyB", recordCount: 0 },
  },
  {
    name: "responder-carries-no-identity",
    description:
      "The responder's terms carry no `identity` -- the field is optional, and " +
      "a party that supplied no name omits the key rather than sending an empty " +
      "string or a stand-in. Pins that the terms slot serializes the absence as " +
      "an absent key, and that the initiator reads the partner's identity back " +
      "as absent rather than as a value it invented.",
    initiator: { terms: "partyA", recordCount: 12 },
    responder: { terms: "unnamedParty", recordCount: 34 },
  },
];

const abortFrames = [
  {
    name: "responder-abort-message-2",
    slot: "message 2",
    sender: "responder",
    description:
      "The responder's message-2 slot doubles as its abort frame, so it carries " +
      "the terms and the protocol version the initiator reconciles before it " +
      "reads the decision -- and neither the record count nor any other role " +
      "metadata, which an abort has no use for.",
    carriesLinkageTerms: "partyB",
    abortReasons: ["a fixed reason, standing in for compatibility copy"],
  },
  {
    name: "initiator-abort-message-3",
    slot: "message 3",
    sender: "initiator",
    description:
      "The initiator's message-3 slot closes an exchange whose versions both " +
      "parties have already reconciled, so its abort carries the decision and " +
      "the reasons alone -- no terms, and no version.",
    carriesLinkageTerms: null,
    abortReasons: ["a fixed reason, standing in for compatibility copy"],
  },
];

/** Record every frame a connection sends, passing it through to the pipe. */
function recording(conn) {
  const sent = [];
  return {
    sent,
    conn: {
      send: (data) => {
        sent.push(data);
        return conn.send(data);
      },
      receive: (timeoutMs) => conn.receive(timeoutMs),
      close: () => conn.close(),
    },
  };
}

/** The frame with `linkageTerms` lifted out, plus the party it named. */
function splitFrame(frame) {
  const fields = Object.keys(frame);
  const envelope = {};
  let carriesLinkageTerms = null;
  for (const field of fields) {
    if (field !== "linkageTerms") {
      envelope[field] = frame[field];
      continue;
    }
    // Matched on the whole document rather than on `identity`, which is optional
    // and absent from one fixture: the terms a frame holds are one of the
    // fixtures above verbatim, so equality names which.
    const carried = JSON.stringify(frame.linkageTerms);
    carriesLinkageTerms = Object.keys(linkageTerms).find(
      (name) => JSON.stringify(linkageTerms[name]) === carried,
    );
    if (carriesLinkageTerms === undefined)
      throw new Error(
        "a captured frame carries linkage terms matching no fixture in this " +
          "generator; the frame could not be split.",
      );
  }
  return { fields, envelope, carriesLinkageTerms };
}

/** What the terms exchange handed each party back off the partner's envelope. */
function readBack(result) {
  return {
    // Null rather than undefined so an absent identity survives JSON: the field
    // is optional, and "the partner named itself none" is what this pins.
    partnerIdentity: result.partnerTerms.identity ?? null,
    partnerRecordCount: result.partnerRecordCount,
    partnerSaveIntent: result.partnerSaveIntent,
    partnerDisclosesPayload: result.partnerDisclosesPayload ?? null,
    partnerHostKey: result.partnerHostKey ?? null,
    partnerHostKeyMalformed: result.partnerHostKeyMalformed,
  };
}

const partySlots = {
  initiator: ["message 1", "message 3"],
  responder: ["message 2"],
};

async function runScenario(scenario) {
  const [rawInitiator, rawResponder] = createMessagePipe();
  const initiator = recording(rawInitiator);
  const responder = recording(rawResponder);

  const drive = (conn, role, side) =>
    exchangeTerms(
      conn,
      role,
      linkageTerms[side.terms],
      side.recordCount,
      side.saveIntent,
      side.hostKey,
      side.disclosesPayload,
    );

  const [initiatorResult, responderResult] = await Promise.all([
    drive(initiator.conn, "initiator", scenario.initiator),
    drive(responder.conn, "responder", scenario.responder),
  ]);

  const frames = [];
  for (const [sender, recorder] of [
    ["initiator", initiator],
    ["responder", responder],
  ]) {
    const slots = partySlots[sender];
    if (recorder.sent.length !== slots.length)
      throw new Error(
        `the ${sender} sent ${recorder.sent.length} frame(s) on a proceeding ` +
          `terms exchange, but the ${slots.length} slot(s) named here are ` +
          `${slots.join(", ")}; the scenario no longer matches the protocol.`,
      );
    recorder.sent.forEach((frame, index) => {
      frames.push({ sender, slot: slots[index], ...splitFrame(frame) });
    });
  }
  // Message order over the wire rather than per-party grouping, so the file reads
  // the way the exchange runs.
  frames.sort((a, b) => a.slot.localeCompare(b.slot));

  return {
    name: scenario.name,
    description: scenario.description,
    initiator: scenario.initiator,
    responder: scenario.responder,
    frames,
    reads: {
      initiator: readBack(initiatorResult),
      responder: readBack(responderResult),
    },
  };
}

/** Capture one sendAbort frame without a peer: the send is the whole surface. */
async function captureAbort(entry) {
  const sent = [];
  const conn = {
    send: async (data) => {
      sent.push(data);
    },
    receive: async () => ({}),
    close: () => {},
  };
  await sendAbort(
    conn,
    entry.abortReasons,
    entry.carriesLinkageTerms === null
      ? undefined
      : linkageTerms[entry.carriesLinkageTerms],
  );
  if (sent.length !== 1)
    throw new Error(
      `sendAbort emitted ${sent.length} frame(s) for ${entry.name}; the abort ` +
        "slot carries exactly one.",
    );
  return {
    name: entry.name,
    description: entry.description,
    sender: entry.sender,
    slot: entry.slot,
    ...splitFrame(sent[0]),
  };
}

const vectors = {
  description:
    "Known-answer vectors for the terms-exchange message envelope: the field " +
    "set, field order, and values each frame slot puts on the wire, captured " +
    "off a real exchangeTerms run rather than authored. Every piece of " +
    "per-party, per-run role and bounds metadata rides this envelope beside " +
    "`linkageTerms` -- the record count, the declared effective key count, the " +
    "protocol version, the save intent, the payload-intent flag, and the " +
    "observed host key -- and a partner reads each by name, so adding, " +
    "renaming, dropping, or re-ordering one is a wire-format delta. " +
    "`linkageTerms` is lifted out of each frame into the `linkageTerms` section " +
    "below and named per frame by party; the consuming suite rebuilds the full " +
    "frame from `fields`, `envelope`, and `carriesLinkageTerms`. The terms " +
    "document's own content is versioned by the operator-authored " +
    "`linkage_terms.version` rather than by PROTOCOL_VERSION, so what this file " +
    "pins is the envelope around it. `envelopeFields` is every field each slot " +
    "ADMITS, read off the schemas; the frames below are what each slot EMITS, " +
    "and the consuming suite holds their union to it so a field added to a " +
    "schema cannot ride the wire with no frame pinning it. Replayed by " +
    "packages/core/test/termsEnvelopeVectors.test.ts; regenerate with " +
    "generate-terms-envelope-vectors.mjs in this directory.",
  protocolVersion: PROTOCOL_VERSION,
  envelopeFields: TERMS_ENVELOPE_FIELDS,
  frameLayout:
    "Each frame is `fields` in that exact order. A field named in `fields` other " +
    "than `linkageTerms` takes its value from `envelope`; `linkageTerms` takes " +
    "the party named by `carriesLinkageTerms`. A field absent from `fields` is " +
    "absent from the frame -- omitted, never sent as null.",
  linkageTerms,
  scenarios: [],
  abortFrames: [],
};

for (const scenario of scenarios)
  vectors.scenarios.push(await runScenario(scenario));
for (const entry of abortFrames)
  vectors.abortFrames.push(await captureAbort(entry));

process.stdout.write(`${JSON.stringify(vectors, null, 2)}\n`);
