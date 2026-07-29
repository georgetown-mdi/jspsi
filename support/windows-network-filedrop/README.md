# Using a network file drop with psilink on Windows

Your file-drop folder lives on a network location -- you open it in File
Explorer as a mapped drive (`Z:\Exchange`) or a network path
(`\\fileserver\exchange`). Passing that path to Docker does not work:

```text
docker: Error response from daemon: invalid mount config for type "bind":
bind source path does not exist
```

This is not a typo or a permissions problem. The Docker engine runs inside a
Linux virtual machine, and that VM cannot see mapped drive letters or network
paths at all. A drive letter is a per-user mapping belonging to your Windows
sign-in session; a `\\server\share` path is not a filesystem path in the VM.
Adding the path under Docker Desktop's Settings > Resources > File sharing does
not help either -- that list is only for local drives.

The fix is to let Docker mount the network folder itself, as a named volume.
`Setup-PsilinkFileDrop.ps1` works out what that takes and does it.

Every command on this page is PowerShell. Open the Start menu, type
`PowerShell`, and press Enter -- **not** "as Administrator" (see
[Finding the real server by hand](#finding-the-real-server-by-hand) for why).

## Before you start

You need four things in front of you:

- **Docker Desktop, running.** The whale icon in the notification area should
  be still, not animating.
- **The file-drop folder path**, copied from the File Explorer address bar.
- **A username and password** the container can use to reach that folder. This
  is not necessarily your own Windows sign-in -- see
  [What this does with your password](#what-this-does-with-your-password), and
  read it before you type one, not after.
- **A local folder on this PC** holding the CSV you want to match. Results are
  written back into it. It must be a real local folder -- `C:\psilink\work` is
  fine -- not the network drop folder and not a network path.

## The quick way

Download the script and run it:

```powershell
Invoke-WebRequest -UseBasicParsing `
  -Uri 'https://raw.githubusercontent.com/georgetown-mdi/jspsi/main/support/windows-network-filedrop/Setup-PsilinkFileDrop.ps1' `
  -OutFile "$env:USERPROFILE\Setup-PsilinkFileDrop.ps1"

powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\Setup-PsilinkFileDrop.ps1"
```

Downloading it this way rather than through a browser avoids two things that
catch people out: a browser renders the script as text and often saves it as
`.txt`, and a file saved from a browser is marked as coming from the internet
and refused until you run `Unblock-File` on it.

The script asks for the folder as you see it in Explorer and your network
credentials, works out the server, share and subfolder, shows them to you for
confirmation, tests everything from inside a container, creates the volume, and
prints the command to run your exchange.

Run it once, before your first exchange. The volume it creates survives
reboots; you only need to run it again if the password changes.

> **How far this has been tested.** The checks that run inside the container,
> and the volume once it is created, are verified against a real SMB server:
> the failures they report, and the share behaviour psilink depends on. The
> Windows side is verified on Windows 11 under Windows PowerShell 5.1 against
> the same kind of server, apart from one message added since that run. It has
> never been tried against a real DFS namespace, which is why the script asks
> you to confirm the server it worked out rather than trusting it. Corrections
> from a real environment are welcome and are worth more here than anywhere
> else in this repository.

To send the whole run to whoever is helping you:

```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\Setup-PsilinkFileDrop.ps1" 6>&1 |
  Tee-Object "$env:USERPROFILE\psilink-setup-log.txt"
```

The `6>&1` is not decoration. The script writes to the information stream, so a
plain `> log.txt` produces an empty file.

## What to ask your IT department for

Several of the dead ends below end at a ticket. This is what to put in it --
edit the bracketed parts and paste the rest:

```text
Subject: SMB share access for a container on my workstation

I need to run a record-linkage tool (psilink, https://github.com/georgetown-mdi/jspsi)
in Docker Desktop on my workstation [MACHINE NAME]. It exchanges files with
[PARTNER ORGANISATION] through the shared folder:

    [\\server\share\folder as it appears in File Explorer]

The tool runs inside a Linux container, which reaches the file server as a
separate machine on the network. It is not domain-joined and holds no Kerberos
ticket, so it can only authenticate with a username and password over NTLM.

Please could you provide:

1. A service account that can reach that folder with a username and password
   (not Kerberos/single sign-on only), scoped to this share if possible. The
   password must not contain a comma.
2. Read, write, rename and delete rights on that folder specifically -- not
   only on the share above it. The tool creates a file, renames it into place,
   and deletes it once the other side has read it.
3. Confirmation that the folder is reachable on TCP port 445 from my
   workstation's Docker network, which is a different source address than my
   Windows session. [If you use a VPN, say so here.]
4. The real server name and share, if the path above is a DFS namespace.
5. If none of that is possible -- the container cannot reach the server from
   its own address, or the account can only sign in with single sign-on -- then
   a scheduled mirror between that shared folder and a local folder on my
   workstation would work instead, and I would point the tool at the local
   copy. Deletions need to propagate in both directions.

The account will be used only for this exchange and can be retired afterwards.
```

## When it does not work

The script numbers its own progress as **part 1** to **part 4**, and the checks
it runs inside the container as **step 1** to **step 6**. The headings below
say which.

### The container cannot resolve the name

Step 1 fails.

The Docker VM runs its own resolver. It does not inherit Windows' DNS suffix
search list and has no NetBIOS name resolution, so a short server name that
works perfectly in File Explorer often means nothing inside the VM.

Find the full name on Windows and pass it directly:

```powershell
Resolve-DnsName fileserver
.\Setup-PsilinkFileDrop.ps1 -Server fileserver.agency.gov -Share exchange -SubPath dropbox
```

An IP address works too, and is the right answer when there is no DNS entry at
all. If the address might change, ask IT for a stable name.

### The container cannot reach the server

Step 2 fails, or you see a timeout rather than a permission error.

The Docker VM reaches the network through Docker's own address translation, so
as far as the file server is concerned it is a different machine than Windows.
Three things commonly block it while File Explorer keeps working:

- **A split-tunnel VPN.** The VPN routes the Windows side only; the VM's
  traffic goes out the normal interface and never reaches the server. This is
  the most common cause by far.
- **A host firewall rule** scoped to specific processes or interfaces.
- **A server-side address restriction** that does not cover the VM.

If you are on a VPN, that is almost certainly it. Take items 3 and 5 of the
[IT request](#what-to-ask-your-it-department-for) to whoever runs the network.

### The container cannot install its tools

The checks stop before step 3 saying `samba-client` could not be installed, and
print what the package manager said.

Read that message -- it names the cause precisely, which is why the script
shows it rather than summarising:

- **`certificate`, `TLS`, or `not trusted`.** Something is intercepting HTTPS,
  which on a corporate network is a proxy doing inspection. Docker Desktop
  needs its certificate: Settings > Resources > Proxies.
- **`DNS`, `temporary error`, or `could not resolve`.** Name resolution inside
  the VM. Same ground as the section above.

### No password exists

The share opens in Explorer without ever prompting you, and the checks report
`NT_STATUS_LOGON_FAILURE` or `NT_STATUS_NOT_SUPPORTED`.

Windows is signing you in silently with your domain identity over Kerberos. You
never had a password for this share as such. The Docker VM is not domain-joined
and holds no Kerberos ticket, so it must fall back to username and password --
and if your organization has disabled NTLM, which is common, no password will
work.

**Do not work through passwords one at a time.** Each attempt is a real failed
sign-in against the account, and a handful of them will lock it out -- adding a
second problem on top of the one you have.

Three options:

- Ask IT for a **service account** with a real password that can reach the
  share. This is the cleanest fix and usually the fastest to get; it is item 1
  of the [IT request](#what-to-ask-your-it-department-for).
- If no account can be made to work, ask for the scheduled mirror instead --
  item 5 of the [IT request](#what-to-ask-your-it-department-for).
- Kerberos from the container is possible in principle but needs a keytab
  inside the VM. It is not worth the effort here.

### Credentials correct, still denied

The checks report `NT_STATUS_ACCESS_DENIED` rather than
`NT_STATUS_LOGON_FAILURE`. The difference matters: your credentials were
accepted and then authorization was refused.

- The account may lack rights when connecting from a machine that is not
  domain-joined.
- Conditional access or device-based policy may require a managed device; the
  VM is not one.
- The share ACL may grant access to your **computer** account rather than your
  user account.

Ask whoever administers the share to grant the account access from an unmanaged
client, or to provide a service account.

Note that a refusal at the **share root** alone is not a problem. Being granted
rights to your own folder and nothing above it is the ordinary shape of an
agency grant, and the script says so and carries on.

### Access to the share but not the folder

`NT_STATUS_ACCESS_DENIED` at step 5, after step 4 succeeded. Access to a share
does not imply access to every folder inside it. Ask for rights on the
file-drop folder specifically -- item 2 of the
[IT request](#what-to-ask-your-it-department-for).

### It mounts but psilink cannot write

Step 6 fails. The message says which of the three operations failed, and they
mean different things:

- **Could not create a file.** The account has read but not write access.
- **Created a file but could not rename it.** Create rights without the DELETE
  right, which a rename needs. psilink renames every message into place, so
  this stops an exchange even though the folder looks writable.
- **Created and renamed but could not delete.** psilink removes each message
  once the other side has read it. Without delete rights the folder fills up
  and a second exchange will not start. You can run with `--retain-files` on
  both sides, but the folder then has to be emptied by hand between exchanges.

Mount options such as `file_mode` and `dir_mode` cannot fix any of these. They
only change how permissions **look** inside the container; the server still
decides what is allowed.

### The volume will not mount, though the checks passed

`permission denied`, `mount error(112)`, `Host is down`, or
`Operation not supported` at part 4, after part 3 succeeded.

The volume mount and the checks negotiate the SMB dialect differently, and the
kernel doing the mount is stricter than the diagnostic client. Run again
pinning one:

```powershell
.\Setup-PsilinkFileDrop.ps1 -Dialect SMB3
```

and if that fails, `-Dialect SMB2`. `-Dialect NT1` is for diagnosis only: the
Docker VM's kernel is built without SMB1, so a server that speaks nothing newer
cannot be mounted at all. For a server like that, ask for the scheduled mirror
-- item 5 of the [IT request](#what-to-ask-your-it-department-for).

`Required key not available` is different -- it means the mount wanted a
Kerberos ticket. See [No password exists](#no-password-exists).

### The volume mounts a different folder than the checks tested

The script reports that a file it left in the folder is not visible through the
volume.

The checks reach the folder one way and the volume mounts it another, and
nothing else in the process compares them. When they disagree, the server,
share or subfolder is wrong somewhere -- most often because the path is a DFS
namespace, where the real location can differ in all three parts at once.

Read the real path by hand, below, and pass it with `-Server`, `-Share` and
`-SubPath`.

### A comma in the password

The script refuses before it does anything.

Docker separates mount options with commas, so a password containing one is cut
off at the first comma and the mount fails. There is no way to quote or escape
it: the local volume driver takes the credentials only as a single
comma-separated string. Doing it by hand hits exactly the same wall.

Use an account whose password has no comma -- it is item 1 of the
[IT request](#what-to-ask-your-it-department-for).

### The script will not run at all

If PowerShell refuses to run the file, `-ExecutionPolicy Bypass` (as in
[The quick way](#the-quick-way)) covers the ordinary case, and `Unblock-File`
covers a file saved through a browser.

Neither helps if the refusal comes from **Group Policy**, which is likely on an
agency machine. Check with:

```powershell
Get-ExecutionPolicy -List
```

If the `MachinePolicy` or `UserPolicy` row is anything other than `Undefined`,
it wins over everything else and you cannot override it locally. The same is
true if the script reports that PowerShell is in ConstrainedLanguage mode,
which application-control policy (WDAC or AppLocker) imposes.

In either case, use [Doing it by hand](#doing-it-by-hand) below, which is
ordinary commands rather than a script.

### Status codes

| Status | Meaning |
| --- | --- |
| `NT_STATUS_LOGON_FAILURE` | Username, password, or domain genuinely wrong |
| `NT_STATUS_ACCESS_DENIED` | Credentials accepted, authorization refused |
| `NT_STATUS_ACCOUNT_LOCKED_OUT` | Locked out, probably by earlier retries |
| `NT_STATUS_PASSWORD_EXPIRED` | Password expired |
| `NT_STATUS_NOT_SUPPORTED` | Auth method refused; NTLM likely disabled |
| `NT_STATUS_BAD_NETWORK_NAME` | Share name wrong |
| `NT_STATUS_OBJECT_NAME_NOT_FOUND` | Folder inside the share does not exist |
| `NT_STATUS_NOT_A_DIRECTORY` | The path names a file, not a folder |
| `NT_STATUS_PATH_NOT_COVERED` | A DFS link; find the real server, below |

If your code is not in the table, the script printed the server's own message
above it. That text, plus what you were doing, is what to put in a ticket.

## Finding the real server by hand

The path you see is not always the path that exists. A drive letter hides the
server behind it, and a DFS path names a *namespace* rather than a machine --
the real server, the real share, and the folder within it can all be different.
The script asks you to confirm the three values it worked out precisely because
this is the step it cannot verify for you.

Windows will tell you:

1. Open the file-drop folder in File Explorer.
2. Right-click it and choose **Properties**.
3. If there is a **DFS** tab, open it. The **Referral list** shows the real
   path, something like `\\fs-04.agency.gov\exchange$\dropbox`.
4. If there is no DFS tab and it is a mapped drive, run `net use` and read the
   **Remote** column for that letter.

Then split that path into its three parts and pass them directly:

```powershell
.\Setup-PsilinkFileDrop.ps1 -Server fs-04.agency.gov -Share 'exchange$' -SubPath dropbox
```

`\\fs-04.agency.gov\exchange$\dropbox` splits into server `fs-04.agency.gov`,
share `exchange$` (the **first** path component only), and subfolder `dropbox`
(everything after it). Quote the share if it contains a `$`, as most
administrative shares do.

**Do not run PowerShell as Administrator to work around this.** An elevated
session has its own drive table and cannot see the drives you mapped as
yourself, so elevating makes a `Z:\...` path stop resolving entirely. Reading
the path from Properties, as above, is the method that works.

## Doing it by hand

If the script cannot run -- policy, ConstrainedLanguage mode, or you would
rather see each step -- this is what it does. You need the real server, share
and subfolder from the section above.

```powershell
docker volume create --driver local `
  --opt type=cifs `
  --opt 'device=//fs-04.agency.gov/exchange$/dropbox' `
  --opt 'o=username=USER,password=PASS,domain=AGENCY' `
  psilink-rendezvous
```

Note the forward slashes in `device`, and that `\\fs-04\exchange$\dropbox`
becomes `//fs-04/exchange$/dropbox`. Keep the single quotes: without them
PowerShell expands `$/dropbox` as a variable and the path silently changes, and
a `$` in the password does the same to the credentials -- producing a login
failure that looks exactly like a wrong password.

Check that it mounts and that the folder is the one you meant:

```powershell
docker run --rm -v 'psilink-rendezvous:/rz' alpine:3.22 ls -la /rz
```

Then run the exchange:

```powershell
docker run --rm `
  -v 'C:\path\to\your\work:/work' `
  -v 'psilink-rendezvous:/rendezvous' `
  vdorie/psi-link:latest `
  file:///rendezvous input.csv matches.csv
```

`C:\path\to\your\work` must be a **local** folder on your PC holding your input
CSV; the results are written back there. `input.csv` and `matches.csv` are
named relative to it. The `file://` URL needs three slashes.

This route puts the password on a command line, where it is recorded in your
PowerShell history file as well as everywhere described below. Clear it
afterwards, or use the script.

## Running the exchange

A few things about psilink itself that the setup script cannot check for you.

**The keys file is not a result.** Each run writes a
`psilink-record-<timestamp>.keys.json` into your work folder alongside
the matches. It holds the keys to the exchange. Treat it like the input data:
do not send it on with the results, and do not leave it in a folder that syncs
somewhere.

**One exchange per folder, and it must start clean.** psilink refuses to run in
a drop folder that still holds files from a previous exchange -- the check is
deliberate, because a leftover message would corrupt or stall the run. Agree
with your partner who goes when.

If a run fails and leaves the folder dirty -- which the `--lockless-rendezvous`
mismatch below reliably does, since both sides write a greeting file before
either discovers the disagreement -- the next attempt will be refused on both
sides until the folder is cleared. Emptying it in File Explorer is the simplest
fix and the one to reach for first.

There is also a flag that clears it, but **only one of you may use it**, and
that side must start first. It deletes every psilink file in the folder,
including the greeting the other side has just written, so if you both pass it
you will delete each other's greeting and both runs will sit waiting for a
partner who is no longer there. Agree who goes first; that person runs:

```powershell
docker run --rm `
  -v 'C:\path\to\your\work:/work' `
  -v 'psilink-rendezvous:/rendezvous' `
  vdorie/psi-link:latest `
  file:///rendezvous input.csv matches.csv --sweep-exchange-files
```

The other side waits until that run has started, then uses the ordinary command
without the flag.

**A big or busy folder will be refused.** psilink will not read a rendezvous
directory holding more than 8192 entries, or one containing a filename longer
than 255 characters. A folder dedicated to the exchange never comes close; a
general-purpose share repurposed for it can. Use a subfolder of your own.

**Setting up a second file drop replaces the first.** The volume name is
`psilink-rendezvous` unless you say otherwise, so running the script again for
a different partner overwrites the first one's settings. Give each its own:

```powershell
.\Setup-PsilinkFileDrop.ps1 -VolumeName psilink-partner-b
```

and pass that name to `-v` when you run that exchange.

## Synced folders

Some file drops are not live file servers at all: a sync client (OneDrive,
Dropbox, Egnyte, ShareFile) keeps a local copy on each side in step. If that
describes yours, three things change.

First, you may not need a volume at all -- point Docker at the local synced
folder, which it can bind-mount directly:

```powershell
docker run --rm `
  -v 'C:\path\to\your\work:/work' `
  -v 'C:\Users\you\Egnyte\exchange:/rendezvous' `
  vdorie/psi-link:latest `
  file:///rendezvous input.csv matches.csv --lockless-rendezvous
```

Second, `--lockless-rendezvous` is not optional there and **both parties** must
pass it. A synced folder does not behave like a real filesystem: deletions take
time to propagate and both sides can create the same file at once, which breaks
psilink's default way of deciding who goes first. The setting is compared
between the two sides at the start of a run, and a mismatch fails immediately
with an error naming each side's value -- see above for clearing the folder
afterwards.

The setup script tests for this directly when it creates a volume, and tells
you if the share needs it. If you are bind-mounting a synced folder instead,
assume you need it.

Third, if your sync client never propagates deletions -- some do not, by design
or by policy -- `--lockless-rendezvous` alone is not enough, because psilink
still deletes each message once it has been read. Both sides need
`--retain-files` as well, which keeps every file and marks it as consumed
instead. That folder then has to be emptied between exchanges.

A sync round trip also makes every message slower. If runs time out waiting for
the other side, raise the limits on both sides. psilink already waits an hour
for a partner, so raise it past that, and check less often than the default of
every five seconds -- for example `--polling-frequency 30s --peer-timeout 4h`.

Confirm with your exchange partner which kind of folder you are sharing before
the first run.

## What this does with your password

The setup script passes the password to its checks through an environment
variable, so it never reaches a command line there. Creating the volume is
different: Docker's CIFS volume driver accepts credentials only as a mount
option, and that is a command-line argument. There is no way around it, so it
is worth knowing exactly where the password ends up.

- **On a command line, once.** While the volume is created. On a managed
  workstation, command-line auditing (Windows event 4688, Sysmon, or your EDR
  agent) records that durably, and usually forwards it to a central log. That
  is a wider boundary than "Docker on this PC" -- the password may leave the
  machine and be retained by people you will never speak to.
- **In the volume metadata, in cleartext.** `docker volume inspect
  psilink-rendezvous` shows it to anyone who can run Docker here.
- **In your PowerShell history**, if you used
  [Doing it by hand](#doing-it-by-hand). The file is at
  `$env:APPDATA\Microsoft\Windows\PowerShell\PSReadLine\ConsoleHost_history.txt`.
- **After `docker volume rm`,** still in Docker's volume metadata database as a
  freed record. That file lives inside the Docker Desktop virtual disk, which
  endpoint backup and imaging tooling copies wholesale -- so it is the one
  residue that can leave the machine without anyone running Docker.

None of that is introduced by psilink; it is how Docker CIFS volumes work. What
you control is **which account** you use. Use one scoped to the exchange share,
or one you are prepared to retire, and rotate it when the exchanges are done.
Do not use a domain administrator account, and do not use one whose password
protects anything else.

When you are finished:

```powershell
docker volume rm psilink-rendezvous
```

That removes the volume and its options file. Given the last point above, treat
rotating the password as the step that actually ends the exposure.
