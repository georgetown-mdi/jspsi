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
 * invitation already carries, which is free text held to the sheet's ASCII
 * contract by {@link printable}, and this build's public release version, which
 * is interpolated only in the release shape {@link RELEASE_VERSION} admits.
 * Everything else is fixed text, so no secret, no invitation token, and no path
 * from the inviter's machine or container can reach the sheet by construction.
 */

/**
 * The rendezvous locator the sheet prints back, in the two shapes the console
 * mints: an sftp locator (host, optional port, optional remote directory) or a
 * filedrop locator (the shared folder's NAME, never the appliance's absolute
 * path -- see `rendezvousLocatorName`). Credential-free by construction, as the
 * invitation endpoint it is copied from is.
 */
import { PLACEHOLDER_SSH_USERNAME } from "@psilink/core";

export type AcceptKitEndpoint =
  | { channel: "sftp"; host: string; port?: number; path?: string }
  | { channel: "filedrop"; path: string };

/** The inputs the sheet is built from. */
export interface AcceptKitInput {
  /** The rendezvous locator minted into the invitation. */
  endpoint: AcceptKitEndpoint;
  /** The release version this build carries, which decides both the image tag
   * the sheet's commands name and the release page it links; see
   * {@link releaseVersion}. Absent, or in any shape but a release version, the
   * sheet names {@link DEFAULT_PSILINK_IMAGE_TAG} and the releases index. */
  version?: string;
}

/** The published image the sheet's commands run. Named with its registry in
 * full, as the release launchers are, because podman requires the registry
 * prefix and docker accepts it (see `docs/RELEASES.md`). */
const PSILINK_IMAGE_REPOSITORY = "docker.io/vdorie/psi-link";

/**
 * The image tag the sheet names when the build carries no release version -- a
 * development or hosted build, neither of which is a published image. It is the
 * floating tag the release publishes alongside `X.Y.Z` (`docs/RELEASES.md`),
 * the same floating tag the setup script's own `docker run` commands name.
 */
const DEFAULT_PSILINK_IMAGE_TAG = "latest";

/**
 * The shape a release version has: `X.Y.Z` with semver's optional prerelease
 * and build suffixes (`docs/RELEASES.md`). The build's value is interpolated
 * only when it matches, so an absent, partial, or malformed one names the
 * floating tag rather than reaching the sheet -- and `0.0.0`, the marker the
 * manifests that carry no release version hold, is excluded with it. The
 * image build reads the CLI manifest, which never holds `0.0.0`; the carve-out
 * guards a build mis-wired to the unversioned web or root manifest, not a
 * value the production build path delivers.
 */
const RELEASE_VERSION =
  /^(?!0\.0\.0(?:[-+]|$))\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

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
      `  Shared folder:  ${printable(endpoint.path)}`,
      "",
      "That is the folder's name as your partner sees it. Yours is the same",
      "folder reached your own way -- check the name matches before you go on.",
    ];
  const port = endpoint.port === undefined ? "" : `:${endpoint.port}`;
  return [
    `  SFTP server:    ${printable(endpoint.host)}${port}`,
    ...(endpoint.path === undefined
      ? []
      : [`  Directory:      ${printable(endpoint.path)}`]),
    "",
    "The invitation carries the same locator. Check it against what you were",
    "told to expect before you accept.",
  ];
}

/** This build's release version, or undefined when it carries none. The one
 * gate on the value: everything below interpolates the result, so nothing the
 * build supplies reaches the sheet without matching {@link RELEASE_VERSION}. */
function releaseVersion(version: string | undefined): string | undefined {
  return version !== undefined && RELEASE_VERSION.test(version)
    ? version
    : undefined;
}

/** The image reference the sheet's `docker run` lines name. The tag is public
 * release metadata, not a disclosure: a released image is named by its own
 * version, so the partner runs the build their invitation was minted by, and
 * any other build names the floating tag. */
function imageReference(version: string | undefined): string {
  return `${PSILINK_IMAGE_REPOSITORY}:${version ?? DEFAULT_PSILINK_IMAGE_TAG}`;
}

/** The release page the launcher files are downloaded from: this build's own
 * release when it carries a version, so the partner takes the launchers from
 * the release that mints their invitation, else the index whose newest entry is
 * what the floating tag resolves to. Release tags are `vX.Y.Z`
 * (`docs/RELEASES.md`). */
function releasePageUrl(version: string | undefined): string {
  return version === undefined
    ? PSILINK_RELEASES_URL
    : `${PSILINK_RELEASES_URL}/tag/v${version}`;
}

/** The accept command, unindented; each caller indents it to its own step.
 * The CSV positional is part of the primary form: it is what makes the
 * consent display list the columns the partner would send, rather than
 * deferring that list to the exchange run. */
function acceptCommand(version: string | undefined): string {
  return (
    `docker run --rm -it -v "$PWD":${WORK_MOUNT} ` +
    `${imageReference(version)} accept ${INVITATION_PLACEHOLDER} your-file.csv`
  );
}

/** Interpolated operator-authored text, held to the sheet's printable-ASCII
 * contract: any byte outside printable ASCII renders as '?', so the stated
 * invariant is enforced here rather than assumed of the console's inputs. */
function printable(value: string): string {
  return value.replace(/[^\x20-\x7e]/g, "?");
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
    "psilink runs as a container, so there is nothing to install; what it",
    "writes stays in the folders you mount below.",
    "",
    "Every command below is a single line, even where it wraps on screen.",
    "On Windows, run the commands from PowerShell, not Command Prompt.",
    "",
    "On Linux, one thing first. psilink runs inside the container as an",
    "ordinary user numbered 1000, and a folder you mount keeps the owner it",
    "has on your machine, so give the folder that holds your CSV file to",
    "that user once, from inside it:",
    "",
    "  chown 1000:1000 .",
    "",
    'If you cannot change its owner, add --user "$(id -u):$(id -g)" to every',
    "command below instead. Docker Desktop on Windows and macOS needs",
    "neither: it hands the folder to whoever the container runs as.",
    "",
    ...heading("WHAT YOU ARE AGREEING TO"),
    "Not on this sheet, deliberately. Accepting prints your partner's linkage",
    "terms -- what records are matched on, what you receive, and who gets",
    "the result -- and asks you to confirm them. Run accept with your CSV",
    "file named, as the commands below do, and the display also lists which",
    "of your columns would be sent. That display is the thing to read before",
    "you answer; this sheet only gets you to it.",
    "",
    ...heading("WHERE YOU WILL MEET"),
    ...rendezvousLines(endpoint),
    "",
  ];
}

/** The filedrop routing decision: a network drive or DFS path needs the
 * launcher, any folder Docker can open takes the direct commands. */
function filedropBody(version: string | undefined): Array<string> {
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
    "     Dropbox, Egnyte and the like), a plain local folder, or a share",
    "     you mounted yourself on macOS or Linux.",
    "",
    ...heading("A -- A WINDOWS NETWORK DRIVE OR A DFS PATH"),
    "Docker cannot see drive letters or network paths: they belong to",
    "Windows, not to the small Linux virtual machine Docker runs inside. Your",
    "file server also treats Docker as a different computer, so it needs its",
    "own sign-in for the share. A launcher script does all of that for you.",
    "",
    "Download both files from the psilink release page:",
    "",
    `  ${releasePageUrl(version)}`,
    "",
    "  Start-Psilink.ps1",
    "  Setup-PsilinkFileDrop.ps1  (must sit beside it)",
    "",
    'Put them in a folder of their own and run, in PowerShell -- not "Run as',
    'administrator", because an elevated window cannot see the drives you',
    "mapped as yourself:",
    "",
    "  powershell -ExecutionPolicy Bypass -File .\\Start-Psilink.ps1",
    "",
    "It asks for your folders, works out the real server and share behind",
    "your drive letter or DFS path, creates the Docker volume that reaches",
    "it, checks the folder, and opens the psilink console in your browser.",
    "Paste the invitation into the console's accept flow there, and you are",
    "done -- the rest of this sheet is for situation B.",
    "",
    "(On macOS or Linux a network share is not situation A: mount it the way",
    'you usually do -- Finder\'s "Connect to Server", or your file manager --',
    "and once it shows as a folder, it is situation B below.)",
    "",
    "Why you can trust those files: they are plaintext PowerShell scripts,",
    "meant to be read, so your IT department can review every line before",
    "you run one. Take them from the release page above and nowhere else:",
    "that is where the release publishes them together, and the release",
    "copy of Start-Psilink.ps1 names the exact psilink image it starts, so",
    "what it runs is what that release built.",
    "",
    ...heading("B -- A FOLDER DOCKER CAN OPEN"),
    "Two commands, both run from the folder that holds your CSV file. Use a",
    "folder of your own, not the shared folder itself: accepting writes",
    "psilink.yaml and .psilink.key (your key file) beside your CSV, and",
    "anything inside the shared folder can be read and changed by everyone",
    "with access to it.",
    "",
    "1. Accept the invitation. This prints the terms, asks you to confirm,",
    "   and on a yes writes psilink.yaml and .psilink.key into the folder:",
    "",
    `     ${acceptCommand(version)}`,
    "",
    `   Replace ${INVITATION_PLACEHOLDER} with the invitation code your`,
    "   partner sent -- the long block of letters and numbers, not the web",
    "   link -- and your-file.csv with your CSV file's name. Naming your",
    "   file is what lets the display list the columns you would send",
    "   before you confirm; without it, that list is worked out from your",
    "   file only when the exchange runs, and you are not asked again.",
    "",
    "   To keep the code out of your command history, save it into a file",
    "   named invitation.txt next to your CSV and write @invitation.txt in",
    "   its place.",
    "",
    '   On Windows PowerShell, replace "$PWD" with the folder\'s full path in',
    "   every command on this sheet, for example",
    `   -v "C:\\Users\\you\\exchange":${WORK_MOUNT}`,
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
      `${imageReference(version)} exchange your-file.csv results.csv`,
    "",
    "   Replace your-file.csv with your CSV file's name. The matched result",
    "   is written to results.csv beside your input. You and your partner",
    "   each run your own half; whichever runs first waits for the other.",
    "",
  ];
}

/** The SFTP body: accept, fill in the credentials acceptance leaves open, then
 * run -- in that order, because the exchange command only works after the
 * fill-in and a reader follows the sheet top to bottom. */
function sftpBody(version: string | undefined): Array<string> {
  return [
    ...heading("THE THREE STEPS"),
    "The commands run from the folder that holds your CSV file.",
    "",
    "1. Accept the invitation. This prints the terms, asks you to confirm,",
    "   and on a yes writes psilink.yaml and .psilink.key into the folder:",
    "",
    `     ${acceptCommand(version)}`,
    "",
    `   Replace ${INVITATION_PLACEHOLDER} with the invitation code your`,
    "   partner sent -- the long block of letters and numbers, not the web",
    "   link -- and your-file.csv with your CSV file's name. Naming your",
    "   file is what lets the display list the columns you would send",
    "   before you confirm; without it, that list is worked out from your",
    "   file only when the exchange runs, and you are not asked again.",
    "",
    "   To keep the code out of your command history, save it into a file",
    "   named invitation.txt next to your CSV and write @invitation.txt in",
    "   its place.",
    "",
    '   On Windows PowerShell, replace "$PWD" with the folder\'s full path in',
    "   every command on this sheet, for example",
    `   -v "C:\\Users\\you\\exchange":${WORK_MOUNT}`,
    "",
    "2. Fill in your credentials. Accepting wrote psilink.yaml with the",
    "   server and directory taken from the invitation; two things are yours",
    "   to supply, because an invitation never carries credentials:",
    "",
    // The placeholder is core's own constant, so the sheet cannot drift from
    // what accept actually seeds into psilink.yaml.
    `     username: ${PLACEHOLDER_SSH_USERNAME}`,
    "         Replace this placeholder with the account the SFTP server",
    "         accepts for you.",
    "",
    "     password (or private_key)",
    "         Add one under the same server: block. Point it at a file with",
    "         the @ convention rather than typing the secret into",
    "         psilink.yaml:",
    "",
    "           connection:",
    "             server:",
    "               username: your-account",
    "               password: '@/run/secrets/sftp-password'",
    "",
    "         A value beginning with @ is read from that file when psilink",
    "         runs, so the secret stays out of psilink.yaml, out of your",
    "         shell history, and out of process listings.",
    "",
    "   psilink never sends either one to your partner: your credential",
    "   goes only from your machine to the server.",
    "",
    "3. Run the exchange. Docker sees only what you mount, so the command",
    "   also mounts the folder holding your credential file, read-only:",
    "",
    `     docker run --rm -it -v "$PWD":${WORK_MOUNT} ` +
      `-v "/your/secrets":/run/secrets:ro ` +
      `${imageReference(version)} exchange your-file.csv results.csv`,
    "",
    '   Replace "/your/secrets" with the folder that holds your credential',
    "   file, and your-file.csv with your CSV file's name. The matched",
    "   result is written to results.csv beside your input. You and your",
    "   partner each run your own half; whichever runs first waits for the",
    "   other.",
    "",
    "   The first run shows the server's SSH host-key fingerprint and asks",
    "   you to confirm it. Check it against the value the server's",
    "   administrator published; later runs verify it silently.",
    "",
  ];
}

/** The shared closing: recovery, the privacy reassurance, and the reference
 * links. */
function closing(version: string | undefined): Array<string> {
  return [
    ...heading("KEEPING THE KEY FILE"),
    "Accepting writes .psilink.key holding the shared secret: keep it",
    "owner-only (chmod 600 on macOS or Linux) and never commit it.",
    "",
    ...heading("IF SOMETHING GOES WRONG"),
    "  * Invitations expire. If yours has, ask your partner for a new one --",
    "    nothing is lost by starting again.",
    "  * Every command prints what it did and which files it wrote.",
    "  * Your input file itself is never sent. psilink reads it in the folder",
    "    you mounted and writes the result beside your input; what goes to",
    "    your partner is what the accept display describes.",
    "",
    ...heading("REFERENCE"),
    "  Command-line reference:",
    `    ${PSILINK_CLI_DOC_URL}`,
    "  psilink image used above:",
    `    ${imageReference(version)}`,
    "",
  ];
}

/**
 * Build the accept kit for one minted invitation. The output is printable
 * ASCII with a trailing newline, addressed to the partner.
 */
export function buildAcceptKit({
  endpoint,
  version: buildVersion,
}: AcceptKitInput): string {
  const version = releaseVersion(buildVersion);
  const lines = [
    ...opening(endpoint),
    ...(endpoint.channel === "filedrop"
      ? filedropBody(version)
      : sftpBody(version)),
    ...closing(version),
  ];
  return `${lines.join("\n")}\n`;
}

/** The download filename `psilink-accept-instructions-<date>.txt`, the date the
 * local calendar day of `at` -- the moment the operator clicks download, which
 * can be any time the share screen is open, not the mint moment. */
export function acceptKitFileName(at: Date): string {
  const year = at.getFullYear();
  const month = String(at.getMonth() + 1).padStart(2, "0");
  const day = String(at.getDate()).padStart(2, "0");
  return `psilink-accept-instructions-${year}-${month}-${day}.txt`;
}
