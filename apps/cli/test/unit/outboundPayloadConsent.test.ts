import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import YAML from "yaml";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import {
  getDiagnosticSink,
  getLogger,
  parseExchangeSpec,
  setDiagnosticSink,
  UsageError,
} from "@psilink/core";
import type { ExchangeDataSpec, LinkageTerms, Metadata } from "@psilink/core";

import { confirmOutboundPayloadConsent } from "../../src/outboundPayloadConsent";
import { prepareDataset } from "../../src/commands/exchange";
import { promptConfirm } from "../../src/util/prompt";
import { captureStdio } from "../loggingTestSupport";
import { streamOf, ttyStream, withStdin } from "../stdinStream";

// The prompt itself is mocked so these drive the answer rather than a terminal;
// util/prompt's own tests cover promptConfirm, and util/dataIo's
// openInputSource, which prepareDataset reads its CSV through, stays real.
vi.mock("../../src/util/prompt", async () => {
  const actual = await vi.importActual<typeof import("../../src/util/prompt")>(
    "../../src/util/prompt",
  );
  return { ...actual, promptConfirm: vi.fn() };
});

const promptConfirmMock = vi.mocked(promptConfirm);

const log = getLogger("outbound-consent-test");
log.setLevel("silent");

let dir: string;
let configFile: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(tmpdir(), "psilink-outbound-consent-"));
  configFile = path.join(dir, "psilink.yaml");
  promptConfirmMock.mockReset();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// The acceptor shape: terms adopted from an invitation that authored no
// `payload.receive`, so this party's own `payload.send` is absent and its outbound
// set comes from its input columns.
const acceptorTerms: LinkageTerms = {
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

function metadataDisclosing(columns: string[]): Metadata {
  return [
    {
      name: "first_name",
      type: "first_name",
      role: "linkage",
      isPayload: false,
    },
    ...columns.map((name) => ({
      name,
      type: "other" as const,
      role: "payload" as const,
      isPayload: true,
    })),
  ];
}

/** A config on disk holding `consent`, plus operator content to preserve. */
function writeConfig(consent: Record<string, unknown> | undefined): void {
  fs.writeFileSync(
    configFile,
    "# operator-authored note\n" +
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
        ...(consent !== undefined ? { outbound_payload_consent: consent } : {}),
      }),
  );
}

/**
 * Run the confirmation over `spec`, returning what it threw (or undefined).
 * Standard error is captured rather than left to reach the runner's own output:
 * the surface writes there, where the prompt asks.
 */
async function confirm(
  spec: ExchangeDataSpec,
  metadata: Metadata,
  interactive: boolean,
): Promise<unknown> {
  const stdio = captureStdio();
  try {
    return await withStdin(interactive ? ttyStream() : streamOf(""), () =>
      confirmOutboundPayloadConsent({
        spec,
        metadata,
        output: spec.linkageTerms?.output ?? acceptorTerms.output,
        configPath: configFile,
        logFile: undefined,
        log,
      }).then(
        () => undefined,
        (e: unknown) => e,
      ),
    );
  } finally {
    promptWrites = stdio.stderrWrites.join("");
    stdio.restore();
  }
}

/** What the last {@link confirm} wrote where the prompt asks. */
let promptWrites = "";

// --- Nothing owed ------------------------------------------------------------

test("no consent record: nothing is asked and nothing is written", async () => {
  // Every non-acceptor -- an inviter, a zero-setup run, a hand-authored config --
  // is here, so this is the path that must stay exactly as it was.
  writeConfig(undefined);
  const before = fs.readFileSync(configFile, "utf8");
  const spec: ExchangeDataSpec = { linkageTerms: acceptorTerms };
  expect(await confirm(spec, metadataDisclosing(["diagnosis"]), true)).toBe(
    undefined,
  );
  expect(promptConfirmMock).not.toHaveBeenCalled();
  expect(fs.readFileSync(configFile, "utf8")).toBe(before);
});

test("a confirmed set the run still resolves is not asked about again", async () => {
  writeConfig({ status: "confirmed", columns: ["diagnosis"] });
  const before = fs.readFileSync(configFile, "utf8");
  const spec: ExchangeDataSpec = {
    linkageTerms: acceptorTerms,
    outboundPayloadConsent: { status: "confirmed", columns: ["diagnosis"] },
  };
  expect(await confirm(spec, metadataDisclosing(["diagnosis"]), true)).toBe(
    undefined,
  );
  expect(promptConfirmMock).not.toHaveBeenCalled();
  expect(fs.readFileSync(configFile, "utf8")).toBe(before);
});

test("an exchange that transmits nothing is not asked about", async () => {
  // The partner is entitled to no result, so no column leaves whatever the input
  // discloses; asking would be asking about a disclosure that does not happen.
  writeConfig({ status: "pending" });
  const spec: ExchangeDataSpec = {
    linkageTerms: {
      ...acceptorTerms,
      output: { expectsOutput: true, shareWithPartner: false },
    },
    outboundPayloadConsent: { status: "pending" },
  };
  expect(await confirm(spec, metadataDisclosing(["diagnosis"]), true)).toBe(
    undefined,
  );
  expect(promptConfirmMock).not.toHaveBeenCalled();
});

// --- Pending: the accept-with-no-input case ----------------------------------

test("pending, interactive, confirmed: the set is recorded and the spec updated", async () => {
  // The deferred confirmation the acceptance's forward reference promises. What is
  // recorded is the set resolved from THIS run's metadata, and the spec is updated
  // in place so the prepare-time safety check reads the answer just given.
  writeConfig({ status: "pending" });
  promptConfirmMock.mockResolvedValue(true);
  const spec: ExchangeDataSpec = {
    linkageTerms: acceptorTerms,
    outboundPayloadConsent: { status: "pending" },
  };
  expect(
    await confirm(spec, metadataDisclosing(["diagnosis", "notes"]), true),
  ).toBe(undefined);
  expect(promptConfirmMock).toHaveBeenCalledTimes(1);
  // The heading leads with what the answer still decides -- that nothing has been
  // sent -- and claims nothing about connection order: an unpinned SFTP
  // configuration establishes first-use host-key trust over a credential-free probe
  // ahead of this question, so a heading promising that nothing has connected would
  // not hold there. Pinned so the wording cannot drift into one that does.
  expect(promptWrites).toContain(
    "Nothing is sent until you confirm what this exchange will send:",
  );
  // The columns reach the terminal the question is asked on, one per line, so a
  // name containing the list separator cannot be misread as two -- the treatment the
  // acceptance display gives the same fact, under the same label.
  expect(promptWrites).toContain("columns you will send (enforced):");
  expect(promptWrites).toContain("\n    - diagnosis\n");
  expect(promptWrites).toContain("\n    - notes\n");
  expect(spec.outboundPayloadConsent).toEqual({
    status: "confirmed",
    columns: ["diagnosis", "notes"],
  });
  const raw = fs.readFileSync(configFile, "utf8");
  // A surgical one-field write: the operator's comment survives it.
  expect(raw).toContain("# operator-authored note");
  expect(parseExchangeSpec(YAML.parse(raw)).outboundPayloadConsent).toEqual({
    status: "confirmed",
    columns: ["diagnosis", "notes"],
  });
});

test("pending, interactive, declined: nothing is recorded and the run stops", async () => {
  writeConfig({ status: "pending" });
  promptConfirmMock.mockResolvedValue(false);
  const before = fs.readFileSync(configFile, "utf8");
  const spec: ExchangeDataSpec = {
    linkageTerms: acceptorTerms,
    outboundPayloadConsent: { status: "pending" },
  };
  const err = await confirm(spec, metadataDisclosing(["diagnosis"]), true);
  expect(err).toBeInstanceOf(UsageError);
  expect((err as Error).message).toMatch(/were not confirmed/);
  expect(spec.outboundPayloadConsent).toEqual({ status: "pending" });
  expect(fs.readFileSync(configFile, "utf8")).toBe(before);
});

test("pending, non-interactive: refused with the set and how to confirm it", async () => {
  // The unattended path this item exists to close: nothing can answer a prompt, so
  // reading end-of-file as a decline would be inventing an answer -- and proceeding
  // would transmit a set no party chose. It refuses, naming both.
  writeConfig({ status: "pending" });
  const before = fs.readFileSync(configFile, "utf8");
  const spec: ExchangeDataSpec = {
    linkageTerms: acceptorTerms,
    outboundPayloadConsent: { status: "pending" },
  };
  const err = await confirm(spec, metadataDisclosing(["diagnosis"]), false);
  expect(err).toBeInstanceOf(UsageError);
  expect((err as Error).message).toContain("diagnosis");
  expect((err as Error).message).toContain("interactive terminal");
  expect(promptConfirmMock).not.toHaveBeenCalled();
  expect(fs.readFileSync(configFile, "utf8")).toBe(before);
});

test("a column shaped like armor reads the same in the log and at the prompt", async () => {
  // The surface's two sinks run different passes -- core's prefixer strips key
  // material per log argument, and writePromptLine runs none -- so a name left
  // to the sinks would display as the replacement in the log and verbatim at the
  // question it is answered against. Both sinks are captured on ONE run and
  // compared line for line. A decline is what makes that comparison exact: the
  // run ends at the refusal, so the log holds the surface and nothing after it.
  writeConfig({ status: "pending" });
  promptConfirmMock.mockResolvedValue(false);
  const armored = "-----BEGIN RSA PRIVATE KEY-----MIIEowIBAAKCAQEA";
  const spec: ExchangeDataSpec = {
    linkageTerms: acceptorTerms,
    outboundPayloadConsent: { status: "pending" },
  };
  const logged: string[] = [];
  const previousSink = getDiagnosticSink();
  const previousLevel = log.getLevel();
  setDiagnosticSink((_method, _prefix, args) => {
    logged.push(args.map((arg) => String(arg)).join(" "));
  });
  log.setLevel("info");
  const stdio = captureStdio();
  let thrown: unknown;
  try {
    thrown = await withStdin(ttyStream(), () =>
      confirmOutboundPayloadConsent({
        spec,
        metadata: metadataDisclosing([armored]),
        output: acceptorTerms.output,
        configPath: configFile,
        // A --log-file is what routes the log off the terminal the prompt asks
        // on, so each sink receives the surface in its own right.
        logFile: path.join(dir, "run.log"),
        log,
      }).then(
        () => undefined,
        (e: unknown) => e,
      ),
    );
  } finally {
    stdio.restore();
    setDiagnosticSink(previousSink);
    log.setLevel(previousLevel);
  }

  expect(thrown).toBeInstanceOf(UsageError);
  const promptLines = stdio.stderrWrites.join("").split("\n").slice(0, -1);
  expect(promptLines).toEqual(logged);
  expect(promptLines).toContain("    - [redacted private key]");
  expect(promptLines.join("\n")).not.toContain("MIIEow");
  expect(promptLines.join("\n")).not.toContain("BEGIN RSA");
});

// --- Changed: the input file moved between accept and run --------------------

test("a widened set, non-interactive: refused before anything is sent", async () => {
  writeConfig({ status: "confirmed", columns: ["diagnosis"] });
  const spec: ExchangeDataSpec = {
    linkageTerms: acceptorTerms,
    outboundPayloadConsent: { status: "confirmed", columns: ["diagnosis"] },
  };
  const err = await confirm(
    spec,
    metadataDisclosing(["diagnosis", "ssn_note"]),
    false,
  );
  expect(err).toBeInstanceOf(UsageError);
  expect((err as Error).message).toContain("ssn_note");
});

test("a widened set, interactive: re-asked, and a yes re-records the new set", async () => {
  writeConfig({ status: "confirmed", columns: ["diagnosis"] });
  promptConfirmMock.mockResolvedValue(true);
  const spec: ExchangeDataSpec = {
    linkageTerms: acceptorTerms,
    outboundPayloadConsent: { status: "confirmed", columns: ["diagnosis"] },
  };
  expect(
    await confirm(spec, metadataDisclosing(["diagnosis", "ssn_note"]), true),
  ).toBe(undefined);
  expect(
    parseExchangeSpec(YAML.parse(fs.readFileSync(configFile, "utf8")))
      .outboundPayloadConsent,
  ).toEqual({ status: "confirmed", columns: ["diagnosis", "ssn_note"] });
});

test("a narrowed set is asked about too", async () => {
  writeConfig({ status: "confirmed", columns: ["diagnosis", "notes"] });
  const spec: ExchangeDataSpec = {
    linkageTerms: acceptorTerms,
    outboundPayloadConsent: {
      status: "confirmed",
      columns: ["diagnosis", "notes"],
    },
  };
  const err = await confirm(spec, metadataDisclosing(["diagnosis"]), false);
  expect(err).toBeInstanceOf(UsageError);
  expect((err as Error).message).toContain("notes");
});

// --- Through prepareDataset --------------------------------------------------

test("prepareDataset: an unattended run refuses a set widened since the accept", async () => {
  // End to end through prepareDataset: a config accepted with one CSV, run
  // against another whose extra column inferMetadata makes transmittable by
  // default. The refusal is raised while the dataset is being prepared -- before
  // the run that holds credentials, terms, and data -- and has the exit-64
  // classification a UsageError gets, distinct from a transport failure.
  const input = path.join(dir, "in.csv");
  fs.writeFileSync(input, "first_name,diagnosis,ssn_note\nAda,A,S\n");
  const err = await withStdin(streamOf(""), () =>
    prepareDataset(
      {
        linkageTerms: acceptorTerms,
        outboundPayloadConsent: { status: "confirmed", columns: ["diagnosis"] },
      },
      "Acceptor",
      input,
      { configPath: configFile, logFile: undefined },
    ).then(
      () => undefined,
      (e: unknown) => e,
    ),
  );
  expect(err).toBeInstanceOf(UsageError);
  expect((err as Error).message).toContain("ssn_note");
});

test("prepareDataset: the same run prepares once the set is the confirmed one", async () => {
  const input = path.join(dir, "in.csv");
  fs.writeFileSync(input, "first_name,diagnosis\nAda,A\n");
  const prepared = await withStdin(streamOf(""), () =>
    prepareDataset(
      {
        linkageTerms: acceptorTerms,
        outboundPayloadConsent: { status: "confirmed", columns: ["diagnosis"] },
      },
      "Acceptor",
      input,
      { configPath: configFile, logFile: undefined },
    ),
  );
  expect(prepared.metadata.map((c) => c.name)).toEqual([
    "first_name",
    "diagnosis",
  ]);
});

test("a failed record write after a yes is a usage error naming the config, not a transport failure", async () => {
  // The operator answered yes at a terminal and nothing was sent; a read-only or
  // replaced config is a local configuration fault, so it must classify as usage
  // (exit 64) like the sibling config writes, with the fs cause on the chain --
  // not fall through as a transport-class failure.
  writeConfig({ status: "pending" });
  promptConfirmMock.mockResolvedValue(true);
  fs.rmSync(configFile);
  fs.mkdirSync(configFile);
  const spec: ExchangeDataSpec = {
    linkageTerms: acceptorTerms,
    outboundPayloadConsent: { status: "pending" },
  };
  const err = await confirm(spec, metadataDisclosing(["diagnosis"]), true);
  expect(err).toBeInstanceOf(UsageError);
  expect((err as Error).message).toMatch(/could not be recorded/);
  expect((err as Error).message).toContain(configFile);
  expect((err as { cause?: unknown }).cause).toBeDefined();
});
