# Maintainer notes: Alcove file-drop setup on Windows

Notes on [`support/windows-network-filedrop`](../windows-network-filedrop/README.md).
They live outside that folder on purpose: the guide is handed to an operator as
a unit, and what is here -- what is unverified, what was tried and failed -- is
addressed to whoever maintains it next.

## The problem

Alcove ships as a Docker image. Some agencies keep their exchange folder
("file drop") on a network location -- a mapped drive like `Z:\Exchange`, or
`\\fileserver\exchange`. Docker cannot bind-mount those: its engine runs in a
Linux VM that cannot see mapped drives or UNC paths, so `--mount` fails with
"bind source path does not exist".

The workaround is a Docker volume that mounts the share over SMB/CIFS from
inside the VM. Building one needs the real server name, share, and subfolder.
A drive letter hides that, and a DFS path names a namespace rather than a
machine -- users have been finding the real address by right-clicking the
folder and reading the DFS tab.

## What is here

- `Setup-AlcoveFileDrop.ps1` -- takes the folder path as the user sees it in
  Explorer plus network credentials, resolves the server, share and subfolder,
  asks the operator to confirm them, runs `alcove doctor probe` against the
  share from inside a container, creates the volume, runs `alcove doctor mount`
  over it, and prints the `docker run` command.
- `Start-Alcove.ps1` -- the launcher: the same ground plus starting the console
  and opening it. It dot-sources the setup script with `-LoadFunctionsOnly` for
  the path resolution, the credential prompts and the CIFS volume sequence
  rather than carrying a second copy of any of them, which is why the two travel
  together and why a release publishes both.
- `start-alcove.sh` -- the launcher for macOS and Linux. It shares only the
  doctor verdict contract with the PowerShell one; there is no resolution
  machinery in it, because a path the host can see is a path the engine can.
- `README.md` -- the setup page, covering this script and the Command Prompt
  one alike.
- `troubleshooting.md` -- the page the script's errors cite by section name.
- `passwords.md` -- the account decision, cited by the script in two places.

The Command Prompt script and its three container-side shell scripts have their
own notes, [`cmd_windows-network-filedrop.md`](cmd_windows-network-filedrop.md).

The PowerShell script carries no container-side diagnostic of its own; the
Command Prompt one carries three shell scripts, and its notes cover them. The
diagnostic used to live as a here-string inside `Setup-AlcoveFileDrop.ps1`, and
a second, hand-maintained copy of it used to sit beside the script for reading;
that copy drifted -- it read `SMB_VERS` where the script exported `SMB_DIALECT`,
so running it with the script's own environment silently ignored the dialect --
and was removed rather than resynchronised. The lesson outlived both: a second
copy of a diagnostic is a copy that drifts, which is the argument that eventually
moved the whole battery into the image.

## State

**The CIFS volume pins `uid=1000,gid=1000`, and that mapping is measured
against a native Windows server, 17 September 2026.** The published image runs
as an unprivileged account rather than as root, so the mount's own ownership
decides whether an
exchange can write to the share at all. A server without CIFS Unix extensions
-- every native Windows SMB server -- sends no ownership for the client to map,
and `cifs.ko` then presents the whole tree as uid 0 mode 0755/0644 and enforces
that locally, which is `EACCES` on the first write from uid 1000. Both setup
scripts therefore name `uid=1000,gid=1000` in the mount options, as do the
by-hand copies of the command in `by-hand.md` and `troubleshooting.md`.
`noperm` would also clear the refusal, by switching the client's permission
check off wholesale; mapping the ownership is the narrower of the two and is
what these carry.

A volume created with those options over Windows Server 2025 took create,
rename, exclusive create and rename-onto-existing from the image's unprivileged
account, by all three routes that make one: the PowerShell setup script with the
published image, the launcher with an image built from staging, and the Command
Prompt script's own volume check. The 17 September 2026 pass below is that
measurement and holds its detail.

CI still does not reach it. CI does mount
CIFS -- `cli_build_and_test.yaml`'s `smb-doctor` job mounts a local-driver
`type=cifs` Docker volume and, separately, a kernel `mount -t cifs`, both against
the Samba rig it stands up -- but neither leg measures this mapping. Both name
`uid=$(id -u)`, the runner's own account rather than 1000; the volume leg runs
its check in a stock `node` image rather than the published unprivileged one; and
a Samba server can be made to serve the Unix extensions a native Windows server
never does, which is the case these options exist for. The Windows side does not
reach the mount either: the resolution workflow drives the script's resolution
functions on a Windows runner and stops before part 4. And the runs recorded
below reached "the volume mounts and Alcove can write to it" while the image
still ran as root, where the DAC override made the mapping irrelevant. That is
why a working share passed before and why it is not evidence now.

Re-measuring it takes the shape that pass took: run either script through part
4 against a real share and read that same verdict. Both scripts' probes are the
measurement -- `alcove doctor mount` for the PowerShell
one, `cmd_alcove-volcheck.sh` for the Command Prompt one -- and both run inside
the published image, so their write is uid 1000's write and a wrong mapping
fails them rather than passing silently. Worth doing against a native Windows
server rather than the Samba rig: Samba can be configured to serve Unix
extensions, and a rig that does would mask exactly the case these options exist
for.

**The PowerShell script's own container-side diagnostics are gone, 5 August
2026.** Both here-strings -- the smbclient probe and the volume check -- were
deleted, and the script runs the image's `alcove doctor probe` and
`alcove doctor mount` instead, branching on their exit codes (0, 78, 69) rather
than parsing anything. Everything recorded below about those here-strings is the
record of code that no longer exists in this script. The behaviour each finding
produced is carried by the doctor batteries in `apps/cli/src/doctor/`, whose own
CI leg drives them against a real Samba server and a real CIFS mount on every
change to them -- the `smb-doctor` job in
`.github/workflows/cli_build_and_test.yaml`, which is where that coverage now
lives. The Command Prompt script still carries its own copy of both checks, and
its state is recorded in `cmd_windows-network-filedrop.md`; parity between the
doctor's battery and that copy is maintained by hand, not asserted by a test.

**The container half was verified against a real Samba server**, driven through
the here-string the script then carried rather than a paraphrase of it.
Confirmed: the
happy path end to end; `NT_STATUS_LOGON_FAILURE` on a wrong password;
`BAD_NETWORK_NAME` on a wrong share; a share root that refuses to list while
the target subfolder works, which now continues rather than aborting; recovery
from probe files left by an earlier run, including the stale-`.renamed` case
that used to make a writable share report as read-only; the create, rename and
delete stages diagnosed separately; a folder whose name contains a semicolon;
a missing environment variable; a dialect the server refuses, reported as a
negotiation failure rather than as an NTLM policy problem; and the free-space
warning on a share reporting zero blocks available.

Four defects were found by review and fixed against that server, each reproduced
before and after. Each is carried by the doctor battery that replaced the
here-string, which is the reason they are still worth reading:

- **An empty status was read as success.** `status_of` scrapes for an
  `NT_STATUS_` token, and a transport that dies before the server answers
  supplies none. A `socat` listener accepting port 445 and never speaking SMB
  drove the probe to `ALL CHECKS PASSED`, exit 0, having authenticated,
  opened, written and deleted nothing -- and to three fabricated "removed ...
  left behind by an earlier run" notices. `transport_failed` now consults the
  exit status as well, and the same listener exits 3. This is the reason the
  exit status is captured at every decisive call site rather than only the
  output.
- **`set -C` never asked the share.** Under `strace`, busybox ash implements
  the noclobber retry as `newfstatat` and refuses in the shell -- no `openat`
  is issued, so `EXCL_WEAK` was unreachable and the check was a no-op on
  exactly the sync-backed shares it exists to catch. `mkdir` issues `mkdirat`
  and takes `EEXIST` from the server. Note the residue: both map to an SMB
  create with `FILE_CREATE` disposition, so `mkdir` is a proxy for the
  `O_CREAT|O_EXCL` that `createExclusive` actually uses, and a share
  arbitrating the two differently still slips through. That residue is gone from
  this script's path, because `doctor mount` issues the `O_EXCL` open itself
  rather than a proxy for it; it stands for the Command Prompt copy, which still
  uses `mkdir`.
- **The stale sweep cleared names the probe never wrote.** It listed
  `alcove-write-probe.tmp`; the write stage created `alcove-probe-$$.tmp`.
  Seeding `alcove-probe-9.tmp.renamed` on a fully writable share produced
  `NT_STATUS_OBJECT_NAME_COLLISION -- created a file but could not rename it`
  and sent the operator to ask for rights they already held. Swept by mask now,
  and the probe name comes from `SMB_TOKEN`: `$$` is not unique here, measured
  at 9 on essentially every run, because the probe is a child of `sh -c`.
- **The marker was swept too**, which deleted a concurrent operator's live
  marker and turned their volume check into the `MARKER_MISSING` "wrong server,
  probably DFS" verdict. The volume check owns the marker now, and removes it
  only on `MARKER_OK`.

Also measured directly against smbclient: `-m NT1` alone fails with
`NT_STATUS_INVALID_PARAMETER_MIX` against every server, because `-m` sets the
maximum protocol only and the client minimum stays at `SMB2_02`. Adding
`--option="client min protocol=NT1"` negotiates successfully. The option name
takes spaces, not underscores.

**The volume half was verified over a real CIFS mount**: the marker file the
container checks leave behind is visible through a volume mounting the same
directory and absent through one mounting a different directory, which is what
catches a wrong server, share or subfolder before an exchange does. Exclusive
create is honoured, re-measured through `mkdir` after the `set -C` finding
above: the original reading here was taken with a test that never issued a
syscall, so it confirmed the shell rather than the share and would have read
the same against a share that honours nothing. A POSIX rename onto an existing
file succeeds -- note that smbclient's own `rename` refuses that,
which is why the two halves test different things and why a rename check built
on smbclient produces a false negative.

**The Windows half is verified**, on Windows 11 under Windows PowerShell 5.1
against a Samba container on the Docker bridge, in the form it had at
`7396cc73` -- see the delta below for what has changed since. Covered:
a full pass ending in a mounted CIFS volume, driven both from `-Server`/`-Share`
and from `-DropPath`; the confirmation prompt and the warning that fires when
Windows itself cannot open the path; the ConstrainedLanguage preflight, run in a
runspace whose language mode really is constrained, which stops before touching
anything; the helper-image pull; `Get-DriveKind` returning Fixed and Absent from
`IO.DriveInfo`; `Test-Elevated` in both states, including the elevated-session
message, which an elevated run reaches through a letter the session cannot see;
`PtrToStringBSTR` round-tripping a password through `SecureString` intact,
including non-Latin characters; the stale-marker recovery, reached for real
after an earlier run left a marker behind; and all three volume cases -- absent,
already a CIFS volume made by this script, and already something else.

`Resolve-MappedDrive` was exercised against a real Windows drive mapping in an
earlier revision and all three of its lookup methods returned the UNC root; the
mapping was served over WebDAV rather than SMB, because Windows' own
file-sharing service holds port 445. Its third method sits in
`Get-NetUseRemoteName` so that a suite can reach it at all: the two before it
answer whenever they can, so on a machine where either works nothing reaches the
third through them. That method is driven in CI over the rig's mapped letter,
where it returns the UNC root at `$ErrorActionPreference = 'Stop'`, and over a
letter nothing is mapped to, where `net use` writes to standard error and the
redirect turns that into a throw rather than the non-zero exit code the function
reads -- which is what its catch is for.

**The SMB-served mapped drive and the DFS namespace are covered in CI as of 5
August 2026.** `Setup-AlcoveFileDrop.Tests.ps1` drives the script's own
resolution functions on a `windows-latest` runner that serves itself an SMB
share over loopback: a letter mapped to that share resolves to its UNC and
classifies as a network drive; a letter mapped to a link in a standalone DFS
namespace resolves to the namespace path rather than to the server holding the
data, which is the answer the confirmation prompt exists to have the operator
correct; and a fixed local path classifies as local. The same suite covers UNC
and device-prefix parsing, the dialect map, password masking, and `Invoke-Docker`
-- against a name that is not a command, against an empty one, and against a
command that writes to standard error and exits non-zero -- without a rig. Two
of its cases hold the interpreter premises those wrappers are written against
rather than leaving them in comments: at `$ErrorActionPreference = 'Stop'` a
native program's redirected standard error is a terminating record whatever its
exit code says, and calling a name that is not a command raises
`CommandNotFoundException` even under the relaxed preference the wrappers run
their calls at. It reaches those functions by dot-sourcing the script with
`-LoadFunctionsOnly`, a switch that defines the functions and stops before the
setup flow; two of its tests hold that switch to its contract from both sides,
since a guard that swallowed the flow would leave every operator with a script
that does nothing. Of what lies past resolution, the credential and volume
sequences are reached only through the launcher's suite below; the container
checks are verified by the passes above and by nothing else.
`ci-resolution-tests.ps1` runs the suites and reports them as check-run
annotations, which is all a reader of a CI run can see.

**The launchers, as of 6 August 2026: both are driven end to end against a stub
engine.** `scripts/start-alcove-launcher.test.mjs` drives `start-alcove.sh` on
Linux CI against a stub engine on PATH -- a real process reading the real
argument vector, so the mounts and the publish binding are asserted as the
engine receives them. Covered: the unstamped refusal, and
that it happens before the engine is touched at all; the sourcing contract from
both sides; the verdict reader (absent versus null, prose holding a brace, a
comma and a quote, an escaped control character rendered as a space, a check
found by id rather than by position); a `fix_and_retry` loop printing MEANING
and ACTION verbatim and running again; a declined retry; a `fatal` stop that is
not retried; a refused verdict version; the docker-then-podman order; the
account the container is run as and the pasted-credential scratch override that
travels with it, with the host's own kind stubbed each way and `id` stubbed at
root, where a sudo run takes the account sudo names and a root run naming none
-- or naming root in either number, however that number is spelled -- passes no
identity and no override at all; the read-only bind on the input mount, and the
writable rendezvous bind beside it when one folder was given as both; a battery
per folder the console is given, and one battery when the same folder was given
for all of them; what each folder has to answer -- an input
folder that reads and will not write carrying on, an unreadable one stopping,
and a folder given as both the input and the rendezvous held to the writes; and
one pass reaching the console. Nothing there pulls the real image, opens a
browser, or reaches a network.

**What the identity route has not been driven against is an engine.**
`start-alcove.sh` runs the container as the operator's own account on a Linux
host, which is the answer to a bind mount carrying host ownership through to an
image that runs as a fixed number. The stub engine reads the argument vector and
answers; what it cannot say is what a real one does with it. Rootless podman is
the case to drive first: it maps a container account into a subordinate range
rather than onto the host account of the same number, so `--user` there may need
`--userns=keep-id` beside it or instead of it, and only a run settles which.
That is why the troubleshooting page offers that flag as something to try rather
than as the fix, and says there that we have not run it.
Docker Engine on Linux, where the route was chosen, has been reasoned about and
not run either. The macOS branch passes no identity at all, which is what it did
before this, so nothing there is newly unmeasured. The read-only bind on the
input mount belongs to the same list: the suite asserts that `:ro` is in the
argument vector, and what an engine refuses through it is a question only a run
answers. So does the troubleshooting page's account of a folder writable only
through a supplementary group -- what `--user` does with the other groups a
login carries has been reasoned about here and not run.

`Start-Alcove.ps1` is covered by `Start-Alcove.Tests.ps1`, most of it purely:
the verdict reader against the same fixtures, the release stamp, the DFS
candidate selection, the console's argument vector, the parameter-name reader
the dot-source protects itself with, and both engine wrappers against a name
that is not a command and against an empty one.

Its network flow is driven end to end on the runner: a stamped copy of the
launcher, the setup script beside it, a stub `docker.cmd` first on a PATH
holding no other engine, and a listener the suite itself holds open on the
console's port. That run answers the confirmation prompt from a redirected
standard input, creates the volume, runs the `doctor mount` battery over it,
starts the detached container and waits for the port -- and asserts that the
`-VolumeName` the operator passed reaches the volume, the battery, the console's
rendezvous mount and the removal line the run prints, none of them carrying the
setup script's default in its place. One substitution: the copy of the setup
script beside the launcher answers `Read-ShareCredential` from a definition of
its own, because `Read-Host -AsSecureString` reads the console rather than a
redirected standard input, which the suite holds as a case of its own. Nothing
else is stubbed, and the `param()` block whose collision the run is there to
catch is the real one.

**What every stub above cannot reach is the image, and that is measured
separately.** Each of these scripts delegates its checks to a capability of
`ghcr.io/georgetown-mdi/alcove`, and a stub engine answers for the image whatever the image
would really have said. `image_smoke.yaml`'s capability gate closes that: it
derives the set from the scripts -- the Alcove argument vectors they hand a
container, and the helper scripts the `.cmd` pipes into a shell in it -- and runs
each against a real image, once against the one the job just built and once a
week against the published `ghcr.io/georgetown-mdi/alcove:latest` the setup script actually
pulls. A helper's in-image tools are resolved by its own run rather than listed,
and a call site added to any of these scripts fails
`npm run check:image-capabilities` until something exercises it. What that leaves
unmeasured is the same as everywhere else here: Windows, a real share, and the
`.cmd` path's own batch flow around the helpers it pipes in. Detail:
[docs/spec/CONTAINER_IMAGES.md](../../docs/spec/CONTAINER_IMAGES.md).

The folder picker, its typed fallback, the credential prompt itself and the
paths that need a real engine and a real share were executed by the 17 September
2026 pass below. Still unexecuted anywhere: the DFS offer, and the
constrained-language branch, which is the one chosen from documentation rather
than measurement -- the picker in a session whose language mode really is
constrained is where the next pass should start.

The launcher's CIFS volume options are the setup script's -- since 5 August 2026
literally, through `New-ShareVolume`, which the launcher calls with `-Engine`
naming whichever engine it found. Its credential prompts, its password-comma
refusal and its volume replace-or-refuse sequence are the setup script's copies
too, reached through the same dot-source: the launcher's own copies of all three
were deleted rather than kept in step. Neither script's volume options have been
driven against anything but docker, and the launcher still says so on screen
before creating the volume under any other engine rather than predicting what
podman will make of them.

What that sharing costs the launcher, and what to look at first on a real
Windows pass: it now prints the setup script's fuller credential preamble and
its longer refusals, names the device it is creating the volume for, and says
that Docker mounts the volume the first time it is used. Nothing there changes
what it does.

Still unverified: the Windows-containers branch, which needs Docker Desktop
switched to Windows containers to reach -- only the `{{.Server.Os}}` parse it
keys on is confirmed, against a `linux` engine. The launcher asks the same
question of docker alone, for the same reason.

Both `docker run` calls that replaced the here-strings -- the argument vectors
that invoke `doctor probe` and `doctor mount`, the exit codes the script
branches on, and the collected-then-printed output -- were executed by the 17
September 2026 pass below, on the happy path and on a wrong password.

Two branches past them are still unverified on Windows. The branch that reports
a volume which mounted and then refused the write, split out of the "could not
be mounted" verdict it used to share, is reached only after a failure, so the
cost of it being wrong is a wrong message rather than a wrong outcome. And the
image fetch the capability gate makes when the copy on the PC carries no doctor
-- the pull itself, and the second ask that either carries the run on or reaches
the same refusal -- is driven in both directions by the Pester stub engines and
by nothing on Windows; reaching it there takes a local copy older than the
checks, tagged as the floating tag the script asks for.

A later pass ran the script in the form it had on 30 July 2026, from Windows
against the same
kind of rig, with no options and answering its prompts: a full setup ending in
a mounted volume, including the message changes made since `7396cc73`. It does
not reach the branch above -- everything worked, and that branch is only
reached after a failure. It also does not exercise the prompts themselves. The
script cannot be driven from a non-interactive session, because `Read-Host`
reads the console rather than redirected input and blocks at the confirmation;
the run used the `Read-Host` shim described under "If you pick this up", which
substitutes the five prompt reads and nothing else. What a person typing at a
real console would additionally exercise is the console read itself, including
the masked `-AsSecureString` entry. The `SecureString` handling downstream of
it is the script's own and did run, as it did in the earlier pass.

**Logging a run does not hide its questions, and the guide should keep saying
so.** `Read-Host` writes its prompt through the host rather than down the
success stream, so a pipe never carries it. Measured with a script emitting a
distinct marker from `Write-Host` and from `Read-Host`, run as
`... 6>&1 | Tee-Object log.txt`: the `Write-Host` marker reached the file, and
while the process sat blocked at the prompt the `Read-Host` marker was absent
from it -- it had gone to the console, which is where the operator needs it.
`6>&1` is what carries the report itself, because `Write-Host` writes to the
information stream; without it the file is empty. The Command Prompt script is
the opposite case and has no equivalent: `set /p` prompts go to standard
output, so `1> log.txt 2>&1` puts every question in the file and leaves a blank
screen -- confirmed by a full run that completed with nothing displayed at all.
That asymmetry is the reason the guide offers logging for one shell and copying
out of the window for the other.

Two Windows-only defects were found by that pass and fixed. **The volume check
never ran**: its here-string reached `sh` with the CRLF line endings a checkout
with `core.autocrlf` produces, and `sh` does not treat a carriage return as
whitespace, so `fi` arrived as `fi\r` and the interpreter reported an
unterminated `if`. The probe here-string strips line endings for this reason;
the volume check did not. **The existing-volume guard never ran either**, and
this one destroyed data: its inspection template embedded double quotes around
the map key, Windows PowerShell strips those while building a native command
line, and Docker rejected the template for every volume. The non-zero exit was
read as "no such volume", so an unrelated volume of the same name was reused,
mounted, and then removed by the marker branch. The template is now quote-free
and existence is established from `docker volume ls`, so an inspection that
cannot run refuses rather than proceeds.

## Verification pass on staging, 30 July 2026

Run against `d530f47`, the commit that moved the checks into the Alcove image,
because that change had not been exercised from Windows in that form. The rig
was a Samba 4.21.9 container on the Docker bridge, Windows 11, Docker Desktop
28.3.2. The share password throughout was `Pa!ss&w%rd^1`, which carries every
character Command Prompt is known to mangle.

**Both scripts completed, exit 0.** Each was run with no options, answering its
prompts: a UNC path, `Y` to the confirmation, a username, a blank domain, the
password. Each reached a mounted CIFS volume and reported the same four
results -- the volume mounts and is writable, the volume and the checks agree
on the folder, exclusive create and rename behave, and all six checks passed.

**The image change works.** `ghcr.io/georgetown-mdi/alcove:latest` pulled (575 MB) and step 3
authenticated with the `smbclient` now shipped in it; no `apk add` remains in
either probe. The section that used to cover a failed package install is gone
from the troubleshooting page, and nothing still cites it -- checked across both
scripts and the probe, so there is no dead reference for an operator to chase.

**The closing block emits no redirection character.** The Command Prompt run
was made from an empty directory so that a `>` escaping into text passed to
`:info` would leave a file behind rather than merely losing a line. Nothing was
created. This is worth repeating whenever that block is rewritten, because the
failure is silent on screen.

**Every section name the scripts print in quotes resolves to a real heading**,
across all four pages including the new `by-hand.md`. Citations that wrap across
two printed lines have to be rejoined before checking or they read as missing;
a checker that does not rejoin them also swallows the region after a line that
mixes quote styles, and can hide a real mismatch inside it. The two citations
inside that region were confirmed by hand.

Line endings on the checkout were as they must be: the `.cmd` CRLF, the three
`.sh` files LF.

Two shell behaviours were measured during the same session. They concern `cmd`,
PowerShell and Docker rather than any version of these scripts, so they hold
here, but they were driven against the branch's copies rather than staging's:

- `Read-Host` writes its prompt through the host, not down the success stream.
  Measured with a script emitting distinct markers from `Write-Host` and
  `Read-Host` under `6>&1 | Tee-Object`: the `Write-Host` marker reached the
  file and, while the process sat blocked at the prompt, the `Read-Host` marker
  did not. A logged PowerShell run still shows its questions. `set /p` is the
  opposite -- its prompts go to standard output, so `1> log.txt 2>&1` puts every
  question in the file and leaves a blank screen, confirmed by a full run that
  displayed nothing at all.
- At a command line, `%` only expands in pairs naming a variable that exists.
  `one%two` and `pa%NOSUCHVAR%ss` reached Docker intact; `pa%USERNAME%ss` was
  stored as the account name with `pa` and `ss` around it, silently. The scripts
  are immune either way -- `set /p` does not parse what it reads and the single
  expansion at volume-create time is not rescanned -- confirmed by a full run
  authenticating with `pa%USERNAME%ss` and storing it back verbatim.

**What this pass does not cover, and should be read as the limit of it:**

- **Nothing was made to fail.** Every run was a working share. The MEANING and
  ACTION text for every failure -- `LOGON_FAILURE`, the transport-failure path,
  the dialect messages, the write/rename/delete split -- is untested against the
  Alcove image, and the troubleshooting page says as much to the operator. A
  wrong password is the cheapest of these to provoke and the one an operator is
  likeliest to meet first.
- **`by-hand.md` was not walked.** It is a new page of roughly five hundred
  lines giving the whole setup as individual commands. Only the two Command
  Prompt commands that were in the old "Doing it by hand" section were run --
  `docker volume create` and the mount check -- and both worked. The rest of
  that page has not been executed in order.
- **The PowerShell run used the `Read-Host` shim** described under "If you pick
  this up", because the script cannot be driven from a non-interactive session.
  The console reads themselves, including the masked `-AsSecureString` entry,
  were not exercised.
- **No DFS namespace, and no SMB-served mapped drive letter.** Neither was
  reachable in this rig, for the reasons given above and below. Both reached CI
  on 5 August 2026, for the resolution functions only; see the State section.

## Verification pass on staging, 17 September 2026

Run from two lab VMs against staging
`f4271a0d8f50abbf4755cf4fd30b9e8ffb873220`, from a checkout with
`core.autocrlf=false`. Ten runs: four of `Setup-AlcoveFileDrop.ps1`, five of
`Start-Alcove.ps1`, one of `cmd_Setup-AlcoveFileDrop.cmd`. Seven were typed at
the workstation's RDP session; three were scheduled tasks inside that same
session, two of them answering their prompts through a stand-in `Read-Host` and
one on standard input. An SSH logon cannot stand in for that session: `Z:` shows
as Unavailable there, Credential Manager is empty, and the share returns Access
denied.

### The rig

- **Workstation:** Windows 11 Pro 25H2 26200.9457, Windows PowerShell
  5.1.26100.9444, Docker Desktop 4.91.0 (Engine 29.8.0). The operator account
  was a standard user.
- **File server:** Windows Server 2025 Standard Evaluation (Server Core), 26100,
  SMB left at its defaults -- SMB1 off, signing not required, no encryption --
  serving one share to a local account. A native Windows server rather than the
  Samba rig earlier passes used, which is what makes the ownership measurement
  below mean anything: Samba can be made to serve the Unix extensions a Windows
  server never does, and a rig that does masks the case the mount options exist
  for.
- **Published image**, which the setup scripts pull: `ghcr.io/georgetown-mdi/alcove:latest` =
  `sha256:1ac76a1f3db719e9e1b35985ee8f6c817a8147da0ae1a82e6ac79c008566fb90`,
  built 2026-08-16, `User: node`, `id` inside it `uid=1000(node) gid=1000(node)`.
- **Staging image**, which the launcher ran:
  `sha256:8be152ca016f43ed081bd99c33d56ed0195b59b80c084f99ffb16e9cf42916a8`
  (manifest list), built on the workstation from that staging sha and pushed to
  a registry running on it.

The launcher did not run a release copy, because there is none to take: the
release list is empty, and the published `latest` predates split-pair support,
so its console bundle has no `JOB_RENDEZVOUS_OUTBOUND_DIR` and cannot serve a
pair. The copy under test therefore had both its repository line and its digest
line rewritten by hand; a release rewrites the digest line alone, so the
repository half of that stamp is still unexercised.

### The ownership mapping holds

A volume created with `username=...,uid=1000,gid=1000` over that server took
every operation Alcove's rendezvous needs, from the image's unprivileged
account, by all three routes that make one:

- `Setup-AlcoveFileDrop.ps1` with the published image: `doctor mount` reported
  the mount readable, the marker agreed, a file written and renamed into place,
  a second exclusive create refused, and a rename onto an existing file.
- `Start-Alcove.ps1` with the staging image: every volume check returned
  "Nothing here blocks an exchange" -- over a volume on a share subfolder, one
  on a folder within it, and one on a second share.
- `cmd_Setup-AlcoveFileDrop.cmd`: "The volume mounts and Alcove can write to
  it." and "Exclusive create and rename behave the way Alcove needs.", over a
  volume it created with the same options.

That is the measurement the State section above stands on.

### What else held

- **The PowerShell setup script** passed from a mapped drive and from a UNC
  path, with and without a `Tee-Object` log pipe, and replaced an earlier run's
  volume without asking. A wrong password failed correctly:
  `NT_STATUS_LOGON_FAILURE`, its MEANING and ACTION, `NOT READY YET`, and the
  earlier run's volume left alone. An elevated window refused the mapped drive,
  as it must.
- **The launcher** passed for one shared folder chosen in the folder picker, for
  a pair on one share (one volume over the folder holding both, four checks, and
  the console reporting retain mode), and for a pair on two shares of one server
  (two volumes, and the console's rendezvous endpoint reporting the split with a
  folder name per leg). It refused a nested pair and a pair naming one folder
  twice, both in part 1 before any prompt, with exit 1 and no volume. Over
  `ssh -t`, where no picker can open, each folder prompt fell back to a typed
  path and took it.
- **The Command Prompt script** passed end to end, exit 0, with all six network
  checks and all three volume results.
- **The credential prompts were typed at a real console**, the masked
  `-AsSecureString` entry included, in seven of the ten runs. Earlier passes had
  only the `Read-Host` shim.

### The findings

Eleven, none of them a wrong outcome for a working share. Ten are fixed on this
branch:

- **A stray `System.Management.Automation.RemoteException` line** printed once
  per battery, just before the verdict. Windows PowerShell wraps each redirected
  stderr line as an `ErrorRecord`, whose `ToString()` answers with the exception
  type's name when the line is empty -- and the checks print a blank line before
  their summary. `Invoke-Docker` reads the message off the record instead.
- **The `LOGON_FAILURE` ACTION named `SMB_DOMAIN` alone**, which is the variable
  an operator running the image by hand sets and not the Domain prompt these
  scripts ask. The doctor text names both routes in one sentence.
- **Seven identical `SKIP: not run: an earlier check did not pass.` blocks**
  after a failure, each repeating the same MEANING and none naming its check.
  Each skipped check names what it would have asked, and the shared MEANING
  prints once, under the last of them.
- **The elevated-window refusal contradicted itself**: it printed its own remedy
  (close the window, open PowerShell normally) and then the generic "Enter it as
  a drive letter path ...", which is what the operator had just done. That tail
  is suppressed for a reason retyping cannot answer, and the reason is wrapped
  and sentence-cased like the rest of the script's text.
- **A pair on two shares of one server asked for the credentials twice.** The
  second share asks whether to use the first answer again rather than reusing
  it silently, so a pair reached by two accounts is still given both. The
  answer is dropped once the volumes are made, and on every exit within that
  section as well.
- **`Z: is mapped to \\server\share` printed once per folder** where both
  folders were on `Z:`. Once per drive letter now.
- **Answering no at the launcher's share confirmation led away from the
  launcher**, to `Setup-AlcoveFileDrop.ps1 -Server ... -Share ...`, which makes
  a volume and stops rather than opening a console; and it opened "Windows would
  not say what is behind that path" where Windows had just said it. It points at
  `-RendezvousDir` with the path read off the DFS tab instead, and says what the
  connection list did not hold.
- **The Command Prompt script's printed console command had no
  `JOB_RENDEZVOUS_NAME`**, so a console started from it would name the shared
  folder after the mount point in invitations and accept kits. It carries the
  folder name the PowerShell script's line does.
- **`.gitattributes` had no rule for the image entrypoints**, so a checkout with
  Git's `core.autocrlf=true` default on Windows would build an image whose
  entrypoint fails on its own shebang line. Both are `-text` now. Not driven:
  this pass built from an `autocrlf=false` checkout, where neither file had a
  carriage return.
- **Two launcher answers were read too loosely.** An unrecognised answer at a
  `[y/N]` prompt was taken as the default rather than asked again, and the "One
  folder for all of it..." explanation printed even where `-DataRoot` made the
  question moot. The prompt asks again, and the explanation prints with the
  question.

The eleventh is not a code change and is not fixed here: **no operator can get a
launcher that runs today.** The README sends them to a release for
`Start-Alcove.ps1`, a copy from anywhere else refuses to run, and there are no
releases; the published `latest` also predates split-pair support, so no
published image can serve a partner whose accept kit routes them to the
launcher. Cutting a release resolves both, and that is the maintainer's call.

### What this pass does not cover

- A DFS namespace and the DFS offer, and constrained language mode -- both the
  picker branch and the preflight. Both were out of scope for it.
- An administrator elevating their own session. The elevated run reached its
  window through UAC's credential prompt as a second account, the operator being
  a standard user.
- The Command Prompt script typed at a real console: its run was fed on standard
  input.
- The staging image's failure text. The `LOGON_FAILURE` and SKIP wording above
  was read from the published image only.
- The setup script's image fetch when the local copy carries no `doctor`.
- A release copy of either launcher, since there is none.
- Any exchange. Only the checks wrote to the share, and no two-party run was
  made.
- Docker Desktop in Windows containers mode, and podman.

The findings above are fixed against reading rather than against a Windows
console: nothing in this container runs Windows PowerShell or `cmd`, so the next
pass should re-read the four screens they change -- the elevated-window refusal,
a failed battery's SKIP block, a pair on two shares of one server, and the
Command Prompt script's closing console command.

## Decisions worth not relitigating

**Automatic DFS resolution was removed.** `Resolve-RealServer` read the SMB
connection list and substituted the server name. Three things were wrong with
it at once: it substituted only the server while keeping the namespace's share
and subpath, so even a correct lookup produced a device that cannot exist (the
runbook's own worked example differs in all three parts); reading the
connection list requires Administrator rights, and an elevated session cannot
see the mapped drives the rest of the script depends on, so the two documented
routes were mutually exclusive; and following a referral, Windows holds a
connection to the namespace root as well as to the target, so matching on the
namespace's share name should return the namespace server -- the name already
in hand -- making the function a no-op on the case it existed for. That last
point is read off the DFS protocol rather than measured; see the field notes
below.

What replaced it: the script shows the operator the server, share and subfolder
it worked out and asks them to confirm, naming DFS as the case where they will
be wrong; the container classifies `NT_STATUS_PATH_NOT_COVERED`, which is the
server saying outright that the path is a DFS link; and the marker file catches
a wrong answer that slips past both. The manual route -- Properties, DFS tab,
then `-Server`/`-Share`/`-SubPath` -- is the primary one for a namespace, and
the runbook says so.

`NetDfsGetClientInfo` (netapi32, `DFS_INFO_3`, what `dfsutil /pktinfo` reports)
is the API that answers the question properly, and returns storage server and
share together. It was not adopted: it needs `Add-Type` P/Invoke, which
ConstrainedLanguage blocks on exactly the locked-down endpoints this guide
targets, and there is no way to test it here. If a domain-joined machine
becomes available, measure the premise first -- if `Get-SmbConnection` does
name the target, a much smaller fix exists.

**Partly reversed, 5 August 2026: the suggestion is back, as an offer.**
`Start-Alcove.ps1` asks `Get-SmbConnection` for a correction when the operator
says the resolved server and share are wrong, and offers what it finds rather
than substituting it. Of the three defects above, two no longer hold and one
still does.

*Server-only substitution* is fixed rather than argued away. `Select-DfsCandidate`
matches `ServerName` and `ShareName` together and returns both, so a correction
that keeps the namespace's share cannot be produced at all. The suite holds that
against a connection list where the target sits on the namespace's own server
under a different share.

*Namespace-root masking is measured away.* The claim that the connection list
answers with the name already in hand was read off the protocol, not measured;
the rig has measured it. Check-run `92447351999`'s `Q3_resolve` annotation,
taken after a write through `\\runnervmhisb5\alcovedfs2d4600cc\drop` whose
folder target is `\\runnervmhisb5\alcoveci2d4600cc`, records:

```text
smb_connections=localhost\alcoveci2d4600cc|runnervmhisb5\IPC$|runnervmhisb5\alcoveci2d4600cc|runnervmhisb5\alcovedfs2d4600cc
```

The target share is there alongside the namespace root, so dropping the
namespace's own pair leaves something real to offer. Read it for the limit as
well: with `IPC$` dropped, two entries naming a real share remain, so on that
rig the selection reports several and falls back. The rig settles the premise,
not the offer.

*The elevation requirement stands, and is still unmeasured where it matters.*
`Get-SmbConnection` answered on the runner, whose session holds the rights; it
has not been run in an ordinary operator's non-elevated window, where the field
notes below recorded "Access is denied". That is why the fallback is
load-bearing rather than an edge case, and why the suggestion is never more than
an offer: on zero candidates, several, an error, or an empty result the launcher
routes to the DFS tab, exactly the manual route the setup script gives. Settling
the non-elevated premise is assigned to the planned real-Windows end-to-end
pass, which is also the only thing that can exercise the offer's prompt.

The offer is reached only after the operator declines the confirmation, which
keeps it off every path that resolved correctly. `Setup-AlcoveFileDrop.ps1` is
unchanged: it still prints the manual route and stops.

**The probe reports derived facts, not the operator's data.** Step 3 used to
print the server's share list and step 5 the drop folder's listing. The runbook
asks the operator to send the run to whoever is helping them, which for a
supported deployment is us -- and we are not a party to their
exchange, so an agency's share names and the filenames in a record-linkage drop
folder are things we should not end up holding. Step 3 was cut to whether the
named share was among those offered, and step 5 to an entry count. Nothing
downstream read either: `report_space` parsed `LISTING`, not what was printed.
The doctor's `authentication` and `subdirectory` checks report the same two
derived facts and no listing, and its JSON verdict withholds the tool output
behind a failure for the same reason -- so this decision survived the move into
the image rather than needing to be retaken.

Reducing at source rather than warning the operator to review the log is
deliberate. A warning cannot protect the recipient, since it leaves the decision
with someone who has no basis for it, and it adds a judgment call to an audience
the whole guide is trying to spare one. The entry count also closes a coverage
gap for free -- it is where the 8192-entry limit is now checked.

**The guide is split, and the split is the point.** `README.md` is the setup
page: the problem, what you need, which of the two scripts to run, run it, what
you got, how the exchange ends, and where to go if it broke. `troubleshooting.md`
is a section per failure and then reference material -- status codes, the IT
request, reading the real path, doing it by hand. `passwords.md` is the account
decision and what Docker does with the password. The single page all three
replaced was 543 lines, of which about 111
served a reader whose run succeeded -- so four readers in five were paying for a
failure they did not have, on a page whose length is itself the risk with this
audience.

The two axes of that split are different and should not be confused. Splitting
off `troubleshooting.md` spares the successful reader a failure they do not
have. Splitting off `passwords.md` spares the *failing* reader a question no
failure asks: forty-odd lines of exposure detail sitting in the middle of the
page you are on precisely because something broke. The test for a third page is
that nothing forces the reader to it -- an operator who never opens
`passwords.md` still completes an exchange.

Which script you are running is *not* such an axis, which is why the Command
Prompt page was folded back in. The reader who lacks PowerShell finds that out
on the setup page and has to act on it there; sending them to a second page to
do so put a mandatory hop in the one path that was already the harder one. Both
forms are now given wherever the two shells need different commands, PowerShell
first, on all three pages -- and only there: a command that is identical in both
gets one block, as `docker volume rm` does. Where the two blocks would look
nearly alike, label them, since position alone is a weak cue for a reader who
arrived mid-page.

Keep the setup page near its current 160 lines. The pressure will always be to
add "just one more caution" to it, and every one of those is a line every
operator reads to serve a case most of them do not hit. A caution earns its
place there only if acting on it late is expensive: the keys file, one exchange
at a time, which account you pick, and that a second file drop replaces the
first are the four that do.

The line count is the weaker half of that test. The stronger half is that a
line has to change what the operator *does*, and specifically what they do
*before* the script could have told them. Both scripts print, at the moment of
use, most of what the page says in advance -- the whale icon, the elevation
warning, the keys file, the one-exchange rule, the retirement step, the
copy-out procedure. Advance notice earns its place where it changes what the
reader gathers: the comma rule reaches them before they open an IT ticket, and
the account guidance before they ask for the wrong account. Where it does not,
the script is the better place for it and the page should let it go.

**The opening delivers a mental model, deliberately, and it is load-bearing.**
Everything on these pages follows from one idea: Docker works inside a hidden
Linux computer, which cannot see Windows' drive letters *and* which the file
server treats as a different machine. The second half is what makes a second
username and password make sense, and for a long time the page carried only the
first -- so the credentials requirement arrived as an unexplained demand, and
the network half surfaced only on the troubleshooting page, behind "Docker's own
address translation". With both halves stated once at the top, later sections
can say "the hidden Linux computer" instead of introducing VM, container,
resolver, domain-joined and address translation separately. Do not trade those
lines away for brevity: they are why the rest of the guide can be short.

**The testedness note stays on the guide, trimmed.** A review argued it is
maintainer provenance and belongs here instead. It is both -- but
`support/README.md` requires each guide to say how far it has been confirmed, so
the note discharges a convention rather than merely informing. What it does not
need is the audit trail: which script was reverified against which change, and
in what order. Keep the DFS caveat, because it is why the confirmation prompt
exists, and keep the invitation to send corrections. The fuller account lives
here.

**The synced-folder fork was cut from the setup page, deliberately.** It used to
open the page, sending a reader whose drop is kept in step by OneDrive or Egnyte
to `troubleshooting.md#synced-folders` before they gathered credentials. Three
independent reviews of the fold-in asked for it back, on the grounds that an
operator who learns this late may already have opened an IT ticket for a service
account they never needed. It stays out, because the premise those reviews share
is wrong: nobody arrives at this page cold. The page exists for one symptom, and
its first fifteen lines are that symptom -- Docker refusing a bind mount with
"bind source path does not exist". A synced folder is a local path, so it
bind-mounts without complaint and never produces the error that sends anyone
here. A reader on this page has a network path by construction. `support/README.md`
routes the synced-folder symptom separately, which is the right place for it.
Do not restore the fork; if a real operator is ever found to have needed it,
that is new evidence and this paragraph is what it overturns.

The pages all sit in the guide folder, so handing it over as a unit still
works; the unit was always the folder rather than the file. Both scripts cite
sections by name, saying "the troubleshooting page" or "the passwords page"
rather than "the runbook". The URL each prints on failure is the troubleshooting
page; the passwords URL appears only in each script's header and help text, so
the operator reaches that page from the pages themselves. A section rename is
therefore a change to both scripts as well. Nothing in CI catches a citation
that has stopped naming a real heading, so check it by hand: pull the quoted
names out of each script, including the ones wrapped across two `emit` lines,
and confirm each is a heading in the page it names.

**"Send me the whole run" is copy-from-window, not a redirect.** Both pages used
to tell the operator to re-run the script with `6>&1 | Tee-Object` in PowerShell
or `1> setup-log.txt 2>&1` in Command Prompt. Both are worse than they look.
`set /p` writes its prompt to stdout, so the Command Prompt form sends all five
questions into the file and leaves the operator answering a blank window; that
much follows from what `set /p` does. The PowerShell form is doubtful for a
related reason: `Read-Host` writes its prompt with no trailing newline, and a
native command's output reaches a PowerShell pipeline a line at a time, so the
prompt should not surface until after it has been answered. **That second one is
reasoned, not measured** -- it has never been run on Windows, and it is the
first thing to check if anyone is tempted to bring the redirect back. Copying
out of the console window replaces both: no second run, and no prompt swallowed
into a file.
Its one cost falls only on Command Prompt, which cannot hide typing, so the
password sits in that scrollback -- which is why both the page and the script
say to start the selection below the `Password:` line.

**The local-folder fallback was cut.** It was forty-three lines showing the
operator how to build a two-way `robocopy` mirror on a Scheduled Task and point
Docker at the local copy, as the escape hatch for a container that cannot reach
the server, an account with no usable password, and an SMB1-only server. The
operator running an exchange is not the person who configures file movement
between their agency and a partner, and the drop is remote in every deployment
we have, so the section was asking the wrong reader to build the wrong thing --
its own closing line already said to hand it to IT.

What replaced it is item 5 of the IT request, which asks for the same mirror in
one sentence, and the four places that routed into the section now route there.
The two cautions it carried went with it and are not lost: the `/PURGE`-inbound
-only point is a property of a mirror IT now owns, and the LSA-secrets warning
applied to a Scheduled Task the operator no longer creates.

**A comma in the password is refused up front** rather than warned about.
Docker's local driver takes CIFS credentials only as one comma-separated
string, so there is no escaping available and the mount cannot work. Refusing
early also avoids printing the failure, whose text carries the tail of the
password in the clear -- Docker masks `password=` only as far as the next
comma.

## If you pick this up

Settling the DFS question needs a domain-joined machine with a real namespace
and an elevated PowerShell session, since `Get-SmbConnection` is readable only
to an Administrator.

A standalone namespace needs no domain, and CI stands one up: a
`windows-latest` runner installs `FS-DFS-Namespace`, points a link at a share it
serves itself, and the suite resolves a mapped letter through it. That settles
what the script does with a namespace path -- it reports the namespace, not the
target -- and settles nothing about `Get-SmbConnection` on a domain namespace,
which is the question above.

Mocking the namespace in a container does not work, and the obstacle is worth
knowing before someone spends an afternoon on it. Samba serves DFS referrals
happily (`host msdfs` plus an `msdfs:server\share` symlink), so the server side
is easy. The Windows client is the problem: its SMB redirector uses port 445 and
no other, and stopping the Server service does not free that port -- the
listener belongs to the kernel SMB drivers and survives the service stop, so
Docker cannot publish a container there. Freeing 445 means unbinding File and
Printer Sharing from an interface, which is a heavier change than the test is
worth. What the CI runner has and a workstation does not is the namespace role
itself: `Install-WindowsFeature` and `FS-DFS-Namespace` exist only on the server
product types.

Everything else runs on one machine with Docker and no special rights:

- **The share and the volume.** Run a Samba container on a Docker bridge
  network, read its address from `docker inspect`, and pass it with `-Server`
  and `-Share`. Container-to-container traffic on the bridge sidesteps the port
  445 problem entirely. Watch out for `force user` in whatever image you use:
  the exported directory has to be owned by that user or every write returns
  `ACCESS_DENIED`, which reads exactly like a genuine permissions finding.
  For the unlistable-root case, use a share whose path is inside the container
  rather than a bind mount -- host bind mounts do not carry permission bits
  reliably across platforms.
- **A mapped drive letter.** Windows holds port 445 for its own file sharing,
  so a container cannot serve SMB to the host without stopping that service.
  WebDAV needs no privileged port: run Apache with `mod_dav` (DAV class 2, so
  `LOCK` works and Windows will accept it), publish it on any port, and map
  with `net use Z: \\127.0.0.1@8080\Exchange`. The WebClient service must be
  running.
- **Driving the script unattended.** `Read-Host` reads the console rather than
  the pipeline, so a scripted run needs a `Read-Host` shim defined in the
  calling scope; the script has no `-Password` or `-Credential` parameter.
  `-SkipConfirm` suppresses the confirmation prompt but not the credential
  ones.
- **The container checks on their own.** `docker run --rm --env SMB_SERVER ...
  ghcr.io/georgetown-mdi/alcove:latest doctor probe`, with `SMB_SERVER`, `SMB_SHARE`,
  `SMB_PATH`, `SMB_USER`, `SMB_PASS`, `SMB_DOMAIN`, `SMB_DIALECT`, `SMB_MARKER`
  and `SMB_TOKEN` set: the same environment the script exports, and the same
  command it runs. `doctor mount /rz` over the volume is the other half. The
  here-string extraction this entry used to describe is what the container half
  above was verified through, and there is no longer a here-string to extract.

## Field notes: the DFS mock attempt, 28 July 2026

The account below is reproduced as written at the end of the session that
attempted it. The sections above state the conclusions drawn from it; this is
the raw record, kept because the negative result is the part most likely to be
repeated by whoever tries next.

> The DFS mock didn't work, and the reason is worth knowing.
>
> **Why it failed:** stopping LanmanServer does **not** free port 445. Two
> listeners remained on PID 4 -- the SMB listener lives in the kernel drivers
> and outlives the service stop. Docker couldn't bind `127.0.0.1:445`, so the
> containers never started and every step after that failed on a name that
> didn't resolve. Samba's side was fine: the `msdfs:dfstarget\exchange`
> symlink was in place and the target server was serving. The obstacle is the
> Windows client, not Docker. Freeing 445 means unbinding File and Printer
> Sharing from an interface, which is a bigger change than this test justifies.
>
> **What the run did settle:** elevated, `Get-SmbConnection` returned 0 errors
> against "Access is denied" unelevated. That positively confirms the
> elevation finding I shipped in the first commit, which until now rested only
> on the failing half.
>
> **What it turned up as a doubt:** even with a working namespace,
> `Resolve-RealServer` probably can't do its job. The script parses
> `\\namespace\dfs\link` into share `dfs`, and the function matches
> connections on that share name. Following a referral, Windows holds a
> connection to the namespace root (share `dfs`) *and* to the target (the
> target's own share name). Matching on `dfs` should return the namespace
> server -- equal to the name already in hand -- so no correction gets
> applied, making the function a no-op on the exact case it exists for.
> **That's read off the DFS protocol, not measured.** I've recorded it in the
> handoff as the first thing to test rather than as a finding, along with the
> note that the real client-side answer is `NetDfsGetClientInfo` (what
> `dfsutil /pktinfo` reports), and that the honest alternative is dropping the
> automatic resolution entirely. I did not change the code on the strength of
> an unverified inference.

## Before running it

The script creates a Docker volume named `alcove-sync`; `-VolumeName`
overrides it. An existing volume of that name is replaced, but only after
inspecting it -- one that is not a CIFS volume is left alone and the run
refuses, because the name is unvalidated and a typo would otherwise destroy
something unrelated. Docker stores the share password in cleartext in the
volume metadata; the passwords page, "Where the password ends up", is the full
account, including the residue that survives `docker volume rm`.
