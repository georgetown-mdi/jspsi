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
- `FILEDROP_WINDOWS.md` -- the user-facing runbook the script's errors point
  into.
- `smb-probe.sh` -- the container-side diagnostic, embedded in the script;
  here separately for reference.

## State

Written and tested on macOS, so the container-side half is verified and the
Windows half is not.

Verified against a real Samba server: the SMB diagnostic and its error
classification (`NT_STATUS_LOGON_FAILURE`, `ACCESS_DENIED`, `BAD_NETWORK_NAME`,
`OBJECT_NAME_NOT_FOUND`, read-only write failure), and CIFS volume creation
with write-and-rename end to end. The script parses under PowerShell 7.

Unverified: everything touching Windows -- `Resolve-MappedDrive`,
`Resolve-RealServer`, `Resolve-DropPath`, and the script under Windows
PowerShell 5.1, which is what users will actually run. The shakiest assumption
is that `Get-SmbConnection` reports the real target server for a DFS namespace
path rather than the namespace name. If it does not, that resolution needs
replacing and the manual right-click route in the runbook becomes primary.

## Before running it

The script creates a Docker volume named `psilink-rendezvous` and deletes any
existing volume of that name first; `-VolumeName` overrides it. Docker stores
the share password in cleartext in the volume metadata, so prefer a scoped or
throwaway account and `docker volume rm psilink-rendezvous` when finished.
