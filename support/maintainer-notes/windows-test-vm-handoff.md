# Handoff: a Windows test VM on the Proxmox cluster

What a Windows virtual machine on the maintainer's Proxmox x86 cluster has to
provide before either piece of work below can run on it. Provisioning the
machine is the cluster agent's work, outside this repository; this document is
the psilink half of it -- the requirements, each one attributed to the work that
needs it, so the list can be cut down rather than guessed at.

A second handoff for the same cluster stands up an Amazon Linux VM to check the
standalone broker's systemd unit. One host session can do both, and neither
depends on the other.

## The two pieces of work this VM serves

Every requirement below names which of these needs it: **the file-drop pass**,
**the CLI leg**, or **both**.

**The file-drop pass** is a guided run of the Windows file-drop scripts in
[`support/windows-network-filedrop`](../windows-network-filedrop/README.md)
against a real network share:
[`Setup-PsilinkFileDrop.ps1`](../windows-network-filedrop/Setup-PsilinkFileDrop.ps1)
through its four parts -- locating the file drop, credentials, testing the share
from inside a container, creating the Docker volume -- and
[`Start-Psilink.ps1`](../windows-network-filedrop/Start-Psilink.ps1) through the
same ground plus starting the console. It covers both of the launcher's flows:
one folder shared with the partner, and the split pair of an inbound and an
outbound folder, including the single volume mounted over the folder that holds
a pair and the two volumes a pair on separate shares takes.

What that pass measures and no CI leg does is in the
[State section](windows-network-filedrop.md#state) of the PowerShell notes: a
CIFS volume pinned to `uid=1000,gid=1000` against a server that serves no Unix
extensions, written to by the published image's unprivileged account. A share
the tester created on the test machine reaches none of it -- the path
resolution, the share credential and the mount's ownership mapping are the
subject -- which is why the share below sits on another machine.

**The CLI leg** is the nightly Windows job in
[`nightly_platform.yaml`](../../.github/workflows/nightly_platform.yaml) ("CLI
unit tests (Windows)"), run on the VM instead of one workflow dispatch per
iteration. The job is a checkout, the shared prologue in
[`.github/actions/setup`](../../.github/actions/setup/action.yml), and
`npm test -w apps/cli`. On a Windows runner that prologue restores no cache --
its cache steps are Linux-only -- so the VM reproduces the job in full with:

```
git clone --branch staging https://github.com/georgetown-mdi/jspsi
npm ci
npm run build -w packages/core
npm test -w apps/cli
```

The Windows-gated tests are the reason the leg exists: the owner-only ACL
describe in `apps/cli/test/unit/fileUtils.test.ts` and the Windows-path refusal
in `apps/cli/test/unit/signingIdentityFile.test.ts` execute on this platform and
skip everywhere else. The same machine can run the manual procedure those
automate,
[Verifying Windows owner-only file protections](../../docs/TESTING.md#verifying-windows-owner-only-file-protections).

## The virtual machine

The figures here are what psilink needs. Where a vendor states its own minimum
-- the Windows 11 installer's firmware requirements, the feature split between
Windows editions, the host requirements and backend Docker Desktop asks for --
the cluster agent checks that vendor's documentation; this repository measures
none of it.

- **Windows 11 Pro, x64, 24H2 or later.** Both. Pro rather than Home: hosting a
  Remote Desktop session is a Pro feature, and the pass needs the interactive
  session described under access below. A Windows Server edition is not a
  substitute -- Docker Desktop's supported hosts are the desktop editions -- and
  the recorded pass this one follows ran on Windows 11 with Docker Desktop
  28.3.2.
- **4 vCPU, CPU type `host`, nested virtualization enabled.** Both. Docker
  Desktop runs its own hypervisor inside the guest and does not start without
  it; the install and the core build are the CPU-bound steps of the CLI leg.
- **8 GB RAM, 16 GB if the cluster has it.** Both. Docker Desktop's Linux VM
  takes a fixed share of the machine's memory, and the `@psilink/core` build is
  the largest single demand in the CLI leg.
- **120 GB thin-provisioned disk.** Both. Windows 11 asks 64 GB for itself,
  then the WSL2 disk image, the psilink image (a 575 MB pull), the checkout, and
  its installed dependency tree (543 MB in this repository's dev container).
- **UEFI firmware (OVMF) with an EFI disk, a TPM 2.0 state device, and Secure
  Boot.** Both. The Windows 11 installer requires them.
- **virtio-scsi disk and virtio network device, with the virtio-win driver ISO
  attached for the install**, or SATA and e1000 where that is quicker to stand
  up. Both.
- **The LAN bridge, with the address recorded.** Both. The machine needs a route
  to the file server below (the file-drop pass) and outbound access to Docker
  Hub, the npm registry, nodejs.org and github.com (both).
- **No `onboot`; leave the VM stopped when it is idle**, as the cluster's other
  test guests are. Note the VM id in the report.

## Software to install

The agent may install everything on this list and whatever it depends on, plus
Windows updates and the Proxmox guest agent. It needs local Administrator
rights on the VM: the Docker Desktop install, the OpenSSH Server feature and
`Get-SmbConnection` all ask for them -- the last reads nothing unelevated. It
does not need to join the machine to a domain.

- **Docker Desktop for Windows**, running, with its WSL2 backend, able to pull
  `docker.io/vdorie/psi-link`. File-drop pass. Whether Docker Desktop's licence
  terms cover this use on the maintainer's cluster is the maintainer's call and
  is not decided here.
- **Windows PowerShell 5.1**, which Windows 11 includes. File-drop pass. Both
  scripts are written for it rather than for PowerShell 7: the SMB, Server
  Manager and DFS modules they use are native there, which is also why the CI
  suite drives them as `powershell -NoProfile -ExecutionPolicy Bypass -File`
  (see
  [`windows_resolution.yaml`](../../.github/workflows/windows_resolution.yaml)).
  Installing PowerShell 7 beside it is harmless and is not a substitute.
- **Git for Windows**, default settings. Both. `.gitattributes` pins the line
  endings of the files that cannot take a conversion, so the default
  `core.autocrlf=true` is correct here. Its Git Bash also serves the prologue's
  shell steps.
- **Node 26.** CLI leg. The repository pins the major in
  [`.nvmrc`](../../.nvmrc) and in the root `package.json` `engines` field
  (`>=26`), and the CI prologue installs `26`. The Windows MSI or nvm-windows,
  either one.
- **The GitHub CLI, authenticated**, only if the agent wants the prologue's
  vendored-prebuild provenance step as well. CLI leg, optional: that step runs
  `gh attestation verify` against api.github.com, and `npm test -w apps/cli`
  does not depend on it.
- **A C++ toolchain, only on demand.** CLI leg. `cpu-features` is an optional
  dependency with a build step, so an install without a toolchain is expected to
  skip it. If `npm ci` fails there, install the Visual Studio Build Tools
  "Desktop development with C++" workload and Python 3 rather than reading the
  failure as a psilink defect.
- **A browser.** File-drop pass. The launcher opens the console in the default
  one; the Edge that ships with Windows 11 is enough.

## The launcher copy the pass runs

`Start-Psilink.ps1` refuses to run unless its digest line names an image, so
that an operator's copy cannot run whatever a floating tag points at today; the
release workflow fills that line in, and a copy from a checkout holds the
placeholder (see
[Stamped launchers](../../docs/RELEASES.md#stamped-launchers)). The pass
therefore runs one of two copies, and the report says which:

- the release assets `Start-Psilink.ps1` and `Setup-PsilinkFileDrop.ps1`, kept
  side by side -- the launcher dot-sources the setup script -- where a release
  includes the flows under test; or
- the `staging` copies with the digest line filled in by hand with the digest of
  the image the machine pulled, which is what a flow that has not reached a
  release needs.

`Setup-PsilinkFileDrop.ps1` is unstamped either way and runs from a checkout as
it stands.

## The share (file-drop pass)

The share is served by a machine other than the VM. A second guest on the
cluster or an existing file server both qualify; a folder shared out by the test
machine itself does not, for the reason the State section gives.

- **A native Windows SMB server, by preference.** The ownership mapping under
  test exists for servers that serve no CIFS Unix extensions, which is
  every native Windows SMB server. A Samba server can be configured to serve
  those extensions and then hides the case the mount options exist for, so
  Samba with the Unix extensions switched off is the fallback, and using it is a
  deviation the report states.
- **A share account, not the VM's own login.** A local account on the file
  server, granted write access to the exchange folder, with a password holding
  the punctuation that Command Prompt and PowerShell are known to mangle -- the
  recorded pass used `Pa!ss&w%rd^1`. Record the account and password where the
  maintainer can read them. Test folders and test data only: no real exchange
  data goes on this machine.
- **The folders, created before the pass starts.** One exchange folder for the
  single-folder flow; inside it, two sibling folders (an inbound and an
  outbound) for the split pair, which is the layout the guide asks operators to
  keep. A second share on the same server, holding one leg of a pair, for the
  two-volume case.
- **A mapped drive letter on the VM**, persistent, pointing at the share (`net
  use Z: \\server\share`), so the pass can drive the script's drive-letter
  resolution. The VM cannot serve that to itself: Windows holds port 445 for its
  own file sharing, and stopping the Server service does not free it.
- **No DFS namespace.** The namespace role exists only on the Windows Server
  product types, and a domain namespace needs a domain, so this VM is not the
  machine for that question; CI covers the standalone-namespace resolution
  instead. The remaining DFS question and what it needs are under
  [If you pick this up](windows-network-filedrop.md#if-you-pick-this-up).

## How the maintainer's agent reaches the VM

- **The Proxmox console (noVNC or SPICE).** Both. It needs nothing installed in
  the guest, which makes it the route for the Windows install itself and for a
  machine the network cannot reach.
- **RDP over the LAN, into an interactive desktop session.** File-drop pass.
  The scripts' prompts read the console rather than the pipeline, so a piped or
  redirected run never answers them, and the launcher's folder picker opens only
  in a session with a desktop. The recorded pass worked around the first of
  those with a `Read-Host` shim, which left the real console reads -- the masked
  password entry among them -- unexercised; a desktop session is what closes
  that. Enable Remote Desktop and put the account in Remote Desktop Users.
- **OpenSSH Server**, the Windows optional feature, with key authentication for
  the maintainer's key and the default shell set to PowerShell. CLI leg. The
  install, build and test commands are non-interactive and are cheaper to drive
  over a shell than through a desktop.

## What this VM does not cover

- A domain-joined machine with a real DFS namespace, per the share section.
- A managed endpoint's own policy -- the locked-down configuration a colleague
  or a pilot organisation runs. Arranging a run on such an endpoint stays a
  separate thing to do; this VM makes the pass possible without waiting for it.
- A two-party exchange across the share. The requirements above cover
  provisioning, the container checks and the mount checks; a run with a partner
  on the other end is a separate arrangement.

## What to report back

Enough for the pass to be recorded in these notes the way the earlier one is:
the VM id and address, the Windows build, the Docker Desktop, PowerShell, Node
and git versions, the file server and share names with the server's product and
SMB configuration, the share account, the mapped drive letter, the access routes
that were set up, and every deviation from the list above. Then stop the VM and
leave its disk in place, so the pass can be repeated.
