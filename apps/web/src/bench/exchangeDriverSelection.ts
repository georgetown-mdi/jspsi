import type { DeploymentProfile } from "@utils/clientConfig";
import type { Transport } from "./inviterModel";

/**
 * How a chosen channel runs in a given build. `browser` runs the live WebRTC
 * exchange in this tab; `server-job` runs a filedrop or sftp exchange through
 * the console appliance's job API; `save-file` mints an exchange file the
 * operator runs with the command-line tool. The bench's two seams consume
 * this: the Create branch routes `save-file` to the save surface and both live
 * kinds to the run, and the run hooks build the matching {@link ExchangeDriver}.
 */
export type ExchangeDriverSelection =
  { kind: "browser" } | { kind: "server-job" } | { kind: "save-file" };

/**
 * Map a chosen `channel`, the build's `profile`, and the appliance's sftp
 * server-job availability to how the exchange runs. A filedrop channel runs
 * server-side on the console appliance; an sftp channel runs server-side only
 * when the build is a console AND the appliance has a provisioned SFTP server
 * (`sftpConfigured`) -- with none, there is no server-side connection material,
 * so it saves a file for the command-line tool instead of arming a run that
 * cannot start. Browser always runs live.
 *
 * The `channel` switch is exhaustive over {@link Transport} with no default: a
 * new channel makes this fail to compile rather than silently falling through
 * to a save-file (or, worse, a live) branch it was never vetted for -- the
 * allowlist discipline CONTRIBUTING.md requires for transport branching.
 */
export function selectExchangeDriver(
  channel: Transport,
  profile: DeploymentProfile,
  sftpConfigured: boolean,
): ExchangeDriverSelection {
  switch (channel) {
    case "browser":
      return { kind: "browser" };
    case "filedrop":
      return profile === "console"
        ? { kind: "server-job" }
        : { kind: "save-file" };
    case "sftp":
      return profile === "console" && sftpConfigured
        ? { kind: "server-job" }
        : { kind: "save-file" };
  }
}
