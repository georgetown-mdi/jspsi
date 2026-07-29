# Using a network file drop with psilink on Windows

Your file-drop folder lives on a network location -- you open it in File
Explorer as a mapped drive (`Z:\Exchange`) or a network path
(`\\fileserver\exchange`). Pointing Docker at it does not work:

```text
docker: Error response from daemon: invalid mount config for type "bind":
bind source path does not exist
```

This is not a typo or a permissions problem. Docker does its work inside a small
Linux virtual machine it keeps hidden on your PC, and two things follow from
that:

- **It cannot see your drive letters or network paths.** Those belong to
  Windows, not to it. Docker Desktop's file-sharing settings do not help either;
  that list is only for local drives.
- **Your file server treats it as a different computer.** It cannot borrow the
  Windows sign-in that gets you into the folder, so you have to give it a
  username and password to sign in with.

The fix is to let Docker open the network folder itself and keep that connection
saved under a name. Docker calls that a **volume**, and creating one is the only
thing the setup script does. Run it once, before your first exchange; it takes
about ten minutes.

## What you need

- **Docker Desktop, running.** The whale icon should be still, not animating.
- **The file-drop folder path.** Click once in the File Explorer address bar and
  it turns into text you can copy.
- **The username and password the file server accepts for that folder.** Often
  your usual Windows sign-in, but not always, as some servers want a separate
  account for the share. If you can create a new account just for the project,
  [choosing an account](passwords.md) is five minutes well spent first -- it is
  the one choice here that is awkward to undo.

## Which version to run

Try the **PowerShell script** first, listed below. If it refuses to run use the
Command Prompt one instead and stay with it from then on. They ask the same
questions and report the same failures.

Where the two need different commands, this guide gives both, PowerShell first.
A single block means the command is the same in either.

Rather not run a downloaded script at all? Step through
[**setting it up by hand**](by-hand.md) instead. It is the same checks in the
same order, one command at a time with an explanation of each, and it ends in
the same place. Allow half an hour.

## Get it and run it

Open the Start menu, type `PowerShell`, or `cmd` for the Command Prompt version,
and press Enter. Do not choose **Run as administrator**: an elevated window
cannot see the drive letters you mapped as yourself.

First, make a folder for the script and download it there -- its own folder
rather than loose among everything else in your user folder, so that it is easy
to find again and easy to delete when you are finished.

**PowerShell:**

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\psilink" | Out-Null
cd "$env:USERPROFILE\psilink"
Invoke-WebRequest -UseBasicParsing `
  -Uri 'https://raw.githubusercontent.com/georgetown-mdi/jspsi/main/support/windows-network-filedrop/Setup-PsilinkFileDrop.ps1' `
  -OutFile .\Setup-PsilinkFileDrop.ps1
```

**Command Prompt** -- four files rather than one, and **all four have to be in
the same folder**, which is what the folder is for: the script feeds the other
three to Docker.

```text
mkdir "%USERPROFILE%\psilink" 2>nul
cd /d "%USERPROFILE%\psilink"
set BASE=https://raw.githubusercontent.com/georgetown-mdi/jspsi/main/support/windows-network-filedrop
curl -L -o cmd_Setup-PsilinkFileDrop.cmd %BASE%/cmd_Setup-PsilinkFileDrop.cmd
curl -L -o cmd_psilink-probe.sh %BASE%/cmd_psilink-probe.sh
curl -L -o cmd_psilink-credcheck.sh %BASE%/cmd_psilink-credcheck.sh
curl -L -o cmd_psilink-volcheck.sh %BASE%/cmd_psilink-volcheck.sh
```

Use the command rather than saving from a browser, which saves it in a form
Windows will not run. Nothing appears on screen when the download works -- that
is success, and the files land in `C:\Users\<you>\psilink`.

Then run it. The first line is only needed if you have opened a new window
since:

**PowerShell:**

```powershell
cd "$env:USERPROFILE\psilink"
powershell -ExecutionPolicy Bypass -File .\Setup-PsilinkFileDrop.ps1
```

**Command Prompt:**

```text
cd /d "%USERPROFILE%\psilink"
cmd_Setup-PsilinkFileDrop.cmd
```

It asks you for three things, in this order:

1. **The file-drop folder**, exactly as you see it in Explorer.
2. **Whether the server, share and folder it worked out are right.** The
   **share** is the first name after the server -- in
   `\\fileserver\exchange\dropbox` it is `exchange`. If you are not sure, answer
   `Y`; a later check catches a wrong answer.
3. **A username, a domain, and a password.** If you sign in to Windows as
   something like `AGENCY\yourname`, the domain is the `AGENCY` part; if you
   just type a username, leave it blank. In PowerShell nothing appears on screen
   as you type the password, which is normal; Command Prompt cannot hide typing,
   so there it shows as you enter it.

A good run ends with a heading reading **Ready to run an exchange**, followed by
the command to copy. Anything in red before that is a failure, and the script
says underneath what to do about it.

## When it finishes

It prints the `docker run` command for an exchange with your volume name already
filled in, and explains underneath which parts to replace. One of them is a
folder on this PC that holds your input file; results are written back into the
same folder. It should be a folder on this PC -- not the file drop, and not a
network path.

## When you are done with this partner

Remove the volume. The script prints this command with your volume name in it
when it finishes, and it is the same in either shell:

```text
docker volume rm psilink-sync
```

That does not end the exposure of the password you gave it. Having that password
changed, or the account switched off, is what does --
[choosing an account, and where its password ends up](passwords.md) says why.

## If something goes wrong

The script says what failed, what it means, and what to do about it. Follow that
first. [**Troubleshooting**](troubleshooting.md) is the longer version, with a
section for each failure, and it covers how to send the whole run to whoever is
helping you.

> **How far this has been tested.** Both versions have been run start to finish
> on Windows 11 against a real file server, and the checks they run inside
> Docker are verified against that server too. Neither has ever met a real DFS
> namespace, which is why the script asks you to confirm the server it worked
> out rather than trusting it. Corrections from a real environment are welcome,
> and are worth more here than anywhere else in this repository.
