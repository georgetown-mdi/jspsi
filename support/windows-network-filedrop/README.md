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
paths at all. Docker Desktop's file-sharing settings do not help either; that
list is only for local drives.

The fix is to let Docker mount the network folder itself, as a named volume.
The setup script works out what that takes and does it. You run it once, before
your first exchange, and it takes about ten minutes.

## What you need

- **Docker Desktop, running.** The whale icon in the notification area should
  be still, not animating.
- **The file-drop folder path.** Click once in the File Explorer address bar
  and it turns into text you can copy.
- **A username and password** that can reach that folder. Not your own Windows
  sign-in, and never a domain administrator: Docker stores this password where
  anyone who can run Docker on this PC can read it, so use an account scoped to
  this share or one you can retire afterwards. It is the choice here that is
  awkward to undo, so [the passwords page](passwords.md) is worth five minutes
  before you ask for one. The password must not contain a comma, or a double
  quote if you use
  [the Command Prompt version](#which-version-to-run). If you have no such
  account, send IT
  [this ready-made request](troubleshooting.md#what-to-ask-your-it-department-for).

## Which version to run

There are two scripts. They ask the same questions, run the same checks in the
same container, and report the same failures.

- **PowerShell -- `Setup-PsilinkFileDrop.ps1`.** Use this one if you can.
- **Command Prompt -- `cmd_Setup-PsilinkFileDrop.cmd`.** Use it when PowerShell
  is missing, or when Group Policy or application-control policy stops it from
  running.

Pick one and stay with it. Wherever the two need different commands, this guide
gives both: the PowerShell one first, the Command Prompt one after. A single
block means the command is the same in either.

The Command Prompt version differs in two ways worth knowing before you start.
**Your password is visible as you type it** -- Command Prompt cannot hide typing
the way PowerShell does, so run `cls` or close the window when you are done.
And **it will not accept a password containing a double quote**, on top of the
no-comma rule that applies to both.

## Get it and run it

Open the Start menu, type `PowerShell`, or `cmd` for the Command Prompt version,
and press Enter. Do not choose **Run as administrator**: an elevated window
cannot see the drive letters you mapped as yourself.

```powershell
Invoke-WebRequest -UseBasicParsing `
  -Uri 'https://raw.githubusercontent.com/georgetown-mdi/jspsi/main/support/windows-network-filedrop/Setup-PsilinkFileDrop.ps1' `
  -OutFile "$env:USERPROFILE\Setup-PsilinkFileDrop.ps1"
```

The Command Prompt version comes as four files rather than one, and **all four
have to be in the same folder** -- the script feeds the other three to the
container:

```text
cd /d "%USERPROFILE%"
set BASE=https://raw.githubusercontent.com/georgetown-mdi/jspsi/main/support/windows-network-filedrop
curl -L -o cmd_Setup-PsilinkFileDrop.cmd %BASE%/cmd_Setup-PsilinkFileDrop.cmd
curl -L -o cmd_psilink-probe.sh %BASE%/cmd_psilink-probe.sh
curl -L -o cmd_psilink-credcheck.sh %BASE%/cmd_psilink-credcheck.sh
curl -L -o cmd_psilink-volcheck.sh %BASE%/cmd_psilink-volcheck.sh
```

Downloading rather than saving from a browser avoids two things that catch
people out: a browser renders a script as text and often saves it as `.txt`, and
a file saved from a browser is refused until you run `Unblock-File` on it.
`curl` is part of Windows 10 and 11, and a `.cmd` file has no execution policy
to work around and nothing to unblock.

It will ask you for three things, in this order:

1. **The file-drop folder**, exactly as you see it in Explorer.
2. **Whether the server, share and folder it worked out are right.** If you are
   not sure, answer `Y`. A later check compares the folder the volume opens
   against the one it just tested, and tells you if they differ.
3. **A username, a domain, and a password.** Leave the domain blank if you do
   not have one. In PowerShell nothing appears on screen as you type the
   password; that is normal.

Then run it:

```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\Setup-PsilinkFileDrop.ps1"
```

```text
cmd_Setup-PsilinkFileDrop.cmd
```

It tests the share from inside a container, creates the volume, and prints the
command to run your exchange.

## When it finishes

It prints the `docker run` command for an exchange with your volume name already
filled in, and explains underneath which parts to replace. One of them is a
local folder on this PC to keep your data in, which results are written back
into; it has to be a real local folder, not the file drop and not a network
path. It prints a second command as well, for driving the same exchange from a
page in your browser instead of the command line.

Two things to know before the first run:

- **The `.keys.json` file is not a result.** Each run writes one next to the
  matches. It holds the keys to the exchange, so treat it like the input data
  and do not send it on with the results.
- **One exchange per folder at a time.** The folder must start empty, so agree
  who goes first. If a run fails and leaves files behind, see
  [running the exchange](troubleshooting.md#running-the-exchange) -- which also
  covers setting up a second file drop, since a second one replaces the first
  unless you give it its own name.

## When you are done with this partner

Remove the volume. The script prints this command with your volume name in it
when it finishes, and it is the same in either shell:

```text
docker volume rm psilink-rendezvous
```

Then have the account retired, or its password reset. Docker stores the share
password in the volume's metadata in cleartext and leaves traces of it behind
even after the volume is gone, so rotating the password is the step that
actually ends the exposure.
[Choosing an account, and where its password ends up](passwords.md) is the whole
of that story.

## If something goes wrong

The script says what failed, what it means, and what to do about it. Follow
that first. [**Troubleshooting**](troubleshooting.md) is the longer version,
with a section for each failure.

To send the whole run to whoever is helping you, copy it straight out of the
window rather than running it again: right-click the title bar, then **Edit >
Select All** and **Edit > Copy**. In Command Prompt your password is on that
screen, so drag-select from just below the `Password:` line instead of using
Select All -- everything the checks printed comes after it.

> **How far this has been tested.** The checks that run inside the container,
> and the volume once it is created, are verified against a real SMB server:
> both the failures they report and the share behaviour psilink depends on. The
> Windows side is verified on Windows 11 under Windows PowerShell 5.1 against
> the same kind of server, and a setup from start to finish has been run there
> again since the last changes to it. It has never been tried against a real DFS
> namespace, which is why the script asks you to confirm the server it worked
> out rather than trusting it. The Command Prompt version was verified the same
> way, on the same server, with a password holding every character Command
> Prompt is known to mangle; its container checks were later replaced by the
> ones the PowerShell script uses, and it too has been run from start to finish
> since. Both were last run side by side against the same share, and report the
> same result. What neither has been made to do again since those checks changed
> is fail, so the diagnoses on the troubleshooting page are the part now resting
> on the older run. Corrections from a real environment are welcome, and are
> worth more here than anywhere else in this repository.
