import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  PARTNER_PIN_UNRECORDABLE_FAILURE,
  partnerCertificatePinnedNotice,
  recordedPartnerFingerprint,
} from "@jobs/partnerPinNotice";
import { ERROR_MESSAGE_CHAIN_FIELD } from "@psi/relayErrorChain";
import { JOB_FILE_NAMES } from "@jobs/intentSchemas";
import { JobManager } from "@jobs/jobManager";
import { composeConfigDocument } from "@jobs/intentConfig";

import {
  STUB_CLI_PATH,
  STUB_CONFIG_FILE_TOKEN,
  tempDataRoot,
  validIntent,
  validLinkageTerms,
} from "../../utils/jobFixtures";

import type { JobRecord } from "@jobs/jobManager";
import type { RelayEvent } from "@jobs/cliDriver";

// What the console tells an operator about a first authenticated contact: the
// notice a run that pinned the partner's certificate raises, and the failure a
// run that could not record the pin stops on. Each of the CLI's own sentences
// names the configuration file the pin goes into, a path inside this container,
// so the relay rebuilds them from console copy and the recorded value.

/** A canonical 43-character fingerprint (the final character drawn from the
 * aligned set the config schema requires). */
const ADOPTED_FINGERPRINT = "E".repeat(42) + "A";

const dirs: Array<string> = [];
const managers: Array<JobManager> = [];

afterEach(() => {
  for (const manager of managers.splice(0)) manager.shutdown();
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

function scratchDir(label: string): string {
  const dir = tempDataRoot(label);
  fs.mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  return dir;
}

/** The buffered record of a job driven to its terminal event. */
async function awaitTerminal(
  manager: JobManager,
  id: string,
): Promise<JobRecord> {
  const record = manager.getJob(id)!;
  const deadline = Date.now() + 5000;
  while (!record.terminalEmitted) {
    if (Date.now() > deadline)
      throw new Error("timed out waiting for terminal");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return record;
}

/** A composed exchange configuration on disk, as the manager writes one, with
 * the signing block the intent's mode produces. Composed rather than
 * hand-written: what the reader has to find is the key the composer emits, so a
 * document built any other way would stop testing that pairing. */
function composedConfigFile(pin: string | undefined): string {
  const dir = scratchDir("pin-config");
  const intent = validIntent({
    linkageTerms: { ...validLinkageTerms(), identity: "Agency A" },
    signing: {
      mode: "certificate",
      ...(pin !== undefined ? { partnerFingerprint: pin } : {}),
    },
  });
  const configPath = path.join(dir, JOB_FILE_NAMES.config);
  fs.writeFileSync(
    configPath,
    composeConfigDocument(intent, path.join(dir, "rendezvous"), undefined, {
      identityFile: path.join(dir, ".psilink-signing-identity.json"),
      receiptOutput: path.join(dir, JOB_FILE_NAMES.receipt),
    }),
  );
  return configPath;
}

describe("the recorded pin is read back from the composed configuration", () => {
  test("a pin on file is found under the key the composer emits", () => {
    expect(
      recordedPartnerFingerprint(composedConfigFile(ADOPTED_FINGERPRINT)),
    ).toBe(ADOPTED_FINGERPRINT);
  });

  test("a configuration with no pin yields none", () => {
    expect(recordedPartnerFingerprint(composedConfigFile(undefined))).toBe(
      undefined,
    );
  });

  test("a value that is not a canonical digest is not shown", () => {
    // The value comes back through a file. It is a digest the CLI derived, but
    // only a canonical one is put in front of the operator as a fingerprint to
    // compare.
    const configPath = composedConfigFile(ADOPTED_FINGERPRINT);
    fs.writeFileSync(
      configPath,
      fs
        .readFileSync(configPath, "utf8")
        .replace(ADOPTED_FINGERPRINT, "not-a-fingerprint"),
    );
    expect(recordedPartnerFingerprint(configPath)).toBe(undefined);
  });

  test("an unreadable or unparsable configuration yields none rather than throwing", () => {
    const dir = scratchDir("pin-unreadable");
    expect(recordedPartnerFingerprint(path.join(dir, "absent.yaml"))).toBe(
      undefined,
    );
    const broken = path.join(dir, JOB_FILE_NAMES.config);
    fs.writeFileSync(broken, "signing: [unclosed\n");
    expect(recordedPartnerFingerprint(broken)).toBe(undefined);
  });
});

describe("the notice states the pin without naming a file", () => {
  test("it gives the value, what the pin rests on, and what to do next", () => {
    const notice = partnerCertificatePinnedNotice(ADOPTED_FINGERPRINT);
    expect(notice).toContain(ADOPTED_FINGERPRINT);
    expect(notice).toMatch(/channel the invitation travelled/);
    expect(notice).toMatch(/psilink fingerprint/);
    // The console composes a fresh configuration per run, so an adopted pin is
    // lost unless the operator enters it -- unlike a command-line run, which
    // records it in the file it was passed.
    expect(notice).toMatch(/before the next exchange/);
  });

  test("a value it could not read back leaves the pin stated and the value out", () => {
    const notice = partnerCertificatePinnedNotice(undefined);
    expect(notice).toMatch(/pinned the signing certificate/);
    expect(notice).toMatch(/could not read the value back/);
  });
});

describe("the relayed notice carries no container path", () => {
  test("the CLI's wording is replaced by the console's, holding the pin", async () => {
    const dataRoot = scratchDir("pin-relay-root");
    const manager = new JobManager({
      dataRoot,
      binaryPath: STUB_CLI_PATH,
      jobRendezvousDir: scratchDir("pin-relay-rvz"),
      childEnv: {
        STUB_EXIT_CODE: "0",
        STUB_PARTNER_PIN: ADOPTED_FINGERPRINT,
        STUB_FD3_EVENTS: JSON.stringify([
          {
            v: 1,
            type: "warning",
            source: "partnerCertificatePinned",
            // The real sentence, which names the configuration file: what must
            // not reach the browser.
            message:
              "Pinned the partner's signing certificate on this first " +
              `contact: fingerprint ${ADOPTED_FINGERPRINT}, recorded as ` +
              "signing.partner_fingerprint in " +
              `${dataRoot}/jobs/some-id/psilink.yaml.`,
          },
          { v: 1, type: "result", resultWritten: true },
        ]),
      },
    });
    managers.push(manager);
    const id = await manager.createJob(
      validIntent({
        linkageTerms: { ...validLinkageTerms(), identity: "Agency A" },
        signing: { mode: "certificate" },
      }),
    );
    const record = await awaitTerminal(manager, id);
    const warnings = record.events
      .map((entry) => entry.event)
      .filter((event) => event.type === "warning");
    expect(warnings).toHaveLength(1);
    const notice = warnings[0];
    // The source is relayed unchanged, so a supervisor still switches on it.
    expect(notice.source).toBe("partnerCertificatePinned");
    expect(notice.message).toContain(ADOPTED_FINGERPRINT);
    expect(notice.message).not.toContain(dataRoot);
    expect(notice.message).not.toContain("psilink.yaml");
    expect(notice.message).toBe(
      partnerCertificatePinnedNotice(ADOPTED_FINGERPRINT),
    );
  });
});

// The CLI's two first-contact refusals as it writes them: each names the
// configuration file the pin goes into (the token the stub replaces with the
// --config-file value it was spawned with) and offers an edit of that file or a
// writable mount of it, neither of which a console operator can act on.
const PRE_CONNECTION_REFUSAL =
  "this exchange signs receipts (signing.mode: certificate) and pins no " +
  "partner fingerprint, so its first authenticated contact records the " +
  `certificate the partner presents into ${STUB_CONFIG_FILE_TOKEN} -- and ` +
  "that file cannot be replaced: recording the pin writes a new file in the " +
  "directory holding it and renames that over the old one, which needs the " +
  "directory writable by the user this run is. The run stopped before " +
  "connecting. Either record signing.partner_fingerprint in that file by " +
  "hand, from the value the partner's 'psilink fingerprint' prints, or mount " +
  "the configuration writable for the run that records the pin.";

const ADOPTION_WRITE_FAILURE =
  "the partner's signing certificate was pinned on this first contact, but " +
  `the fingerprint could not be recorded in ${STUB_CONFIG_FILE_TOKEN} ` +
  "(EROFS: read-only file system), so the run stops here. The partner's " +
  `fingerprint is ${ADOPTED_FINGERPRINT}; before the next run, either record ` +
  "signing.partner_fingerprint in that file by hand, from the value the " +
  "partner's 'psilink fingerprint' prints, or mount the configuration " +
  "writable for the run that records the pin.";

/** One certificate-mode job whose child emits `message` as its terminal
 * failure, run to that terminal: the data root it ran under, every event the
 * browser would be served, and the single failure among them. */
async function runWithTerminalFailure(
  label: string,
  message: string,
): Promise<{ dataRoot: string; events: string; failure: RelayEvent }> {
  const dataRoot = scratchDir(`${label}-root`);
  const manager = new JobManager({
    dataRoot,
    binaryPath: STUB_CLI_PATH,
    jobRendezvousDir: scratchDir(`${label}-rvz`),
    childEnv: {
      STUB_EXIT_CODE: "64",
      STUB_FD3_EVENTS: JSON.stringify([
        { v: 1, type: "error", category: "config", message },
      ]),
    },
  });
  managers.push(manager);
  const id = await manager.createJob(
    validIntent({
      linkageTerms: { ...validLinkageTerms(), identity: "Agency A" },
      signing: { mode: "certificate" },
    }),
  );
  const record = await awaitTerminal(manager, id);
  const failures = record.events
    .map((entry) => entry.event)
    .filter((event) => event.type === "error");
  expect(failures).toHaveLength(1);
  return {
    dataRoot,
    events: JSON.stringify(record.events),
    failure: failures[0],
  };
}

describe("the relayed first-contact failure carries no container path", () => {
  async function expectRebuiltFailure(
    label: string,
    cliMessage: string,
  ): Promise<void> {
    const { dataRoot, events, failure } = await runWithTerminalFailure(
      label,
      cliMessage,
    );
    // Both fields, since the seat renders the chain where it holds text and the
    // flat field otherwise.
    expect(failure.message).toBe(PARTNER_PIN_UNRECORDABLE_FAILURE);
    expect(failure[ERROR_MESSAGE_CHAIN_FIELD]).toEqual([
      PARTNER_PIN_UNRECORDABLE_FAILURE,
    ]);
    // The category is relayed unchanged, so the seat routes the failure as it
    // did before the message was rebuilt.
    expect(failure.category).toBe("config");
    expect(events).not.toContain(dataRoot);
    expect(events).not.toContain(JOB_FILE_NAMES.config);
  }

  test("the refusal raised before connecting is rebuilt", async () => {
    await expectRebuiltFailure("pin-preflight", PRE_CONNECTION_REFUSAL);
  });

  test("the adoption write's own failure is rebuilt", async () => {
    await expectRebuiltFailure("pin-adoption", ADOPTION_WRITE_FAILURE);
  });

  test("a failure naming no console path is relayed as the CLI wrote it", async () => {
    // The rebuild is keyed on the configuration path the message states, so a
    // config failure about anything else reaches the operator in the CLI's own
    // words.
    const message =
      "the linkage terms name a key no column supplies, so the run stopped " +
      "before connecting.";
    const { failure } = await runWithTerminalFailure("pin-unrelated", message);
    expect(failure.message).toBe(message);
  });

  test("the console's own copy names no file and states the action", () => {
    expect(PARTNER_PIN_UNRECORDABLE_FAILURE).not.toContain(
      JOB_FILE_NAMES.config,
    );
    expect(PARTNER_PIN_UNRECORDABLE_FAILURE).not.toContain(
      "signing.partner_fingerprint",
    );
    expect(PARTNER_PIN_UNRECORDABLE_FAILURE).toMatch(/psilink fingerprint/);
    expect(PARTNER_PIN_UNRECORDABLE_FAILURE).toMatch(/run the exchange again/);
    // The run stopped at or before the terms exchange, so no row of the
    // operator's file moved (packages/core/src/exchange.ts, the terms-time pin
    // resolution).
    expect(PARTNER_PIN_UNRECORDABLE_FAILURE).toMatch(/sent none of your data/);
  });
});
