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
 * How the SFTP transport stands on a given build, distinct from today's binary
 * "configured or not":
 * - `runHere`: an authored-and-complete connection exists, so the exchange runs
 *   here as a server job.
 * - `authoringRequired`: a console build offers to run SFTP here but no connection
 *   is authored yet -- the card reveals the authoring form rather than silently
 *   degrading to save-a-file.
 * - `saveFileOnly`: a hosted build never runs SFTP here; it only saves an exchange
 *   file for the command-line tool.
 */
export type SftpConnectionAvailability =
  "runHere" | "authoringRequired" | "saveFileOnly";

/** The SFTP availability for a build: hosted always saves a file; a console runs
 * it here when a connection is configured, else it needs one authored first. */
export function sftpConnectionAvailability(
  profile: DeploymentProfile,
  sftpConfigured: boolean,
): SftpConnectionAvailability {
  if (profile !== "console") return "saveFileOnly";
  return sftpConfigured ? "runHere" : "authoringRequired";
}

/**
 * Map a chosen `channel`, the build's `profile`, the appliance's sftp connection
 * availability, and the operator's explicit save-a-file choice to how the
 * exchange runs. A filedrop channel runs server-side on the console appliance. An
 * sftp channel on a console runs server-side when a connection is configured
 * (`sftpConfigured`) -- and, when none is authored yet, STILL resolves to a
 * server-job (it runs here once the operator authors one), unless the operator
 * deliberately chose to save a file for their own command-line tool instead
 * (`sftpSaveFilePreferred`). A hosted build always saves a file. Browser always
 * runs live.
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
  sftpSaveFilePreferred = false,
): ExchangeDriverSelection {
  switch (channel) {
    case "browser":
      return { kind: "browser" };
    case "filedrop":
      return profile === "console"
        ? { kind: "server-job" }
        : { kind: "save-file" };
    case "sftp": {
      if (profile !== "console") return { kind: "save-file" };
      if (sftpConfigured) return { kind: "server-job" };
      return sftpSaveFilePreferred
        ? { kind: "save-file" }
        : { kind: "server-job" };
    }
  }
}
