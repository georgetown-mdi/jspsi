import { createReadStream } from "node:fs";

import {
  EncryptedMessageConnection,
  FileSyncConnection,
  authenticateConnection,
  decodeInvitation,
  fromEventConnection,
  loadCSVFile,
  loadPsiBackend,
  prepareForExchange,
  runExchange,
} from "@psilink/core";
// @ts-ignore this is really there
import PSI from "@openmined/psi.js/psi_wasm_web";

import {
  acceptorColumnsEditorState,
  acceptorInitialColumnsState,
  acceptorLaunchPayload,
} from "@exchange/acceptorColumnsModel";
import { authenticateExchange } from "@psi/authenticateExchange";
import { generateInvitation } from "@psi/invitation";
import { inviterExchangeDataSpec } from "@psi/authoring/advancedInviteTerms";
import { prepareAcceptorExchange } from "@exchange/acceptorExchange";

import { HarnessFileDropClient } from "./fileDropTransport";

import type {
  CSVRow,
  HandshakeRole,
  MessageConnection,
  PreparedExchange,
} from "@psilink/core";
import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

/** The CSV a party links on, parsed through the same core reader both runtimes
 * use, so a divergence here cannot be mistaken for a protocol one. */
async function readCsv(
  inputCsvPath: string,
): Promise<{ rawRows: Array<CSVRow>; columns: Array<string> }> {
  const parsed = await loadCSVFile(createReadStream(inputCsvPath));
  return { rawRows: parsed.data, columns: parsed.meta.fields ?? [] };
}

/** A web party's credential and prepared half of an exchange, whichever seat it
 * came from. */
export interface WebPartySetup {
  prepared: PreparedExchange;
  sharedSecret: string;
  expires?: string;
}

/** What a web party mints when it holds the inviter seat: its own setup plus the
 * token the CLI party accepts. */
export interface WebInvitation extends WebPartySetup {
  encoded: string;
}

/**
 * The web app's acceptor seat: adopt a partner's invitation and assemble this
 * party's half of the exchange from it.
 *
 * Every step is the app's own (apps/web/src/exchange): the confirm-columns editor's
 * seed over this file's header, the recommended per-type cleaning it derives, the
 * launch payload it hands off, and `prepareAcceptorExchange`'s terms adoption
 * with its disclosed-payload and partner-deduplicate commitments. What the harness
 * supplies is the CSV and the name -- an acceptor who opened the file and edited
 * nothing.
 */
export async function acceptAsWebParty(params: {
  token: string;
  identity: string;
  inputCsvPath: string;
}): Promise<WebPartySetup> {
  const { token, identity, inputCsvPath } = params;
  const decoded = await decodeInvitation(token);
  const { rawRows, columns } = await readCsv(inputCsvPath);
  const { edits } = acceptorLaunchPayload(
    acceptorColumnsEditorState(
      acceptorInitialColumnsState(columns),
      decoded.linkageTerms,
      rawRows,
    ),
  );
  return {
    prepared: prepareAcceptorExchange({
      linkageTerms: decoded.linkageTerms,
      acceptorName: identity,
      edits,
      rawRows,
      columns,
      disclosedPayloadColumns: decoded.disclosedPayloadColumns,
    }),
    sharedSecret: decoded.sharedSecret,
    expires: decoded.expires,
  };
}

/**
 * The web app's inviter seat: mint an invitation naming the shared file-drop
 * directory, and assemble this party's half on the terms the token holds.
 *
 * `generateInvitation` is the app's own mint, taken on its `profiledColumns`
 * branch (the console's, where columns are known without the browser parsing
 * the file) since that is the branch a node host's CSV handling can reach.
 * It returns no rows on that branch (the console hands the run to the CLI),
 * so the rows this party links on are read here and bound through
 * `inviterExchangeDataSpec`, the app's own inviter spec assembly.
 */
export async function inviteAsWebParty(params: {
  identity: string;
  inputCsvPath: string;
  dropDir: string;
}): Promise<WebInvitation> {
  const { identity, inputCsvPath, dropDir } = params;
  const { rawRows, columns } = await readCsv(inputCsvPath);
  const minted = await generateInvitation({
    inviterName: identity,
    profiledColumns: columns,
    location: {
      origin: "http://127.0.0.1:3000",
      hostname: "127.0.0.1",
      port: "3000",
    },
    connectionEndpoint: { channel: "filedrop", path: dropDir },
  });
  return {
    encoded: minted.encoded,
    sharedSecret: minted.sharedSecret,
    expires: minted.expires,
    prepared: prepareForExchange(
      inviterExchangeDataSpec(minted.linkageTerms),
      identity,
      rawRows,
      columns,
    ),
  };
}

/**
 * Which handshake driver the web party runs.
 *
 * `app` is the web app's own {@link authenticateExchange}: it asks for no
 * application-layer AEAD and refuses a partner that asks, since the app exchanges
 * only over a DTLS-confidential WebRTC channel. A CLI party on a file-sync channel
 * asks unconditionally -- the frames sit in a share whose admin can read them --
 * so `applyEncryption` (the OR of both requests) forces this driver to fail closed.
 *
 * `aead-stand-in` is what a web party WOULD run if the app applied the
 * file-sync wrap: the same core handshake asking for encryption, and core's
 * `EncryptedMessageConnection` over the result. It stands in for the one piece
 * apps/web does not implement, so the completing arms can exercise everything
 * above and below it. Nothing else on the web party's side is substituted.
 */
export type WebHandshakeDriver = "app" | "aead-stand-in";

/** One web party's completed exchange. */
export interface WebPartyOutcome {
  /** The partner's declared identity, read off the agreed terms. */
  partnerIdentity: string | undefined;
  /** The matched (own row, partner row) pairs, ascending by own row. */
  pairs: Array<[number, number]>;
}

/** The matched pairs an exchange result holds, ordered so two parties'
 * mirrored tables compare directly. */
function matchedPairs(
  associationTable: [Array<number>, Array<number>] | undefined,
): Array<[number, number]> {
  if (associationTable === undefined) return [];
  const [own, partner] = associationTable;
  return own
    .map((row, index): [number, number] => [row, partner[index]])
    .sort((a, b) => a[0] - b[0]);
}

/**
 * Run one web party's half of a live exchange over the shared file-drop
 * directory: meet the partner at the rendezvous, authenticate, and run the PSI
 * rounds on the browser WASM engine the app selects.
 *
 * The PSI backend is loaded exactly as the app loads it -- `loadPsiBackend` with
 * only a WASM loader and `isNode: false`, over `@openmined/psi.js/psi_wasm_web`
 * -- so this party never reaches the native addon a CLI party may pick. That
 * asymmetry is by design: the two engines agreeing on the wire is the point.
 */
export async function runWebPartyExchange(params: {
  dropDir: string;
  setup: WebPartySetup;
  driver: WebHandshakeDriver;
  pollIntervalMs: number;
  peerTimeoutMs: number;
}): Promise<WebPartyOutcome> {
  const { dropDir, setup, driver, pollIntervalMs, peerTimeoutMs } = params;
  const connection = new FileSyncConnection(new HarnessFileDropClient(), {
    verbose: -1,
  });
  try {
    await connection.open({
      channel: "filedrop",
      path: dropDir,
      options: { pollIntervalMs, peerTimeoutMs },
    });
    await connection.synchronize();
    const handshakeRole = connection.handshakeRole;
    if (handshakeRole === undefined)
      throw new Error("the rendezvous negotiated no handshake role");
    // Polling must be running before the handshake: the bridge below feeds an
    // awaited receive() from the poll loop's inbound frames.
    connection.start();

    const transport = fromEventConnection(connection, {
      inactivityTimeoutMs: peerTimeoutMs,
    });
    const secure = await authenticateAndWrap(
      transport,
      handshakeRole,
      setup,
      driver,
    );

    const { library } = await loadPsiBackend(
      { loadWasm: () => PSI() as Promise<PSILibrary> },
      { isNode: false },
    );
    const result = await runExchange(secure, handshakeRole, setup.prepared, {
      psiLibrary: library,
      verbosity: -1,
    });
    return {
      partnerIdentity: result.partnerTerms.identity,
      pairs: matchedPairs(result.associationTable),
    };
  } finally {
    await connection.close().catch(() => {});
  }
}

/** Authenticate through the chosen driver and return the connection the PSI
 * rounds run on -- wrapped when the handshake negotiated the AEAD. */
async function authenticateAndWrap(
  transport: MessageConnection,
  handshakeRole: HandshakeRole,
  setup: WebPartySetup,
  driver: WebHandshakeDriver,
): Promise<MessageConnection> {
  if (driver === "app") {
    await authenticateExchange(
      transport,
      handshakeRole,
      setup.sharedSecret,
      setup.expires,
    );
    return transport;
  }
  const { sessionKey, applyEncryption } = await authenticateConnection(
    transport,
    { sharedSecret: setup.sharedSecret, expires: setup.expires },
    handshakeRole,
    true,
  );
  return applyEncryption
    ? await EncryptedMessageConnection.create(
        transport,
        sessionKey,
        handshakeRole,
      )
    : transport;
}
