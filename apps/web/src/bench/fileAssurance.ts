import { isConsoleBuild } from "@utils/clientConfig";

/**
 * The browser-only file-processing claim, exactly as the mockup and the
 * hosted deployment state it. True only where the deployment never sends the
 * file anywhere -- the default, browser-only build.
 */
export const BROWSER_ONLY_FILE_ASSURANCE =
  "Your file is processed entirely in your browser and it is never " +
  "uploaded to our server.";

/**
 * Decide the file-assurance line from whether this deployment's server
 * receives files. `false` (the hosted, browser-only deployment) renders
 * {@link BROWSER_ONLY_FILE_ASSURANCE} unchanged. `true` omits the claim
 * rather than substituting different copy: the browser-only claim would be
 * false for that deployment, but no replacement claim has been verified yet
 * either, and an unverified claim is worse than no claim. The deployment that
 * legitimately receives files (the console appliance) supplies its own
 * truthful copy when it ships.
 */
export function fileAssuranceLine(
  serverReceivesFiles: boolean,
): string | undefined {
  return serverReceivesFiles ? undefined : BROWSER_ONLY_FILE_ASSURANCE;
}

/**
 * The single resolved file-assurance line (or its absence) for this build. The
 * server receives files exactly on the console appliance ({@link isConsoleBuild}),
 * where the browser-only claim no longer holds. All three bench surfaces that
 * show the assurance copy (AcceptorBench, BenchLobby, YourFileSection) render
 * this constant rather than each reading the profile or hardcoding the claim,
 * so the deployment-awareness lives in one place.
 */
export const FILE_ASSURANCE_LINE = fileAssuranceLine(isConsoleBuild());
