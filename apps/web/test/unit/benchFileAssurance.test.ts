import { describe, expect, test } from "vitest";

import {
  APPLIANCE_FILE_ASSURANCE,
  BROWSER_ONLY_FILE_ASSURANCE,
  fileAssuranceLine,
} from "@bench/fileAssurance";
import { ConfigManager } from "@utils/clientConfig";

describe("BROWSER_ONLY_FILE_ASSURANCE", () => {
  test("is the exact copy the hosted, browser-only deployment states", () => {
    expect(BROWSER_ONLY_FILE_ASSURANCE).toBe(
      "Your file is processed entirely in your browser and it is never uploaded to our server.",
    );
  });
});

describe("APPLIANCE_FILE_ASSURANCE", () => {
  test("is the truthful console copy for a mounted-directory intake", () => {
    expect(APPLIANCE_FILE_ASSURANCE).toBe(
      "Files are read from this appliance's mounted work directory; your browser does not upload them.",
    );
  });
});

describe("fileAssuranceLine", () => {
  test("renders the browser-only claim when the server does not receive files", () => {
    expect(fileAssuranceLine(false)).toBe(BROWSER_ONLY_FILE_ASSURANCE);
  });

  test("omits the claim rather than substituting copy when the server receives files", () => {
    expect(fileAssuranceLine(true)).toBeUndefined();
  });
});

describe("DEPLOYMENT_PROFILE default", () => {
  test("defaults to hosted: a deployment must opt in to the console appliance", async () => {
    const configManager = new ConfigManager();
    const config = await configManager.load({ data: {} });
    expect(config.DEPLOYMENT_PROFILE).toBe("hosted");
  });

  test("accepts the console profile", async () => {
    const configManager = new ConfigManager();
    const config = await configManager.load({
      data: { DEPLOYMENT_PROFILE: "console" },
    });
    expect(config.DEPLOYMENT_PROFILE).toBe("console");
  });
});
