# Setting up the file drop by hand

This is the setup script's job done one command at a time, by you. Use it if
you would rather not run a script you downloaded, or if your PC will not let
you run one. It ends in the same place: a Docker volume called `psilink-sync`
that points at your file-drop folder, tested against the things psilink
actually needs. Allow half an hour rather than ten minutes.

Nothing here installs anything on Windows. Every check runs inside a throwaway
Linux container that Docker deletes when you close it.

Read [the setup page](README.md) first if you have not -- it explains why a
network folder needs a volume at all. Which account to use is
[the passwords page](passwords.md), and it is worth five minutes before you
start, because that choice is the awkward one to undo.

**The parts and steps below are numbered to match the Command Prompt script.**
So when [troubleshooting](troubleshooting.md) names a step, it is the one with
that number here. The PowerShell script runs the checks that ship inside the
psilink image, which name what they looked at rather than numbering it, and
which ask the same questions in the same order. Every step names the section
that covers its failure, and you can stop reading this page at that point.

## What you will need in front of you

- **Docker Desktop, running.** The whale icon should be still, not animating.
- **The file-drop folder path**, as File Explorer shows it. Click once in the
  address bar and it turns into text you can copy.
- **A username and password for that folder.** Not your own Windows sign-in,
  and never an administrator account. If you have no such account, send IT
  [this ready-made request](troubleshooting.md#what-to-ask-your-it-department-for).
- **A password with no comma in it.** Docker separates its settings with
  commas, so a password containing one is cut off at the comma and there is no
  way to escape it. No double quote either, if you are working in the Command
  Prompt.

Open PowerShell or the Command Prompt from the Start menu. Do **not** choose
**Run as administrator**: an elevated window keeps its own list of drive
letters and cannot see the ones you mapped as yourself, so `Z:\...` stops
working there entirely.

Almost every command below is the same in either shell, and is given once.
The one place they differ is creating the volume, in part 4, where both forms
are given.

## Part 1: work out where the file drop really lives

Docker needs the folder as three separate values, and the path you see in
Explorer is not always the path that exists.

`\\fs-04.agency.gov\exchange$\dropbox` splits into:

| | |
| --- | --- |
| **server** | `fs-04.agency.gov` |
| **share** | `exchange$` -- the **first** name after the server, only |
| **subfolder** | `dropbox` -- everything after it |

Write those three down. You will type them many times below.

**If your path is a drive letter** such as `Z:\dropbox`, the server is hidden
behind the letter. Ask Windows what it stands for:

```text
net use
```

Read the **Remote** column for that letter. If it prints
`\\fs-04.agency.gov\exchange$`, then your `Z:\dropbox` is really
`\\fs-04.agency.gov\exchange$\dropbox`, which is the path split up in the table
above. Put the letter's remote path first and whatever followed the letter
after it.

**If the path is a DFS namespace,** the name you see is a nickname your agency
invented and all three values can be different from what they look like.
Right-click the folder in Explorer, choose **Properties**, and open the **DFS**
tab if there is one; the **Referral list** shows the real path. This is the one
step nothing else can check for you, which is why part 4 tests it directly.

**If the folder turns out to be on this PC after all** -- a `C:\` path, or a
folder a sync client such as OneDrive, Dropbox, Egnyte or ShareFile keeps in
step with your partner -- then you need no volume and none of this page
applies. Docker can mount a local folder directly. See
[synced folders](troubleshooting.md#synced-folders).

Two things worth doing before you go on:

- **Open the folder in File Explorer.** If Windows itself cannot reach it, the
  checks below will fail for a reason that has nothing to do with Docker.
- **Note whether Explorer ever asks you for a password.** If it does not,
  Windows is signing you in automatically and there may be no password that
  works from a container. Read
  [the share never asks for a password](troubleshooting.md#the-share-never-asks-for-a-password)
  now rather than after four failed attempts.

## Part 2: check Docker, and pick the account

Ask Docker what it is:

```text
docker version --format "{{.Server.Os}} {{.Server.Version}}"
```

You want `linux` and a version number. If nothing answers, Docker Desktop is
not running -- start it and wait for the whale to stop animating. If it says
`windows`, Docker is in Windows containers mode and every container below will
fail to start: right-click the whale icon in the notification area and choose
**Switch to Linux containers**.

Then fetch the image the checks run in, so that a failure to download it does
not get mistaken later for a problem with your share:

```text
docker pull vdorie/psi-link:latest
```

Now the account. The username and password you are about to use are the ones
the **container** will present to the file server -- Windows signs you in as
yourself, and Docker cannot borrow that. Two things to know, and
[the passwords page](passwords.md) has the rest:

- Docker will store this password in cleartext where anyone who can run Docker
  on this PC can read it. Use an account scoped to this share, or one you are
  prepared to retire.
- Removing the volume at the end is not what ends the exposure. Rotating or
  retiring the account is.

If you sign in to Windows as something like `AGENCY\yourname`, then `AGENCY` is
your **domain** and `yourname` is your **username**; they are given separately
below. If you just type a username, you have no domain and you can leave every
`-W AGENCY` off.

## Part 3: test the share from inside a container

Everything in this part happens inside one throwaway container. Start it:

```text
docker run --rm -it --entrypoint sh vdorie/psi-link:latest
```

The prompt changes to `/work #`. You are now typing inside Linux, not Windows.
**Keep this window open until the end of part 3** -- the files you create live
only in this container, and leaving it throws them away. If you do lose it,
start again from here; nothing is left behind.

`--rm` is what guarantees that: Docker deletes the container the moment you
leave it.

### Step 1: can the container find the server?

```text
getent hosts fs-04.agency.gov
```

Success prints an IP address and the name. Nothing printed means the container
cannot resolve it -- it runs its own name lookup and does not know your
agency's shortcuts, so a short name that works perfectly in Explorer can mean
nothing here.

If it fails, leave the container (`exit`), run `nslookup fs-04` in Windows, and
start part 3 again using the full name or the address it prints. See
[the container cannot find the server](troubleshooting.md#the-container-cannot-find-the-server).

### Step 2: can it reach the server?

```text
nc -z -w 8 fs-04.agency.gov 445 && echo reachable
```

`reachable` is the answer you want. Port 445 is the file-sharing port.

If it prints nothing, the container cannot get to the server even though
Explorer can. The container reaches the network as what looks to the server
like a different machine, so a VPN carrying only Windows' own traffic will do
exactly this -- and it is the most common cause by far. See
[the container cannot reach the server](troubleshooting.md#the-container-cannot-reach-the-server).

### Make the file step 6 will send

```text
echo psilink write probe > /tmp/psilink-probe-check.tmp
```

### Step 3: do the credentials work?

```text
smbclient -L //fs-04.agency.gov -W AGENCY -U yourname
```

Drop `-W AGENCY` if you have no domain. It asks for the password and does not
show it as you type, which is normal.

A list of share names under a `Sharename` heading means the credentials were
accepted. Look for your share on it -- but do not worry if it is absent, since
a share can be reachable without being listed, and step 4 is the test that
counts.

Some servers refuse to list their shares to ordinary accounts and report
`NT_STATUS_ACCESS_DENIED` here. That is common and decides nothing; carry on to
step 4.

What does decide something is `NT_STATUS_LOGON_FAILURE`, which means the
username, password or domain is genuinely wrong. **Do not work through
passwords one at a time.** Each attempt is a real failed sign-in against the
account and a handful of them will lock it out, adding a second problem on top
of the one you have. Any other `NT_STATUS_` code is in
[the status-code table](troubleshooting.md#status-codes).

### Step 4: does the share open?

```text
smbclient '//fs-04.agency.gov/exchange$' -W AGENCY -U yourname
```

Note that this is the **share** only -- the first name after the server -- not
the whole folder path. The single quotes matter if your share name ends in `$`,
as many do: without them the shell inside the container reads the `$` as the
start of something to substitute. Quoting costs nothing when there is no `$`,
so keep them either way.

On success the prompt becomes `smb: \>`. Type:

```text
ls
```

**Stay at this prompt for steps 5 and 6.** `quit` leaves it when you are done.

`NT_STATUS_BAD_NETWORK_NAME` means there is no share by that name; you have
most likely given the whole path where only the first name belongs.
`NT_STATUS_PATH_NOT_COVERED` means it is a DFS link and you need the real path
from the Properties DFS tab.

If `ls` is refused with `NT_STATUS_ACCESS_DENIED` but you have a subfolder to
go to, that is usually fine and not worth chasing: being granted rights to
your own folder and nothing above it is the ordinary shape of an agency grant.
Go straight to step 5. It is only a real failure if the share root is where
your exchange runs. See
[the password works but access is refused](troubleshooting.md#the-password-works-but-access-is-refused).

### Step 5: does your folder open?

Skip this if your exchange runs in the share root. Otherwise, still at the
`smb: \>` prompt:

```text
cd dropbox
ls
```

You should see the contents of your file-drop folder -- probably nothing, which
is what an empty exchange folder looks like.

`NT_STATUS_ACCESS_DENIED` here, after step 4 worked, means access to a share
does not extend to this folder. See
[the share opens but the folder does not](troubleshooting.md#the-share-opens-but-the-folder-does-not).

If `ls` shows more than about eight thousand files, psilink will not run here
at all; use a folder dedicated to the exchange.

### Step 6: can it write, rename and delete?

Read access is not enough. psilink writes each message under a temporary name
and renames it into place, then deletes it once the other side has read it, so
all three have to work. Still at the `smb: \>` prompt, in your folder:

```text
put /tmp/psilink-probe-check.tmp psilink-probe-check.tmp
rename psilink-probe-check.tmp psilink-probe-check.tmp.renamed
del psilink-probe-check.tmp.renamed
```

That is the file you made a moment ago being sent to the share, renamed, and
removed again.

Each of the three can fail on its own, and they mean different things:

- **`put` refused.** The account can read this folder but not write to it.
- **`rename` refused.** Creating files is allowed and renaming them is not --
  on a Windows share this is usually the delete right being withheld, which a
  rename needs. The folder looks writable and an exchange still cannot run.
- **`del` refused.** Without delete rights the folder fills up and a second
  exchange will not start.

All three end at the same request: full change rights on this folder. See
[the folder cannot be written to](troubleshooting.md#the-folder-cannot-be-written-to).

### Leave one file behind on purpose

The checks you just ran reached the folder one way; the volume in part 4 will
reach it another. Nothing so far proves those are the same folder. So leave a
marker for part 4 to find:

```text
put /tmp/psilink-probe-check.tmp psilink-setup-check.tmp
quit
exit
```

`quit` leaves smbclient and `exit` leaves the container, which Docker then
deletes. You are back in Windows.

## Part 4: create the volume and check it

### Create it

**If you have been here before,** remove the old volume first:

```text
docker volume rm psilink-sync
```

Creating a volume over a name that already exists succeeds and quietly keeps
the settings the old one had, so without this a second attempt would go on
using the old password and you would be debugging a change that never took
effect.

This next command is the one that differs between the two shells, and the
quoting is load-bearing in both.

**PowerShell:**

```powershell
docker volume create --driver local `
  --opt type=cifs `
  --opt 'device=//fs-04.agency.gov/exchange$/dropbox' `
  --opt 'o=username=yourname,password=YOURPASSWORD,domain=AGENCY' `
  psilink-sync
```

**Command Prompt:**

```text
docker volume create --driver local --opt type=cifs --opt "device=//fs-04.agency.gov/exchange$/dropbox" --opt "o=username=yourname,password=YOURPASSWORD,domain=AGENCY" psilink-sync
```

Things to get right:

- **Forward slashes**, and the server, share and subfolder run together:
  `\\fs-04\exchange$\dropbox` becomes `//fs-04/exchange$/dropbox`.
- **Drop `,domain=AGENCY`** if you have no domain.
- **In PowerShell the quotes must be single ones.** Double quotes let it expand
  `$/dropbox` as a variable name, and the path silently changes; a `$` in the
  password does the same to the credentials, producing a login failure that
  looks exactly like a wrong password.
- **In the Command Prompt they must be double ones,** so that each `--opt`
  survives as a single argument whatever punctuation the password holds. `$`
  means nothing there. `%` is the character to watch, and only in pairs: a
  password of `pa%USERNAME%ss` arrives with your Windows account name in the
  middle of it, silently. If yours has two `%` in it, run the script instead --
  it reads the password rather than taking it from a command line, so nothing
  expands.
- **This command puts the password on a command line,** and in PowerShell that
  means your history file, which persists across sessions.
  [The passwords page](passwords.md) covers everywhere else it ends up.

Success prints the volume name back at you and no more.

**That does not mean it works.** Docker does not contact the server until the
volume is first used, so creating one always looks fine, even with the password
wrong and the path pointing nowhere. The next two steps are the ones that
establish anything.

### Check it mounts, and opens the right folder

```text
docker run --rm -v psilink-sync:/rz --entrypoint sh vdorie/psi-link:latest -c "ls -la /rz"
```

You are looking for **`psilink-setup-check.tmp`**, the marker you left at the
end of part 3.

- **It is there.** The volume and the checks agree on which folder this is.
  That is the last thing that could have been silently wrong. Go on.
- **The listing works but the marker is absent.** The volume is mounting a
  different folder from the one you just tested. The server, share or subfolder
  is wrong somewhere, and a DFS path is the usual reason. Read the real path
  from the folder's Properties, DFS tab, and start again from part 1. See
  [the volume opens the wrong folder](troubleshooting.md#the-volume-opens-the-wrong-folder).
- **An error instead of a listing** -- `permission denied`, `host is down`,
  `operation not supported`. The volume did not mount at all.
  The volume asks the server for a different version of the file-sharing
  protocol than smbclient did, and is the fussier of the two. Remove the volume
  and create it again with `,vers=3.1.1` added to the end of the `o=` option;
  if that fails, `,vers=2.1`. See
  [the volume will not mount](troubleshooting.md#the-volume-will-not-mount).
- **`required key not available`.** The server is refusing password
  authentication and wants a Kerberos ticket the container cannot have. See
  [the share never asks for a password](troubleshooting.md#the-share-never-asks-for-a-password).

### Check the behaviour psilink depends on

Two of psilink's rules about who goes first are not permissions but behaviour,
and a share can pass everything above and still get them wrong. This has to run
over the volume rather than through smbclient, which refuses some of these
whatever the server would have allowed.

```text
docker run --rm -it -v psilink-sync:/rz --entrypoint sh vdorie/psi-link:latest
```

You are inside a container again, with your file drop mounted at `/rz`. Move
into it:

```text
cd /rz
```

First, renaming a file onto one that already exists:

```text
echo a > psilink-probe-a.tmp
echo b > psilink-probe-b.tmp
mv -f psilink-probe-a.tmp psilink-probe-b.tmp && echo RENAME OK
rm -f psilink-probe-a.tmp psilink-probe-b.tmp
```

Then refusing to create something that already exists. Here the **second**
command is the one that has to fail:

```text
mkdir psilink-probe-x.d
mkdir psilink-probe-x.d
rmdir psilink-probe-x.d
```

You want `RENAME OK` from the first, and from the second `mkdir` a complaint
that the directory already exists. Together they mean the share behaves the way
psilink expects and there is nothing more to do.

If either comes out the other way -- no `RENAME OK`, or the second `mkdir`
quietly succeeding -- the share cannot arbitrate between two sides starting at
once. It is still usable, but **both** parties must add
`--lockless-rendezvous` to the end of their command when they run the exchange.
This is what a folder kept in step by a sync service usually looks like.

Finally, clear up after yourself and leave:

```text
rm -f psilink-setup-check.tmp
exit
```

The marker has done its job, and the folder is your partner's too.

## Running the exchange

You are now where the script would have left you. The volume survives reboots
and you do not need to do any of this again unless the password changes.

**PowerShell:**

```powershell
docker run --rm `
  -v 'C:\path\to\your\work:/work' `
  -v 'psilink-sync:/sync' `
  vdorie/psi-link:latest `
  file:///sync input.csv matches.csv
```

**Command Prompt:**

```text
docker run --rm -v "C:\path\to\your\work:/work" -v "psilink-sync:/sync" vdorie/psi-link:latest file:///sync input.csv matches.csv
```

`C:\path\to\your\work` is a folder **on this PC** holding your input CSV;
results are written back into it. It must not be the file drop and must not be
a network path. `input.csv` and `matches.csv` are named relative to it. Keep
the quotes -- a work folder under OneDrive has a space in its path.

Three things to know before the first run:

- **The `.keys.json` file is not a result.** Each run writes one next to the
  matches. It holds the keys to the exchange, so treat it like the input data
  and do not send it on with the results.
- **One exchange per folder at a time,** and the folder must start empty. Agree
  with your partner who goes first. If a run fails and leaves files behind, see
  [running the exchange](troubleshooting.md#running-the-exchange).
- **A second partner needs a second volume.** Give it another name in part 4 --
  `psilink-partner-b` -- and use that name here.

## When you are done with this partner

```text
docker volume rm psilink-sync
```

Then have the account switched off, or its password changed. That, rather than
removing the volume, is what ends the exposure --
[choosing an account, and where its password ends up](passwords.md) says why.

> **How far this has been tested.** The checks here are the ones the setup
> script runs, in its order, and those have been exercised against a real file
> server. This page's hand form of them has not been run end to end, and two
> details are its own rather than the script's: the script hands smbclient a
> credentials file, where this page has you type the password at its prompt and
> give the domain as `-W`. If either behaves differently on your machine, trust
> your screen over this page, and a correction is welcome.
