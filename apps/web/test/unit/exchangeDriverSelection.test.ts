import { describe, expect, test } from "vitest";

import { selectExchangeDriver } from "@bench/exchangeDriverSelection";

import type { DeploymentProfile } from "@utils/clientConfig";
import type { ExchangeDriverSelection } from "@bench/exchangeDriverSelection";
import type { Transport } from "@bench/inviterModel";

const PROFILES: ReadonlyArray<DeploymentProfile> = ["hosted", "console"];
const CHANNELS: ReadonlyArray<Transport> = ["browser", "sftp", "filedrop"];
const SFTP_CONFIGURED: ReadonlyArray<boolean> = [false, true];

// Every (channel x profile x sftp-configured) cell, asserting the fixed
// scope-decision table:
//   browser  (any profile, any sftp)         -> browser
//   filedrop + console (any sftp)            -> server-job
//   filedrop + hosted  (any sftp)            -> save-file
//   sftp     + console + server provisioned  -> server-job
//   sftp     + console + none provisioned    -> save-file
//   sftp     + hosted  (any sftp)            -> save-file
const EXPECTED: Record<
  Transport,
  Record<
    DeploymentProfile,
    Record<"true" | "false", ExchangeDriverSelection["kind"]>
  >
> = {
  browser: {
    hosted: { false: "browser", true: "browser" },
    console: { false: "browser", true: "browser" },
  },
  filedrop: {
    hosted: { false: "save-file", true: "save-file" },
    console: { false: "server-job", true: "server-job" },
  },
  sftp: {
    hosted: { false: "save-file", true: "save-file" },
    console: { false: "save-file", true: "server-job" },
  },
};

describe("selectExchangeDriver", () => {
  for (const channel of CHANNELS) {
    for (const profile of PROFILES) {
      for (const configured of SFTP_CONFIGURED) {
        const expected = EXPECTED[channel][profile][`${configured}`];
        test(`${channel} on a ${profile} build (sftp ${configured ? "provisioned" : "absent"}) selects ${expected}`, () => {
          expect(selectExchangeDriver(channel, profile, configured).kind).toBe(
            expected,
          );
        });
      }
    }
  }

  test("browser never routes to a server-side or save path", () => {
    for (const profile of PROFILES)
      for (const configured of SFTP_CONFIGURED)
        expect(selectExchangeDriver("browser", profile, configured).kind).toBe(
          "browser",
        );
  });

  test("sftp runs server-side ONLY on a console with a provisioned server", () => {
    expect(selectExchangeDriver("sftp", "console", true).kind).toBe(
      "server-job",
    );
    // Fail toward save-file: no provisioned server means no server-side
    // connection material, and a non-console build has no job API at all.
    expect(selectExchangeDriver("sftp", "console", false).kind).toBe(
      "save-file",
    );
    for (const configured of SFTP_CONFIGURED)
      expect(selectExchangeDriver("sftp", "hosted", configured).kind).toBe(
        "save-file",
      );
  });

  test("the sftp-configured flag never changes a non-sftp routing", () => {
    for (const channel of ["browser", "filedrop"] as const)
      for (const profile of PROFILES)
        expect(selectExchangeDriver(channel, profile, true).kind).toBe(
          selectExchangeDriver(channel, profile, false).kind,
        );
  });
});
