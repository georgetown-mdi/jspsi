import { describe, expect, test } from "vitest";

import { selectExchangeDriver } from "@bench/exchangeDriverSelection";

import type { DeploymentProfile } from "@utils/clientConfig";
import type { ExchangeDriverSelection } from "@bench/exchangeDriverSelection";
import type { Transport } from "@bench/inviterModel";

const PROFILES: ReadonlyArray<DeploymentProfile> = ["hosted", "console"];
const CHANNELS: ReadonlyArray<Transport> = ["browser", "sftp", "filedrop"];

// Every (channel x profile) cell, asserting the fixed scope-decision table:
//   browser  (any profile)      -> browser
//   filedrop + console          -> server-job
//   filedrop + hosted           -> save-file
//   sftp     (any profile)      -> save-file
const EXPECTED: Record<
  Transport,
  Record<DeploymentProfile, ExchangeDriverSelection["kind"]>
> = {
  browser: { hosted: "browser", console: "browser" },
  filedrop: { hosted: "save-file", console: "server-job" },
  sftp: { hosted: "save-file", console: "save-file" },
};

describe("selectExchangeDriver", () => {
  for (const channel of CHANNELS) {
    for (const profile of PROFILES) {
      test(`${channel} on a ${profile} build selects ${EXPECTED[channel][profile]}`, () => {
        expect(selectExchangeDriver(channel, profile).kind).toBe(
          EXPECTED[channel][profile],
        );
      });
    }
  }

  test("browser never routes to a server-side or save path", () => {
    for (const profile of PROFILES)
      expect(selectExchangeDriver("browser", profile).kind).toBe("browser");
  });

  test("sftp is never routed to the server-job driver in this slice", () => {
    for (const profile of PROFILES)
      expect(selectExchangeDriver("sftp", profile).kind).not.toBe("server-job");
  });
});
