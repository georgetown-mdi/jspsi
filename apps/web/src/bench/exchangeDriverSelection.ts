import type { DeploymentProfile } from "@utils/clientConfig";
import type { Transport } from "./inviterModel";

/**
 * How a chosen channel runs in a given build. `browser` runs the live WebRTC
 * exchange in this tab; `server-job` runs a filedrop exchange through the
 * console appliance's job API; `save-file` mints an exchange file the operator
 * runs with the command-line tool. The bench's two seams consume this: the
 * Create branch routes `save-file` to the save surface and both live kinds to
 * the run, and the run hooks build the matching {@link ExchangeDriver}.
 */
export type ExchangeDriverSelection =
  { kind: "browser" } | { kind: "server-job" } | { kind: "save-file" };

/**
 * Map a chosen `channel` and the build's `profile` to how the exchange runs.
 * The job API is filedrop-only by design, so only a filedrop channel on the
 * console appliance runs server-side; sftp always saves a file (server-job SFTP
 * is a separately-tracked future item), and browser always runs live.
 *
 * The `channel` switch is exhaustive over {@link Transport} with no default: a
 * new channel makes this fail to compile rather than silently falling through
 * to a save-file (or, worse, a live) branch it was never vetted for -- the
 * allowlist discipline CONTRIBUTING.md requires for transport branching.
 */
export function selectExchangeDriver(
  channel: Transport,
  profile: DeploymentProfile,
): ExchangeDriverSelection {
  switch (channel) {
    case "browser":
      return { kind: "browser" };
    case "filedrop":
      return profile === "console"
        ? { kind: "server-job" }
        : { kind: "save-file" };
    case "sftp":
      return { kind: "save-file" };
  }
}
