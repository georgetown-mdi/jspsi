import {
  ALLOW_MISSING_BUILD_ENV,
  BUILD_COMMAND,
  hasBuild,
  prodEntry,
} from "./prodServer.js";

// A globalSetup on the `integration` project only, listed before the dev-server
// setup so a missing build fails the project once, before the run pays to start a
// server. The suites that drive `node .output/server/index.mjs` gate on hasBuild,
// so without this guard a build-free run reports a PASS with the built-server
// surface unexercised. CI builds the web app first (eb_build_and_test.yaml),
// so this only fires on a local run against a fresh clone.
//
// The opt-out restores the skip for a dev-server-only run. The guard cannot
// live on the shared dev-server setup, which the `browser` project also runs
// and which needs no production build.

export default function setup(): void {
  if (hasBuild) return;

  if (process.env[ALLOW_MISSING_BUILD_ENV] === "1") {
    console.log(
      `[prod-build] ${ALLOW_MISSING_BUILD_ENV}=1: skipping the suites that ` +
        `drive the built server (no build at ${prodEntry}).`,
    );
    return;
  }

  throw new Error(
    `No web production build at ${prodEntry}, so the integration suites that ` +
      `drive the built server would silently skip and this run would report a ` +
      `pass. Build it first with \`${BUILD_COMMAND}\`, or set ` +
      `${ALLOW_MISSING_BUILD_ENV}=1 to skip those suites deliberately and run ` +
      `only the dev-server-backed ones.`,
  );
}
