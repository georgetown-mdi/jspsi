# Choosing an account, and where its password ends up

Nothing on this page is needed to make an exchange work. It covers one decision
-- **which account** you hand to the setup script -- and what Docker does with
its password afterwards, so that you can make that decision knowing the cost
rather than discovering it later.

Two points are worth having before your first run, and the rest can wait until
you are finished with the exchange:

- Do not use your own Windows sign-in, and never a domain administrator
  account. Use one scoped to the exchange share, or one you are prepared to
  retire.
- Removing the volume at the end is not what ends the exposure. Rotating or
  retiring the account is.

Start from [the setup page](README.md) if you have not run the script yet;
[troubleshooting](troubleshooting.md) is the page for a run that failed.

## Where the password ends up

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
- **On the screen you were typing at,** if you used the Command Prompt version,
  which cannot hide typing. It stays in the window's scrollback until you run
  `cls` or close it -- which matters most when you copy the run out of that
  window to send to someone.
- **In your PowerShell history,** if you used
  [Doing it by hand](troubleshooting.md#doing-it-by-hand). The file is at
  `$env:APPDATA\Microsoft\Windows\PowerShell\PSReadLine\ConsoleHost_history.txt`,
  and it persists across sessions. Command Prompt keeps no equivalent on disk.
- **In Docker's volume metadata database, after `docker volume rm`.** It
  survives there as a freed record. That file lives inside the Docker Desktop
  virtual disk, which endpoint backup and imaging tooling copies wholesale --
  so it is the one residue that can leave the machine without anyone running
  Docker.

None of that is introduced by psilink; it is how Docker CIFS volumes work, and
a password that has been in a process's memory on a Windows PC cannot be
reliably erased afterwards. What you control is which account you use.

## Ending the exposure

When you are finished with this partner, in either shell:

```text
docker volume rm psilink-rendezvous
```

That removes the volume and its options file. Given the last point above, treat
rotating the password as the step that actually ends the exposure -- and if IT
issued the account, that means going back to them. The
[request to send IT](troubleshooting.md#what-to-ask-your-it-department-for) ends
by telling them to expect exactly that.

## If the account has no password to give

Some shares never prompt you at all: Windows signs you in silently over
Kerberos, and there is no password for the container to use. That is a failure
mode rather than a hardening question, and it has its own section --
[the share never asks for a password](troubleshooting.md#the-share-never-asks-for-a-password).
Do not work through candidate passwords one at a time; each attempt is a real
failed sign-in and a handful of them will lock the account out.
