# When the file-drop setup does not work

One section per thing that goes wrong, in the order you would meet it, and then
reference material: the status codes, the request to send IT, how to read the
real path from Windows, and how to do by hand what the script does for you.
Start from [the setup page](README.md) if you have not run the script yet.
Which account to use, and what Docker does with its password, is on
[the passwords page](passwords.md); nothing there is needed to fix a failure, so
read it when the exchange is over.

The script prints a MEANING and an ACTION for every failure it can name. Follow
those first; this page is the longer version. The setup path has been exercised
against a real server more recently than these diagnoses have, so if one of them
does not match what you are seeing, trust what is on your screen.

To send the whole run to whoever is helping you, copy it straight out of the
window: right-click the title bar, then **Edit > Select All** and **Edit >
Copy**. In Command Prompt your password is on that screen, so drag-select from
just below the `Password:` line instead of using Select All -- everything the
checks printed comes after it.

In PowerShell you can also log the next attempt to a file as it runs. The
questions still appear on screen, because PowerShell writes them to the window
rather than into the log, so you answer them exactly as usual:

```powershell
cd "$env:USERPROFILE\psilink"
powershell -ExecutionPolicy Bypass -File .\Setup-PsilinkFileDrop.ps1 6>&1 |
  Tee-Object .\psilink-setup-log.txt
```

The `6>&1` is not decoration: without it the file comes out empty, because the
script writes its report to a stream a plain redirect does not carry. The log
lands next to the script, in `C:\Users\<you>\psilink`. It holds the server,
share and account names and what each check said. It does not hold your
password.

There is no Command Prompt equivalent, and this is the one place the two shells
genuinely differ. Sending output to a file there sends the questions with it,
leaving you typing at a blank screen with nothing to say what is being asked.
Copy out of the window instead.

Both scripts run in four numbered parts. What runs inside part 3 differs. The
PowerShell script runs the checks that ship inside the psilink image, which name
what they looked at rather than numbering it: every line begins `OK:`, `WARN:`,
`FAIL:` or `SKIP:`, and a `FAIL:` carries its own MEANING and ACTION. The
Command Prompt script carries its own copy of those checks, numbered steps 1 to
6. The sections below name both, and a "step" on this page is always one of the
Command Prompt script's.

Where the two shells need different commands, both are given: the PowerShell one
first, the Command Prompt one after, matching
[which version you are running](README.md#which-version-to-run). A single block
means the command is the same in either. The Command Prompt script takes the
same options as the PowerShell one, and accepts them in either form -- `-Server`
or `/Server`. Run either script with `-?` for the list.

Commands below that name the script assume your window is in the folder you
downloaded it to: `cd "$env:USERPROFILE\psilink"` in PowerShell,
`cd /d "%USERPROFILE%\psilink"` in the Command Prompt.

## The script will not run

This one is PowerShell's alone; a `.cmd` file has no execution policy to refuse
it.

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

In either case switch to
[the Command Prompt version](README.md#which-version-to-run) and use its
commands from here on, including in [Doing it by hand](#doing-it-by-hand) --
whose PowerShell commands the same policy blocks.

## A comma or a double quote in the password

The script refuses before it does anything.

Docker has no way to pass a password containing a comma: it separates its own
settings with commas, so the password is cut off at the first one. There is no
workaround, and doing it by hand hits the same wall.

The Command Prompt version refuses a double quote as well. Docker takes the
mount options as one quoted argument, and a quote inside the password ends that
argument early, so Docker creates an unnamed volume instead of the one asked
for.

Use an account whose password has neither -- it is item 1 of the
[IT request](#what-to-ask-your-it-department-for).

## The container cannot find the server

The name check fails -- `FAIL: cannot resolve 'fileserver'`, or step 1 in the
Command Prompt script.

The hidden Linux computer looks up server names on its own, and does not know
your agency's shortcuts. A short name like `fileserver` can work perfectly in
File Explorer and mean nothing to it.

Find the full name on Windows and pass it directly. Run the first command with
your own server's short name; it prints the full name, which goes into the
second:

```powershell
Resolve-DnsName fileserver
.\Setup-PsilinkFileDrop.ps1 -Server fileserver.agency.gov -Share exchange -SubPath dropbox
```

```text
nslookup fileserver
cmd_Setup-PsilinkFileDrop.cmd -Server fileserver.agency.gov -Share exchange -SubPath dropbox
```

An IP address works too, and is the right answer when there is no DNS entry at
all. If the address might change, ask IT for a stable name.

If the name has an `@` in it, or the first folder is `DavWWWRoot`, the drive is
SharePoint or another WebDAV site rather than a file share, and Docker cannot
mount it this way at all. See [Synced folders](#synced-folders).

## The container cannot reach the server

The port check fails -- `FAIL: cannot reach fileserver:445`, or step 2 in the
Command Prompt script -- or the checks report that the connection stopped
responding.

Remember that the file server sees the hidden Linux computer as a different
machine. Three things commonly stop *it* while File Explorer keeps working:

- **A VPN.** Many VPNs carry only Windows' own traffic. Docker's goes out the
  ordinary way and never arrives. This is the most common cause by far.
- **A firewall on this PC** that allows Windows but not Docker.
- **A rule on the server** that only accepts computers it already knows.

If you are on a VPN, that is almost certainly it. Take items 3 and 5 of the
[IT request](#what-to-ask-your-it-department-for) to whoever runs the network.

## The share never asks for a password

The share opens in Explorer without ever prompting you, and the checks report
`NT_STATUS_LOGON_FAILURE` or `NT_STATUS_NOT_SUPPORTED`.

Windows signs you in to this folder automatically, as yourself. There was never
a password for it. The hidden Linux computer cannot be signed in that way -- it
can only use a username and password, and many agencies have switched that off
entirely.

**Do not work through passwords one at a time.** Each attempt is a real failed
sign-in against the account, and a handful of them will lock it out -- adding a
second problem on top of the one you have.

Two options, and one dead end:

- Ask IT for a **service account** with a real password that can reach the
  share. This is the cleanest fix and usually the fastest to get; it is item 1
  of the [IT request](#what-to-ask-your-it-department-for).
- If no account can be made to work, ask for the scheduled mirror instead --
  item 5 of the [IT request](#what-to-ask-your-it-department-for).

If a volume later fails to mount with `required key not available`, that is the
same problem in a different place.

## The password works but access is refused

The checks report `NT_STATUS_ACCESS_DENIED` rather than
`NT_STATUS_LOGON_FAILURE`. The username and password were right; the account
simply is not allowed in.

This one needs IT. Ask whoever administers the folder to let the account in from
an unmanaged computer, or to provide a service account, and give them these
possibilities:

- The account may lack rights when connecting from a machine that is not
  domain-joined.
- Conditional access or device-based policy may require a managed device; the
  Docker VM is not one.
- The share ACL may grant access to the **computer** account rather than the
  user account.

Note that a refusal at the **share root** alone is not a problem. Being granted
rights to your own folder and nothing above it is the ordinary shape of an
agency grant, and the script says so and carries on.

## The share opens but the folder does not

`NT_STATUS_ACCESS_DENIED` on the folder inside the share, after the share itself
opened -- steps 5 and 4 in the Command Prompt script. Access to a share does not
imply access to every folder inside it. Ask for rights on the
file-drop folder specifically -- item 2 of the
[IT request](#what-to-ask-your-it-department-for).

## The folder cannot be written to

A write, rename, or delete check fails -- step 6 in the Command Prompt script --
or the volume mounts and then refuses the write.

When it is one of those three checks, the message names which operation failed,
and they mean different things:

- **Could not create a file.** The account has read but not write access.
- **Created a file but could not rename it.** Create rights without the delete
  right, which a rename needs. psilink renames every message into place, so
  this stops an exchange even though the folder looks writable.
- **Created and renamed but could not delete.** psilink removes each message
  once the other side has read it. Without delete rights the folder fills up
  and a second exchange will not start.

For the three checks above, ask for full change rights on the folder -- item 2
of the [IT request](#what-to-ask-your-it-department-for).

When the volume is what refused, the operation is not named, and there are three
things it can be:

- **The volume was created without `uid=1000,gid=1000`.** psilink runs in the
  container as an account numbered 1000, and a Windows file server serves no
  ownership the mount can read, so a volume made without those options presents
  the share as belonging to someone else and refuses every write. Re-run the
  setup script: it re-creates the volume with the options, without asking. A
  volume made by hand, or by an earlier copy of the script, is the one that has
  this gap; [Doing it by hand](#doing-it-by-hand) shows the full command.
- **The share is out of space.** Check this first, since it is the one you can
  see.
- **The account can open the folder but not create files in it.** Item 2 of the
  [IT request](#what-to-ask-your-it-department-for) again.

Mount options such as `file_mode` and `dir_mode` cannot fix a share whose own
permissions refuse you -- the three named checks, and the last cause above. They
only change how permissions **look** inside the container; the server still
decides what is allowed. `uid` and `gid` are the exception, and only for the
first cause: they decide which account the mount is presented to, which is a
question the server does not answer. Neither does `-Dialect` fix any of this: if
the share was reached, the dialect is not what is refusing you.

**On macOS and Linux there is no volume.** `start-psilink.sh` mounts each folder
as your machine already sees it and runs the container as your own account, so a
refused write there is your own account's access to your own folder: check who
owns it and what it grants, on the machine you are running from. Starting the
container by hand is the other way to meet this. Without `--user` it runs as the
account the image ships with, numbered 1000, which cannot write a folder
belonging to anyone else; pass `--user "$(id -u):$(id -g)"` and it runs as you
do.

The launcher asks this of the folders the console writes in: the working folder
and the folder shared with your partner. Your input folder is only read from --
your CSVs are read where they are and nothing is written back to them -- so one
you cannot write in passes its check, and a read-only mount is fine there.

## The volume will not mount

`permission denied`, `host is down`, or `operation not supported` at part 4,
after part 3 passed.

The checks and the volume ask the server for different versions of the
file-sharing protocol, and the volume is the fussier of the two. Run it again,
naming a version:

```powershell
.\Setup-PsilinkFileDrop.ps1 -Dialect SMB3
```

```text
cmd_Setup-PsilinkFileDrop.cmd -Dialect SMB3
```

and if that fails, `-Dialect SMB2`. If both fail, the server is too old for
Docker to use it at all. Ask for the scheduled mirror -- item 5 of the
[IT request](#what-to-ask-your-it-department-for).

## The volume opens the wrong folder

The script reports that a file it left in the folder is not visible through the
volume.

The checks reach the folder one way and the volume mounts it another. This is
the only check that compares the two. When they disagree, the server, share or
subfolder is wrong somewhere -- most often a DFS path.

[Read the real path from Windows](#reading-the-real-path-from-windows) and pass
it with `-Server`, `-Share` and `-SubPath`.

If instead the script reports a check file it did not itself write, an earlier
run or another operator left that one, and it settles nothing about this folder.

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
code is not here, the server's own message is on screen with it, indented under
the line naming the code. That text, plus what you were doing, is what to put in
a ticket.

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
server behind it, and a DFS path is a nickname your agency invented: the real
server, the real shared folder, and the folder inside it can all be different
from what you see. The script asks you to confirm the three values it worked out
precisely because this is the step it cannot verify for you.

Windows will tell you:

1. Open the file-drop folder in File Explorer.
2. Right-click it and choose **Properties**.
3. If there is a **DFS** tab, open it. The **Referral list** shows the real
   path, something like `\\fs-04.agency.gov\exchange$\dropbox`.
4. If there is no DFS tab and it is a mapped drive, go back to the PowerShell or
   Command Prompt window, run `net use`, and read the **Remote** column for that
   letter.

Then split that path into its three parts and pass them directly:

```powershell
.\Setup-PsilinkFileDrop.ps1 -Server fs-04.agency.gov -Share 'exchange$' -SubPath dropbox
```

```text
cmd_Setup-PsilinkFileDrop.cmd -Server fs-04.agency.gov -Share exchange$ -SubPath dropbox
```

`\\fs-04.agency.gov\exchange$\dropbox` splits into server `fs-04.agency.gov`,
share `exchange$` (the **first** path component only), and subfolder `dropbox`
(everything after it). In PowerShell, quote the share if it contains a `$`, as
most administrative shares do -- unquoted, PowerShell reads it as the start of a
variable name. Command Prompt does not treat `$` specially, so it needs no
quotes.

Give all three together. `-Server` on its own is ignored, and passing `-Server`
and `-Share` without `-SubPath` builds the volume on the share root.

**Do not run PowerShell as Administrator to work around this.** A window opened
that way keeps its own list of drive letters and cannot see the ones you mapped,
so a `Z:\...` path stops working entirely. Reading the path from Properties, as
above, is the method that works.

## Doing it by hand

This one is for someone comfortable at a command line: the two commands the
script comes down to, for when it failed for a reason nothing above covers. You
need the real server, share and subfolder from the section above.

If you want the whole setup this way rather than these two commands -- every
check the script runs, one at a time, with what each one establishes --
[setting it up by hand](by-hand.md) is that, at a slower pace.

**PowerShell:**

```powershell
docker volume create --driver local `
  --opt type=cifs `
  --opt 'device=//fs-04.agency.gov/exchange$/dropbox' `
  --opt 'o=username=USER,password=PASS,uid=1000,gid=1000,domain=AGENCY' `
  psilink-sync
```

**Command Prompt:**

```text
docker volume create --driver local --opt type=cifs --opt "device=//fs-04.agency.gov/exchange$/dropbox" --opt "o=username=USER,password=PASS,uid=1000,gid=1000,domain=AGENCY" psilink-sync
```

Note the forward slashes in `device`, and that `\\fs-04\exchange$\dropbox`
becomes `//fs-04/exchange$/dropbox`. `uid=1000,gid=1000` is not optional:
psilink runs in the container as an unprivileged account numbered 1000, and a
Windows file server serves no ownership the mount can read, so a volume created
without them mounts and then refuses every write.

The quotes are load-bearing in both, for
different reasons. In PowerShell they must be single quotes: without them it
expands `$/dropbox` as a variable and the path silently changes, and a `$` in
the password does the same to the credentials -- producing a login failure that
looks exactly like a wrong password. In Command Prompt each `--opt` is one
argument that has to survive whatever punctuation the password holds, which is
what the double quotes are for; `$` means nothing there. `%` is the character to
watch instead, and only in pairs: a single `%` is passed through, and so is a
pair naming something that does not exist, but a pair around the name of a real
environment variable is replaced before Docker ever sees it. A password of
`pa%USERNAME%ss` arrives with your Windows account name in the middle of it,
silently, and every later attempt reads as a wrong password. If yours has two
`%` in it, run the script instead: it reads the password rather than taking it
from a command line, so nothing expands.

Check that it mounts and that the folder is the one you meant:

**PowerShell:**

```powershell
docker run --rm -v 'psilink-sync:/rz' --entrypoint sh vdorie/psi-link:latest -c "ls -la /rz"
```

**Command Prompt:**

```text
docker run --rm -v "psilink-sync:/rz" --entrypoint sh vdorie/psi-link:latest -c "ls -la /rz"
```

This route puts the password on a command line -- in PowerShell, that means your
history file, which persists across sessions. Clear it afterwards, or use the
script. [The passwords page](passwords.md) covers everywhere else it ends up.

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
`psilink-sync` unless you say otherwise, so running the script again for a
different partner overwrites the first one's settings. Give each its own with
`-VolumeName psilink-partner-b`, and pass that name to `-v` when you run that
exchange.

## Synced folders

Some file drops are not live file servers at all: a sync client (OneDrive,
Dropbox, Egnyte, ShareFile) keeps a local copy on each side in step. There is
no volume to create -- point Docker at the local synced folder, which it can
bind-mount directly:

**PowerShell:**

```powershell
docker run --rm `
  -v 'C:\path\to\your\work:/work' `
  -v 'C:\Users\you\Egnyte\exchange:/sync' `
  vdorie/psi-link:latest `
  file:///sync input.csv matches.csv --lockless-rendezvous
```

**Command Prompt:**

```text
docker run --rm -v "C:\path\to\your\work:/work" -v "C:\Users\you\Egnyte\exchange:/sync" vdorie/psi-link:latest file:///sync input.csv matches.csv --lockless-rendezvous
```

`--lockless-rendezvous` is not optional there and **both parties** must pass it.
A synced folder is slower and less exact than a real one: deletions take time to
reach the other side, and both sides can create the same file at the same
moment. That breaks the way psilink normally decides who goes first. If only one
of you passes it, the run stops straight away and says so.

If your sync client never propagates deletions -- some do not, by design or by
policy -- both sides need `--retain-files` as well, and the folder has to be
emptied between exchanges.

The setup script tests for this directly when it creates a volume, and tells
you if the share needs it. If you are bind-mounting a synced folder instead,
assume you need it, and confirm with your partner which kind of folder you are
sharing before the first run.
