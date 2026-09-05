import { describe, expect, test } from "vitest";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { parseExchangeSpec, snakeizeKeys } from "@psilink/core";

import {
  HANDOFF_CREDENTIAL_PATH_PLACEHOLDER,
  HANDOFF_SIGNING_IDENTITY_PLACEHOLDER,
  buildJobHandoff,
} from "@jobs/handoff";
import { composeSftpConfigDocument } from "@jobs/intentConfig";
import { jobCreateIntentSchema } from "@jobs/intentSchemas";

import {
  TEST_HOST_KEY_FINGERPRINT,
  testSftpServerEntry,
  validSftpIntent,
  validZeroSetupSftpIntent,
} from "../../utils/jobFixtures";

import type {
  JobExchangeOptions,
  JobSftpExchangeIntent,
  JobZeroSetupSftpIntent,
} from "@jobs/intentSchemas";
import type { Metadata, Standardization } from "@psilink/core";

/**
 * The graduation invariant, pinned against drift: everything the console lets an
 * operator author reaches the recurring-run hand-off -- the exchange mode's
 * portable `psilink.yaml` or the zero-setup mode's command line -- and the
 * composed configuration stays one format with one validator, core's.
 *
 * The enumerations below are `Record`s keyed by the authoring surface's own
 * TYPES, so a field added to {@link JobExchangeOptions} or to either intent
 * leaves this file failing to compile until someone states where it graduates
 * (or why it does not). The assertions then drive the real composers over a
 * MAXIMAL intent -- every authorable field set to a non-default value -- so an
 * enumerated route that stops working fails here rather than at an operator's
 * first scheduled run.
 */

/** Where one authorable member is passed into the hand-off. */
type HandoffRoute =
  /** A top-level key of the composed `psilink.yaml`. */
  | { carries: "configKey"; key: string }
  /** An exact token of the zero-setup command line. */
  | { carries: "argvToken"; token: string }
  /** The connection's tuning block, routed member by member by
   * {@link TUNING_OPTION_ROUTES}. */
  | { carries: "tuningOptions" }
  /** Not passed, for the stated reason. */
  | { carries: "nothing"; because: string };

/** How one tuning option graduates: as a configuration key on the exchange
 * mode's document, and -- where the CLI has a flag for it -- as that flag on the
 * zero-setup command line. */
type TuningRoute =
  | { configKey: string; flag: string }
  | { configKey: string; flag: null; because: string };

/** Every tuning option the console can author, with the value the maximal intent
 * below sets it to. Typed `Required<...>`, so an option added to the surface
 * without a value here fails to compile. */
const MAXIMAL_OPTIONS: Required<JobExchangeOptions> = {
  retainFiles: true,
  locklessRendezvous: true,
  timestampInFilename: true,
  peerId: "clinic-a",
  unexpectedFiles: "warn",
  pollIntervalMs: 600_000,
  peerTimeoutMs: 7_200_000,
  serverConnectTimeoutMs: 45_000,
  maxReconnectAttempts: 12,
  connectionPerPoll: true,
};

/** Where each of those options graduates, for the values above. */
const TUNING_OPTION_ROUTES: Record<
  keyof Required<JobExchangeOptions>,
  TuningRoute
> = {
  retainFiles: { configKey: "retain_files", flag: "--retain-files" },
  locklessRendezvous: {
    configKey: "lockless_rendezvous",
    flag: "--lockless-rendezvous",
  },
  timestampInFilename: {
    configKey: "timestamp_in_filename",
    flag: "--timestamp-in-filename",
  },
  peerId: { configKey: "peer_id", flag: "--peer-id=clinic-a" },
  unexpectedFiles: {
    configKey: "unexpected_files",
    flag: null,
    because:
      "a configuration-only setting with no CLI flag; the zero-setup arms " +
      "refuse it rather than accept a choice the command line would drop",
  },
  pollIntervalMs: {
    configKey: "poll_interval_ms",
    flag: "--polling-frequency=600000ms",
  },
  peerTimeoutMs: { configKey: "peer_timeout_ms", flag: "--peer-timeout=7200s" },
  serverConnectTimeoutMs: {
    configKey: "server_connect_timeout_ms",
    flag: "--connection-timeout=45s",
  },
  maxReconnectAttempts: {
    configKey: "max_reconnect_attempts",
    flag: "--max-reconnect-attempts=12",
  },
  connectionPerPoll: {
    configKey: "connection_per_poll",
    flag: "--connection-per-poll",
  },
};

const MAXIMAL_METADATA: Metadata = [
  { name: "ssn", type: "ssn", role: "linkage", isPayload: false },
  { name: "notes", type: "other", role: "payload", isPayload: true },
];

const MAXIMAL_STANDARDIZATION: Standardization = [
  { output: "ssn", input: "ssn", steps: [{ function: "trim" }] },
];

/** A partner fingerprint in core's canonical unpadded base64url shape. */
const PARTNER_FINGERPRINT = "c".repeat(42) + "A";

/** A schema-valid shared secret whose base64 run is distinct from the all-`A`
 * host-key fingerprint, so an absent-from-the-template assertion is neither
 * satisfied nor defeated by the pin sitting beside it. */
const DISTINCT_SECRET = "b".repeat(42) + "A";

/** The container-internal paths the LIVE run composes, none of which may appear
 * in a template the operator sends to another machine. */
const CONTAINER_SIGNING_IDENTITY = "/data/jobs/job-7/signing-identity.json";
const CONTAINER_RECEIPT_OUTPUT = "/data/jobs/job-7/receipt.json";
/** The container-internal credential reference the authored server entry holds. */
const CONTAINER_CREDENTIAL_PATH = "@/etc/psilink/prod-east-password";

/** An sftp exchange intent with every authorable field set. */
function maximalExchangeIntent(): JobSftpExchangeIntent {
  return validSftpIntent({
    sharedSecret: DISTINCT_SECRET,
    metadata: MAXIMAL_METADATA,
    standardization: MAXIMAL_STANDARDIZATION,
    expectedPayloadColumns: ["partner_notes"],
    expectedPartnerDeduplicate: false,
    side: "acceptor",
    options: MAXIMAL_OPTIONS,
    eventStream: true,
    diagnosticRun: true,
    sweepExchangeFiles: true,
    signing: { mode: "certificate", partnerFingerprint: PARTNER_FINGERPRINT },
    retentionDisposition: "Filed with the 2026 intake, kept seven years.",
  });
}

/** An sftp zero-setup intent with every authorable field set. `unexpectedFiles`
 * is dropped: the zero-setup arms refuse it (see {@link TUNING_OPTION_ROUTES}). */
function maximalZeroSetupIntent(): JobZeroSetupSftpIntent {
  const { unexpectedFiles: _configOnly, ...zeroSetupOptions } = MAXIMAL_OPTIONS;
  return validZeroSetupSftpIntent({
    options: zeroSetupOptions,
    eventStream: true,
    diagnosticRun: true,
    sweepExchangeFiles: true,
    identity: "County Health",
    linkageStrategy: "single-pass",
  });
}

/** Every field of an sftp exchange intent, and where it graduates. */
const EXCHANGE_INTENT_ROUTES: Record<
  keyof Required<JobSftpExchangeIntent>,
  HandoffRoute
> = {
  mode: {
    carries: "nothing",
    because: "it selects the config template over the command template",
  },
  channel: { carries: "configKey", key: "connection" },
  linkageTerms: { carries: "configKey", key: "linkage_terms" },
  sharedSecret: {
    carries: "nothing",
    because:
      "the secret rides the on-disk key file the hand-off tells the operator " +
      "to copy; no template ever carries it",
  },
  inputCsv: {
    carries: "nothing",
    because:
      "the input is a positional of the fixed run command the hand-off prints, " +
      "not a value the template carries",
  },
  inputFile: {
    carries: "nothing",
    because:
      "a reference to a file in the appliance's mount; the scheduling machine " +
      "has its own, named by the fixed run command's positional",
  },
  metadata: { carries: "configKey", key: "metadata" },
  standardization: { carries: "configKey", key: "standardization" },
  expectedPayloadColumns: {
    carries: "configKey",
    key: "expected_payload_columns",
  },
  expectedPartnerDeduplicate: {
    carries: "configKey",
    key: "expected_partner_deduplicate",
  },
  side: { carries: "configKey", key: "outbound_payload_consent" },
  options: { carries: "tuningOptions" },
  eventStream: {
    carries: "nothing",
    because:
      "it selects how the APPLIANCE watches this run (the machine-readable " +
      "event stream the console's own surface folds), not what the exchange does",
  },
  diagnosticRun: {
    carries: "nothing",
    because:
      "a per-run diagnostic whose log lands at a container path; a schedule " +
      "asks for one on the command line when it needs one",
  },
  sweepExchangeFiles: {
    carries: "nothing",
    because:
      "a per-run recovery action over a directory this run met, not a setting " +
      "a recurring run repeats",
  },
  signing: { carries: "configKey", key: "signing" },
  retentionDisposition: { carries: "configKey", key: "retention_disposition" },
};

/** Every field of an sftp zero-setup intent, and where it graduates. */
const ZERO_SETUP_INTENT_ROUTES: Record<
  keyof Required<JobZeroSetupSftpIntent>,
  HandoffRoute
> = {
  mode: {
    carries: "nothing",
    because: "it selects the command template over the config template",
  },
  channel: {
    carries: "nothing",
    because:
      "it selects the connection locator, which the command's own positional " +
      "carries as a placeholder",
  },
  // The input SOURCE does not travel -- the console's mount is not the
  // scheduling machine's -- but the command holds a positional for it, under
  // the fixed name the hand-off tells the operator to use.
  inputCsv: { carries: "argvToken", token: "input.csv" },
  inputFile: { carries: "argvToken", token: "input.csv" },
  options: { carries: "tuningOptions" },
  eventStream: {
    carries: "nothing",
    because:
      "it selects how the APPLIANCE watches this run (the machine-readable " +
      "event stream the console's own surface folds), not what the exchange does",
  },
  diagnosticRun: {
    carries: "nothing",
    because:
      "a per-run diagnostic whose log lands at a container path; a schedule " +
      "asks for one on the command line when it needs one",
  },
  sweepExchangeFiles: {
    carries: "nothing",
    because:
      "a per-run recovery action over a directory this run met, not a setting " +
      "a recurring run repeats",
  },
  identity: { carries: "argvToken", token: "--identity=County Health" },
  linkageStrategy: {
    carries: "argvToken",
    token: "--linkage-strategy=single-pass",
  },
};

/** The maximal exchange hand-off's template, as YAML text. */
function maximalExchangeYaml(): string {
  const handoff = buildJobHandoff(
    maximalExchangeIntent(),
    testSftpServerEntry(),
    { credentialPasted: false, filedropSplit: false },
  );
  if (handoff.template.kind !== "config")
    throw new Error("an exchange hand-off composed no config template");
  return handoff.template.yaml;
}

/** The maximal zero-setup hand-off's command tokens. */
function maximalZeroSetupArgv(): Array<string> {
  const handoff = buildJobHandoff(
    maximalZeroSetupIntent(),
    testSftpServerEntry(),
    { credentialPasted: false, filedropSplit: false },
  );
  if (handoff.template.kind !== "command")
    throw new Error("a zero-setup hand-off composed no command template");
  return handoff.template.argv;
}

describe("every authorable option graduates into the hand-off", () => {
  test("the maximal intents are ones a client can actually author", () => {
    // The enumerations are only worth what they are enumerated over: an intent
    // the create route would refuse is not an authoring surface at all.
    expect(
      jobCreateIntentSchema.safeParse(maximalExchangeIntent()).success,
    ).toBe(true);
    expect(
      jobCreateIntentSchema.safeParse(maximalZeroSetupIntent()).success,
    ).toBe(true);
  });

  test("each tuning option reaches the exchange template's options block", () => {
    const options = (
      parseYaml(maximalExchangeYaml()) as {
        connection: { options: Record<string, unknown> };
      }
    ).connection.options;
    for (const [field, route] of Object.entries(TUNING_OPTION_ROUTES))
      expect({ field, value: options[route.configKey] }).toEqual({
        field,
        value: MAXIMAL_OPTIONS[field as keyof JobExchangeOptions],
      });
  });

  test("each tuning option with a flag reaches the zero-setup command line", () => {
    const argv = maximalZeroSetupArgv();
    for (const [field, route] of Object.entries(TUNING_OPTION_ROUTES)) {
      if (route.flag === null) {
        expect({ field, because: route.because.length > 0 }).toEqual({
          field,
          because: true,
        });
        continue;
      }
      expect({ field, present: argv.includes(route.flag) }).toEqual({
        field,
        present: true,
      });
    }
  });

  test("the exchange template's keys are exactly the routed ones", () => {
    // Two-way: an authorable field routed to a key the template does not hold
    // fails, and a key appearing in the template that no authorable field routes
    // to fails -- which is what would catch a console-only key.
    const routedKeys = Object.values(EXCHANGE_INTENT_ROUTES)
      .filter((route) => route.carries === "configKey")
      .map((route) => route.key);
    expect(
      Object.keys(parseYaml(maximalExchangeYaml()) as object).sort(),
    ).toEqual([...routedKeys].sort());
  });

  test("the zero-setup command is exactly the routed tokens", () => {
    // The whole command, in order: the connection portion the authored server
    // composes, then the tuning flags, the two selectors, and the positionals.
    expect(maximalZeroSetupArgv()).toEqual([
      "psilink",
      "sftp://sftp.example.org:2222/exchange",
      "--server-username=linkage",
      `--server-password=${HANDOFF_CREDENTIAL_PATH_PLACEHOLDER}`,
      `--server-host-key-fingerprint=${TEST_HOST_KEY_FINGERPRINT}`,
      "--retain-files",
      "--lockless-rendezvous",
      "--timestamp-in-filename",
      "--peer-id=clinic-a",
      "--polling-frequency=600000ms",
      "--peer-timeout=7200s",
      "--connection-timeout=45s",
      "--max-reconnect-attempts=12",
      "--connection-per-poll",
      "--identity=County Health",
      "--linkage-strategy=single-pass",
      "input.csv",
      "results.csv",
    ]);
  });

  test("each zero-setup selector reaches the command line", () => {
    const argv = maximalZeroSetupArgv();
    for (const [field, route] of Object.entries(ZERO_SETUP_INTENT_ROUTES)) {
      if (route.carries === "argvToken")
        expect({ field, present: argv.includes(route.token) }).toEqual({
          field,
          present: true,
        });
      else if (route.carries === "nothing")
        expect({ field, because: route.because.length > 0 }).toEqual({
          field,
          because: true,
        });
    }
  });

  test("the linkage strategy graduates on the exchange mode inside the terms", () => {
    // The exchange mode has no `--linkage-strategy` of its own: the strategy is
    // part of the linkage terms both parties agreed, and the template holds
    // them as they ran.
    const intent = maximalExchangeIntent();
    intent.linkageTerms = {
      ...intent.linkageTerms,
      linkageStrategy: "single-pass",
    };
    const handoff = buildJobHandoff(intent, testSftpServerEntry(), {
      credentialPasted: false,
      filedropSplit: false,
    });
    const yaml =
      handoff.template.kind === "config" ? handoff.template.yaml : "";
    expect(
      (parseYaml(yaml) as { linkage_terms: { linkage_strategy: string } })
        .linkage_terms.linkage_strategy,
    ).toBe("single-pass");
  });
});

describe("the composed config stays one format with one validator", () => {
  test("the template parses through the same core entry point the CLI loads with", () => {
    // `loadConfig` (apps/cli/src/commands/exchange.ts) parses the operator's
    // psilink.yaml through core's parseExchangeSpec and nothing else, so a
    // template that survives this parse is one the CLI loads.
    expect(() =>
      parseExchangeSpec(parseYaml(maximalExchangeYaml())),
    ).not.toThrow();
  });

  test("the template contains no key outside core's schema", () => {
    // Re-serializing core's own parse of the document reproduces it byte for
    // byte: nothing in the template is outside the schema (it would be dropped),
    // and nothing the schema fills in is missing from the template.
    const yaml = maximalExchangeYaml();
    expect(
      stringifyYaml(snakeizeKeys(parseExchangeSpec(parseYaml(yaml)))),
    ).toBe(yaml);
  });

  test("the authored values survive the round trip unchanged", () => {
    const spec = parseExchangeSpec(parseYaml(maximalExchangeYaml()));
    const intent = maximalExchangeIntent();
    expect(spec.linkageTerms).toEqual(intent.linkageTerms);
    expect(spec.metadata).toEqual(MAXIMAL_METADATA);
    expect(spec.standardization).toEqual(MAXIMAL_STANDARDIZATION);
    expect(spec.expectedPayloadColumns).toEqual(["partner_notes"]);
    expect(spec.expectedPartnerDeduplicate).toBe(false);
    expect(spec.retentionDisposition).toBe(intent.retentionDisposition);
    expect(spec.signing?.mode).toBe("certificate");
    expect(spec.signing?.partnerFingerprint).toBe(PARTNER_FINGERPRINT);
    expect(spec.connection.options).toMatchObject({
      retainFiles: true,
      locklessRendezvous: true,
      timestampInFilename: true,
      peerId: "clinic-a",
      unexpectedFiles: "warn",
      pollIntervalMs: 600_000,
      peerTimeoutMs: 7_200_000,
      serverConnectTimeoutMs: 45_000,
      maxReconnectAttempts: 12,
      connectionPerPoll: true,
    });
  });
});

describe("the placeholder invariants hold over every authorable option", () => {
  test("the maximal exchange template contains no secret and no container path", () => {
    const yaml = maximalExchangeYaml();
    // The live run's own config, composed from the same intent and the same
    // authored entry, holds exactly the container paths the template must not.
    const live = composeSftpConfigDocument(
      maximalExchangeIntent(),
      testSftpServerEntry(),
      {
        identityFile: CONTAINER_SIGNING_IDENTITY,
        receiptOutput: CONTAINER_RECEIPT_OUTPUT,
      },
    );
    expect(live).toContain(CONTAINER_SIGNING_IDENTITY);
    expect(live).toContain(CONTAINER_CREDENTIAL_PATH);

    expect(yaml).not.toContain(maximalExchangeIntent().sharedSecret);
    expect(yaml.toLowerCase()).not.toContain("secret");
    expect(yaml).not.toContain(CONTAINER_CREDENTIAL_PATH);
    expect(yaml).not.toContain(CONTAINER_SIGNING_IDENTITY);
    expect(yaml).not.toContain(CONTAINER_RECEIPT_OUTPUT);
    expect(yaml).toContain(HANDOFF_CREDENTIAL_PATH_PLACEHOLDER);
    expect(yaml).toContain(HANDOFF_SIGNING_IDENTITY_PLACEHOLDER);
  });

  test("the maximal zero-setup command contains no secret and no container path", () => {
    const line = maximalZeroSetupArgv().join(" ");
    expect(line).not.toContain(CONTAINER_CREDENTIAL_PATH);
    expect(line).not.toContain(CONTAINER_SIGNING_IDENTITY);
    expect(line.toLowerCase()).not.toContain("secret");
    expect(line).toContain(HANDOFF_CREDENTIAL_PATH_PLACEHOLDER);
  });
});
