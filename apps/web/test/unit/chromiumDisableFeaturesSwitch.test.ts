import { createRequire } from "node:module";
import fs from "node:fs";

import { describe, expect, it } from "vitest";
import { chromium } from "playwright";

import viteConfig from "../../vite.config.ts";

const MDNS_FEATURE = "WebRtcHideLocalIpsWithMdns";
const SWITCH_PREFIX = "--disable-features=";

// Playwright keeps its list in a module its package exports no entry point for,
// so the one readable copy is the bundle the chromium launch path is built
// from. Reading it here is what makes the copy in vite.config.ts checkable
// rather than asserted.
function installedPlaywrightDisabledFeatures(): Array<string> {
  const playwrightCoreBundle = createRequire(import.meta.url).resolve(
    "playwright-core/lib/coreBundle",
  );
  const source = fs.readFileSync(playwrightCoreBundle, "utf8");
  const start = source.indexOf("disabledFeatures = [");
  const end = source.indexOf("].filter(Boolean)", start);
  if (start < 0 || end < 0) {
    throw new Error(
      `No disabledFeatures list in ${playwrightCoreBundle}. Playwright moved or ` +
        `renamed it, so the copy in apps/web/vite.config.ts can no longer be checked ` +
        `against the installed package -- find the list again and reteach this test.`,
    );
  }
  const features = [
    ...source.slice(start, end).matchAll(/^\s*"([^"]+)",?$/gm),
  ].map((match) => match[1]);
  if (features.length === 0) {
    throw new Error(
      `The disabledFeatures list in ${playwrightCoreBundle} parsed as empty, which ` +
        `would make every assertion below vacuous.`,
    );
  }
  return features;
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

function disableFeaturesSwitches(args: ReadonlyArray<string>): Array<string> {
  return args.filter((arg) => arg.startsWith(SWITCH_PREFIX));
}

function featuresOf(disableFeaturesSwitch: string): Array<string> {
  return disableFeaturesSwitch.slice(SWITCH_PREFIX.length).split(",");
}

describe("the browser projects' --disable-features switch", () => {
  it("passes one switch holding Playwright's list and the mDNS feature", async () => {
    const expected = [
      ...installedPlaywrightDisabledFeatures(),
      MDNS_FEATURE,
    ].sort();
    const launchArgs = await browserProjectLaunchArgs();

    expect([...launchArgs.keys()].sort()).toEqual(["browser", "live-webrtc"]);
    for (const [projectName, args] of launchArgs) {
      const switches = disableFeaturesSwitches(args);
      expect(switches, `${projectName} project`).toHaveLength(1);
      expect(featuresOf(switches[0]).sort(), `${projectName} project`).toEqual(
        expected,
      );
    }
  });

  it("leaves chromium one winning switch, with the mDNS obfuscation off", async (context) => {
    let executable = "";
    try {
      executable = chromium.executablePath();
    } catch {
      executable = "";
    }
    if (!executable || !fs.existsSync(executable)) {
      context.skip(
        `no chromium build installed (npx playwright install chromium), so the ` +
          `launched command line and the candidates it yields go unmeasured`,
      );
    }

    const args = (await browserProjectLaunchArgs()).get("browser");
    expect(args).toBeDefined();
    const server = await chromium.launchServer({ headless: true, args });
    try {
      // Playwright puts its own switch on the command line too, and chromium
      // keeps only the last one, so the switch that decides the run is the last.
      const switches = disableFeaturesSwitches(server.process().spawnargs);
      const deciding = featuresOf(switches[switches.length - 1]);
      expect(deciding).toEqual(
        expect.arrayContaining([
          ...installedPlaywrightDisabledFeatures(),
          MDNS_FEATURE,
        ]),
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
