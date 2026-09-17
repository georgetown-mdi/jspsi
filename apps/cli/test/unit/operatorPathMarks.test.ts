import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import YAML from "yaml";
import { getLogger, operatorSuppliedSpans } from "@psilink/core";
import type {
  DualSignedRecord,
  ExchangeDataSpec,
  ExchangeRecord,
  LinkageTerms,
  Metadata,
  VerificationKeys,
} from "@psilink/core";

// The prompt is mocked so the confirmation cases drive the answer rather than a
// terminal; util/prompt's own tests cover promptConfirm, and the sink under test
// here is the line the confirmation writes after it, not the question.
vi.mock("../../src/util/prompt", async () => {
  const actual = await vi.importActual<typeof import("../../src/util/prompt")>(
    "../../src/util/prompt",
  );
  return { ...actual, promptConfirm: vi.fn() };
});

import { logOnlineBootstrapOutcome } from "../../src/onlineBootstrap";
import { confirmOutboundPayloadConsent } from "../../src/outboundPayloadConsent";
import { writeDualSignedRecord } from "../../src/receiptFile";
import { writeExchangeRecord } from "../../src/recordFile";
import { promptConfirm } from "../../src/util/prompt";
import { captureStdio } from "../loggingTestSupport";
import { ttyStream, withStdin } from "../stdinStream";

// Every message the record and receipt writers, the outbound-payload
// confirmation and the online-bootstrap summary compose about the OPERATOR's
// own path marks that path, so the display sink shows it as they typed it
// instead of escaping every separator and handing back a path they cannot copy
// into a command (packages/core/src/utils/operatorSuppliedText.ts).
//
// Each case below drives one converted sink and reads what it produced: the
// marked spans on the error for a refusal, the rendered line for a log sink.
// The fixture path holds backslashes on every platform -- native separators on
// Windows, and one directory name spelling them off it, where a backslash is a
// legal filename character -- so the NATIVE-separator case runs on Windows
// alone while every sink is still exercised wherever the suite runs.
//
// The two sinks reached only through a live bootstrap run are driven where that
// harness already exists: runOnlineBootstrap's re-gate refusal and its
// both-files-on-disk note in onlineBootstrap.test.ts, and the rotated-token
// save failure in protocol.test.ts, which pairs two authenticated parties.

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-operator-path-"));
  vi.mocked(promptConfirm).mockReset();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** A path under the fixture directory holding backslashes, its parent created. */
function backslashedPath(name: string): string {
  const full =
    process.platform === "win32"
      ? path.join(dir, "psilink", name)
      : path.join(dir, `C:\\psilink\\${name}`);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  return full;
}

/** The same path as a fragment nobody marked reaches the operator. */
const escaped = (value: string): string => value.replaceAll("\\", "\\\\");

/** The fragments a refusal marks as the operator's own, read off the error. */
function markedFragments(thrown: unknown): string[] {
  const error = thrown as Error;
  return (operatorSuppliedSpans(error, error.message) ?? [])
    .filter((span) => span.operatorSupplied)
    .map((span) => span.text);
}

/**
 * One converted sink: what drives it, and a fragment of the copy it alone
 * writes, so a case that reached some other message fails rather than passing
 * on a path another line named.
 */
interface SinkCase<Outcome> {
  readonly name: string;
  readonly says: readonly string[];
  readonly drive: () => Promise<Outcome>;
}

/** A refusal: the error the driver raised, plus the path it names. */
interface RefusalOutcome {
  readonly filePath: string;
  readonly thrown: unknown;
}

/** A log line: every line the driver emitted, plus the paths it names. */
interface LineOutcome {
  readonly filePaths: readonly string[];
  readonly lines: readonly string[];
}

/** A logger stub for the functions that take one, with the lines it collected. */
function stubLog(): { log: ReturnType<typeof getLogger>; lines: string[] } {
  const lines: string[] = [];
  const collect = (message: string): void => {
    lines.push(message);
  };
  return {
    lines,
    log: {
      info: collect,
      warn: collect,
      error: collect,
    } as unknown as ReturnType<typeof getLogger>,
  };
}

/** Collect every line a named logger emits at the levels these sinks use. */
function captureLines(loggerName: string): string[] {
  const logger = getLogger(loggerName);
  const lines: string[] = [];
  const collect = (...args: unknown[]): void => {
    lines.push(args.map(String).join(" "));
  };
  vi.spyOn(logger, "info").mockImplementation(collect);
  vi.spyOn(logger, "warn").mockImplementation(collect);
  return lines;
}

/**
 * Assert that the sink the case is about wrote the operator's path as they
 * typed it: the copy it alone writes is there, each path is there unescaped,
 * and no line the drive produced holds the escaped form.
 */
function expectPathsAsTyped(
  outcome: LineOutcome,
  says: readonly string[],
): void {
  const text = outcome.lines.join("\n");
  for (const phrase of says) expect(text).toContain(phrase);
  for (const filePath of outcome.filePaths) {
    expect(text).toContain(filePath);
    expect(text).not.toContain(escaped(filePath));
  }
}

/** Run `act`, returning what it threw. */
async function raised(act: () => unknown): Promise<unknown> {
  try {
    await act();
  } catch (err: unknown) {
    return err;
  }
  throw new Error("the driver raised nothing");
}

// --- the record and receipt writers ------------------------------------------

const RECORD: ExchangeRecord = {
  version: "psilink-exchange-record/v8",
  outcome: "completed",
  certificateMismatchObserved: false,
  createdAt: "2026-01-02T03:04:05.000Z",
  termsHash: "hQi6gjL9Z0RFtfz2TZVqXmUF1Cu8PaBFbClOJ9R8l_Q",
  localIdentity: "Party A",
  partnerIdentity: "Party B",
  governance: {
    algorithm: "psi",
    matchingBasis: [{ name: "ssn", type: "ssn" }],
    payloadSent: [],
    payloadReceived: [],
    matching: {
      localDeduplicate: false,
      partnerDeduplicate: false,
      cardinality: "one-to-one",
    },
  },
  recordsExposed: 5,
  resultSize: 2,
  bindingNonce: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  commitments: {
    localPayloadSent: "We5eIlrtkWBUe1uSGrla5rvLs0YhGFPPVDjk4EPX2k8",
    partnerPayloadReceived: "IFfNSyYoX8tKe2k-o6TjmrS1sW1ndtpZjexzR-fZa5g",
  },
};

const KEYS: VerificationKeys = {
  version: "psilink-exchange-keys/v1",
  salts: {
    localPayloadSent: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
    partnerPayloadReceived: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI",
  },
};

const CERTIFICATE = {
  version: "psilink-signing-cert/v2" as const,
  algorithm: "ecdsa-p256-sha256" as const,
  identity: "Party A",
  publicKey: {
    kty: "EC" as const,
    crv: "P-256" as const,
    x: "UVw9brnjlrkE0_7Kf1T9zQzB6Ze_N13KUVrQpsO0A18",
    y: "RTa-OlDzGPv5pUdZAqIhUCvvDVfgjFOyzApW8X2fk1Q",
  },
  signature:
    "CzgwEmZnlYhLunf5m3CK7WWpHiUlMeRW_hhdJmbaPiwbsuT0LPP0EJGcHskJMB7icXOXfuZ1DPlQlnkpqtVL4g",
};

const DUAL_SIGNED_RECORD: DualSignedRecord = {
  version: "psilink-signed-receipt/v3",
  content: {
    termsHash: "dGVybXNIYXNo",
    initiatorToResponderPayload: "aTJyUGF5bG9hZA",
    responderToInitiatorPayload: "cjJpUGF5bG9hZA",
    binder: "YmluZGVy",
  },
  initiator: { certificate: CERTIFICATE, signature: "AAAA" },
  responder: {
    certificate: { ...CERTIFICATE, identity: "Party B" },
    signature: "AAAA",
  },
};

// --- the outbound-payload confirmation ---------------------------------------

const ACCEPTOR_TERMS: LinkageTerms = {
  version: "1.0.0",
  identity: "Acceptor",
  date: "2026-01-01",
  algorithm: "psi",
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: [{ name: "first_name", type: "first_name" }],
  linkageKeys: [{ name: "FN", elements: [{ field: "first_name" }] }],
};

const DISCLOSING_METADATA: Metadata = [
  { name: "first_name", type: "first_name", role: "linkage", isPayload: false },
  { name: "diagnosis", type: "other", role: "payload", isPayload: true },
];

/** A config on disk the confirmation can record its answer in. */
function writePendingConfig(configPath: string): void {
  fs.writeFileSync(
    configPath,
    YAML.stringify({
      connection: { channel: "filedrop", path: "/mnt/share" },
      linkage_terms: {
        version: "1.0.0",
        identity: "Acceptor",
        date: "2026-01-01",
        algorithm: "psi",
        output: { expects_output: true, share_with_partner: true },
        deduplicate: false,
        linkage_fields: [{ name: "first_name", type: "first_name" }],
        linkage_keys: [{ name: "FN", elements: [{ field: "first_name" }] }],
      },
      outbound_payload_consent: { status: "pending" },
    }),
  );
}

/** Answer the confirmation with a yes, over a terminal stdin. */
async function confirmYes(
  configPath: string,
  log: ReturnType<typeof getLogger>,
): Promise<void> {
  const spec: ExchangeDataSpec = {
    linkageTerms: ACCEPTOR_TERMS,
    outboundPayloadConsent: { status: "pending" },
  };
  vi.mocked(promptConfirm).mockResolvedValue(true);
  const stdio = captureStdio();
  try {
    await withStdin(ttyStream(), () =>
      confirmOutboundPayloadConsent({
        spec,
        metadata: DISCLOSING_METADATA,
        output: ACCEPTOR_TERMS.output,
        configPath,
        logFile: undefined,
        log,
      }),
    );
  } finally {
    stdio.restore();
  }
}

// --- refusals ----------------------------------------------------------------

const REFUSALS: readonly SinkCase<RefusalOutcome>[] = [
  {
    name: "outbound consent: a confirmation that could not be recorded",
    says: ["could not be recorded in"],
    drive: async () => {
      // No file at the path, so the surgical one-field write fails where the
      // answer has already been given and nothing has been sent.
      const filePath = backslashedPath("psilink.yaml");
      const { log } = stubLog();
      return {
        filePath,
        thrown: await raised(() => confirmYes(filePath, log)),
      };
    },
  },
];

for (const { name, says, drive } of REFUSALS)
  test(`${name} marks the path it names`, async () => {
    const { filePath, thrown } = await drive();
    for (const phrase of says)
      expect((thrown as Error).message).toContain(phrase);
    expect(markedFragments(thrown)).toContain(filePath);
  });

// --- log lines ---------------------------------------------------------------

const LINES: readonly SinkCase<LineOutcome>[] = [
  {
    name: "record file: the verification keys it wrote",
    says: ["wrote private verification keys to"],
    drive: async () => {
      const filePath = backslashedPath("psilink-record.json");
      const lines = captureLines("record-marks");
      writeExchangeRecord(
        { recordFile: filePath },
        RECORD,
        KEYS,
        "record-marks",
      );
      return { filePaths: [filePath.replace(/\.json$/, ".keys.json")], lines };
    },
  },
  {
    name: "record file: the self-attested record it wrote",
    says: ["self-attested exchange record"],
    drive: async () => {
      const filePath = backslashedPath("psilink-record.json");
      const lines = captureLines("record-marks");
      writeExchangeRecord(
        { recordFile: filePath },
        RECORD,
        KEYS,
        "record-marks",
      );
      return { filePaths: [filePath], lines };
    },
  },
  {
    name: "record file: the keys orphaned by a failed record write",
    says: ["were already written to"],
    drive: async () => {
      // A directory at the record's own path: the keys beside it are written
      // first and the record write then fails, leaving them to be named.
      const filePath = backslashedPath("psilink-record.json");
      fs.mkdirSync(filePath);
      const lines = captureLines("record-marks");
      writeExchangeRecord(
        { recordFile: filePath },
        RECORD,
        KEYS,
        "record-marks",
      );
      return { filePaths: [filePath.replace(/\.json$/, ".keys.json")], lines };
    },
  },
  {
    name: "receipt file: the dual-signed record it wrote",
    says: ["wrote dual-signed exchange record"],
    drive: async () => {
      const filePath = backslashedPath("psilink-receipt.json");
      const lines = captureLines("receipt-marks");
      writeDualSignedRecord(
        { receiptFile: filePath },
        DUAL_SIGNED_RECORD,
        "2026-01-01T00:00:00Z",
        "receipt-marks",
      );
      return { filePaths: [filePath], lines };
    },
  },
  {
    name: "outbound consent: the confirmation it recorded",
    says: ["recorded your confirmation in"],
    drive: async () => {
      const filePath = backslashedPath("psilink.yaml");
      writePendingConfig(filePath);
      const { log, lines } = stubLog();
      await confirmYes(filePath, log);
      return { filePaths: [filePath], lines };
    },
  },
  {
    name: "bootstrap summary: the config and key a clean run wrote",
    says: ["saved config to"],
    drive: async () => {
      const configFile = backslashedPath("psilink.yaml");
      const keyFile = backslashedPath(".psilink.key");
      const { log, lines } = stubLog();
      logOnlineBootstrapOutcome(log, { configFile, keyFile });
      return { filePaths: [configFile, keyFile], lines };
    },
  },
  {
    name: "bootstrap summary: the config a reuse run kept",
    says: ["reused the existing configuration at"],
    drive: async () => {
      const configFile = backslashedPath("psilink.yaml");
      const keyFile = backslashedPath(".psilink.key");
      const { log, lines } = stubLog();
      logOnlineBootstrapOutcome(log, {
        configFile,
        keyFile,
        reuseExistingConfig: true,
      });
      return { filePaths: [configFile, keyFile], lines };
    },
  },
  {
    name: "bootstrap summary: the config a failed write left unwritten",
    says: ["but the configuration could not be written to"],
    drive: async () => {
      const configFile = backslashedPath("psilink.yaml");
      const keyFile = backslashedPath(".psilink.key");
      const { log, lines } = stubLog();
      logOnlineBootstrapOutcome(log, {
        configFile,
        keyFile,
        configWriteError: new Error("permission denied"),
      });
      return { filePaths: [configFile, keyFile], lines };
    },
  },
];

for (const { name, says, drive } of LINES)
  test(`${name} names the path as the operator typed it`, async () => {
    expectPathsAsTyped(await drive(), says);
  });

test("a log sink renders an operator path rather than interpolating it raw", async () => {
  // What the mark decides beyond the separators: the render replaces the
  // control class with a printable marker, so a path carrying an escape
  // sequence cannot drive the terminal it is reported on. Interpolated raw, the
  // byte would reach the operator as it stands.
  const { log, lines } = stubLog();
  logOnlineBootstrapOutcome(log, {
    configFile: "/srv/\x1b[31mdrop/psilink.yaml",
    keyFile: ".psilink.key",
  });
  const text = lines.join("\n");
  expect(text).toContain("/srv/<1b>[31mdrop/psilink.yaml");
  expect(text).not.toContain("\x1b");
});
