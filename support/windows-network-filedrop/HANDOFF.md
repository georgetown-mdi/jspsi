# psilink file-drop setup on Windows

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
  Explorer plus network credentials, resolves the real server, tests the share,
  creates the volume, and prints the `docker run` command for an exchange.
- `README.md` -- the user-facing runbook the script's errors point into.
- `smb-probe.sh` -- the container-side diagnostic, embedded in the script;
  here separately for reference.

## State

Verified against a real Samba server: the SMB diagnostic and its error
classification (`NT_STATUS_LOGON_FAILURE`, `ACCESS_DENIED`, `BAD_NETWORK_NAME`,
`OBJECT_NAME_NOT_FOUND`, read-only write failure), and CIFS volume creation
with write-and-rename end to end.

Verified on Windows 11 under Windows PowerShell 5.1, which is what users
actually run: the script parses, `Resolve-DropPath` classifies drive-letter,
UNC, malformed, and absent-drive paths correctly, and a full run against a
Samba server on the Docker bridge passes every step, creates the CIFS volume,
and mounts it -- confirmed by writing through the volume and reading the file
on the server. A wrong password exits 4 with the right classification.
`Resolve-MappedDrive` is verified against a real Windows drive mapping: all
three of its lookup methods (`Get-PSDrive`, `Win32_NetworkConnection`, and
parsing `net use`) return the UNC root, and `Resolve-DropPath` splits it into
server, share, and subdirectory through the mapped letter. The mapping was
served over WebDAV rather than SMB, because Windows' own file-sharing service
holds port 445 and the SMB redirector will not use any other port. The
function reads mapping metadata and has no SMB-specific logic, so this
exercises it as written, but it does leave SMB-specific mapping behavior
untouched.

One Windows behavior remains unverified: `Resolve-RealServer` against a
genuine DFS namespace. Its handling of the readable-but-no-match and
unreadable cases is covered by driving the function with stubbed connection
sets, and `Get-SmbConnection` is confirmed to return cleanly when elevated and
to fail with "Access is denied" when not. What is not confirmed is the premise
the function rests on: that `Get-SmbConnection` names the real target server.

There is reason to doubt it. The script parses `\\namespace\dfs\link` into
share `dfs`, and the function then matches connections on that share name.
Following a referral, Windows holds a connection to the namespace root, whose
share name is `dfs`, as well as one to the target, whose share name is the
target's own. Matching on `dfs` should therefore return the namespace server
itself, leave `Server` equal to the name already in hand, and apply no
correction -- making the function a no-op on the very case it exists for. That
is read off the DFS protocol, not measured, so treat it as the first thing to
test rather than as a finding.

If it holds, the repair is not a better heuristic over the connection list.
The client-side question "which server backs this DFS path" is answered by
`NetDfsGetClientInfo` (what `dfsutil /pktinfo` reports), and the honest
alternative to calling it is to drop the automatic resolution and send every
DFS user to the manual route the runbook documents.

`Get-SmbConnection` requires Administrator rights, so an ordinary run cannot
resolve a DFS path at all. The script says so and points at the runbook's
manual route rather than guessing. Keep it that way: an unrelated SMB
connection -- a mapped home drive, a print server -- is not evidence about
this share, and naming one as the file server sends the user somewhere
unrelated to their file drop with no sign anything went wrong.

## If you pick this up

Settling `Resolve-RealServer` needs a domain-joined machine with a DFS
namespace and an elevated PowerShell session, since `Get-SmbConnection` is
readable only to an Administrator.

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

- **The share and the volume.** Run a Samba container on the Docker bridge,
  read its address from `docker inspect`, and pass it with `-Server` and
  `-Share`. Container-to-container traffic on the bridge sidesteps the port
  445 problem entirely. The image used here sets `force user`, so the
  exported directory has to be owned by that user or every write returns
  `ACCESS_DENIED` -- which reads exactly like a genuine permissions finding.
- **A mapped drive letter.** Windows holds port 445 for its own file sharing,
  so a container cannot serve SMB to the host without stopping that service.
  WebDAV needs no privileged port: run Apache with `mod_dav` (DAV class 2, so
  `LOCK` works and Windows will accept it), publish it on any port, and map
  with `net use Z: \\127.0.0.1@8080\Exchange`. The WebClient service must be
  running.
- **Driving the script unattended.** `Read-Host` reads the console rather
  than the pipeline, so a scripted run needs a `Read-Host` shim defined in the
  calling scope; the script has no `-Password` or `-Credential` parameter.

## Before running it

The script creates a Docker volume named `psilink-rendezvous` and deletes any
existing volume of that name first; `-VolumeName` overrides it. Docker stores
the share password in cleartext in the volume metadata, so prefer a scoped or
throwaway account and `docker volume rm psilink-rendezvous` when finished.
