import YAML from "yaml";

import {
  DEFAULT_MAX_RECONNECT_ATTEMPTS,
  DEFAULT_PEER_TIMEOUT_MS,
  DEFAULT_POLLING_FREQUENCY_MS,
  DEFAULT_SERVER_CONNECT_TIMEOUT_MS,
} from "@psilink/core";

/**
 * The documentation section holding one runnable `connection` block per channel.
 * `invite` and `accept` write a connection block the operator still has to
 * complete, so the notice they print and the comment in the file they write both
 * name this section rather than a document that only describes the channels.
 */
export const CONNECTION_BLOCK_DOC_URL =
  "https://github.com/georgetown-mdi/jspsi/blob/main/docs/" +
  "EXCHANGE_REFERENCE.md#connection-blocks-by-channel";

/**
 * The sentence the `invite` and `accept` notices end with, pointing at the block
 * for whichever channel the operator picks.
 */
export const CONNECTION_BLOCK_NOTICE =
  "The block each channel takes -- sftp, filedrop (a shared mounted " +
  `directory), or webrtc -- is at ${CONNECTION_BLOCK_DOC_URL}`;

const CONNECTION_LINES = [
  "How to reach your exchange partner. channel is one of sftp, filedrop (a",
  "shared mounted directory), or webrtc; the block each one takes is at",
  CONNECTION_BLOCK_DOC_URL,
];

const TUNING_LINES = [
  "Connection tuning, all optional; the defaults are shown below. Uncomment",
  "and edit to change one.",
];

const POLL_LINES = [
  "Every wait for the partner's next file costs up to one poll_interval_ms, and",
  "an exchange makes many, so on a small dataset the polling, not the PSI",
  "masking, is most of its wall-clock time. Lower it on a directory or a server",
  "you control.",
];

const POLL_INTERVAL_KEY = "poll_interval_ms";

/**
 * The tuning fields shown as a commented example, in render order.
 * `poll_interval_ms` applies to the file-based channels only (`sftp` and
 * `filedrop`), so a `webrtc` block omits it: that channel's options schema
 * strips the key on parse, and an operator who uncommented it would get no
 * effect and no error.
 */
function tuningDefaults(channel: unknown): Array<[string, number]> {
  const shared: Array<[string, number]> = [
    ["server_connect_timeout_ms", DEFAULT_SERVER_CONNECT_TIMEOUT_MS],
    ["peer_timeout_ms", DEFAULT_PEER_TIMEOUT_MS],
    ["max_reconnect_attempts", DEFAULT_MAX_RECONNECT_ATTEMPTS],
  ];
  if (channel === "webrtc") return shared;
  return [[POLL_INTERVAL_KEY, DEFAULT_POLLING_FREQUENCY_MS], ...shared];
}

function commentBlock(lines: Array<string>): string {
  return lines.map((line) => (line.length > 0 ? ` ${line}` : "")).join("\n");
}

function commentBeforeKey(
  map: YAML.YAMLMap,
  key: string,
  lines: Array<string>,
): void {
  for (const pair of map.items)
    if (YAML.isScalar(pair.key) && pair.key.value === key)
      pair.key.commentBefore = commentBlock(lines);
}

/**
 * Attach the operator guidance to a saved config's `connection` block: what the
 * channel alternatives are and where each one's block is documented, plus the
 * connection tuning as a commented example at its defaults.
 *
 * The tuning is commented rather than written active so the config keeps taking
 * whatever the running version's defaults are; a field the block already sets is
 * left out of the example instead of being shown twice. A no-op when the
 * document holds no `connection` mapping, a shape this CLI does not write -- the
 * comment is guidance, so a miss must not fail the write.
 */
export function annotateConnectionGuidance(doc: YAML.Document): void {
  const connection = doc.get("connection", true);
  if (!YAML.isMap(doc.contents) || !YAML.isMap(connection)) return;
  commentBeforeKey(doc.contents, "connection", CONNECTION_LINES);

  const options = connection.get("options", true);
  const alreadySet = YAML.isMap(options) ? options : undefined;
  const shown = tuningDefaults(connection.get("channel")).filter(
    ([key]) => alreadySet === undefined || alreadySet.get(key) === undefined,
  );
  if (shown.length === 0) return;

  const intro = shown.some(([key]) => key === POLL_INTERVAL_KEY)
    ? [...TUNING_LINES, ...POLL_LINES]
    : TUNING_LINES;
  const example = shown.map(([key, value]) => `${key}: ${value}`);
  if (alreadySet !== undefined) {
    alreadySet.comment = commentBlock([...intro, ...example]);
    return;
  }
  connection.comment = commentBlock([
    ...intro,
    "options:",
    ...example.map((line) => `  ${line}`),
  ]);
}
