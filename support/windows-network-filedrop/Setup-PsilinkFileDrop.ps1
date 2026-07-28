<#
.SYNOPSIS
    Makes a network file-drop folder usable by psilink running in Docker.
    Run this once before your first exchange.

.DESCRIPTION
    You have a file-drop folder that lives on a network location -- something
    you open in File Explorer as a mapped drive (Z:\Exchange) or a network path
    (\\fileserver\exchange). Docker cannot use that path directly: the Docker
    engine runs inside a Linux virtual machine that cannot see mapped drives or
    network paths at all, which is why passing one to --mount produces
    "bind source path does not exist".

    The fix is to have Docker mount the network folder itself, as a named
    volume. This script does that for you:

      1. Works out the real server behind the path you see in Explorer.
         A mapped drive letter hides it, and a DFS path can point somewhere
         different again -- this is the step people otherwise do by hand via
         right-click, Properties, DFS tab.
      2. Tests that the server is reachable and that your credentials work,
         reporting exactly what is wrong when they do not.
      3. Creates the Docker volume and verifies psilink can write to it.
      4. Prints the docker command to run your exchange.

    Nothing is installed on Windows; the checks run in throwaway containers.

    About the password: the diagnostic phase passes it through an inherited
    environment variable, so it never reaches a command line. Creating the
    volume is different -- Docker requires the credentials as a mount option,
    so the password is briefly visible in the process list and is then stored
    in cleartext in the volume metadata, where "docker volume inspect" shows
    it. That is inherent to Docker CIFS volumes. Prefer an account scoped to
    the exchange share, and run "docker volume rm psilink-rendezvous" when you
    are finished.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Setup-PsilinkFileDrop.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Setup-PsilinkFileDrop.ps1 -DropPath 'Z:\Exchange\psilink'
#>

[CmdletBinding()]
param(
    [string] $DropPath,
    [string] $Username,
    [string] $Domain,
    [string] $Server,
    [string] $Share,
    [string] $SubPath,
    [ValidateSet('', 'SMB3', 'SMB2', 'NT1')]
    [string] $Dialect = '',
    [string] $VolumeName = 'psilink-rendezvous',
    [switch] $SkipVolumeTest
)

$ErrorActionPreference = 'Stop'

function Write-Head {
    param([string] $Text)
    Write-Host ''
    Write-Host ('=' * 72) -ForegroundColor DarkGray
    Write-Host $Text -ForegroundColor Cyan
    Write-Host ('=' * 72) -ForegroundColor DarkGray
}
function Write-Good { param([string] $T) Write-Host "  OK    $T" -ForegroundColor Green }
function Write-Bad  { param([string] $T) Write-Host "  FAIL  $T" -ForegroundColor Red }
function Write-Note { param([string] $T) Write-Host "        $T" -ForegroundColor Yellow }
function Write-Info { param([string] $T) Write-Host "        $T" }

function Invoke-Docker {
    <#  Runs docker and returns a hashtable of its combined output and exit
        code.

        Docker is never called with a bare "2>&1" in this script, because
        Windows PowerShell 5.1 turns every stderr line of a native program
        into an ErrorRecord when its stderr is redirected -- and this script
        runs with $ErrorActionPreference = 'Stop', which makes that record
        throw. Docker writes routine, expected messages to stderr ("no such
        volume" when removing one that was never created, which is what every
        first run hits), so the redirect must happen with the preference
        relaxed or the script dies partway through with a raw .NET error
        instead of the message it meant to print.

        The arguments are passed as one explicit array rather than as loose
        trailing words: a function that collects remaining arguments is an
        advanced function, so PowerShell binds docker's own short flags to the
        common parameters first -- "-v" becomes -Verbose and never reaches
        docker, which then reads the volume spec as the image name and fails
        with "invalid reference format". #>
    param([Parameter(Mandatory = $true)][string[]] $DockerArgs)

    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $lines = & docker @DockerArgs 2>&1 | ForEach-Object { "$_" }
        return @{ Output = ($lines -join [Environment]::NewLine); ExitCode = $LASTEXITCODE }
    }
    finally { $ErrorActionPreference = $previous }
}

# ==========================================================================
# Path resolution: Explorer-visible path -> real server, share, subdirectory
# ==========================================================================

function Resolve-MappedDrive {
    <#  Given 'Z', return the UNC root it maps to, or $null if it is a local
        disk. Three independent methods, because which ones are available
        varies with Windows version and how the drive was mapped. #>
    param([string] $Letter)

    try {
        $psd = Get-PSDrive -Name $Letter -ErrorAction SilentlyContinue
        if ($psd -and $psd.DisplayRoot -and $psd.DisplayRoot -like '\\*') {
            return $psd.DisplayRoot
        }
    } catch { }

    try {
        $conn = Get-CimInstance -ClassName Win32_NetworkConnection -ErrorAction SilentlyContinue |
                Where-Object { $_.LocalName -eq "${Letter}:" }
        if ($conn -and $conn.RemoteName) { return $conn.RemoteName }
    } catch { }

    try {
        $netUse = & net use "${Letter}:" 2>$null
        if ($LASTEXITCODE -eq 0) {
            foreach ($line in $netUse) {
                if ($line -match '\\\\[^\s]+') { return $Matches[0] }
            }
        }
    } catch { }

    return $null
}

function Resolve-RealServer {
    <#  A DFS namespace path such as \\corp.example.com\dfs\exchange is served
        by some other machine entirely. Touching the path makes Windows open
        the real SMB connection; Get-SmbConnection then reports which server
        that actually is -- but only to an Administrator, so an ordinary run
        cannot see it. Returns a hashtable whose Status is:

          Resolved   - Server holds the server actually serving ShareName
          NoMatch    - the connection list is readable and has no entry for
                       ShareName, so there is nothing to correct
          Unreadable - the connection list could not be read (the usual case:
                       this window is not elevated)

        There is deliberately no fallback to "some other server in the list":
        an unrelated connection -- a mapped home drive, a print server's IPC$ --
        is not evidence about this share, and reporting one as the real server
        sends the user somewhere that has nothing to do with their file drop. #>
    param([string] $UncPath, [string] $NamespaceServer, [string] $ShareName)

    try { Get-ChildItem -LiteralPath $UncPath -ErrorAction SilentlyContinue | Out-Null } catch { }

    $conns = $null
    $readError = $null
    try {
        $conns = Get-SmbConnection -ErrorAction SilentlyContinue -ErrorVariable readError
    } catch {
        $readError = $_
    }
    if ($readError) { return @{ Status = 'Unreadable' } }

    $match = $conns | Where-Object { $_.ShareName -eq $ShareName } | Select-Object -First 1
    if ($match -and $match.ServerName) {
        return @{ Status = 'Resolved'; Server = $match.ServerName }
    }

    return @{ Status = 'NoMatch' }
}

function Resolve-DropPath {
    <#  Classify the path the user sees in Explorer. Returns a hashtable with
        Kind = Local | Network | Unknown, plus Server/Share/SubPath when
        Kind is Network. #>
    param([string] $Raw)

    # Windows accepts either slash, and a path copied out of a browser, a
    # ticket, or a shell script often arrives with forward ones. Fold them to
    # backslashes up front so the patterns below only ever see one separator;
    # matching a share name as "anything but a backslash" otherwise swallows
    # //server/share/sub whole and reports the entire tail as the share.
    $p = $Raw.Trim().Trim('"').Replace('/', '\').TrimEnd('\')
    if (-not $p) { return @{ Kind = 'Unknown'; Reason = 'empty path' } }

    # --- drive letter -----------------------------------------------------
    if ($p -match '^([A-Za-z]):($|\\.*$)') {
        $letter = $Matches[1]
        $rest   = $Matches[2].TrimStart('\')

        $unc = Resolve-MappedDrive -Letter $letter
        if (-not $unc) {
            # No mapping. That means a local disk -- or a letter that is not
            # there at all, which is worth saying: a mistyped letter would
            # otherwise be reported as a local folder, and the user would be
            # sent off to bind-mount a path that does not exist.
            if (-not (Test-Path -LiteralPath "${letter}:\")) {
                return @{ Kind = 'Unknown'
                          Reason = "there is no ${letter}: drive on this PC. If it is a network drive that is not connected right now, open it in File Explorer first, then re-run" }
            }
            return @{ Kind = 'Local'; LocalPath = $p }
        }
        Write-Good "${letter}: is mapped to $unc"
        $p = if ($rest) { "$unc\$rest" } else { $unc }
    }

    # --- UNC naming a server but no share ---------------------------------
    if ($p -match '^\\\\([^\\]+)$') {
        return @{ Kind = 'Unknown'
                  Reason = "'$Raw' names the server '$($Matches[1])' but no share. Include the share as well, as in \\$($Matches[1])\exchange" }
    }

    # --- UNC --------------------------------------------------------------
    if ($p -match '^\\\\([^\\]+)\\([^\\]+)($|\\.*$)') {
        $server  = $Matches[1]
        $share   = $Matches[2]
        $sub     = $Matches[3].TrimStart('\').Replace('\', '/')

        $uncRoot = "\\$server\$share"
        $resolution = Resolve-RealServer -UncPath $p -NamespaceServer $server -ShareName $share
        switch ($resolution.Status) {
            'Resolved' {
                if ($resolution.Server -ne $server) {
                    Write-Good "'$server' is a namespace; the real server is '$($resolution.Server)'"
                    Write-Info "(this is the address the right-click Properties DFS tab shows)"
                    $server = $resolution.Server
                }
            }
            'Unreadable' {
                Write-Note "Could not check whether '$server' is a DFS namespace -- reading"
                Write-Note "that needs Administrator rights."
                Write-Info "Only matters if it is one, in which case '$server' names the"
                Write-Info "namespace rather than the file server and the checks below will"
                Write-Info "not reach it. See the runbook, 'Finding the real server by hand'."
            }
        }

        return @{ Kind = 'Network'; Server = $server; Share = $share; SubPath = $sub; Unc = $uncRoot }
    }

    # --- plain local path -------------------------------------------------
    if ($p -match '^[A-Za-z]:') { return @{ Kind = 'Local'; LocalPath = $p } }

    return @{ Kind = 'Unknown'; Reason = "could not interpret '$Raw'" }
}

# ==========================================================================
# The probe that runs inside the container
# ==========================================================================
$probe = @'
#!/bin/sh
set -u
AUTH=/tmp/psilink-auth
emit() { printf '%s\n' "$*"; }
step() { emit ""; emit "-- $1"; }

apk add --no-cache samba-client >/dev/null 2>&1 || {
  emit "FAIL: could not install samba-client inside the container."
  emit "The Docker VM has no internet access. Check Docker Desktop's proxy"
  emit "settings, or whether a corporate TLS proxy blocks the Alpine mirror."
  exit 1
}

umask 077
{
  printf 'username=%s\n' "$SMB_USER"
  printf 'password=%s\n' "$SMB_PASS"
  [ -n "${SMB_DOMAIN:-}" ] && printf 'domain=%s\n' "$SMB_DOMAIN"
} > "$AUTH"

VERSOPT=""
[ -n "${SMB_DIALECT:-}" ] && VERSOPT="-m $SMB_DIALECT"

step "1. Name resolution from inside the Docker VM"
if printf '%s' "$SMB_SERVER" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
  emit "OK: $SMB_SERVER is a literal IP address."
elif getent hosts "$SMB_SERVER" >/dev/null 2>&1; then
  emit "OK: resolved to $(getent hosts "$SMB_SERVER" | awk '{print $1}' | head -1)"
else
  emit "FAIL: cannot resolve '$SMB_SERVER'."
  emit ""
  emit "The Docker VM runs its own resolver. It does not inherit Windows' DNS"
  emit "suffix search list and has no NetBIOS name resolution, so a short"
  emit "server name that works in File Explorer often fails here."
  emit ""
  emit "ACTION: re-run this script and give the fully-qualified server name"
  emit "        or its IP address. On the Windows side, 'Resolve-DnsName"
  emit "        $SMB_SERVER' will show you the full name."
  exit 2
fi

step "2. TCP reachability on port 445"
if nc -z -w 8 "$SMB_SERVER" 445 2>/dev/null; then
  emit "OK: port 445 is open."
else
  emit "FAIL: cannot reach $SMB_SERVER:445 from inside the Docker VM."
  emit ""
  emit "The VM reaches the network through Docker's NAT, so to the file server"
  emit "it is a different machine than Windows. A split-tunnel VPN that routes"
  emit "only the Windows side, a host firewall rule, or a server-side IP"
  emit "restriction blocks the VM while File Explorer keeps working."
  emit ""
  emit "ACTION: if you are on a VPN, that is the likely cause. See the runbook"
  emit "        section 'The container cannot reach the server'."
  exit 3
fi

step "3. Authentication"
OUT=$(timeout 30 smbclient -L "//$SMB_SERVER" -A "$AUTH" $VERSOPT 2>&1)
STATUS=$(printf '%s' "$OUT" | grep -o 'NT_STATUS_[A-Z_]*' | head -1)
if [ -z "$STATUS" ] && printf '%s' "$OUT" | grep -q 'Sharename'; then
  emit "OK: authenticated. Shares visible to this account:"
  printf '%s\n' "$OUT" | sed -n '/Sharename/,/^$/p' | sed 's/^/      /'
else
  emit "FAIL: ${STATUS:-authentication failed}"
  emit ""
  printf '%s\n' "$OUT" | sed 's/^/      /'
  emit ""
  case "$STATUS" in
    NT_STATUS_LOGON_FAILURE)
      emit "MEANING: the username, password, or domain is wrong. This is the"
      emit "         one status that really does mean bad credentials."
      emit ""
      emit "ACTION:  if this is a domain account, re-run with -Domain set."
      emit "         If the folder opens in File Explorer WITHOUT ever asking"
      emit "         for a password, Windows is signing you in automatically"
      emit "         with Kerberos and there may be no password that works"
      emit "         here. See the runbook, 'No password exists'." ;;
    NT_STATUS_ACCESS_DENIED)
      emit "MEANING: the credentials were ACCEPTED and access was then refused."
      emit "         This is not a wrong password."
      emit ""
      emit "ACTION:  the account probably lacks rights when connecting from a"
      emit "         machine that is not domain-joined, or the server requires"
      emit "         Kerberos. See 'Credentials correct, still denied'." ;;
    NT_STATUS_ACCOUNT_LOCKED_OUT)
      emit "MEANING: the account is locked out, most likely from earlier failed"
      emit "         attempts, which may now be masking the original cause."
      emit "ACTION:  stop retrying. Wait for the lockout to expire or ask IT"
      emit "         to unlock, then run this script once." ;;
    NT_STATUS_PASSWORD_EXPIRED|NT_STATUS_PASSWORD_MUST_CHANGE)
      emit "MEANING: the password is expired."
      emit "ACTION:  change it in Windows, then re-run." ;;
    NT_STATUS_NOT_SUPPORTED)
      emit "MEANING: the server rejected the authentication METHOD, not the"
      emit "         credentials. NTLM is probably disabled server-side."
      emit "ACTION:  see the runbook, 'No password exists'." ;;
    NT_STATUS_CONNECTION_RESET|NT_STATUS_IO_TIMEOUT|NT_STATUS_INVALID_NETWORK_RESPONSE)
      emit "MEANING: the SMB dialect was probably rejected."
      emit "ACTION:  re-run with -Dialect SMB3, then -Dialect SMB2." ;;
    *)
      emit "ACTION:  look up the status code above in the runbook table." ;;
  esac
  exit 4
fi

step "4. Opening share '$SMB_SHARE'"
OUT=$(timeout 30 smbclient "//$SMB_SERVER/$SMB_SHARE" -A "$AUTH" $VERSOPT -c 'ls' 2>&1)
STATUS=$(printf '%s' "$OUT" | grep -o 'NT_STATUS_[A-Z_]*' | head -1)
if [ -n "$STATUS" ]; then
  emit "FAIL: $STATUS"
  printf '%s\n' "$OUT" | sed 's/^/      /'
  emit ""
  emit "ACTION: check the share name against the listing in step 3. It is the"
  emit "        first path component only, not the whole folder path."
  exit 5
fi
emit "OK: share opened."

TARGET=""
if [ -n "${SMB_PATH:-}" ]; then
  step "5. Entering subdirectory '$SMB_PATH'"
  OUT=$(timeout 30 smbclient "//$SMB_SERVER/$SMB_SHARE" -A "$AUTH" $VERSOPT \
        -c "cd \"$SMB_PATH\"; ls" 2>&1)
  STATUS=$(printf '%s' "$OUT" | grep -o 'NT_STATUS_[A-Z_]*' | head -1)
  if [ -n "$STATUS" ]; then
    emit "FAIL: $STATUS"
    emit ""
    if [ "$STATUS" = "NT_STATUS_OBJECT_NAME_NOT_FOUND" ]; then
      emit "MEANING: the share is fine but this subfolder does not exist."
      emit "ACTION:  check the spelling, or create it first."
    else
      emit "MEANING: the subfolder exists but this account cannot open it."
      emit "ACTION:  access to a share does not imply access to every folder"
      emit "         in it. Ask for rights on this folder specifically."
    fi
    exit 6
  fi
  emit "OK: directory listed."
  printf '%s\n' "$OUT" | sed 's/^/      /'
  TARGET="$SMB_PATH"
else
  step "5. Subdirectory"
  emit "SKIP: using the share root."
fi

step "6. Write, rename, and delete"
emit "psilink writes each message under a temporary name and renames it into"
emit "place, so read access alone is not enough."
PROBE=psilink-write-probe.tmp
printf 'psilink write probe\n' > /tmp/$PROBE
CMD="put /tmp/$PROBE $PROBE; rename $PROBE $PROBE.renamed; del $PROBE.renamed"
[ -n "$TARGET" ] && CMD="cd \"$TARGET\"; $CMD"
OUT=$(timeout 30 smbclient "//$SMB_SERVER/$SMB_SHARE" -A "$AUTH" $VERSOPT -c "$CMD" 2>&1)
STATUS=$(printf '%s' "$OUT" | grep -o 'NT_STATUS_[A-Z_]*' | head -1)
if [ -n "$STATUS" ]; then
  emit "FAIL: $STATUS"
  printf '%s\n' "$OUT" | sed 's/^/      /'
  emit ""
  emit "MEANING: this account can read the folder but not write to it."
  emit ""
  emit "ACTION:  ask whoever administers the share for write permission on"
  emit "         this folder. Mount options such as file_mode cannot grant"
  emit "         it -- they only change how permissions look inside the"
  emit "         container, not what the server allows."
  exit 7
fi
emit "OK: created, renamed, and deleted a file."
emit ""
emit "ALL CHECKS PASSED"
'@

# ==========================================================================
# Preflight
# ==========================================================================
Write-Head 'psilink file-drop setup'

Write-Host 'Checking Docker...'
$dockerVersion = Invoke-Docker -DockerArgs @('version', '--format', '{{.Server.Version}}')
if ($dockerVersion.ExitCode -ne 0) {
    Write-Bad 'Docker is not running, or is not installed.'
    Write-Note 'Start Docker Desktop, wait for the whale icon to stop animating,'
    Write-Note 'then run this script again.'
    exit 1
}
Write-Good "Docker engine $($dockerVersion.Output) is running."

# ==========================================================================
# Step 1: work out where the file drop really lives
# ==========================================================================
Write-Head 'Step 1: locating the file drop'

if (-not ($Server -and $Share)) {
    if (-not $DropPath) {
        Write-Host 'Enter the file-drop folder exactly as you see it in File Explorer.'
        Write-Host 'Examples:  Z:\Exchange\psilink'
        Write-Host '           \\fileserver.agency.gov\exchange\psilink'
        Write-Host ''
        $DropPath = Read-Host 'File-drop folder'
    }

    $resolved = Resolve-DropPath -Raw $DropPath

    switch ($resolved.Kind) {
        'Local' {
            Write-Head 'This folder is already local'
            Write-Good "$($resolved.LocalPath) is on this PC, not a network server."
            if (-not (Test-Path -LiteralPath $resolved.LocalPath)) {
                Write-Note "It does not exist yet -- create it before running the exchange,"
                Write-Note 'or Docker will report "bind source path does not exist".'
            }
            Write-Host ''
            Write-Host 'That means you do not need a Docker volume at all -- you can mount'
            Write-Host 'the folder directly. Run your exchange like this:'
            Write-Host ''
            Write-Host "  docker run --rm ``"
            Write-Host "    -v C:\path\to\your\work:/work ``"
            Write-Host "    -v $($resolved.LocalPath):/rendezvous ``"
            Write-Host "    vdorie/psi-link:latest ``"
            Write-Host "    file:///rendezvous input.csv matches.csv"
            Write-Host ''
            Write-Note 'If this folder is kept in step with your partner by a sync client'
            Write-Note '(OneDrive, Dropbox, Egnyte, ShareFile), both sides must also pass'
            Write-Note '--lockless-rendezvous. See the runbook, "Synced folders".'
            exit 0
        }
        'Unknown' {
            Write-Bad "Could not interpret that path: $($resolved.Reason)"
            Write-Note 'Enter it as a drive letter path (Z:\Exchange) or a network path'
            Write-Note '(\\server\share\folder). Copy it from the Explorer address bar.'
            exit 1
        }
    }

    if (-not $Server)  { $Server  = $resolved.Server }
    if (-not $Share)   { $Share   = $resolved.Share }
    if (-not $PSBoundParameters.ContainsKey('SubPath')) { $SubPath = $resolved.SubPath }
}

Write-Good "Server:       $Server"
Write-Good "Share:        $Share"
Write-Good "Subdirectory: $(if ($SubPath) { $SubPath } else { '(share root)' })"

# ==========================================================================
# Step 2: credentials
# ==========================================================================
Write-Head 'Step 2: credentials for the file server'

if (-not $Username) { $Username = Read-Host 'Username' }
if (-not $PSBoundParameters.ContainsKey('Domain')) {
    $Domain = Read-Host 'Domain (press Enter if you do not have one)'
}
if ($Username -match '^(.+?)\\(.+)$') {
    if (-not $Domain) { $Domain = $Matches[1] }
    $Username = $Matches[2]
    Write-Note "Using domain '$Domain' and username '$Username'."
}

$securePass = Read-Host 'Password' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePass)
try   { $plainPass = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }

if ([string]::IsNullOrEmpty($plainPass)) {
    Write-Bad 'No password entered.'
    Write-Note 'If you never type a password when opening this folder in Explorer,'
    Write-Note 'Windows signs you in automatically and this approach may not work at'
    Write-Note 'all. Read the runbook section "No password exists" first.'
    exit 1
}

# ==========================================================================
# Step 3: test the share from inside a container
# ==========================================================================
Write-Head 'Step 3: testing the share from inside a container'

$probeB64 = [Convert]::ToBase64String(
    [Text.Encoding]::UTF8.GetBytes(($probe -replace "`r`n", "`n")))

$env:SMB_SERVER  = $Server
$env:SMB_SHARE   = $Share
$env:SMB_PATH    = $SubPath
$env:SMB_USER    = $Username
$env:SMB_DOMAIN  = $Domain
$env:SMB_PASS    = $plainPass
$env:SMB_DIALECT = $Dialect

& docker run --rm `
    --env SMB_SERVER --env SMB_SHARE --env SMB_PATH `
    --env SMB_USER --env SMB_DOMAIN --env SMB_PASS --env SMB_DIALECT `
    alpine sh -c "echo $probeB64 | base64 -d | sh"
$probeExit = $LASTEXITCODE

foreach ($v in 'SMB_SERVER','SMB_SHARE','SMB_PATH','SMB_USER','SMB_DOMAIN','SMB_DIALECT') {
    Remove-Item "env:$v" -ErrorAction SilentlyContinue
}

if ($probeExit -ne 0) {
    Remove-Item env:SMB_PASS -ErrorAction SilentlyContinue
    Write-Head 'Not ready yet'
    Write-Bad 'The file drop is not usable from Docker. Follow the ACTION above.'
    exit $probeExit
}
Write-Good 'The share is reachable, writable, and supports rename.'

if ($SkipVolumeTest) {
    Remove-Item env:SMB_PASS -ErrorAction SilentlyContinue
    Write-Note 'Skipping volume creation as requested.'
    exit 0
}

# ==========================================================================
# Step 4: create and test the Docker volume
# ==========================================================================
Write-Head 'Step 4: creating the Docker volume'

$device = "//$Server/$Share"
if ($SubPath) { $device = "$device/$SubPath" }

$opts = "username=$Username,password=$plainPass"
if ($Domain)  { $opts = "$opts,domain=$Domain" }
if ($Dialect) {
    $versMap = @{ 'SMB3' = '3.0'; 'SMB2' = '2.1'; 'NT1' = '1.0' }
    $opts = "$opts,vers=$($versMap[$Dialect])"
}

if ($plainPass.Contains(',')) {
    Write-Note 'Your password contains a comma. Docker separates mount options with'
    Write-Note 'commas, so this fails with "invalid argument" rather than a login'
    Write-Note 'error. See the runbook, "A comma in the password".'
}

try {
    Invoke-Docker -DockerArgs @('volume', 'rm', $VolumeName) | Out-Null

    Write-Host "Creating volume '$VolumeName' for $device"
    $create = Invoke-Docker -DockerArgs @(
        'volume', 'create', '--driver', 'local',
        '--opt', 'type=cifs', '--opt', "device=$device", '--opt', "o=$opts",
        $VolumeName)
    if ($create.ExitCode -ne 0) {
        Write-Bad 'Could not create the volume.'
        Write-Host $create.Output
        exit 8
    }
    Write-Good 'Volume created. Docker mounts it the first time it is used.'

    Write-Host 'Mounting it and writing a test file...'
    $test = Invoke-Docker -DockerArgs @(
        'run', '--rm', '-v', "${VolumeName}:/rz", 'alpine', 'sh', '-c',
        'echo probe > /rz/.psilink-probe.tmp && mv /rz/.psilink-probe.tmp /rz/.psilink-probe.renamed && rm /rz/.psilink-probe.renamed && echo MOUNTOK')
    $testOut = $test.Output

    if ($test.ExitCode -ne 0 -or "$testOut" -notmatch 'MOUNTOK') {
        Write-Bad 'The volume could not be mounted.'
        Write-Host $testOut
        Write-Host ''
        if ("$testOut" -match 'invalid argument') {
            Write-Note 'The mount options were malformed -- a comma or equals sign in the'
            Write-Note 'password is the usual cause. See the runbook.'
        }
        elseif ("$testOut" -match 'permission denied') {
            Write-Note 'The kernel refused the mount even though step 3 authenticated.'
            Write-Note 'The SMB dialect is the most likely difference: re-run with'
            Write-Note '-Dialect SMB3, and if that fails, -Dialect SMB2.'
        }
        Invoke-Docker -DockerArgs @('volume', 'rm', $VolumeName) | Out-Null
        exit 9
    }
    Write-Good 'The volume mounts and psilink can write to it.'
}
finally {
    Remove-Item env:SMB_PASS -ErrorAction SilentlyContinue
    $plainPass = $null
}

# ==========================================================================
# Done
# ==========================================================================
Write-Head 'Ready to run an exchange'
Write-Host "The volume '$VolumeName' is set up and survives reboots. You do not"
Write-Host 'need to run this script again unless the password changes.'
Write-Host ''
Write-Host 'Run your exchange like this:' -ForegroundColor Cyan
Write-Host ''
Write-Host "  docker run --rm ``"
Write-Host "    -v C:\path\to\your\work:/work ``"
Write-Host "    -v ${VolumeName}:/rendezvous ``"
Write-Host "    vdorie/psi-link:latest ``"
Write-Host "    file:///rendezvous input.csv matches.csv"
Write-Host ''
Write-Info 'C:\path\to\your\work is a LOCAL folder on this PC holding your input'
Write-Info 'CSV; results are written back there. It must not be a network path.'
Write-Info 'input.csv and matches.csv are named relative to that folder.'
Write-Host ''
Write-Host 'Or run the browser console instead:' -ForegroundColor Cyan
Write-Host ''
Write-Host "  docker run --rm -p 127.0.0.1:3000:3000 ``"
Write-Host "    --env JOB_DATA_ROOT=/data --env JOB_RENDEZVOUS_DIR=/rendezvous ``"
Write-Host "    -v C:\path\to\your\work:/data ``"
Write-Host "    -v ${VolumeName}:/rendezvous ``"
Write-Host "    vdorie/psi-link:latest serve"
Write-Host ''
Write-Info 'then open http://127.0.0.1:3000'
Write-Host ''
Write-Note 'Check with your exchange partner: if this folder is kept in step by a'
Write-Note 'sync service rather than being a live file server, both sides must'
Write-Note 'pass --lockless-rendezvous. See the runbook, "Synced folders".'
Write-Host ''
Write-Note "Docker stores the share password in cleartext in the volume metadata."
Write-Note "Run 'docker volume rm $VolumeName' when you are finished with it."
