# Maintainer notes: psilink file-drop setup on Windows

Notes on [`support/windows-network-filedrop`](../windows-network-filedrop/README.md).
They live outside that folder on purpose: the guide is handed to an operator as
a unit, and what is here -- what is unverified, what was tried and failed -- is
addressed to whoever maintains it next.

## The problem

psilink ships as a Docker image. Some agencies keep their exchange folder
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

- `Setup-PsilinkFileDrop.ps1` -- takes the folder path as the user sees it in
  Explorer plus network credentials, resolves the server, share and subfolder,
  asks the operator to confirm them, tests the share from inside a container,
  creates the volume, tests it, and prints the `docker run` command.
- `README.md` -- the setup page, covering this script and the Command Prompt
  one alike.
- `troubleshooting.md` -- the page the script's errors cite by section name.
- `passwords.md` -- the account decision, cited by the script in two places.

The Command Prompt script and its three container-side shell scripts have their
own notes, [`cmd_windows-network-filedrop.md`](cmd_windows-network-filedrop.md).

The container-side diagnostic lives only as a here-string inside the script. A
second, hand-maintained copy of it used to sit beside the script for reading;
it drifted -- it read `SMB_VERS` where the script exported `SMB_DIALECT`, so
running it with the script's own environment silently ignored the dialect --
and was removed rather than resynchronised. Anything that needs a standalone
copy should generate it from the here-string and fail on drift.

## State

**The container half is verified against a real Samba server**, driven through
the script's own here-string rather than a paraphrase of it. Confirmed: the
happy path end to end; `NT_STATUS_LOGON_FAILURE` on a wrong password;
`BAD_NETWORK_NAME` on a wrong share; a share root that refuses to list while
the target subfolder works, which now continues rather than aborting; recovery
from probe files left by an earlier run, including the stale-`.renamed` case
that used to make a writable share report as read-only; the create, rename and
delete stages diagnosed separately; a folder whose name contains a semicolon;
a missing environment variable; a dialect the server refuses, reported as a
negotiation failure rather than as an NTLM policy problem; and the free-space
warning on a share reporting zero blocks available.

Four defects found by review and fixed against that server, each reproduced
before and after:

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
  arbitrating the two differently still slips through.
- **The stale sweep cleared names the probe never wrote.** It listed
  `psilink-write-probe.tmp`; the write stage created `psilink-probe-$$.tmp`.
  Seeding `psilink-probe-9.tmp.renamed` on a fully writable share produced
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

**The volume half is verified over a real CIFS mount**: the marker file the
container checks leave behind is visible through a volume mounting the same
directory and absent through one mounting a different directory, which is what
catches a wrong server, share or subfolder before an exchange does. Exclusive
create is honoured, re-measured through `mkdir` after the `set -C` finding
below: the original reading here was taken with a test that never issued a
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
file-sharing service holds port 445, so SMB-specific mapping behaviour remains
untouched. The function is unchanged since.

Still unverified: the Windows-containers branch, which needs Docker Desktop
switched to Windows containers to reach -- only the `{{.Server.Os}}` parse it
keys on is confirmed, against a `linux` engine.

Unverified on Windows since that pass, the whole delta: the branch that
reports a volume which mounted and then refused the write, split out of the
"could not be mounted" verdict it used to share. It is PowerShell that the
Windows run never executed. Everything else changed since is either
container-side -- the probe and the volume-check body, verified against a real
Samba server and a real CIFS mount -- or the CRLF strip, which that run made
itself. The branch is reached only on a path that has already failed, so the
cost of it being wrong is a wrong message rather than a wrong outcome, but it
has not been run there and the next Windows pass should start with it.

A later pass ran the script as it now stands, from Windows against the same
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

**The probe reports derived facts, not the operator's data.** Step 3 used to
print the server's share list and step 5 the drop folder's listing. The runbook
asks the operator to send the run to whoever is helping them, which for a
supported deployment is us -- and we are not a party to their
exchange, so an agency's share names and the filenames in a record-linkage drop
folder are things we should not end up holding. Step 3 now reports only whether
the named share was among those offered, and step 5 an entry count. Nothing
downstream read either: `report_space` parses `LISTING`, not what was printed.

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

Mocking the namespace locally does not work, and the obstacle is worth knowing
before someone spends an afternoon on it. Samba serves DFS referrals happily
(`host msdfs` plus an `msdfs:server\share` symlink), so the server side is
easy. The Windows client is the problem: its SMB redirector uses port 445 and
no other, and stopping the Server service does not free that port -- the
listener belongs to the kernel SMB drivers and survives the service stop, so
Docker cannot publish a container there. Freeing 445 means unbinding File and
Printer Sharing from an interface, which is a heavier change than the test is
worth.

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
- **The container checks on their own.** Extract the `$probe` here-string and
  run it in `alpine` with `SMB_SERVER`, `SMB_SHARE`, `SMB_PATH`, `SMB_USER`,
  `SMB_PASS`, `SMB_DOMAIN`, `SMB_DIALECT`, `SMB_MARKER` and `SMB_TOKEN` set.
  That is how the container half above was verified.

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

The script creates a Docker volume named `psilink-rendezvous`; `-VolumeName`
overrides it. An existing volume of that name is replaced, but only after
inspecting it -- one that is not a CIFS volume is left alone and the run
refuses, because the name is unvalidated and a typo would otherwise destroy
something unrelated. Docker stores the share password in cleartext in the
volume metadata; the passwords page, "Where the password ends up", is the full
account, including the residue that survives `docker volume rm`.
