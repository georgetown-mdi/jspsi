/**
 * What a managed exchange's command-line `psilink.yaml` may hold: the one rule
 * both legs of the hand-off apply -- the export that writes the file
 * ({@link ./managedCronExport.ts}) and the import that reads one back
 * ({@link ./managedCommandLineImport.ts}).
 *
 * The rule is an allowlist measured off the app's own composition rather than a
 * list restated here: the connection may hold only what a credential-free webrtc
 * locator expands to ({@link connectionFromLocator}), and the document only the
 * top-level fields the record composer produces
 * ({@link composeManagedExchangeFile}), plus the `authentication` block the
 * export injects from the local max-age policy and the `retentionDisposition`
 * the record spec sanctions as operator-authored free text
 * (docs/spec/MANAGED_EXCHANGE_RECORD.md). The shared exchange-file schema is
 * wider than both: it can represent a TURN `credential`, a `provider_options`
 * map, an `ice_provision` auth block, a PeerJS `server.key`/`server.username`,
 * a shared secret, and a `signing` block (`identity_file`, `receipt_output`,
 * `partner_fingerprint`), and the CLI resolves an `@path` in the file it loads
 * (`apps/cli/src/util/atSignRefs.ts`). Exporting one would republish the
 * operator's own credential file for a scheduled run to open; importing one
 * would store a partner-supplied path for this app to hand back to the CLI on
 * the next export.
 *
 * Each leg words its own refusal -- what an operator does about a stored field
 * they cannot see differs from what they do about a line in the file in front of
 * them -- and both name FIELD NAMES only. A field's VALUE is the credential, and
 * it never enters a message.
 */

import {
  connectionFromLocator,
  getDefaultLinkageTerms,
  snakeizeKey,
} from "@psilink/core";

import { composeManagedExchangeFile } from "./managedExchangeRecord";

import type {
  ExchangeSpec,
  WebRTCConnectionConfig,
  WebRTCExchangeLocator,
} from "@psilink/core";
import type { ManagedExchangeFileComposition } from "./managedExchangeRecord";

/**
 * The locator both composition probes below are driven with: a webrtc locator
 * holding every optional field, so what each probe measures is the widest shape
 * the app can compose rather than the narrowest.
 */
const WIDEST_PROBE_LOCATOR: WebRTCExchangeLocator = {
  channel: "webrtc",
  host: "locator.invalid",
  port: 443,
  path: "/",
};

/**
 * The field names a credential-free webrtc locator expands to, at the
 * connection and its nested `server`. Read off {@link connectionFromLocator}'s
 * own webrtc arm rather than restated, so the allowlist cannot drift from the
 * composition rule (docs/spec/MANAGED_EXCHANGE_RECORD.md, "The connection
 * block: credential-free by composition").
 */
function credentialFreeLocatorFields(): {
  connection: ReadonlySet<string>;
  server: ReadonlySet<string>;
} {
  const composed = connectionFromLocator(WIDEST_PROBE_LOCATOR);
  if (composed.channel !== "webrtc")
    throw new Error(
      "the credential-free locator expansion did not compose a webrtc " +
        "connection from a webrtc locator",
    );
  return {
    connection: new Set(Object.keys(composed)),
    server: new Set(Object.keys(composed.server)),
  };
}

const CREDENTIAL_FREE_LOCATOR_FIELDS = credentialFreeLocatorFields();

/**
 * A webrtc connection's fields that a credential-free locator does not expand
 * to, named in the operator's own snake_case spelling so a refusal points at the
 * lines to remove, and sorted so two runs name them in one order. `role` is
 * outside the subset: the export injects it and the import reads it into the
 * record's local `side`, so a caller that has consumed it passes a connection
 * without it.
 */
export function fieldsOutsideLocatorSubset(
  connection: WebRTCConnectionConfig,
): Array<string> {
  const outside = Object.keys(connection).filter(
    (field) => !CREDENTIAL_FREE_LOCATOR_FIELDS.connection.has(field),
  );
  // Typed as required, but this gate runs on shapes that reached it without the
  // record read path's validation, so the nested object is read defensively: a
  // missing `server` is the exchange schema's refusal to make, not a TypeError
  // here.
  const server: unknown = connection.server;
  const serverFields =
    typeof server === "object" && server !== null ? Object.keys(server) : [];
  return [
    ...outside.map((field) => snakeizeKey(field)),
    ...serverFields
      .filter((field) => !CREDENTIAL_FREE_LOCATOR_FIELDS.server.has(field))
      .map((field) => `server.${snakeizeKey(field)}`),
  ].sort();
}

/**
 * The top-level document fields the app can put in a stored document, measured
 * by composing one. Typed `Required<ManagedExchangeFileComposition>`, so a
 * field added to the record composer's input fails this module's compile
 * until the probe holds it. Read off {@link composeManagedExchangeFile}'s
 * OUTPUT, not its input: the probe measures which KEYS survive composition,
 * never what they hold.
 */
function composableDocumentFields(): ReadonlySet<string> {
  const widestComposition: Required<ManagedExchangeFileComposition> = {
    connection: WIDEST_PROBE_LOCATOR,
    linkageTerms: getDefaultLinkageTerms("composition probe"),
    metadata: [],
    standardization: [],
    disclosedPayloadColumns: [],
    expectedPayloadColumns: [],
    expectedPartnerDeduplicate: false,
    outboundPayloadConsent: { status: "pending" },
    includeOwnColumns: "all",
    csvDelimiter: "|",
  };
  return new Set(Object.keys(composeManagedExchangeFile(widestComposition)));
}

/**
 * The top-level fields a command-line document may hold: what the app can
 * compose (above), plus the `authentication` block holding the max-age policy,
 * plus the `retentionDisposition` the record spec sanctions on a stored document
 * as operator-authored free text (docs/spec/MANAGED_EXCHANGE_RECORD.md, the
 * `exchangeFile` row). Nothing else the shared exchange-file schema can
 * represent belongs in a managed exchange's psilink.yaml.
 */
const COMMAND_LINE_DOCUMENT_FIELDS: ReadonlySet<string> = new Set([
  ...composableDocumentFields(),
  "authentication",
  "retentionDisposition",
]);

/**
 * A document's top-level fields outside {@link COMMAND_LINE_DOCUMENT_FIELDS},
 * named in the operator's own snake_case spelling and sorted. Names only -- a
 * field's VALUE is what the CLI would act on (a path it opens as this party's
 * signing identity, a path it writes a receipt to, a fingerprint it pins a
 * partner certificate against) and never enters a message.
 */
export function fieldsOutsideComposableDocument(
  document: ExchangeSpec,
): Array<string> {
  return Object.keys(document)
    .filter((field) => !COMMAND_LINE_DOCUMENT_FIELDS.has(field))
    .map((field) => snakeizeKey(field))
    .sort();
}
