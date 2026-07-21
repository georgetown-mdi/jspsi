import { describe, expect, test } from "vitest";

import {
  selectExchangeDriver,
  sftpConnectionAvailability,
} from "@bench/exchangeDriverSelection";

import type { DeploymentProfile } from "@utils/clientConfig";
import type { ExchangeDriverSelection } from "@bench/exchangeDriverSelection";
import type { Transport } from "@bench/inviterModel";

const PROFILES: ReadonlyArray<DeploymentProfile> = ["hosted", "console"];
const CHANNELS: ReadonlyArray<Transport> = ["browser", "sftp", "filedrop"];
const SFTP_CONFIGURED: ReadonlyArray<boolean> = [false, true];

// Every (channel x profile x sftp-configured) cell, asserting the fixed
// scope-decision table (with no deliberate save-a-file preference):
//   browser  (any profile, any sftp)         -> browser
//   filedrop + console (any sftp)            -> server-job
//   filedrop + hosted  (any sftp)            -> save-file
//   sftp     + console + server configured   -> server-job
//   sftp     + console + none configured     -> server-job (runs here once authored)
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
    console: { false: "server-job", true: "server-job" },
  },
};

describe("selectExchangeDriver", () => {
  for (const channel of CHANNELS) {
    for (const profile of PROFILES) {
      for (const configured of SFTP_CONFIGURED) {
        const expected = EXPECTED[channel][profile][`${configured}`];
        test(`${channel} on a ${profile} build (sftp ${configured ? "configured" : "absent"}) selects ${expected}`, () => {
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

  test("unconfigured console sftp runs here (authoring pending), not save-file", () => {
    // The silent configured:false -> save-file degrade is gone: the run mode is
    // server-job (it runs here once the operator authors a connection), and the
    // create gate blocks minting until there is one.
    expect(selectExchangeDriver("sftp", "console", false).kind).toBe(
      "server-job",
    );
  });

  test("the deliberate save-a-file preference flips unconfigured console sftp", () => {
    // Only when the operator explicitly chooses to save a file for their own
    // command-line tool does an unconfigured console sftp route to save-file.
    expect(selectExchangeDriver("sftp", "console", false, true).kind).toBe(
      "save-file",
    );
    // A configured connection ignores the preference -- it runs here.
    expect(selectExchangeDriver("sftp", "console", true, true).kind).toBe(
      "server-job",
    );
  });

  test("sftp on a hosted build always saves a file", () => {
    for (const configured of SFTP_CONFIGURED)
      for (const preferred of [false, true])
        expect(
          selectExchangeDriver("sftp", "hosted", configured, preferred).kind,
        ).toBe("save-file");
  });

  test("the sftp-configured flag never changes a non-sftp routing", () => {
    for (const channel of ["browser", "filedrop"] as const)
      for (const profile of PROFILES)
        expect(selectExchangeDriver(channel, profile, true).kind).toBe(
          selectExchangeDriver(channel, profile, false).kind,
        );
  });
});

describe("sftpConnectionAvailability", () => {
  test("hosted always saves a file", () => {
    expect(sftpConnectionAvailability("hosted", false)).toBe("saveFileOnly");
    expect(sftpConnectionAvailability("hosted", true)).toBe("saveFileOnly");
  });

  test("console runs here when configured, else needs authoring", () => {
    expect(sftpConnectionAvailability("console", true)).toBe("runHere");
    expect(sftpConnectionAvailability("console", false)).toBe(
      "authoringRequired",
    );
  });
});
