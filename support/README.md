# Support: getting psilink running in your environment

This area holds field guides for problems that sit *around* psilink rather than
in it -- your operating system, your Docker installation, your agency's network
and its policies. psilink is barely involved in most of them; the same
obstacles face anyone running a container against a corporate file server.

These pages are separate from [`docs/`](../docs/README.md) on purpose.
Documentation there describes the software and is kept honest by the test
suite. What is here describes the outside world -- Windows releases, Docker
Desktop behavior, DFS, VPN and authentication policy -- which no test of ours
can verify. These pages are written from field experience, may be provisional,
and each says how far it has actually been confirmed.

If you are choosing, evaluating, or operating psilink deliberately, start at
[`docs/`](../docs/README.md) instead. Come here when something will not start.

## Find your problem

| What you are seeing | Where to go |
| --- | --- |
| `bind source path does not exist` when mounting a network folder on Windows | [windows-network-filedrop](windows-network-filedrop/README.md) |
| Docker cannot use a mapped drive (`Z:\...`) or a network path (`\\server\share`) | [windows-network-filedrop](windows-network-filedrop/README.md) |
| `permission denied` creating or mounting a Docker CIFS/SMB volume | [windows-network-filedrop](windows-network-filedrop/README.md) |
| A file drop that a sync service keeps in step, rather than a live file server | [synced folders](windows-network-filedrop/troubleshooting.md#synced-folders) |
| A network folder the container reaches but cannot write, rename, or delete in | [the folder cannot be written to](windows-network-filedrop/troubleshooting.md#the-folder-cannot-be-written-to) |
| Nothing to send IT when a network problem turns out to be theirs | [what to ask IT for](windows-network-filedrop/troubleshooting.md#what-to-ask-your-it-department-for) |
| A Windows PC with no PowerShell, or with policy blocking it | [which version to run](windows-network-filedrop/README.md#which-version-to-run) |
| Deciding which account to give a Docker CIFS volume, and what happens to its password | [passwords](windows-network-filedrop/passwords.md) |

## Each guide

A guide is a self-contained folder: the instructions plus whatever scripts go
with them, so it can be handed to someone as a unit. Each says how far it has
actually been confirmed and where, because these age with the platforms they
describe rather than with this repository.

- [windows-network-filedrop](windows-network-filedrop/README.md) -- using a
  file drop that lives on a Windows network location (mapped drive, UNC path,
  or DFS namespace) with the psilink container. The folder holds a short setup
  page covering both the PowerShell and the Command Prompt script, a
  [troubleshooting page](windows-network-filedrop/troubleshooting.md) with a
  section per failure, an optional page on
  [choosing the account](windows-network-filedrop/passwords.md) whose password
  Docker will store, and the scripts themselves. The launchers that open the
  psilink console -- `Start-Psilink.ps1` and `start-psilink.sh` -- live here
  too, because the Windows one needs the setup script beside it; the macOS and
  Linux one is here to keep the pair together rather than because the folder's
  subject matter applies to it.

## Maintainer notes

[`maintainer-notes/`](maintainer-notes/) holds what a guide's maintainer needs
and its reader does not: which claims are measured and which are inferred, what
was attempted and failed, and why a given approach was chosen over another. It
is deliberately outside the guide folders, so that handing one over does not
hand over a working document addressed to someone else.

## Contributing a guide

If you work through one of these and something is wrong or has changed, say so
-- a correction from a real environment is worth more here than anywhere else
in the repository. The same applies if you solve an environment problem that is
not covered: a new folder with what you ran and what it printed is a useful
guide even before anyone polishes it.
