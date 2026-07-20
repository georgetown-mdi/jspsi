import { describe, expect, test } from "vitest";

import { isJobApiEnabled, readJobApiConfig } from "@jobs/gate";

describe("readJobApiConfig", () => {
  test("reads the data root and trims it", () => {
    const config = readJobApiConfig({ JOB_DATA_ROOT: "  /srv/jobs  " });
    expect(config.dataRoot).toBe("/srv/jobs");
  });

  test("an unset data root disables the API", () => {
    expect(isJobApiEnabled(readJobApiConfig({}))).toBe(false);
  });
});
