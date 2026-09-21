import { beforeAll, describe, expect, it } from "vitest";
import { chromium } from "playwright";

import viteConfig from "../../vite.config.ts";

// The integration project rather than the unit one: every case here launches a
// real Chromium, and CI installs the browser (eb_build_and_test.yaml) before
// this project runs and after the unit project has finished. A case moved back
// to unit would have no browser to launch on the automated gate.

const MDNS_FEATURE = "WebRtcHideLocalIpsWithMdns";
const SWITCH_PREFIX = "--disable-features=";

function disableFeaturesSwitches(args: ReadonlyArray<string>): Array<string> {
  return args.filter((arg) => arg.startsWith(SWITCH_PREFIX));
}

function featuresOf(disableFeaturesSwitch: string): Array<string> {
  return disableFeaturesSwitch.slice(SWITCH_PREFIX.length).split(",");
}

/** The launch arguments of every vitest project that launches a browser. */
async function browserProjectLaunchArgs(): Promise<Map<string, Array<string>>> {
  interface ProjectWithLaunchArgs {
    test?: {
      name?: string;
      browser?: {
        provider?: { options?: { launchOptions?: { args?: Array<string> } } };
      };
    };
  }
  const resolved = await viteConfig({ command: "serve", mode: "test" });
  const projects = (resolved.test?.projects ??
    []) as Array<ProjectWithLaunchArgs>;
  const launchArgs = new Map<string, Array<string>>();
  for (const project of projects) {
    const args = project.test?.browser?.provider?.options?.launchOptions?.args;
    if (args) launchArgs.set(project.test?.name ?? "<unnamed>", args);
  }
  return launchArgs;
}

describe("the browser projects' --disable-features switch", () => {
  // Playwright's own list, read off a launch it composed itself: the installed
  // package exports no entry point reaching it, and the launched command line
  // is the list as the browser actually receives it.
  let playwrightDefaultFeatures: Array<string> = [];

  beforeAll(async () => {
    const server = await chromium.launchServer({ headless: true });
    try {
      const switches = disableFeaturesSwitches(server.process().spawnargs);
      expect(switches, "a launch passing no arguments of ours").toHaveLength(1);
      playwrightDefaultFeatures = featuresOf(switches[0]);
    } finally {
      await server.close();
    }
  }, 120_000);

  it("passes one switch holding Playwright's list and the mDNS feature", async () => {
    const expected = [...playwrightDefaultFeatures, MDNS_FEATURE].sort();
    const launchArgs = await browserProjectLaunchArgs();

    expect([...launchArgs.keys()].sort()).toEqual(["browser", "live-webrtc"]);
    for (const [projectName, args] of launchArgs) {
      const switches = disableFeaturesSwitches(args);
      expect(switches, `${projectName} project`).toHaveLength(1);
      expect(featuresOf(switches[0]).sort(), `${projectName} project`).toEqual(
        expected,
      );
    }
  }, 30_000);

  it("leaves chromium one winning switch, with the mDNS obfuscation off", async () => {
    const args = (await browserProjectLaunchArgs()).get("browser");
    expect(args).toBeDefined();
    const server = await chromium.launchServer({ headless: true, args });
    try {
      // Playwright puts its own switch on the command line too, and chromium
      // keeps only the last one, so the switch that decides the run is the last.
      const switches = disableFeaturesSwitches(server.process().spawnargs);
      const deciding = featuresOf(switches[switches.length - 1]);
      expect(deciding).toEqual(
        expect.arrayContaining([...playwrightDefaultFeatures, MDNS_FEATURE]),
      );

      const browser = await chromium.connect(server.wsEndpoint());
      const page = await browser.newPage();
      const hostCandidates = await page.evaluate(async () => {
        const connection = new RTCPeerConnection({ iceServers: [] });
        const candidates: Array<string> = [];
        connection.createDataChannel("gather");
        const gathered = new Promise<void>((resolve) => {
          connection.onicecandidate = (event) => {
            if (!event.candidate) resolve();
            else candidates.push(event.candidate.candidate);
          };
          setTimeout(resolve, 10_000);
        });
        await connection.setLocalDescription(await connection.createOffer());
        await gathered;
        connection.close();
        return candidates.filter((candidate) =>
          candidate.includes(" typ host"),
        );
      });
      await browser.close();

      expect(hostCandidates.length).toBeGreaterThan(0);
      expect(
        hostCandidates.filter((candidate) => candidate.includes(".local")),
      ).toEqual([]);
    } finally {
      await server.close();
    }
  }, 120_000);
});
