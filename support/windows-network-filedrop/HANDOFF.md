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
Two Windows behaviors resist testing outside a domain and remain unverified:

- `Resolve-MappedDrive` against a genuine mapped drive. Only its negative
  cases are covered (a local disk and a letter that does not exist).
- `Resolve-RealServer` against a genuine DFS namespace. The premise that
  `Get-SmbConnection` reports the real target server is still an assumption;
  its handling of the readable-but-no-match and unreadable cases is covered by
  driving the function with stubbed connection sets.

`Get-SmbConnection` requires Administrator rights, so an ordinary run cannot
resolve a DFS path at all. The script says so and points at the runbook's
manual route rather than guessing. Keep it that way: an unrelated SMB
connection -- a mapped home drive, a print server -- is not evidence about
this share, and naming one as the file server sends the user somewhere
unrelated to their file drop with no sign anything went wrong.

## If you pick this up

Getting a Windows test environment is the open problem. What a run needs, in
descending order of value: a domain-joined machine with a DFS namespace (the
only way to settle `Resolve-RealServer`), an elevated PowerShell session (to
see `Get-SmbConnection` work at all), and any real mapped drive (settles
`Resolve-MappedDrive`).

A local rig covers everything else. Run a Samba container on the Docker
bridge, read its address from `docker inspect`, and pass it with `-Server` and
`-Share`; the image used here sets `force user`, so the exported directory has
to be owned by that user or every write returns `ACCESS_DENIED`. `Read-Host`
reads the console rather than the pipeline, so an unattended run needs a
`Read-Host` shim defined in the calling scope -- the script has no `-Password`
or `-Credential` parameter.

## Before running it

The script creates a Docker volume named `psilink-rendezvous` and deletes any
existing volume of that name first; `-VolumeName` overrides it. Docker stores
the share password in cleartext in the volume metadata, so prefer a scoped or
throwaway account and `docker volume rm psilink-rendezvous` when finished.
