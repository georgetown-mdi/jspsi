import { describe, expect, test } from "vitest";

import { selectExchangeDriver } from "@bench/exchangeDriverSelection";

import type { DeploymentProfile } from "@utils/clientConfig";
import type { ExchangeDriverSelection } from "@bench/exchangeDriverSelection";
import type { Transport } from "@bench/inviterModel";

const PROFILES: ReadonlyArray<DeploymentProfile> = ["hosted", "console"];
const CHANNELS: ReadonlyArray<Transport> = ["browser", "sftp", "filedrop"];
const REMOTES: ReadonlyArray<boolean> = [false, true];

// Every (channel x profile x remotes-configured) cell, asserting the fixed
// scope-decision table:
//   browser  (any profile, any remotes)      -> browser
//   filedrop + console (any remotes)         -> server-job
//   filedrop + hosted  (any remotes)         -> save-file
//   sftp     + console + remotes configured  -> server-job
//   sftp     + console + none configured     -> save-file
//   sftp     + hosted  (any remotes)         -> save-file
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
      for (const remotes of REMOTES) {
        const expected = EXPECTED[channel][profile][`${remotes}`];
        test(`${channel} on a ${profile} build (remotes ${remotes ? "configured" : "absent"}) selects ${expected}`, () => {
          expect(selectExchangeDriver(channel, profile, remotes).kind).toBe(
            expected,
          );
        });
      }
    }
  }

  test("browser never routes to a server-side or save path", () => {
    for (const profile of PROFILES)
      for (const remotes of REMOTES)
        expect(selectExchangeDriver("browser", profile, remotes).kind).toBe(
          "browser",
        );
  });

  test("sftp runs server-side ONLY on a console with configured remotes", () => {
    expect(selectExchangeDriver("sftp", "console", true).kind).toBe(
      "server-job",
    );
    // Fail toward save-file: no remotes means no server-side connection
    // material, and a non-console build has no job API at all.
    expect(selectExchangeDriver("sftp", "console", false).kind).toBe(
      "save-file",
    );
    for (const remotes of REMOTES)
      expect(selectExchangeDriver("sftp", "hosted", remotes).kind).toBe(
        "save-file",
      );
  });

  test("the remotes flag never changes a non-sftp routing", () => {
    for (const channel of ["browser", "filedrop"] as const)
      for (const profile of PROFILES)
        expect(selectExchangeDriver(channel, profile, true).kind).toBe(
          selectExchangeDriver(channel, profile, false).kind,
        );
  });
});
