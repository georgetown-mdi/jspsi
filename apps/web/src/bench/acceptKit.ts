/**
 * The partner's accept kit: one plaintext, printable, ASCII instruction sheet
 * the inviter downloads at mint time and sends alongside the invitation, for a
 * partner who accepts through the command-line tool (the `sftp` and `filedrop`
 * channels). It assumes the partner has Docker Desktop or can get it, and
 * nothing else.
 *
 * Pure: explicit inputs in, one string out -- no React, no I/O, no clock -- so
 * the sheet's whole contract is pinned by unit tests. Its partner-facing
 * invariants are specified in `docs/spec/SERVER_JOB_API.md` ("The partner
 * accept kit").
 *
 * The sheet is a DISCLOSURE SURFACE: whatever it interpolates is written to
 * disk and handed to the partner. Exactly two dynamic values are representable
 * here, each justified where it is interpolated -- the rendezvous locator the
 * invitation already carries, and the public image tag. Everything else is
 * fixed text, so no secret, no invitation token, and no path from the inviter's
 * machine or container can reach the sheet by construction.
 */

/**
 * The rendezvous locator the sheet prints back, in the two shapes the console
 * mints: an sftp locator (host, optional port, optional remote directory) or a
 * filedrop locator (the shared folder's NAME, never the appliance's absolute
 * path -- see `rendezvousLocatorName`). Credential-free by construction, as the
 * invitation endpoint it is copied from is.
 */
export type AcceptKitEndpoint =
  | { channel: "sftp"; host: string; port?: number; path?: string }
  | { channel: "filedrop"; path: string };

/** The inputs the sheet is built from. */
export interface AcceptKitInput {
  /** The rendezvous locator minted into the invitation. */
  endpoint: AcceptKitEndpoint;
  /** The published image tag the sheet's `docker run` lines name; see
   * {@link DEFAULT_PSILINK_IMAGE_TAG}. */
  imageTag: string;
}

/** The published image the sheet's commands run. Named with its registry in
 * full, as the release launchers are, because podman requires the registry
 * prefix and docker accepts it (see `docs/RELEASES.md`). */
const PSILINK_IMAGE_REPOSITORY = "docker.io/vdorie/psi-link";

/**
 * The image tag the sheet names when nothing supplies a version-matched one.
 * The web build exposes no version of its own -- its only build-time signal is
 * `VITE_DEPLOYMENT_PROFILE` -- so the sheet falls back to the floating tag the
 * release publishes alongside `X.Y.Z` (`docs/RELEASES.md`), the same deliberate
 * float the host-side launchers' documented default carries. Wire a real
 * version through {@link AcceptKitInput.imageTag} if the build ever exposes one.
 */
export const DEFAULT_PSILINK_IMAGE_TAG = "latest";

/** The release page the launcher files are downloaded from; the same URL the
 * launchers themselves carry. */
const PSILINK_RELEASES_URL = "https://github.com/georgetown-mdi/jspsi/releases";

/** The command-line reference the sheet closes on. */
const PSILINK_CLI_DOC_URL =
  "https://github.com/georgetown-mdi/jspsi/blob/main/docs/CLI.md";

/** The placeholder the partner replaces with the invitation string. The sheet
 * carries this and never a token: the invitation travels separately, so a
 * mislaid sheet discloses nothing. */
export const INVITATION_PLACEHOLDER = "PASTE_YOUR_INVITATION";

/** The container mount point the sheet's commands bind the partner's own
 * working folder to. It is the image's own working directory, part of the
 * published `docker run` form -- a fixed string in the partner's future
 * command, not a path from the inviter's machine. */
const WORK_MOUNT = "/work";

/** The container mount point the filedrop commands bind the partner's own
 * shared folder to. Fixed, like {@link WORK_MOUNT}. */
const SYNC_MOUNT = "/sync";

const RULE = "=".repeat(66);

function heading(title: string): Array<string> {
  return [title, "-".repeat(title.length), ""];
}

/**
 * The rendezvous locator, as the sheet prints it back for the partner to check.
 * Interpolating it is not a disclosure: it is exactly the credential-free
 * locator the invitation the partner already holds carries, and on the filedrop
 * channel it is the shared folder's name rather than any path on the inviter's
 * machine.
 */
function rendezvousLines(endpoint: AcceptKitEndpoint): Array<string> {
  if (endpoint.channel === "filedrop")
    return [
      `  Shared folder:  ${endpoint.path}`,
      "",
      "That is the folder's name as your partner sees it. Yours is the same",
      "folder reached your own way -- check the name matches before you go on.",
    ];
  const port = endpoint.port === undefined ? "" : `:${endpoint.port}`;
  return [
    `  SFTP server:    ${endpoint.host}${port}`,
    ...(endpoint.path === undefined
      ? []
      : [`  Directory:      ${endpoint.path}`]),
    "",
    "The invitation carries the same locator. Check it against what you were",
    "told to expect before you accept.",
  ];
}

/** The image reference the sheet's `docker run` lines name. The tag is public
 * release metadata, not a disclosure. */
function imageReference(imageTag: string): string {
  return `${PSILINK_IMAGE_REPOSITORY}:${imageTag}`;
}

/** The accept command, unindented; each caller indents it to its own step. */
function acceptCommand(imageTag: string): string {
  return (
    `docker run --rm -it -v "$PWD":${WORK_MOUNT} ` +
    `${imageReference(imageTag)} accept ${INVITATION_PLACEHOLDER}`
  );
}

/** The shared opening: what this is, what the partner needs, and where the
 * terms actually live. The channel is named; the terms are not restated -- the
 * invitation's own consent display owns that disclosure. */
function opening(endpoint: AcceptKitEndpoint): Array<string> {
  const channelLines =
    endpoint.channel === "filedrop"
      ? [
          "This one runs over a shared folder you and your partner can both",
          "reach.",
        ]
      : ["This one runs over an SFTP server."];
  return [
    RULE,
    "PSILINK -- HOW TO ACCEPT THIS EXCHANGE",
    RULE,
    "",
    "Your partner has set up a psilink record-linkage exchange with you and",
    "sent you an invitation. This sheet takes you from nothing to accepting",
    "it.",
    "",
    ...channelLines,
    "",
    "The invitation is confidential: it carries a one-time secret, so keep it",
    "to the channel it arrived on. This sheet carries no secret of any kind.",
    "",
    ...heading("WHAT YOU NEED"),
    "Docker Desktop, installed and running (docker.com). Nothing else:",
    "psilink runs as a container, so there is nothing to install and nothing",
    "left behind afterwards.",
    "",
    "Every command below is a single line, even where it wraps on screen.",
    "",
    ...heading("WHAT YOU ARE AGREEING TO"),
    "Not on this sheet, deliberately. Accepting prints your partner's linkage",
    "terms -- what records are matched on, which of your columns are sent,",
    "which you receive, and who gets the result -- and asks you to confirm",
    "them. That display is the thing to read before you answer; this sheet",
    "only gets you to it.",
    "",
    ...heading("WHERE YOU WILL MEET"),
    ...rendezvousLines(endpoint),
    "",
  ];
}

/** The filedrop routing decision: a network drive or DFS path needs the
 * launcher, any folder Docker can open takes the direct commands. */
function filedropBody(imageTag: string): Array<string> {
  return [
    ...heading("STEP 1 -- WHICH KIND OF FOLDER IS YOURS?"),
    "The answer decides everything below. Pick one.",
    "",
    "  A. A Windows network drive or a DFS path. It opens in File Explorer",
    "     as Z:\\Exchange, \\\\fileserver\\exchange, or a DFS namespace your",
    "     IT department set up.",
    "",
    "  B. A folder that syncs on this PC, or any other folder Docker can",
    "     open: a synced folder under your own user folder (OneDrive,",
    "     Dropbox, Egnyte and the like), or a plain local folder.",
    "",
    ...heading("A -- A WINDOWS NETWORK DRIVE OR A DFS PATH"),
    "Docker cannot see drive letters or network paths: they belong to",
    "Windows, not to the small Linux virtual machine Docker runs inside. Your",
    "file server also treats Docker as a different computer, so it needs its",
    "own sign-in for the share. A launcher script does all of that for you.",
    "",
    "Download from the psilink release page:",
    "",
    `  ${PSILINK_RELEASES_URL}`,
    "",
    "  On Windows:      Start-Psilink.ps1",
    "                   Setup-PsilinkFileDrop.ps1  (must sit beside it)",
    "  On macOS/Linux:  start-psilink.sh",
    "",
    'Put them in a folder of their own and run, in PowerShell -- not "Run as',
    'administrator", because an elevated window cannot see the drives you',
    "mapped as yourself:",
    "",
    "  powershell -ExecutionPolicy Bypass -File .\\Start-Psilink.ps1",
    "",
    "or, on macOS or Linux:",
    "",
    "  bash start-psilink.sh",
    "",
    "It asks for your folders, works out the real server and share behind",
    "your drive letter or DFS path, creates the Docker volume that reaches",
    "it, checks the folder, and opens the psilink console in your browser.",
    "Paste the invitation into the console's accept flow there, and you are",
    "done -- the rest of this sheet is for situation B.",
    "",
    "Why you can trust those files: they are plaintext PowerShell and shell",
    "scripts, meant to be read, so your IT department can review every line",
    "before you run one. Take them from the release page above and nowhere",
    "else -- a copy from anywhere else refuses to run, because only a release",
    "copy names the exact psilink image it will start.",
    "",
    ...heading("B -- A FOLDER DOCKER CAN OPEN"),
    "Two commands, both run from the folder that holds your CSV file.",
    "",
    "1. Accept the invitation. This prints the terms, asks you to confirm,",
    "   and on a yes writes psilink.yaml and .psilink.key into the folder:",
    "",
    `     ${acceptCommand(imageTag)}`,
    "",
    `   Replace ${INVITATION_PLACEHOLDER} with the invitation string your`,
    "   partner sent. Adding your CSV file name after it also checks your",
    "   columns against the terms before you are asked to confirm.",
    "",
    '   On Windows PowerShell, replace "$PWD" with the folder\'s full path,',
    `   for example -v "C:\\Users\\you\\exchange":${WORK_MOUNT}`,
    "",
    "2. Point psilink at your own copy of the shared folder. Accepting wrote",
    "   the folder's name as your partner sees it; what psilink needs is",
    "   where that folder is on your machine. Open psilink.yaml and set:",
    "",
    "     connection:",
    "       channel: filedrop",
    `       path: ${SYNC_MOUNT}`,
    "",
    "   Then mount your shared folder there when you run the exchange:",
    "",
    `     docker run --rm -v "$PWD":${WORK_MOUNT} ` +
      `-v "/path/to/your/shared/folder":${SYNC_MOUNT} ` +
      `${imageReference(imageTag)} exchange your-file.csv results.csv`,
    "",
    "   The matched result is written to results.csv beside your input. You",
    "   and your partner each run your own half; whichever runs first waits",
    "   for the other.",
    "",
  ];
}

/** The SFTP body: the same two commands, plus the fields acceptance leaves for
 * the partner to fill in. */
function sftpBody(imageTag: string): Array<string> {
  return [
    ...heading("THE TWO COMMANDS"),
    "Both run from the folder that holds your CSV file.",
    "",
    "1. Accept the invitation. This prints the terms, asks you to confirm,",
    "   and on a yes writes psilink.yaml and .psilink.key into the folder:",
    "",
    `     ${acceptCommand(imageTag)}`,
    "",
    `   Replace ${INVITATION_PLACEHOLDER} with the invitation string your`,
    "   partner sent. Adding your CSV file name after it also checks your",
    "   columns against the terms before you are asked to confirm.",
    "",
    '   On Windows PowerShell, replace "$PWD" with the folder\'s full path,',
    `   for example -v "C:\\Users\\you\\exchange":${WORK_MOUNT}`,
    "",
    "2. Fill in the two fields below, then run the exchange:",
    "",
    `     docker run --rm -it -v "$PWD":${WORK_MOUNT} ` +
      `${imageReference(imageTag)} exchange your-file.csv results.csv`,
    "",
    "   The matched result is written to results.csv beside your input. You",
    "   and your partner each run your own half; whichever runs first waits",
    "   for the other.",
    "",
    "   The first run shows the server's SSH host-key fingerprint and asks",
    "   you to confirm it. Check it against the value the server's",
    "   administrator published; later runs verify it silently.",
    "",
    ...heading("WHAT YOU FILL IN BEFORE STEP 2"),
    "Accepting writes psilink.yaml with the server and directory taken from",
    "the invitation. Two things are yours to supply, because an invitation",
    "never carries credentials:",
    "",
    "  username: REPLACE_WITH_SSH_USERNAME",
    "      Replace this placeholder with the account the SFTP server accepts",
    "      for you.",
    "",
    "  password (or private_key)",
    "      Add one under the same server: block. Point it at a file with the",
    "      @ convention rather than typing the secret into psilink.yaml:",
    "",
    "        connection:",
    "          server:",
    "            username: your-account",
    "            password: '@/run/secrets/sftp-password'",
    "",
    "      A value beginning with @ is read from that file when psilink runs,",
    "      so the secret stays out of psilink.yaml, out of your shell history,",
    "      and out of process listings. Docker sees only what you mount, so",
    "      mount the file's folder too, read-only, by adding this to the",
    "      exchange command:",
    "",
    '        -v "/your/secrets":/run/secrets:ro',
    "",
    "Your partner never sees either one: the credential is between you and",
    "the server.",
    "",
  ];
}

/** The shared closing: recovery, the privacy reassurance, and the reference
 * links. */
function closing(imageTag: string): Array<string> {
  return [
    ...heading("KEEPING THE KEY FILE"),
    "Accepting writes .psilink.key holding the shared secret: keep it",
    "owner-only (chmod 600 on macOS or Linux) and never commit it.",
    "",
    ...heading("IF SOMETHING GOES WRONG"),
    "  * Invitations expire. If yours has, ask your partner for a new one --",
    "    nothing is lost by starting again.",
    "  * Every command prints what it did and which files it wrote.",
    "  * Your file is never uploaded anywhere. psilink reads it in the folder",
    "    you mounted and writes the result beside it.",
    "",
    ...heading("REFERENCE"),
    "  Command-line reference:",
    `    ${PSILINK_CLI_DOC_URL}`,
    "  psilink image used above:",
    `    ${imageReference(imageTag)}`,
    "",
  ];
}

/**
 * Build the accept kit for one minted invitation. The output is printable
 * ASCII with a trailing newline, addressed to the partner.
 */
export function buildAcceptKit({ endpoint, imageTag }: AcceptKitInput): string {
  const lines = [
    ...opening(endpoint),
    ...(endpoint.channel === "filedrop"
      ? filedropBody(imageTag)
      : sftpBody(imageTag)),
    ...closing(imageTag),
  ];
  return `${lines.join("\n")}\n`;
}

/** The download filename `psilink-accept-instructions-<date>.txt`, the date the
 * local calendar day of `at` (the moment the invitation was minted), matching
 * the exchange file's stamping discipline. */
export function acceptKitFileName(at: Date): string {
  const year = at.getFullYear();
  const month = String(at.getMonth() + 1).padStart(2, "0");
  const day = String(at.getDate()).padStart(2, "0");
  return `psilink-accept-instructions-${year}-${month}-${day}.txt`;
}
