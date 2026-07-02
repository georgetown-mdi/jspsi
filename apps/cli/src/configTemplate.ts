import YAML from "yaml";

import {
  DEFAULT_MAX_RECONNECT_ATTEMPTS,
  DEFAULT_PEER_TIMEOUT_MS,
  DEFAULT_POLLING_FREQUENCY_MS,
  DEFAULT_SERVER_CONNECT_TIMEOUT_MS,
  snakeizeKeys,
} from "@psilink/core";
import type { LinkageTerms, Metadata, Standardization } from "@psilink/core";

// Placeholder server fields the operator must replace before the first exchange.
// Kept identical in spirit to the offline-invite placeholder connection
// (bootstrap.ts) so a config written by `init` and one written by `invite` both
// flag the same fields for editing.
const PLACEHOLDER_HOST = "REPLACE_WITH_SFTP_HOST";
const PLACEHOLDER_USERNAME = "REPLACE_WITH_SSH_USERNAME";

/**
 * The exchange-data portion of a template, as produced by `buildDataSpec`: the
 * linkage terms (always present -- default templates, or inferred from an input
 * file) plus the metadata and standardization that are inferred only when an
 * input file is given. Mirrors `ResolvedDataSpec` without coupling this module to
 * the bootstrap command layer.
 */
export interface TemplateDataSpec {
  linkageTerms: LinkageTerms;
  metadata?: Metadata;
  standardization?: Standardization;
}

const HEADER_LINES = [
  "psilink configuration template.",
  "",
  "Every option below is documented inline. Edit the placeholders (anything",
  "REPLACE_WITH_...), fill in your connection credentials, and review the",
  "linkage terms before running an exchange. The shared secret is NOT stored",
  "here -- it lives in the key file (.psilink.key), written by invite/accept.",
  "",
  "Field reference: docs/EXCHANGE_REFERENCE.md. CLI usage: docs/CLI.md.",
  "snake_case keys; a value beginning with @ is read from the file at that path",
  "(use it for credentials so secrets stay out of this file).",
];

/**
 * Per-field documentation attached to the live document. Each entry is a path
 * into the (snake_case) document and the comment lines to render before that
 * key. The connection and linkage-terms scalar fields are documented here; the
 * inferred array sections (linkage_fields, linkage_keys, metadata,
 * standardization) are documented at the section level just below, since their
 * contents are example/inferred data rather than fixed options.
 *
 * @internal exported so a test asserts every entry's path still resolves in the
 * rendered document -- {@link commentKey} no-ops on a miss, so a renamed field
 * would otherwise drop its comment silently.
 */
export const FIELD_DOCS: Array<{ path: Array<string>; lines: Array<string> }> =
  [
    {
      path: ["connection"],
      lines: [
        "How to reach your exchange partner. channel is sftp here (the primary CLI",
        "transport); filedrop (a shared mounted directory) and webrtc are also",
        "supported -- see docs/COMMUNICATION.md to switch.",
      ],
    },
    {
      path: ["connection", "server"],
      lines: [
        "SFTP server both parties drop files on. Supply a credential by adding one",
        "of (preferably as an @path, never a literal secret -- quote the value, as",
        "a leading @ is reserved in YAML):",
        '  password: "@./sftp-password.txt"',
        '  private_key: "@~/.ssh/id_psilink"',
        "Optionally pin the host key to verify the server on connect:",
        "  host_key_fingerprint: SHA256:....",
      ],
    },
    {
      path: ["connection", "server", "host"],
      lines: ["SFTP host name or IP."],
    },
    {
      path: ["connection", "server", "port"],
      lines: ["SSH port (default 22)."],
    },
    {
      path: ["connection", "server", "username"],
      lines: ["SSH username for the server."],
    },
    {
      path: ["connection", "options"],
      lines: [
        "Connection tuning. Defaults shown; most exchanges leave these untouched.",
      ],
    },
    {
      path: ["connection", "options", "server_connect_timeout_ms"],
      lines: ["Per-attempt timeout connecting to the server, in ms."],
    },
    {
      path: ["connection", "options", "peer_timeout_ms"],
      lines: ["How long to wait for the partner at any one step, in ms."],
    },
    {
      path: ["connection", "options", "poll_interval_ms"],
      lines: ["How often to check for the partner's file, in ms."],
    },
    {
      path: ["connection", "options", "max_reconnect_attempts"],
      lines: ["Retries after a transient connection failure."],
    },
    {
      path: ["connection", "options", "timestamp_in_filename"],
      lines: [
        "Encode a timestamp + sequence in message filenames (sync-mediated drops).",
      ],
    },
    {
      path: ["connection", "options", "lockless_rendezvous"],
      lines: [
        "Use an ack-handshake barrier instead of a lock file; both parties must",
        "set this identically. Required for transports without atomic create.",
      ],
    },
    {
      path: ["connection", "options", "retain_files"],
      lines: [
        "Keep every message as a durable transcript instead of deleting it.",
        "Requires lockless_rendezvous and timestamp_in_filename both true; both",
        "parties must set it identically and start from a fresh directory.",
      ],
    },
    {
      path: ["linkage_terms"],
      lines: [
        "What will be matched and how. Both parties' terms must agree, or the",
        "exchange aborts. linkage_fields are the standardized PII elements;",
        "linkage_keys are the ordered keys built from them (most to least precise).",
      ],
    },
    {
      path: ["linkage_terms", "version"],
      lines: ["Linkage-terms schema version."],
    },
    {
      path: ["linkage_terms", "identity"],
      lines: [
        "Who holds these terms (name, organization, contact). Self-asserted.",
      ],
    },
    {
      path: ["linkage_terms", "date"],
      lines: ["Date these terms were last edited (YYYY-MM-DD)."],
    },
    {
      path: ["linkage_terms", "algorithm"],
      lines: [
        "psi reveals matched ids; psi-c reveals only the match count (psi-c is",
        "not yet implemented -- use psi).",
      ],
    },
    {
      path: ["linkage_terms", "linkage_strategy"],
      lines: [
        "cascade (one PSI round per key) or single-pass (all keys in one round,",
        "fewer round-trips, but discloses your full per-key value structure).",
      ],
    },
    {
      path: ["linkage_terms", "deduplicate"],
      lines: [
        "Allow several of your records to match the same partner record.",
      ],
    },
    {
      path: ["linkage_terms", "output"],
      lines: [
        "expects_output: do you receive the result. share_with_partner: does the",
        "partner receive it.",
      ],
    },
    {
      path: ["linkage_terms", "linkage_fields"],
      lines: ["The standardized PII fields keys are built from."],
    },
    {
      path: ["linkage_terms", "linkage_keys"],
      lines: ["Ordered keys, applied most to least precise."],
    },
    {
      path: ["metadata"],
      lines: [
        "Per-column description of your input CSV: semantic type and role",
        "(linkage / identifier / payload / ignored). Inferred from column names",
        "when omitted.",
      ],
    },
    {
      path: ["standardization"],
      lines: [
        "Per-field cleaning applied to a column before keys are built. output is a",
        "linkage field, input is the raw CSV column, steps run in order.",
      ],
    },
  ];

// Optional sections appended as commented-out examples: opt-in features with no
// default value to pre-fill, so they are documented here for the operator to
// uncomment and edit rather than written active. Kept in sync with the optional
// top-level sections of ExchangeSpec (see init.test.ts, which asserts every
// schema section appears in the template).
//
// @internal exported so a test un-comments each example and validates it against
// the schema -- an operator who enables a section must get a loadable config.
export const OPTIONAL_SECTIONS = `# --- Optional sections (uncomment and edit to enable) ------------------------

# authentication: partner shared-secret policy. The secret itself lives in the
# key file, never here; only policy belongs in the config.
# authentication:
#   # Stamp a maximum age (in days) onto the rotated token; omit for no limit.
#   token_max_age_days: 365

# signing: receipt signing and partner-certificate trust. mode is none,
# session-derived (tamper-evident), or certificate (third-party verifiable).
# signing:
#   mode: none
#   # identity_file: ~/.psilink/signing-identity.json   # created by 'psilink fingerprint'
#   # partner_fingerprint: <43-char base64url>          # pin the partner's certificate
#   # receipt_output: ./receipts                        # where signed receipts are written

# retention_disposition: a local note (recorded in your own exchange record
# only, never shared) describing where you file the result and under what
# retention schedule.
# retention_disposition: "Filed in the secure share; purged after 90 days."

# expected_payload_columns: payload columns (in the partner's namespace) you
# require to receive at runtime. An empty list means "receive nothing"; omit the
# field to accept whatever the partner sends.
# expected_payload_columns:
#   - matched_record_id

# disclosed_payload_columns: payload columns (in YOUR OWN namespace) you
# committed to disclose to the partner when the exchange was established -- the
# send-side counterpart of expected_payload_columns. 'psilink invite' fills this
# in automatically from the invitation it published; you rarely set it by hand.
# Before connecting, an exchange checks that your current metadata still discloses
# exactly this set and fails (exit 64) otherwise, so a drift is caught locally
# instead of aborting on the partner's side. To disclose less on purpose, re-invite
# the partner rather than editing this. An empty list means "disclose nothing";
# omit the field if you made no such commitment.
# disclosed_payload_columns:
#   - matched_record_id
`;

// The commented metadata + standardization block shown only when no input file
// was given (with an input file these sections are inferred and written active).
// Their presence -- active or commented -- is what keeps every ExchangeSpec
// section represented in the template.
//
// @internal exported so a test un-comments the example and validates it against
// the schema -- an operator who follows it by hand must get a loadable config.
export const INFERRED_SECTIONS_HINT = `# metadata and standardization are inferred from an input CSV: run
# 'psilink init data.csv' to fill them in, or author them by hand.
#
# metadata:
#   - name: ssn
#     type: ssn
#     role: linkage
#     is_payload: false
# standardization:
#   - output: ssn
#     input: ssn
#     steps:
#       - function: trim_whitespace
`;

/**
 * Render the commented `psilink.yaml` template `psilink init` writes: an
 * `sftp` connection scaffold with placeholder credentials, the linkage terms
 * (default or inferred), the inferred metadata/standardization when an input
 * file was given, and the optional sections documented as commented examples.
 *
 * The active sections are built into one YAML document so per-field comments
 * land in the right place and the result round-trips through the schema (the
 * test parses it); the opt-in sections, which have no default to pre-fill, are
 * appended as commented text. The connection block is always a placeholder --
 * there is nothing to infer a server address from -- so the file is a scaffold
 * to hand-edit, not a runnable config.
 */
export function renderConfigTemplate(data: TemplateDataSpec): string {
  const spec: Record<string, unknown> = {
    connection: {
      channel: "sftp",
      server: {
        host: PLACEHOLDER_HOST,
        port: 22,
        username: PLACEHOLDER_USERNAME,
      },
      options: {
        serverConnectTimeoutMs: DEFAULT_SERVER_CONNECT_TIMEOUT_MS,
        peerTimeoutMs: DEFAULT_PEER_TIMEOUT_MS,
        pollIntervalMs: DEFAULT_POLLING_FREQUENCY_MS,
        maxReconnectAttempts: DEFAULT_MAX_RECONNECT_ATTEMPTS,
        timestampInFilename: false,
        locklessRendezvous: false,
        retainFiles: false,
      },
    },
    linkageTerms: data.linkageTerms,
  };
  if (data.metadata !== undefined) spec.metadata = data.metadata;
  if (data.standardization !== undefined)
    spec.standardization = data.standardization;

  const doc = new YAML.Document(snakeizeKeys(spec));
  doc.commentBefore = HEADER_LINES.map((line) =>
    line.length > 0 ? ` ${line}` : "",
  ).join("\n");
  for (const { path, lines } of FIELD_DOCS) commentKey(doc, path, lines);

  const sections = [doc.toString().trimEnd()];
  // When no input file seeded metadata/standardization, document them (commented)
  // so every ExchangeSpec section is still represented in the template.
  if (data.metadata === undefined) sections.push(INFERRED_SECTIONS_HINT);
  sections.push(OPTIONAL_SECTIONS);
  return sections.join("\n") + "\n";
}

/**
 * Attach a block comment before the key at `path` in the document. A no-op when
 * the path's parent is not a mapping or the key is absent -- the FIELD_DOCS
 * entries track the spec shape this module builds, so a miss means that shape
 * changed and the matching entry should be updated, not that the render should
 * fail.
 */
function commentKey(
  doc: YAML.Document,
  path: Array<string>,
  lines: Array<string>,
): void {
  const parentPath = path.slice(0, -1);
  const key = path[path.length - 1];
  const parent =
    parentPath.length === 0 ? doc.contents : doc.getIn(parentPath, true);
  if (!YAML.isMap(parent)) return;
  for (const pair of parent.items) {
    if (YAML.isScalar(pair.key) && pair.key.value === key) {
      pair.key.commentBefore = lines.map((line) => ` ${line}`).join("\n");
      return;
    }
  }
}
