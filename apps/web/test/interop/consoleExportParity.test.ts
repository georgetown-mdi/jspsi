import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  parseExchangeSpec,
  parseSensitiveJson,
  parseSensitiveYaml,
  serializeExchangeDocument,
} from "@psilink/core";

import {
  HANDOFF_CREDENTIAL_PATH_PLACEHOLDER,
  HANDOFF_SHARED_DIRECTORY_PLACEHOLDER,
  buildJobHandoff,
} from "@jobs/handoff";

import {
  disclosedDocument,
  mountedConfigurationDocument,
} from "@jobs/configLoad";
import { authoringStateFromDocument } from "@console/loadedConfig";
import { connectionTuningOptions } from "@console/connectionTuningModel";

import { TEST_HOST_KEY_FINGERPRINT, tempDataRoot } from "../utils/jobFixtures";

import {
  cliIsBuilt,
  expectCliSucceeded,
  invitationFrom,
  startCli,
} from "./cliParty";

import type { JobExchangeIntent, JobExchangeSide } from "@jobs/intentSchemas";
import type { CliRun } from "./cliParty";
import type { ExchangeSpec } from "@psilink/core";
import type { JobSftpServerEntry } from "@jobs/sftpServer";

/**
 * The export leg of "use the GUI for the settings and the CLI for the work":
 * a configuration psilink itself wrote, opened in the console, run, and handed
 * back as the file a scheduled command-line run loads.
 *
 * The comparison is against the REAL CLI's own bytes, which is why it lives
 * here rather than in the unit project: the fixtures below are written by the
 * built `psilink` (apps/cli must not be imported from apps/web -- apps consume
 * packages, not each other), the console reads them through the production load
 * and mapping, and the hand-off's template is compared to what the CLI left on
 * disk.
 *
 * Two facts about that comparison, both measured against the built CLI rather
 * than assumed:
 *
 * - The console's template is byte-identical to the CLI's file re-written
 *   through the writer `saveConfig` uses, over the document the CLI's own
 *   loader would read out of it. That is the parity claim, and it fails on any
 *   setting the console loses, adds, or alters.
 * - Against the CLI's file as it sits on disk, the residual difference is key
 *   ORDER inside a block: `psilink invite` and `psilink accept` hand
 *   `saveConfig` a spec they assembled, whose key order is the assembly's,
 *   while every document the console writes has been through the schema, whose
 *   key order is the declaration's. The whole-file line multiset is the
 *   assertion that names that residual: the same lines, differently ordered.
 *   Key order is not round-trippable, and the spec says so
 *   (docs/spec/EXCHANGE_FILE.md, "Writing a configuration back").
 *
 * The operator's own fill-in is the `connection` block, which an offline
 * invitation leaves as a placeholder for them to complete; every other block in
 * the fixtures is the CLI's own bytes.
 *
 * What the console composes without the CLI -- the merge with the mounted
 * document, the settings it holds, and the block set it may hold -- is the unit
 * project's (test/unit/jobs/configExportParity.unit.test.ts).
 */

/** A hard kill on one `psilink` invocation. Each is an offline `invite` or
 * `accept` that writes a file and exits, so the budget bounds a hang rather
 * than sizing a wait. */
const CLI_INVOCATION_TIMEOUT_MS = 120_000;

const FIXTURE_CSV =
  "ssn,first_name,last_name,date_of_birth\n" +
  "111223333,bob,smith,1990-01-01\n" +
  "222334444,carol,jones,1985-11-30\n";

/** A schema-valid shared secret whose base64 run is distinct from the all-`A`
 * host-key fingerprint, so the absent-from-the-export assertion is neither
 * satisfied nor defeated by the pin sitting beside it. */
const RUN_SHARED_SECRET = "b".repeat(42) + "A";

const INVITER_IDENTITY = "Agency A, a@agency-a.example";
const ACCEPTOR_IDENTITY = "Agency B, b@agency-b.example";

/** The tuning the file-drop fixture's connection block states, matched by the
 * console intent below so the two connection blocks are one composition. */
const FIXTURE_POLL_INTERVAL_MS = 2_000;
const FIXTURE_PEER_TIMEOUT_MS = 600_000;

/** The connect timeout the fixtures state. The connection-tuning card states a
 * value for this setting whether or not the file does, so a fixture leaving it
 * unset would export the card's default explicitly -- a setting stated at the
 * value it already had, which is what the spec's round-trip statement names. */
const FIXTURE_CONNECT_TIMEOUT_MS = 30_000;

const dirs: Array<string> = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

/** A scratch mount for one fixture, removed after the test. */
function scratchDir(label: string): string {
  const dir = tempDataRoot(label);
  fs.mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  return dir;
}

/** Run one `psilink` invocation, failing with everything it wrote. */
async function runCli(args: Array<string>, cwd: string): Promise<CliRun> {
  const run = await startCli({
    args,
    cwd,
    timeoutMs: CLI_INVOCATION_TIMEOUT_MS,
  });
  expectCliSucceeded(run, args[0]);
  return run;
}

/**
 * Replace the configuration's `connection` block, the step an offline
 * invitation tells the operator to take. A line-scoped rewrite rather than a
 * YAML round-trip: the file is one psilink just wrote, and re-emitting it
 * through a parser would rewrite every other block as a side effect of
 * replacing one.
 */
function fillInConnection(configPath: string, block: Array<string>): void {
  const lines = fs.readFileSync(configPath, "utf8").split("\n");
  const start = lines.findIndex((line) => line === "connection:");
  if (start === -1) throw new Error(`${configPath} holds no connection block`);
  let end = start + 1;
  while (end < lines.length && /^[\s#]\S|^\s/.test(lines[end])) end += 1;
  fs.writeFileSync(
    configPath,
    [...lines.slice(0, start), ...block, ...lines.slice(end)].join("\n"),
  );
}

/** A configuration `psilink invite` wrote, with its connection block filled in
 * as the operator's own step. */
async function invitedConfiguration(block: Array<string>): Promise<string> {
  const dir = scratchDir("export-invite");
  fs.writeFileSync(path.join(dir, "input.csv"), FIXTURE_CSV);
  await runCli(["invite", "--identity", INVITER_IDENTITY, "input.csv"], dir);
  const configPath = path.join(dir, "psilink.yaml");
  fillInConnection(configPath, block);
  return configPath;
}

/** A configuration `psilink accept` wrote for the invitation above, with its
 * connection block filled in the same way. */
async function acceptedConfiguration(block: Array<string>): Promise<string> {
  const inviteDir = scratchDir("export-invite-for-accept");
  fs.writeFileSync(path.join(inviteDir, "input.csv"), FIXTURE_CSV);
  const invitation = invitationFrom(
    await runCli(
      ["invite", "--identity", INVITER_IDENTITY, "input.csv"],
      inviteDir,
    ),
  );
  const dir = scratchDir("export-accept");
  fs.writeFileSync(path.join(dir, "input.csv"), FIXTURE_CSV);
  await runCli(
    [
      "accept",
      "--identity",
      ACCEPTOR_IDENTITY,
      "--consent-to-terms",
      invitation,
      "input.csv",
    ],
    dir,
  );
  const configPath = path.join(dir, "psilink.yaml");
  fillInConnection(configPath, block);
  return configPath;
}

/** The file-drop connection block the fixture states, whose directory is the
 * placeholder the hand-off shows a container path as -- so the two connection
 * blocks under comparison are the same composition. */
const FILEDROP_CONNECTION_BLOCK = [
  "connection:",
  "  channel: filedrop",
  `  path: ${HANDOFF_SHARED_DIRECTORY_PLACEHOLDER}`,
  "  options:",
  `    poll_interval_ms: ${FIXTURE_POLL_INTERVAL_MS}`,
  `    peer_timeout_ms: ${FIXTURE_PEER_TIMEOUT_MS}`,
  `    server_connect_timeout_ms: ${FIXTURE_CONNECT_TIMEOUT_MS}`,
];

/** The sftp connection block the fixture states. The credential is the
 * placeholder the hand-off shows one as, for the same reason. */
const SFTP_CONNECTION_BLOCK = [
  "connection:",
  "  channel: sftp",
  "  server:",
  "    host: sftp.example.org",
  "    port: 2222",
  "    username: linkage",
  "    path: /exchange",
  `    password: "${HANDOFF_CREDENTIAL_PATH_PLACEHOLDER}"`,
  `    host_key_fingerprint: ${TEST_HOST_KEY_FINGERPRINT}`,
  "  options:",
  `    poll_interval_ms: ${FIXTURE_POLL_INTERVAL_MS}`,
  `    peer_timeout_ms: ${FIXTURE_PEER_TIMEOUT_MS}`,
  `    server_connect_timeout_ms: ${FIXTURE_CONNECT_TIMEOUT_MS}`,
];

/** The authored connection the console runs an sftp exchange over, stating what
 * the fixture's block states. Its credential is already the placeholder, which
 * is what the hand-off would substitute for a container path. */
function fixtureServerEntry(): JobSftpServerEntry {
  return {
    host: "sftp.example.org",
    port: 2222,
    username: "linkage",
    path: "/exchange",
    password: HANDOFF_CREDENTIAL_PATH_PLACEHOLDER,
    hostKeyFingerprint: TEST_HOST_KEY_FINGERPRINT,
  };
}

/**
 * The exchange the console runs for a loaded configuration: the settings the
 * document states, taken through the console's own mapping
 * ({@link authoringStateFromDocument}) and the cards' own option builders,
 * never restated here. A setting the document does not state is not stated
 * back, so the export holds what the operator opened plus what they changed.
 */
function intentFromLoaded(
  document: ExchangeSpec,
  channel: "sftp" | "filedrop",
): JobExchangeIntent {
  const disclosed = disclosedDocument(document);
  const loaded = authoringStateFromDocument(disclosed);
  // The side the document was written on: only an acceptance records an
  // outbound payload consent, and only that side's composition derives one.
  const side: JobExchangeSide =
    document.outboundPayloadConsent !== undefined ? "acceptor" : "inviter";
  const base = {
    linkageTerms: loaded.linkageTerms,
    sharedSecret: RUN_SHARED_SECRET,
    inputCsv: FIXTURE_CSV,
    side,
    ...(loaded.metadata !== undefined ? { metadata: loaded.metadata } : {}),
    ...(loaded.standardization !== undefined
      ? { standardization: loaded.standardization }
      : {}),
    ...loaded.records,
    ...(connectionTuningOptions(loaded.connectionTuning) !== undefined
      ? { options: connectionTuningOptions(loaded.connectionTuning) }
      : {}),
  };
  return channel === "sftp"
    ? { ...base, channel: "sftp" }
    : { ...base, channel: "filedrop" };
}

/** The hand-off template a console run of the loaded configuration produces. */
function exportedConfiguration(
  configPath: string,
  channel: "sftp" | "filedrop",
): { exported: string; document: ExchangeSpec } {
  const document = mountedConfigurationDocument(
    fs.readFileSync(configPath, "utf8"),
  );
  const handoff = buildJobHandoff(
    intentFromLoaded(document, channel),
    channel === "sftp" ? fixtureServerEntry() : undefined,
    {
      credentialPasted: false,
      filedropSplit: false,
      mountedDocument: document,
    },
  );
  if (handoff.template.kind !== "config")
    throw new Error("an exchange hand-off composed no configuration template");
  return { exported: handoff.template.yaml, document };
}

/** The document a psilink loader reads out of a file, which is what the two
 * sides of a parity assertion are compared as documents. */
function loadedSpec(source: string): ExchangeSpec {
  return parseExchangeSpec(parseSensitiveYaml(source, "parity fixture"));
}

/**
 * A file's setting lines, sorted: two files with the same multiset state the
 * same settings at the same values, and differ only in the order they are
 * written in. Comment lines are out, since the fixture's connection block is
 * the operator's own hand-fill and carries none of the guidance a writer
 * attaches; the comments are asserted on their own below.
 */
function sortedSettingLines(source: string): Array<string> {
  return (
    source
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      // A sequence entry writes its first key on the dash line, so reordering the
      // keys of an entry moves which key that is. Flattening the dash compares
      // the keys rather than which one came first.
      .map((line) => line.replace(/^(\s*)- /, "$1  "))
      .sort()
  );
}

/** The comment block a psilink-written configuration opens with, above its
 * connection block. */
function guidanceHeaderOf(source: string): string {
  const lines = source.split("\n");
  const end = lines.findIndex((line) => !line.startsWith("#"));
  if (end <= 0) throw new Error("the fixture opens with no guidance comment");
  return lines.slice(0, end).join("\n");
}

/** The lines `after` holds that `before` does not, as a sorted list. */
function addedLines(before: string, after: string): Array<string> {
  const held = new Map<string, number>();
  for (const line of before.split("\n"))
    held.set(line, (held.get(line) ?? 0) + 1);
  const added: Array<string> = [];
  for (const line of after.split("\n")) {
    const count = held.get(line) ?? 0;
    if (count === 0) added.push(line);
    else held.set(line, count - 1);
  }
  return added.sort();
}

/** The `.psilink.key` psilink wrote beside the configuration. */
function keyFileBeside(keyPath: string): { sharedSecret: string } {
  const parsed = parseSensitiveJson(
    fs.readFileSync(keyPath, "utf8"),
    "parity fixture key file",
  );
  const { sharedSecret } = parsed as { sharedSecret?: unknown };
  if (typeof sharedSecret !== "string")
    throw new Error(`${keyPath} states no shared secret`);
  return { sharedSecret };
}

describe.skipIf(!cliIsBuilt)("a psilink-written configuration", () => {
  describe.each([
    {
      channel: "filedrop" as const,
      label: "a file-drop configuration psilink accept wrote",
      fixture: () => acceptedConfiguration(FILEDROP_CONNECTION_BLOCK),
    },
    {
      channel: "sftp" as const,
      label: "an sftp configuration psilink invite wrote",
      fixture: () => invitedConfiguration(SFTP_CONNECTION_BLOCK),
    },
  ])("$label, opened in the console and exported", ({ channel, fixture }) => {
    test("the export is what psilink writes for the document it would load", async () => {
      const configPath = await fixture();
      const written = fs.readFileSync(configPath, "utf8");
      const { exported } = exportedConfiguration(configPath, channel);

      // The parity claim, byte for byte: the console's export is the file
      // `saveConfig` writes (apps/cli/src/config.ts calls exactly this writer)
      // for the document psilink's own loader reads out of its file.
      expect(exported).toBe(serializeExchangeDocument(loadedSpec(written)));
      // ... and against the file as psilink left it, the residual is order.
      expect(sortedSettingLines(exported)).toEqual(sortedSettingLines(written));
      // The guidance psilink wrote above its own connection block is in the
      // export too: one writer attaches it, and this is the file the operator
      // edits by hand from here on.
      expect(exported).toContain(guidanceHeaderOf(written));
    });

    test("the export re-exports itself unchanged", async () => {
      const configPath = await fixture();
      const { exported } = exportedConfiguration(configPath, channel);
      fs.writeFileSync(configPath, exported);
      expect(exportedConfiguration(configPath, channel).exported).toBe(
        exported,
      );
    });

    test("one changed setting is the only changed line", async () => {
      const configPath = await fixture();
      const { exported, document } = exportedConfiguration(configPath, channel);
      const edited = buildJobHandoff(
        {
          ...intentFromLoaded(document, channel),
          retentionDisposition: "Kept seven years.",
        },
        channel === "sftp" ? fixtureServerEntry() : undefined,
        {
          credentialPasted: false,
          filedropSplit: false,
          mountedDocument: document,
        },
      );
      if (edited.template.kind !== "config")
        throw new Error("the edited hand-off composed no template");
      expect(addedLines(exported, edited.template.yaml)).toEqual([
        "retention_disposition: Kept seven years.",
      ]);
      expect(addedLines(edited.template.yaml, exported)).toEqual([]);
    });

    test("no shared secret and no key-file value reaches the export", async () => {
      const configPath = await fixture();
      const keyPath = path.join(path.dirname(configPath), ".psilink.key");
      const { exported } = exportedConfiguration(configPath, channel);
      const key = keyFileBeside(keyPath);
      expect(exported).not.toContain(key.sharedSecret);
      expect(exported).not.toContain("shared_secret");
      expect(exported).not.toContain(RUN_SHARED_SECRET);
    });
  });
});
