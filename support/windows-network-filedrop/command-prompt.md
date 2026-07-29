# The Command Prompt version

`cmd_Setup-PsilinkFileDrop.cmd` is the same setup driven from a Command Prompt.
It asks the same questions, runs the same checks inside the same container, and
reports the same failures. Use it when PowerShell is missing, or when Group
Policy or application-control policy stops it from running.

Every diagnosis on [the setup page](README.md) and in
[troubleshooting](troubleshooting.md) applies to it unchanged. The commands on
those pages do not: they are PowerShell. Run `cmd_Setup-PsilinkFileDrop.cmd`
wherever one shows `.\Setup-PsilinkFileDrop.ps1`, with the same options, and
`nslookup` wherever one shows `Resolve-DnsName`. Only
[Doing it by hand](troubleshooting.md#doing-it-by-hand) has no Command Prompt
equivalent.

## Get it and run it

It comes as four files rather than one, and **all four have to be in the same
folder** -- the script feeds the other three to the container. Open the Start
menu, type `cmd`, press Enter, and run:

```text
cd /d "%USERPROFILE%"
set BASE=https://raw.githubusercontent.com/georgetown-mdi/jspsi/main/support/windows-network-filedrop
curl -L -o cmd_Setup-PsilinkFileDrop.cmd %BASE%/cmd_Setup-PsilinkFileDrop.cmd
curl -L -o cmd_psilink-probe.sh %BASE%/cmd_psilink-probe.sh
curl -L -o cmd_psilink-credcheck.sh %BASE%/cmd_psilink-credcheck.sh
curl -L -o cmd_psilink-volcheck.sh %BASE%/cmd_psilink-volcheck.sh
cmd_Setup-PsilinkFileDrop.cmd
```

`curl` is part of Windows 10 and 11. There is no execution policy to work
around and nothing to unblock: a `.cmd` file saved from the internet runs.

Options are the same as the PowerShell script's, and take either form --
`-Server` or `/Server`. Run it with `-?` for the list.

## What differs from the PowerShell version

Two things, both worth knowing before you start:

- **Your password is visible as you type it.** Command Prompt cannot hide
  typing the way PowerShell does. Close the window when you are finished, or
  run `cls` to clear it.
- **The password cannot contain a double quote,** on top of the no-comma rule
  on the setup page. Docker takes the mount options as a single quoted
  argument, and a quote inside the password ends that argument early. Use an
  account whose password has neither -- it is item 1 of the
  [IT request](troubleshooting.md#what-to-ask-your-it-department-for).

## If something goes wrong

The script says what failed, what it means, and what to do about it, and names
the [troubleshooting](troubleshooting.md) section that covers it.

To send the whole run to whoever is helping you, run it like this instead:

```text
cmd_Setup-PsilinkFileDrop.cmd 1> setup-log.txt 2>&1
```

That log holds the server, share and account names and what each check said. It
does not hold your password, the names of the files in your drop folder, or the
other shares on your file server.
