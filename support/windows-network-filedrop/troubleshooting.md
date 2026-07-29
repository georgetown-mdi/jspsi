# When the file-drop setup does not work

One section per thing that goes wrong, in the order you would meet it, and then
reference material: the status codes, the request to send IT, how to read the
real path from Windows, and how to do by hand what the script does for you.
Start from [the setup page](README.md) if you have not run the script yet.

The script prints a MEANING and an ACTION for every failure it can name. Follow
those first; this page is the longer version.

The script runs in four numbered parts, and the checks inside part 3 are
numbered separately, steps 1 to 6. A "step" on this page is always one of those
checks.

Commands here are PowerShell. If you are using
[the Command Prompt version](command-prompt.md), run
`cmd_Setup-PsilinkFileDrop.cmd` wherever one shows `.\Setup-PsilinkFileDrop.ps1`
-- the options are the same -- and `nslookup` wherever one shows
`Resolve-DnsName`. Only [Doing it by hand](#doing-it-by-hand) has no Command
Prompt equivalent, and it says so.

## The script will not run

The `-ExecutionPolicy Bypass` on [the setup page](README.md#get-it-and-run-it)
covers the ordinary refusal, and `Unblock-File` covers a file saved through a
browser.

Neither helps if the refusal comes from **Group Policy**, which is likely on an
agency machine. Check with:

```powershell
Get-ExecutionPolicy -List
```

If the `MachinePolicy` or `UserPolicy` row is anything other than `Undefined`,
it wins over everything else and you cannot override it locally. The same is
true if the script reports that PowerShell is in ConstrainedLanguage mode,
which application-control policy (WDAC or AppLocker) imposes.

In either case use [the Command Prompt version](command-prompt.md). Do not
reach for [Doing it by hand](#doing-it-by-hand) first: those are PowerShell
commands too, and they meet the same policy.

## A comma or a double quote in the password

The script refuses before it does anything.

Docker separates mount options with commas, so a password containing one is cut
off at the first comma and the mount fails. There is no way to quote or escape
it: the local volume driver takes the credentials only as a single
comma-separated string. Doing it by hand hits exactly the same wall.

[The Command Prompt version](command-prompt.md) refuses a double quote as well.
Docker takes the mount options as one quoted argument, and a quote inside the
password ends that argument early, so Docker creates an unnamed volume instead
of the one asked for.

Use an account whose password has neither -- it is item 1 of the
[IT request](#what-to-ask-your-it-department-for).

## The container cannot find the server

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

If the name has an `@` in it, or the first folder is `DavWWWRoot`, the drive is
SharePoint or another WebDAV site rather than a file share, and Docker cannot
mount it this way at all. See [Synced folders](#synced-folders).

## The container cannot reach the server

Step 2 fails, or the checks report that the connection stopped responding.

The Docker VM reaches the network through Docker's own address translation, so
the file server sees it as a different machine from Windows. Three things
commonly block it while File Explorer keeps working:

- **A split-tunnel VPN.** The VPN routes the Windows side only; the VM's
  traffic goes out the normal interface and never reaches the server. This is
  the most common cause by far.
- **A host firewall rule.** One scoped to specific processes or interfaces.
- **A server-side address restriction.** One that does not cover the VM.

If you are on a VPN, that is almost certainly it. Take items 3 and 5 of the
[IT request](#what-to-ask-your-it-department-for) to whoever runs the network.

## The container cannot install its tools

The checks stop before step 3 saying `samba-client` could not be installed, and
print what the package manager said.

Read that message; it names the cause:

- **`certificate`, `TLS`, or `not trusted`.** Something is intercepting HTTPS,
  which on a corporate network is a proxy doing inspection. Docker Desktop
  needs its certificate: Settings > Resources > Proxies.
- **`DNS`, `temporary error`, or `could not resolve`.** Name resolution inside
  the VM. Same ground as the section above.

## The share never asks for a password

The share opens in Explorer without ever prompting you, and the checks report
`NT_STATUS_LOGON_FAILURE` or `NT_STATUS_NOT_SUPPORTED`.

Windows is signing you in silently with your domain identity over Kerberos.
There was never a password for this share to begin with. The Docker VM is not
domain-joined
and holds no Kerberos ticket, so it must fall back to username and password --
and if your organization has disabled NTLM, which is common, no password will
work.

**Do not work through passwords one at a time.** Each attempt is a real failed
sign-in against the account, and a handful of them will lock it out -- adding a
second problem on top of the one you have.

Two options, and one dead end:

- Ask IT for a **service account** with a real password that can reach the
  share. This is the cleanest fix and usually the fastest to get; it is item 1
  of the [IT request](#what-to-ask-your-it-department-for).
- If no account can be made to work, ask for the scheduled mirror instead --
  item 5 of the [IT request](#what-to-ask-your-it-department-for).
- Kerberos from the container is possible in principle but needs a keytab
  inside the VM. It is not worth the effort here.

If a volume later fails to mount with `Required key not available`, that is the
same problem: the mount wanted a Kerberos ticket and the VM has none.

## The password works but access is refused

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

## The share opens but the folder does not

`NT_STATUS_ACCESS_DENIED` at step 5, after step 4 succeeded. Access to a share
does not imply access to every folder inside it. Ask for rights on the
file-drop folder specifically -- item 2 of the
[IT request](#what-to-ask-your-it-department-for).

## The folder cannot be written to

Step 6 fails, or the volume mounts and then refuses the write.

When step 6 is what failed, the message names which of the three operations
failed, and they mean different things:

- **Could not create a file.** The account has read but not write access.
- **Created a file but could not rename it.** Create rights without the delete
  right, which a rename needs. psilink renames every message into place, so
  this stops an exchange even though the folder looks writable.
- **Created and renamed but could not delete.** psilink removes each message
  once the other side has read it. Without delete rights the folder fills up
  and a second exchange will not start.

When the volume is what refused, the operation is not named: either the account
can open the folder but not create files in it, or the share is out of space.
Check the free space first, since that is the one you can see.

Either way, ask for full change rights on the folder -- item 2 of the
[IT request](#what-to-ask-your-it-department-for).

Mount options such as `file_mode` and `dir_mode` cannot fix any of these. They
only change how permissions **look** inside the container; the server still
decides what is allowed. Neither does `-Dialect`: if the share was reached, the
dialect is not what is refusing you.

## The volume will not mount

`permission denied`, `mount error(112)`, `Host is down`, or
`Operation not supported` at part 4, after part 3 passed.

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

## The volume opens the wrong folder

The script reports that a file it left in the folder is not visible through the
volume.

The checks reach the folder one way and the volume mounts it another. This is
the only step that compares the two. When they disagree, the server, share or
subfolder is wrong somewhere -- most often a DFS path.

[Read the real path from Windows](#reading-the-real-path-from-windows) and pass
it with `-Server`, `-Share` and `-SubPath`.

## Status codes

| Status | Meaning |
| --- | --- |
| `NT_STATUS_LOGON_FAILURE` | Username, password, or domain genuinely wrong |
| `NT_STATUS_ACCESS_DENIED` | Credentials accepted, authorization refused |
| `NT_STATUS_ACCOUNT_LOCKED_OUT` | Locked out, probably by earlier retries |
| `NT_STATUS_ACCOUNT_DISABLED` | Cannot sign in at all |
| `NT_STATUS_ACCOUNT_EXPIRED`, `NT_STATUS_ACCOUNT_RESTRICTION`, `NT_STATUS_INVALID_LOGON_HOURS`, `NT_STATUS_INVALID_WORKSTATION`, `NT_STATUS_PASSWORD_RESTRICTION` | Barred from signing in, for a reason that is not the password |
| `NT_STATUS_PASSWORD_EXPIRED`, `NT_STATUS_PASSWORD_MUST_CHANGE` | Password expired or must be changed first |
| `NT_STATUS_NOT_SUPPORTED`, `NT_STATUS_LOGON_TYPE_NOT_GRANTED` | Auth method refused; NTLM likely disabled |
| `NT_STATUS_BAD_NETWORK_NAME` | Share name wrong |
| `NT_STATUS_OBJECT_NAME_NOT_FOUND`, `NT_STATUS_OBJECT_PATH_NOT_FOUND` | Folder inside the share does not exist |
| `NT_STATUS_NOT_A_DIRECTORY` | Path names a file, not a folder |
| `NT_STATUS_PATH_NOT_COVERED` | A DFS link; read the real path, below |

The script prints its own MEANING and ACTION for every code in this table, so
the table is for looking one up afterwards rather than for diagnosing. If your
code is not here, the script printed the server's own message on screen just
above the code. That text, plus what you were doing, is what to put in a ticket.

## What to ask your IT department for

Several of the problems above end at a ticket. This is what to put in it --
edit the bracketed parts and paste the rest:

```text
Subject: SMB share access for a container on my workstation

I need to run a record-linkage tool (psilink, https://github.com/georgetown-mdi/jspsi)
in Docker Desktop on my workstation [MACHINE NAME]. It exchanges files with
[PARTNER ORGANIZATION] through the shared folder:

    [\\server\share\folder as it appears in File Explorer]

The tool runs inside a Linux container, which reaches the file server as a
separate machine on the network. It is not domain-joined and holds no Kerberos
ticket, so it can only authenticate with a username and password over NTLM.

Please could you provide:

1. A service account that can reach that folder with a username and password
   (not Kerberos/single sign-on only), scoped to this share if possible. The
   password must not contain a comma or a double quote.
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

The account will be used only for this exchange. Please retire it, or reset its
password, when I tell you the exchange is finished -- I will follow up.
```

## Reading the real path from Windows

The path you see is not always the path that exists. A drive letter hides the
server behind it, and a DFS path names a **namespace** rather than a machine --
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

Give all three together. `-Server` on its own is ignored, and passing `-Server`
and `-Share` without `-SubPath` builds the volume on the share root.

**Do not run PowerShell as Administrator to work around this.** An elevated
session has its own drive table and cannot see the drives you mapped as
yourself, so elevating makes a `Z:\...` path stop resolving entirely. Reading
the path from Properties, as above, is the method that works.

## Doing it by hand

If you would rather see each step, or the script failed for a reason nothing
above covers, this is what it does. You need the real server, share and
subfolder from the section above.

These are PowerShell commands, so policy that blocks the script blocks them
too. If that is why you are here, use
[the Command Prompt version](command-prompt.md) instead.

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

This route puts the password on a command line, where it is recorded in your
PowerShell history file as well as everywhere described under
[Where your password ends up](#where-your-password-ends-up). Clear it
afterwards, or use the script.

## Running the exchange

**The folder must start clean.** psilink refuses to run in a drop folder that
still holds files from a previous exchange, because a leftover message would
corrupt or stall the run. Emptying it in File Explorer is the simplest fix.

`--sweep-exchange-files`, added to the end of the command, empties it for you.
**Only one of you may use it,** and that side must start first. It deletes every
psilink file in the folder, including the first message the other side has just
written. If you both pass it, you will delete each other's first message and
both runs will sit waiting for a partner that is no longer there. Agree who goes
first. That person runs with the flag; the other waits until that run has
started, then uses the ordinary command.

**Setting up a second file drop replaces the first.** The volume name is
`psilink-rendezvous` unless you say otherwise, so running the script again for
a different partner overwrites the first one's settings. Give each its own with
`-VolumeName psilink-partner-b`, and pass that name to `-v` when you run that
exchange.

## Synced folders

Some file drops are not live file servers at all: a sync client (OneDrive,
Dropbox, Egnyte, ShareFile) keeps a local copy on each side in step. There is
no volume to create -- point Docker at the local synced folder, which it can
bind-mount directly:

```powershell
docker run --rm `
  -v 'C:\path\to\your\work:/work' `
  -v 'C:\Users\you\Egnyte\exchange:/rendezvous' `
  vdorie/psi-link:latest `
  file:///rendezvous input.csv matches.csv --lockless-rendezvous
```

`--lockless-rendezvous` is not optional there and **both parties** must pass
it. A synced folder does not behave like a real filesystem: deletions take time
to propagate and both sides can create the same file at once, which breaks
psilink's default way of deciding who goes first. A mismatch between the two
sides fails the run immediately, naming each side's value.

If your sync client never propagates deletions -- some do not, by design or by
policy -- both sides need `--retain-files` as well, and the folder has to be
emptied between exchanges.

The setup script tests for this directly when it creates a volume, and tells
you if the share needs it. If you are bind-mounting a synced folder instead,
assume you need it, and confirm with your partner which kind of folder you are
sharing before the first run.

## Where your password ends up

The setup script passes the password to its checks through an environment
variable, so it never reaches a command line there. That reduces the exposure
but does not remove it: while the check container runs, `docker inspect` shows
the password to anyone who can run Docker on this PC.
Creating the volume is worse again, because Docker's CIFS volume driver accepts
credentials only as a mount option, and that is a command-line argument. There
is no way around it, so it is worth knowing the main places it ends up.

- **On a command line, once.** While the volume is created. On a managed
  workstation, command-line auditing (Windows event 4688, Sysmon, or your EDR
  agent) records that durably, and usually forwards it to a central log. That
  is a wider boundary than "Docker on this PC" -- the password may leave the
  machine and be retained by people you will never speak to.
- **In the volume metadata, in cleartext.** `docker volume inspect
  psilink-rendezvous` shows it to anyone who can run Docker here.
- **In your PowerShell history,** if you used
  [Doing it by hand](#doing-it-by-hand). The file is at
  `$env:APPDATA\Microsoft\Windows\PowerShell\PSReadLine\ConsoleHost_history.txt`.
- **In Docker's volume metadata database, after `docker volume rm`.** It
  survives there as a freed record. That file lives inside the Docker Desktop
  virtual disk, which endpoint backup and imaging tooling copies wholesale --
  so it is the one residue that can leave the machine without anyone running
  Docker.

None of that is introduced by psilink; it is how Docker CIFS volumes work, and
a password that has been in a process's memory on a Windows PC cannot be
reliably erased afterwards. What you control is **which account** you use. Do
not use your own Windows sign-in, and do not use a domain administrator
account. Use one scoped to the exchange share, or one you are prepared to
retire, and rotate it when the exchanges are done.

When you are finished:

```powershell
docker volume rm psilink-rendezvous
```

That removes the volume and its options file. Given the last point above, treat
rotating the password as the step that actually ends the exposure -- and if IT
issued the account, that means going back to them.
