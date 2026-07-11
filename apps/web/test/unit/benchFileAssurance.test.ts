import { describe, expect, test } from "vitest";

import {
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

describe("fileAssuranceLine", () => {
  test("renders the browser-only claim when the server does not receive files", () => {
    expect(fileAssuranceLine(false)).toBe(BROWSER_ONLY_FILE_ASSURANCE);
  });

  test("omits the claim rather than substituting copy when the server receives files", () => {
    expect(fileAssuranceLine(true)).toBeUndefined();
  });
});

describe("SERVER_RECEIVES_FILES default", () => {
  test("defaults to false: a deployment must opt in to weakening the claim", async () => {
    const configManager = new ConfigManager();
    const config = await configManager.load({ data: {} });
    expect(config.SERVER_RECEIVES_FILES).toBe(false);
  });
});
