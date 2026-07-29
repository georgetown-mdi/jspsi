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
- `README.md` -- the user-facing runbook the script's errors point into.

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
create (`O_EXCL`, via `set -C`) is honoured, and a POSIX rename onto an
existing file succeeds -- note that smbclient's own `rename` refuses that,
which is why the two halves test different things and why a rename check built
on smbclient produces a false negative.

**The Windows half is not verified in its current form.** An earlier revision
ran end to end on Windows 11 under Windows PowerShell 5.1 -- path parsing,
resolving a mapped drive letter, the container checks, and creating and
mounting the CIFS volume against a real SMB server, with a wrong password
classified correctly. `Resolve-MappedDrive` was exercised against a real
Windows drive mapping and all three of its lookup methods returned the UNC
root; the mapping was served over WebDAV rather than SMB, because Windows' own
file-sharing service holds port 445, so SMB-specific mapping behaviour remains
untouched.

Since then the Windows side has changed substantially and none of it has been
run on Windows. Unverified: the elevation detection and the message it prints,
`Get-DriveKind` and its `IO.DriveInfo` drive-type classification, the
confirmation prompt, the ConstrainedLanguage preflight, the helper-image pull
preflight, the Windows-containers check, the existing-volume inspection, and
`PtrToStringBSTR` on Windows. Most are small and independent; the one worth
running first is a plain end-to-end pass on 5.1, which touches all of them.

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
asks the operator to tee the run to a file and send it to whoever is helping
them, which for a supported deployment is us -- and we are not a party to their
exchange, so an agency's share names and the filenames in a record-linkage drop
folder are things we should not end up holding. Step 3 now reports only whether
the named share was among those offered, and step 5 an entry count. Nothing
downstream read either: `report_space` parses `LISTING`, not what was printed.

Reducing at source rather than warning the operator to review the log is
deliberate. A warning cannot protect the recipient, since it leaves the decision
with someone who has no basis for it, and it adds a judgment call to an audience
the whole guide is trying to spare one. The entry count also closes a coverage
gap for free -- it is where the 8192-entry limit is now checked.

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
volume metadata; the runbook section "What this does with your password" is the
full account, including the residue that survives `docker volume rm`.
