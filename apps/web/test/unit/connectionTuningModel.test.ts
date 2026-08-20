import { describe, expect, test } from "vitest";

import { parse as parseYaml } from "yaml";

import {
  CONNECTION_PER_POLL_SHORT_INTERVAL_WARN_MS,
  DEFAULT_MAX_RECONNECT_ATTEMPTS,
  DEFAULT_POLLING_FREQUENCY_MS,
  LOW_POLLING_FREQUENCY_WARN_MS,
  MAX_RECONNECT_ATTEMPTS,
} from "@psilink/core";

import {
  CONNECTION_PER_POLL_SHORT_INTERVAL_ADVISORY,
  CONNECTION_TUNING_DEFAULT,
  FILEDROP_CONNECTION_TUNING,
  LOW_POLL_INTERVAL_ADVISORY,
  SFTP_CONNECTION_TUNING,
  connectionTuningAdvisories,
  connectionTuningOptions,
  connectionTuningProblems,
  defaultPlaceholder,
  withConnectionTuning,
} from "@bench/connectionTuningModel";
import {
  EXCHANGE_FILES_DEFAULT,
  ZERO_SETUP_EXCHANGE_FILES,
  exchangeFilesOptions,
} from "@bench/exchangeFilesModel";
import {
  composeConfigDocument,
  composeSftpConfigDocument,
  zeroSetupOptionsArgv,
} from "@jobs/intent";

import {
  testSftpServerEntry,
  validIntent,
  validSftpIntent,
} from "../utils/jobFixtures";

import type { ConnectionTuningDraft } from "@bench/connectionTuningModel";

const draft = (
  overrides: Partial<ConnectionTuningDraft> = {},
): ConnectionTuningDraft => ({ ...CONNECTION_TUNING_DEFAULT, ...overrides });

/** The `connection.options` block a draft composes into a filedrop config, the
 * document a console invitation run actually loads. */
const composedOptions = (
  authored: ConnectionTuningDraft,
): Record<string, unknown> => {
  const options = connectionTuningOptions(authored, FILEDROP_CONNECTION_TUNING);
  const doc = parseYaml(
    composeConfigDocument(
      validIntent(options !== undefined ? { options } : {}),
      "/srv/jobs/x/exchange",
    ),
  ) as { connection: { options?: Record<string, unknown> } };
  return doc.connection.options ?? {};
};

describe("the authored draft becomes an option block", () => {
  test("an untouched draft carries no options and no problems", () => {
    expect(connectionTuningOptions(CONNECTION_TUNING_DEFAULT)).toBeUndefined();
    expect(connectionTuningProblems(CONNECTION_TUNING_DEFAULT)).toEqual([]);
    expect(connectionTuningAdvisories(CONNECTION_TUNING_DEFAULT)).toEqual([]);
  });

  // The whole point of the untouched-form guarantee: a console run an operator
  // never opened this card on composes exactly the config it composed before the
  // card existed.
  test("an untouched form composes no options block at all", () => {
    const doc = parseYaml(
      composeConfigDocument(validIntent(), "/srv/jobs/x/exchange"),
    ) as { connection: { options?: Record<string, unknown> } };
    expect(doc.connection.options).toBeUndefined();
    expect(composedOptions(CONNECTION_TUNING_DEFAULT)).toEqual({});
  });

  test.each([
    ["ms", "250", 250],
    ["s", "30", 30_000],
    ["m", "2", 120_000],
  ] as const)(
    "a check interval in %s converts to milliseconds",
    (unit, magnitude, expected) => {
      expect(
        connectionTuningOptions(draft({ pollInterval: { magnitude, unit } }))
          ?.pollIntervalMs,
      ).toBe(expected);
    },
  );

  test.each([
    ["s", "45", 45_000],
    ["m", "30", 1_800_000],
    ["h", "2", 7_200_000],
  ] as const)(
    "a partner wait in %s converts to milliseconds",
    (unit, magnitude, expected) => {
      expect(
        connectionTuningOptions(draft({ peerTimeout: { magnitude, unit } }))
          ?.peerTimeoutMs,
      ).toBe(expected);
    },
  );

  test("a padded magnitude is trimmed, and a blank one is unset", () => {
    expect(
      connectionTuningOptions(
        draft({ serverConnectTimeout: { magnitude: "  45  ", unit: "s" } }),
      ),
    ).toEqual({ serverConnectTimeoutMs: 45_000 });
    expect(
      connectionTuningOptions(
        draft({ serverConnectTimeout: { magnitude: "   ", unit: "s" } }),
      ),
    ).toBeUndefined();
  });

  test("a zero retry budget is stated, not treated as unset", () => {
    expect(
      connectionTuningOptions(draft({ maxReconnectAttempts: "0" })),
    ).toEqual({ maxReconnectAttempts: 0 });
  });

  test("the SFTP session mode is emitted only when the flow can carry it", () => {
    const authored = draft({ connectionPerPoll: true });
    expect(connectionTuningOptions(authored, SFTP_CONNECTION_TUNING)).toEqual({
      connectionPerPoll: true,
    });
    // A shared-directory client holds no session, and the intent's filedrop arm
    // refuses the field, so the card never puts it on an intent that would fail.
    expect(
      connectionTuningOptions(authored, FILEDROP_CONNECTION_TUNING),
    ).toBeUndefined();
  });
});

describe("each knob round-trips into the composed config", () => {
  test("every knob reaches a filedrop config under its snake_case name", () => {
    expect(
      composedOptions(
        draft({
          pollInterval: { magnitude: "30", unit: "s" },
          peerTimeout: { magnitude: "2", unit: "h" },
          serverConnectTimeout: { magnitude: "45", unit: "s" },
          maxReconnectAttempts: "12",
        }),
      ),
    ).toEqual({
      poll_interval_ms: 30_000,
      peer_timeout_ms: 7_200_000,
      server_connect_timeout_ms: 45_000,
      max_reconnect_attempts: 12,
    });
  });

  test("the SFTP session mode reaches an sftp config", () => {
    const options = connectionTuningOptions(
      draft({
        connectionPerPoll: true,
        pollInterval: { magnitude: "10", unit: "m" },
      }),
      SFTP_CONNECTION_TUNING,
    );
    const doc = parseYaml(
      composeSftpConfigDocument(
        validSftpIntent(options !== undefined ? { options } : {}),
        testSftpServerEntry(),
      ),
    ) as { connection: { options?: Record<string, unknown> } };
    expect(doc.connection.options).toMatchObject({
      connection_per_poll: true,
      poll_interval_ms: 600_000,
    });
  });

  test("the two cards' blocks merge into the one options object", () => {
    const merged = withConnectionTuning(
      exchangeFilesOptions({ ...EXCHANGE_FILES_DEFAULT, retainFiles: true }),
      draft({ pollInterval: { magnitude: "10", unit: "m" } }),
    );
    expect(merged).toEqual({
      retainFiles: true,
      locklessRendezvous: true,
      timestampInFilename: true,
      pollIntervalMs: 600_000,
    });
  });

  test("neither card contributing leaves the block absent", () => {
    expect(
      withConnectionTuning(
        exchangeFilesOptions(EXCHANGE_FILES_DEFAULT),
        CONNECTION_TUNING_DEFAULT,
      ),
    ).toBeUndefined();
  });

  test("the authored values reach a zero-setup command line unchanged", () => {
    const options = withConnectionTuning(
      exchangeFilesOptions(
        { ...EXCHANGE_FILES_DEFAULT, retainFiles: true },
        ZERO_SETUP_EXCHANGE_FILES,
      ),
      draft({
        pollInterval: { magnitude: "10", unit: "m" },
        peerTimeout: { magnitude: "2", unit: "h" },
        maxReconnectAttempts: "12",
        connectionPerPoll: true,
      }),
      SFTP_CONNECTION_TUNING,
    );
    expect(zeroSetupOptionsArgv(options)).toEqual([
      "--retain-files",
      "--lockless-rendezvous",
      "--timestamp-in-filename",
      "--polling-frequency=600000ms",
      "--peer-timeout=7200s",
      "--max-reconnect-attempts=12",
      "--connection-per-poll",
    ]);
  });
});

describe("a malformed value is a form problem, not a failed job", () => {
  test.each([
    ["a decimal", "1.5"],
    ["a negative", "-5"],
    ["a non-number", "soon"],
    ["a zero", "0"],
  ])("a check interval that is %s is refused", (_label, magnitude) => {
    const problems = connectionTuningProblems(
      draft({ pollInterval: { magnitude, unit: "s" } }),
    );
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain("check interval");
    // A refused field never reaches an option block.
    expect(
      connectionTuningOptions(
        draft({ pollInterval: { magnitude, unit: "s" } }),
      ),
    ).toBeUndefined();
  });

  test("a retry budget past core's ceiling is refused, in its terms", () => {
    const problems = connectionTuningProblems(
      draft({ maxReconnectAttempts: String(MAX_RECONNECT_ATTEMPTS + 1) }),
    );
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain(String(MAX_RECONNECT_ATTEMPTS));
    expect(problems[0]).toContain(String(DEFAULT_MAX_RECONNECT_ATTEMPTS));
    expect(
      connectionTuningProblems(
        draft({ maxReconnectAttempts: String(MAX_RECONNECT_ATTEMPTS) }),
      ),
    ).toEqual([]);
  });

  test("each malformed field reports once, and a sound draft reports nothing", () => {
    expect(
      connectionTuningProblems(
        draft({
          pollInterval: { magnitude: "x", unit: "s" },
          peerTimeout: { magnitude: "y", unit: "m" },
          serverConnectTimeout: { magnitude: "z", unit: "s" },
          maxReconnectAttempts: "w",
        }),
      ).length,
    ).toBe(4);
    expect(
      connectionTuningProblems(
        draft({
          pollInterval: { magnitude: "30", unit: "s" },
          peerTimeout: { magnitude: "2", unit: "h" },
          serverConnectTimeout: { magnitude: "45", unit: "s" },
          maxReconnectAttempts: "12",
        }),
      ),
    ).toEqual([]);
  });
});

// The CLI raises both of these at run time; the console raises them while the
// operator can still act on them. Neither blocks: both values are legitimate
// against a server the operator controls, and the command line refuses neither.
describe("the CLI's two advisories are raised at authoring time", () => {
  test("a sub-second check interval draws the anti-flood advisory", () => {
    const justUnder = LOW_POLLING_FREQUENCY_WARN_MS - 1;
    expect(
      connectionTuningAdvisories(
        draft({ pollInterval: { magnitude: String(justUnder), unit: "ms" } }),
      ),
    ).toEqual([LOW_POLL_INTERVAL_ADVISORY]);
    // And it never blocks the run.
    expect(
      connectionTuningProblems(
        draft({ pollInterval: { magnitude: String(justUnder), unit: "ms" } }),
      ),
    ).toEqual([]);
  });

  test("the advisory is silent at and above the threshold", () => {
    expect(
      connectionTuningAdvisories(
        draft({
          pollInterval: {
            magnitude: String(LOW_POLLING_FREQUENCY_WARN_MS),
            unit: "ms",
          },
        }),
      ),
    ).toEqual([]);
  });

  test("the session mode with a short interval draws the wasteful-dialing advisory", () => {
    const justUnder = CONNECTION_PER_POLL_SHORT_INTERVAL_WARN_MS / 1000 - 1;
    expect(
      connectionTuningAdvisories(
        draft({
          connectionPerPoll: true,
          pollInterval: { magnitude: String(justUnder), unit: "s" },
        }),
        SFTP_CONNECTION_TUNING,
      ),
    ).toEqual([CONNECTION_PER_POLL_SHORT_INTERVAL_ADVISORY]);
  });

  // The pairing the advisory is really about: the operator switches the mode on
  // and leaves the interval alone, so the run polls at core's seconds-scale
  // default and dials afresh every few seconds.
  test("the session mode with an unset interval reads core's default", () => {
    expect(DEFAULT_POLLING_FREQUENCY_MS).toBeLessThan(
      CONNECTION_PER_POLL_SHORT_INTERVAL_WARN_MS,
    );
    expect(
      connectionTuningAdvisories(
        draft({ connectionPerPoll: true }),
        SFTP_CONNECTION_TUNING,
      ),
    ).toEqual([CONNECTION_PER_POLL_SHORT_INTERVAL_ADVISORY]);
  });

  test("the session mode with a long interval draws nothing", () => {
    expect(
      connectionTuningAdvisories(
        draft({
          connectionPerPoll: true,
          pollInterval: { magnitude: "10", unit: "m" },
        }),
        SFTP_CONNECTION_TUNING,
      ),
    ).toEqual([]);
  });

  test("both advisories can be raised at once", () => {
    expect(
      connectionTuningAdvisories(
        draft({
          connectionPerPoll: true,
          pollInterval: { magnitude: "100", unit: "ms" },
        }),
        SFTP_CONNECTION_TUNING,
      ),
    ).toEqual([
      LOW_POLL_INTERVAL_ADVISORY,
      CONNECTION_PER_POLL_SHORT_INTERVAL_ADVISORY,
    ]);
  });

  test("a shared-directory flow raises no session-mode advisory", () => {
    expect(
      connectionTuningAdvisories(
        draft({ connectionPerPoll: true }),
        FILEDROP_CONNECTION_TUNING,
      ),
    ).toEqual([]);
  });
});

describe("the placeholder shows core's own default in the chosen unit", () => {
  test.each([
    ["ms", "5000"],
    ["s", "5"],
  ] as const)("the poll default reads as %s", (unit, expected) => {
    expect(defaultPlaceholder(DEFAULT_POLLING_FREQUENCY_MS, unit)).toBe(
      expected,
    );
  });
});
