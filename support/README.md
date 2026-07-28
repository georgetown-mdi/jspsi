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
| A file drop that a sync service keeps in step, rather than a live file server | [windows-network-filedrop](windows-network-filedrop/README.md#synced-folders) |

## Each guide

A guide is a self-contained folder: the instructions plus whatever scripts go
with them, so it can be handed to someone as a unit. Each opens with a status
note saying what has been confirmed and where, because these age with the
platforms they describe rather than with this repository.

- [windows-network-filedrop](windows-network-filedrop/README.md) -- using a
  file drop that lives on a Windows network location (mapped drive, UNC path,
  or DFS namespace) with the psilink container.

## Contributing a guide

If you work through one of these and something is wrong or has changed, say so
-- a correction from a real environment is worth more here than anywhere else
in the repository. The same applies if you solve an environment problem that is
not covered: a new folder with what you ran and what it printed is a useful
guide even before anyone polishes it.
