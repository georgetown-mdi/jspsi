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
 * The console's truthful file-assurance line, for a surface whose intake reads
 * the input from the console's mounted work directory rather than the browser
 * (the console inviter's and acceptor's server-file pickers). It is not the
 * value {@link fileAssuranceLine} resolves for the console build: the lobby and
 * the receipt verifier never switch to mounted-directory intake, so each
 * mounted-input surface opts into this copy explicitly.
 */
export const APPLIANCE_FILE_ASSURANCE =
  "Files are read from this console's mounted work directory; your browser " +
  "does not upload them.";

/**
 * Decide the file-assurance line from whether this deployment's server
 * receives files. `false` (the hosted, browser-only deployment) renders
 * {@link BROWSER_ONLY_FILE_ASSURANCE} unchanged. `true` omits the claim rather
 * than substituting unverified copy: the deployment that receives files (the
 * console) supplies its own truthful copy when it ships.
 */
export function fileAssuranceLine(
  serverReceivesFiles: boolean,
): string | undefined {
  return serverReceivesFiles ? undefined : BROWSER_ONLY_FILE_ASSURANCE;
}

/**
 * The single resolved file-assurance line (or its absence) for this build. The
 * server receives files exactly on the console ({@link isConsoleBuild}), where
 * the browser-only claim is false. Lobby renders this constant directly;
 * the two mounted-input surfaces (AcceptorScreen, YourFileSection) render it on
 * the hosted build but opt into {@link APPLIANCE_FILE_ASSURANCE} on the console,
 * where their intake reads the file from the console rather than the browser.
 */
export const FILE_ASSURANCE_LINE = fileAssuranceLine(isConsoleBuild());
