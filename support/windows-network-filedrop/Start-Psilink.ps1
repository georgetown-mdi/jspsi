<#
.SYNOPSIS
    Opens the psilink console in your browser. Run it whenever you want to run
    an exchange.

.DESCRIPTION
    You have Docker and a folder or two. This picks the folders, works out what
    Docker has to be told about them, checks them with the container's own
    checks, starts the console and opens it.

    It is plaintext on purpose, so whoever has to approve it can read all of it:
    it fetches nothing itself, keeps nothing between runs, and never updates
    itself. The container image it runs is pinned by digest, stamped in by the
    release that published this file. A new version arrives the way everything
    else in your organisation does -- somebody hands you a new copy.

    A network folder -- a mapped drive, a network path, or a DFS namespace --
    cannot be handed to Docker directly, so this asks
    Setup-PsilinkFileDrop.ps1, which must be in the same folder, to work out the
    real server and share behind it, and then builds the network-share volume
    Docker needs. A folder on this PC needs none of that and is mounted as it
    stands.

.LINK
    https://github.com/georgetown-mdi/jspsi/blob/main/support/windows-network-filedrop/troubleshooting.md

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Start-Psilink.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Start-Psilink.ps1 -DataRoot 'C:\psilink\work'
#>

[CmdletBinding()]
param(
    [string] $DataRoot,
    [string] $InputDir,
    [string] $RendezvousDir,
    [ValidateRange(1, 65535)]
    [int] $Port = 3000,
    [string] $VolumeName = 'psilink-sync',
    [switch] $NoBrowser,
    # Dot-source the script with this switch to define its functions and stop
    # before the launcher runs; it is how the Pester suite in
    # support/maintainer-notes drives the pure ones. Not for operators, and the
    # flow runs whenever it is absent, so nothing they type can skip it.
    [switch] $LoadFunctionsOnly
)

$ErrorActionPreference = 'Stop'

# --- Release stamp ---------------------------------------------------------
# The release workflow rewrites the digest line below, whole, to the digest it
# signed with cosign. A copy that still carries the placeholder did not come
# from a release and refuses to run: an unpinned launcher would run whatever is
# behind a floating tag today, which is the one thing an operator reading this
# file cannot check for themselves.
$PsilinkImageRepository = 'docker.io/vdorie/psi-link'
$PsilinkImageDigest = '@@PSILINK_IMAGE_DIGEST@@'

$PsilinkReleasesUrl = 'https://github.com/georgetown-mdi/jspsi/releases'
$PsilinkTroubleshootingUrl = 'https://github.com/georgetown-mdi/jspsi/blob/main/support/windows-network-filedrop/troubleshooting.md'

# The verdict schema this launcher was written against. `psilink doctor --json`
# carries its own; anything else is refused rather than parsed on, because a
# later version may have re-meaned a field this one reads.
$PsilinkVerdictVersion = 1

# The overall verdicts and check statuses this launcher knows. Both vocabularies
# are closed within a schema version, so a value outside one of these sets means
# the document is not the version it claims and is refused rather than mapped
# onto the nearest thing.
$PsilinkOverallValues = @('ok', 'fix_and_retry', 'fatal')
$PsilinkStatusValues = @('ok', 'warn', 'fail', 'skipped')

# The marker the probe leaves for the mount check to find. Fixed rather than
# unique, so a run always clears any copy an earlier one left; the per-run token
# written into it is what tells the two apart.
$PsilinkMarkerName = 'psilink-setup-check.tmp'

$script:PsilinkEngine = ''

# ==========================================================================
# Display
#
# Named apart from the Write-* helpers in Setup-PsilinkFileDrop.ps1: this script
# dot-sources that one, which would otherwise replace these mid-run with its own
# definitions of the same names.
# ==========================================================================

function Show-Head {
    param([string] $Text)
    Write-Host ''
    Write-Host ('=' * 70) -ForegroundColor DarkGray
    Write-Host $Text -ForegroundColor Cyan
    Write-Host ('=' * 70) -ForegroundColor DarkGray
}
function Show-Ok { param([string] $T) Write-Host "  OK    $T" -ForegroundColor Green }
function Show-Fail { param([string] $T) Write-Host "  FAIL  $T" -ForegroundColor Red }
function Show-Alert { param([string] $T) Write-Host "  WARN  $T" -ForegroundColor Yellow }
function Show-Note { param([string] $T) Write-Host "        $T" -ForegroundColor Yellow }
function Show-Info { param([string] $T) Write-Host "        $T" }

function Show-FromContainer {
    <#  Text the container supplied, shown as the container wrote it. Control
        characters are dropped rather than displayed: this is classified prose
        the image owns, but it passes through a console that reads an escape
        sequence as a command and nothing downstream re-checks it. #>
    param([string] $Text)

    Write-Host ("        " + ($Text -replace '[\x00-\x08\x0b-\x1f\x7f]', ' '))
}

# ==========================================================================
# The image reference
# ==========================================================================

function Get-PsilinkImage {
    <#  Fully qualified, registry included: podman requires the prefix and
        docker accepts it, so one reference serves both. #>
    return "$PsilinkImageRepository@$PsilinkImageDigest"
}

function Test-PsilinkImageStamp {
    <#  Whether this copy carries a real digest, established positively rather
        than by looking for the placeholder: a half-applied stamp is then
        refused on the same branch as an unstamped one, and the placeholder
        token appears in this file exactly once, where the release step expects
        it. #>
    param([string] $Digest = $PsilinkImageDigest)

    return [bool]($Digest -cmatch '^sha256:[0-9a-f]{64}$')
}

function Assert-PsilinkImageStamp {
    if (Test-PsilinkImageStamp) {
        Show-Ok "Image pinned to $(Get-PsilinkImage)"
        return $true
    }
    Show-Fail 'This copy of the launcher did not come from a release.'
    Show-Note 'It carries no image digest, so there is nothing here to say which'
    Show-Note 'psilink it would run. Rather than run whatever is behind a'
    Show-Note 'floating tag today, it stops.'
    Write-Host ''
    Show-Info 'A release copy has the digest filled in. Download one from:'
    Show-Info "    $PsilinkReleasesUrl"
    Show-Info 'or ask whoever in your organisation distributes psilink for the'
    Show-Info 'copy they approved.'
    return $false
}

# ==========================================================================
# The container engine
# ==========================================================================

function Test-EngineCommand {
    <#  Whether a name is a command this session can run. An empty name is
        answered here rather than passed on: Get-Command refuses one while its
        parameters are being bound, which -ErrorAction cannot soften, and the
        engine name is empty until one has been found. #>
    param([string] $Engine)

    if ([string]::IsNullOrWhiteSpace($Engine)) { return $false }
    return [bool](Get-Command $Engine -ErrorAction SilentlyContinue)
}

function New-AbsentEngineResult {
    <#  The answer the two wrappers give for an engine that is not there, in the
        shape a run of one returns. #>
    param([string] $Engine)

    $named = $Engine
    if ([string]::IsNullOrWhiteSpace($named)) { $named = '(no engine)' }
    return @{ Ran = $false; Output = "$named is not a command on this PC."; ExitCode = 127 }
}

function Invoke-EngineQuiet {
    <#  Run the engine and return whether it ran at all, its combined output,
        and its exit code.

        The engine is never called with a bare "2>&1" outside this function,
        because Windows PowerShell 5.1 turns every stderr line of a native
        program into an ErrorRecord when its stderr is redirected -- and this
        script runs with $ErrorActionPreference = 'Stop', which makes that
        record throw. Docker writes routine, expected messages to stderr ("no
        such volume" when removing one that was never created), so the redirect
        has to happen with the preference relaxed.

        A name that is not a command on this PC is answered here rather than
        called: calling one raises CommandNotFoundException, which the relaxed
        preference does not soften and nothing here catches, so a run would end
        on a raw .NET error instead of the message the flow means to print. Ran
        is what tells that apart from an engine that ran and exited: 127 is the
        shell convention for a command that is not there, and a container that
        exits 127 reports the same code.

        The arguments are one explicit array rather than loose trailing words: a
        function that collects remaining arguments is an advanced function, so
        PowerShell binds the engine's own short flags to the common parameters
        first and "-v" becomes -Verbose instead of reaching docker. #>
    param(
        [Parameter(Mandatory = $true)][string[]] $EngineArgs,
        [string] $Engine = $script:PsilinkEngine
    )

    if (-not (Test-EngineCommand -Engine $Engine)) { return (New-AbsentEngineResult -Engine $Engine) }

    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $lines = & $Engine @EngineArgs 2>&1 | ForEach-Object { "$_" }
        return @{ Ran = $true; Output = ($lines -join [Environment]::NewLine); ExitCode = $LASTEXITCODE }
    } finally { $ErrorActionPreference = $previous }
}

function Invoke-EngineCapture {
    <#  Run the engine, capture its standard output, and let its standard error
        reach the console. The doctor's --json verdict is the whole of its
        standard output and its log lines are the whole of its standard error,
        so merging the two would put log text into the document being parsed.

        A name that is not a command on this PC is answered without calling it,
        for the reason Invoke-EngineQuiet gives. #>
    param(
        [Parameter(Mandatory = $true)][string[]] $EngineArgs,
        [string] $Engine = $script:PsilinkEngine
    )

    if (-not (Test-EngineCommand -Engine $Engine)) { return (New-AbsentEngineResult -Engine $Engine) }

    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $lines = & $Engine @EngineArgs
        return @{ Ran = $true; Output = (($lines | ForEach-Object { "$_" }) -join "`n"); ExitCode = $LASTEXITCODE }
    } finally { $ErrorActionPreference = $previous }
}

function Find-ContainerEngine {
    <#  docker first, podman second. An engine counts only when it answers: a
        name on PATH that cannot reach a daemon is the ordinary "Docker Desktop
        is not started yet" case, and must not be chosen over one that works.
        The question is put as a bare "version", which both engines answer,
        rather than through a format template, whose fields differ between them.
        Returns the engine's name, or an empty string. #>
    param([string[]] $Candidates = @('docker', 'podman'))

    foreach ($candidate in $Candidates) {
        if (-not (Get-Command $candidate -ErrorAction SilentlyContinue)) { continue }
        $version = Invoke-EngineQuiet -Engine $candidate -EngineArgs @('version')
        if ($version.ExitCode -ne 0) { continue }
        return $candidate
    }
    return ''
}

function Test-WindowsContainerMode {
    <#  Whether Docker Desktop is serving Windows containers, in which the engine
        answers normally and then every Linux container fails to start. Asked of
        docker alone: {{.Server.Os}} is docker's own template field, confirmed
        against a linux engine, and podman is not modelled here. #>
    param([string] $Engine)

    if ($Engine -ne 'docker') { return $false }
    $probe = Invoke-EngineQuiet -Engine $Engine -EngineArgs @('version', '--format', '{{.Server.Os}}')
    if ($probe.ExitCode -ne 0) { return $false }
    return ($probe.Output.Trim() -eq 'windows')
}

# ==========================================================================
# The verdict document
# ==========================================================================

function Test-JsonMember {
    <#  Whether a parsed JSON object carries a member at all -- presence, not a
        null test. #>
    param($Object, [string] $Name)

    if ($null -eq $Object) { return $false }
    if ($null -eq $Object.PSObject) { return $false }
    return (@($Object.PSObject.Properties.Name) -contains $Name)
}

function Get-JsonText {
    <#  A member's text when the object carries one and it is not null, and an
        empty string otherwise. #>
    param($Object, [string] $Name)

    if (-not (Test-JsonMember -Object $Object -Name $Name)) { return '' }
    $value = $Object.$Name
    if ($null -eq $value) { return '' }
    return [string] $value
}

function Read-DoctorVerdict {
    <#  Read one line of `psilink doctor --json` output, per
        docs/spec/CLI_DOCTOR.md. Returns a hashtable:

          Ok       whether the document is a verdict this launcher understands
          Reason   why not, when it is not
          Overall  ok | fix_and_retry | fatal
          Checks   one hashtable per check: Id, Status, Meaning, Action

        The version is read before anything else and an unknown one is refused
        rather than parsed on. Both vocabularies are closed within a version, so
        a status or an overall outside them is refused too. An optional field is
        carried only when the document actually has it and it is not null: the
        verdict omits what it has nothing to say about, so a null is a document
        this does not understand rather than a value. #>
    param([string] $Json)

    if ([string]::IsNullOrWhiteSpace($Json)) {
        return @{ Ok = $false; Reason = 'the checks printed no verdict' }
    }

    $document = $null
    try { $document = $Json | ConvertFrom-Json } catch {
        return @{ Ok = $false; Reason = 'the verdict is not readable as JSON' }
    }
    if ($null -eq $document) {
        return @{ Ok = $false; Reason = 'the verdict is empty' }
    }

    if (-not (Test-JsonMember -Object $document -Name 'version')) {
        return @{ Ok = $false; Reason = 'the verdict carries no version' }
    }
    $version = $document.version
    if ($version -ne $PsilinkVerdictVersion) {
        return @{ Ok = $false
                  Reason = "the verdict is version $version and this launcher reads version $PsilinkVerdictVersion" }
    }

    if (-not (Test-JsonMember -Object $document -Name 'overall')) {
        return @{ Ok = $false; Reason = 'the verdict carries no overall value' }
    }
    $overall = [string] $document.overall
    if ($PsilinkOverallValues -notcontains $overall) {
        return @{ Ok = $false; Reason = "the verdict's overall value '$overall' is not one this launcher knows" }
    }

    $checks = @()
    if (Test-JsonMember -Object $document -Name 'checks') {
        foreach ($entry in @($document.checks)) {
            if ($null -eq $entry) { continue }
            if (-not (Test-JsonMember -Object $entry -Name 'id')) {
                return @{ Ok = $false; Reason = 'a check in the verdict carries no id' }
            }
            if (-not (Test-JsonMember -Object $entry -Name 'status')) {
                return @{ Ok = $false; Reason = 'a check in the verdict carries no status' }
            }
            $status = [string] $entry.status
            if ($PsilinkStatusValues -notcontains $status) {
                return @{ Ok = $false; Reason = "the check status '$status' is not one this launcher knows" }
            }
            $checks += @{
                Id      = [string] $entry.id
                Status  = $status
                Meaning = Get-JsonText -Object $entry -Name 'meaning'
                Action  = Get-JsonText -Object $entry -Name 'action'
            }
        }
    }

    return @{ Ok = $true; Reason = ''; Overall = $overall; Checks = $checks }
}

function Select-DoctorChecks {
    <#  The checks carrying one of the named statuses, in verdict order. Checks
        are found by status and id; nothing here keys on an entry's position,
        which the verdict does not fix. #>
    param($Verdict, [string[]] $Status)

    $selected = @()
    foreach ($check in @($Verdict.Checks)) {
        if ($Status -contains $check.Status) { $selected += $check }
    }
    # Returned through the comma operator so an empty result stays an empty
    # array. Bare, PowerShell unrolls it to nothing, and "foreach ($x in $null)"
    # then runs its body once with a null -- which would print a check that is
    # not there.
    return , $selected
}

function Show-DoctorCheck {
    <#  One check, as the operator reads it, with MEANING and ACTION as the
        container wrote them. The status alone decides the label: severity is
        never inferred from which optional fields a check happens to carry. #>
    param($Check)

    switch ($Check.Status) {
        'fail' { Show-Fail $Check.Id }
        'warn' { Show-Alert $Check.Id }
        'skipped' { Show-Info "SKIP  $($Check.Id)" }
        default { Show-Ok $Check.Id }
    }
    if ($Check.Meaning) { Show-FromContainer "MEANING: $($Check.Meaning)" }
    if ($Check.Action) { Show-FromContainer "ACTION:  $($Check.Action)" }
}

function Invoke-DoctorBattery {
    <#  Run one battery and report what it said. $BatteryArgs are the doctor's
        own arguments; $EngineArgs are what the engine needs to reach the folder
        (a bind mount, or the network-share volume).

        Returns a hashtable: Established (whether a verdict was read at all),
        Overall, Reason. #>
    param(
        [Parameter(Mandatory = $true)][string[]] $EngineArgs,
        [Parameter(Mandatory = $true)][string[]] $BatteryArgs
    )

    $run = Invoke-EngineCapture -EngineArgs (@('run', '--rm') + $EngineArgs + @((Get-PsilinkImage)) + $BatteryArgs + @('--json'))

    # Docker reserves 125 and above for its own failure to start a container,
    # and every verdict code is below it -- so this is "the checks never ran"
    # rather than anything about the folder.
    if ($run.ExitCode -ge 125) {
        Show-Fail "The container could not be started (exit $($run.ExitCode))."
        Show-Note 'Nothing about your folder was tested. The message the engine'
        Show-Note 'printed above is the one to read. A first run also fetches the'
        Show-Note 'image, which needs a network that can reach the registry.'
        return @{ Established = $false }
    }

    $verdict = Read-DoctorVerdict -Json $run.Output
    if (-not $verdict.Ok) {
        Show-Fail "The checks did not produce a verdict this launcher can read: $($verdict.Reason)."
        Show-Note 'Use the launcher published with the image you are running.'
        return @{ Established = $false }
    }

    switch ($verdict.Overall) {
        'ok' {
            # A warn does not stop an exchange and still has to be read, so it
            # is surfaced here rather than swallowed by the roll-up.
            foreach ($check in (Select-DoctorChecks -Verdict $verdict -Status @('warn'))) {
                Show-DoctorCheck $check
            }
            Show-Ok 'Nothing here blocks an exchange.'
        }
        'fix_and_retry' {
            Write-Host ''
            foreach ($check in (Select-DoctorChecks -Verdict $verdict -Status @('fail', 'warn'))) {
                Show-DoctorCheck $check
            }
            Write-Host ''
            Write-Host 'Do what the ACTION lines say, then run the checks again.'
        }
        'fatal' {
            Write-Host ''
            foreach ($check in (Select-DoctorChecks -Verdict $verdict -Status @('fail'))) {
                Show-DoctorCheck $check
            }
            Write-Host ''
            Show-Fail 'The checks could not be run, so nothing was established.'
            Show-Note 'There is no ACTION to follow: the checks that would have'
            Show-Note 'produced one never ran.'
            Show-Info "See $PsilinkTroubleshootingUrl"
        }
    }
    return @{ Established = $true; Overall = $verdict.Overall }
}

function Invoke-DoctorLoop {
    <#  Run a battery until it passes, the operator gives up, or it reports
        something no retry will change. #>
    param(
        [Parameter(Mandatory = $true)][string[]] $EngineArgs,
        [Parameter(Mandatory = $true)][string[]] $BatteryArgs
    )

    while ($true) {
        $result = Invoke-DoctorBattery -EngineArgs $EngineArgs -BatteryArgs $BatteryArgs
        if (-not $result.Established) { return $false }
        if ($result.Overall -eq 'ok') { return $true }
        if ($result.Overall -eq 'fatal') { return $false }

        Write-Host ''
        $answer = Read-Host 'Run the checks again? [Y/n]'
        if ($answer -and $answer -notmatch '^\s*(y|yes)\s*$') {
            Write-Host ''
            Show-Note 'Stopping without starting the console.'
            return $false
        }
    }
}

# ==========================================================================
# DFS: suggest and confirm
# ==========================================================================

function Get-SmbConnectionCandidates {
    <#  The machine's live SMB connections as server/share pairs, or an empty
        array. Reading them needs Administrator rights, so an ordinary operator
        session answers nothing here -- which is why every caller has a manual
        route to fall back to rather than depending on this. #>

    try {
        $connections = Get-SmbConnection -ErrorAction SilentlyContinue
    } catch { return @() }
    if (-not $connections) { return @() }
    return @($connections)
}

function Select-DfsCandidate {
    <#  Given the machine's SMB connections and the namespace path Windows
        reported, decide whether there is a single real server and share to
        offer as a correction.

        Both halves are matched, never the server alone: a DFS namespace and its
        target can differ in server, share and subfolder at once, and
        substituting only the server produces a device that cannot exist.

        Returns Outcome = 'offer' (with Server and Share), 'none', or 'several'.
        Anything but 'offer' means the caller falls back to the manual route --
        which is load-bearing rather than an edge case, because a non-elevated
        session sees no connections at all. #>
    param(
        $Connections,
        [string] $NamespaceServer,
        [string] $NamespaceShare
    )

    $candidates = @()
    $seen = @()
    foreach ($connection in @($Connections)) {
        if ($null -eq $connection) { continue }
        $server = [string] $connection.ServerName
        $share = [string] $connection.ShareName
        if (-not $server -or -not $share) { continue }
        # IPC$ is the named-pipe share every connection carries; it is never a
        # file-drop target.
        if ($share -eq 'IPC$') { continue }
        if ($server -eq $NamespaceServer -and $share -eq $NamespaceShare) { continue }
        $key = "$server/$share"
        if ($seen -contains $key) { continue }
        $seen += $key
        $candidates += @{ Server = $server; Share = $share }
    }

    if ($candidates.Count -eq 0) { return @{ Outcome = 'none'; Count = 0 } }
    if ($candidates.Count -gt 1) { return @{ Outcome = 'several'; Count = $candidates.Count } }
    return @{ Outcome = 'offer'; Count = 1
              Server = $candidates[0].Server; Share = $candidates[0].Share }
}

function Show-DfsManualRoute {
    Show-Info 'Open the folder in File Explorer, right-click, Properties, and'
    Show-Info 'read the DFS tab: it names the real server, share and folder.'
    Show-Info 'Then run Setup-PsilinkFileDrop.ps1 with those three:'
    Show-Info ''
    Show-Info '    .\Setup-PsilinkFileDrop.ps1 -Server fs-04.agency.gov -Share ''exchange$'' -SubPath dropbox'
    Show-Info ''
    Show-Info "See $PsilinkTroubleshootingUrl, 'Reading the real path from Windows'."
}

function Resolve-DfsSuggestion {
    <#  Offer a correction when the machine's SMB connections name exactly one
        real server and share behind the namespace, and fall back to the manual
        route otherwise. Never substitutes silently: the operator confirms.

        Returns a hashtable with Accepted, Server and Share. #>
    param([string] $NamespaceServer, [string] $NamespaceShare)

    $candidate = Select-DfsCandidate -Connections (Get-SmbConnectionCandidates) `
        -NamespaceServer $NamespaceServer -NamespaceShare $NamespaceShare

    if ($candidate.Outcome -ne 'offer') {
        Write-Host ''
        if ($candidate.Outcome -eq 'several') {
            Show-Note 'This PC holds connections to several shares, so there is no'
            Show-Note 'single one to suggest.'
        } else {
            Show-Note 'Windows would not say what is behind that path. Reading the'
            Show-Note 'connection list needs an Administrator window, and an'
            Show-Note 'elevated window cannot see the drive letters you mapped as'
            Show-Note 'yourself -- so that is not the way round it.'
        }
        Write-Host ''
        Show-DfsManualRoute
        return @{ Accepted = $false }
    }

    Write-Host ''
    Show-Alert 'This PC holds one connection that may be what is really behind it:'
    Show-Note ''
    Show-Note "    Server: $($candidate.Server)"
    Show-Note "    Share:  $($candidate.Share)"
    Show-Note ''
    Show-Note 'That is a guess read off this PC''s connection list, not an answer'
    Show-Note 'from the namespace. The folder underneath the share stays yours to'
    Show-Note 'check; a wrong one is caught by the check file, below, before any'
    Show-Note 'exchange runs.'
    Write-Host ''
    $answer = Read-Host 'Use that server and share? [y/N]'
    if ($answer -match '^\s*(y|yes)\s*$') {
        return @{ Accepted = $true; Server = $candidate.Server; Share = $candidate.Share }
    }

    Write-Host ''
    Show-DfsManualRoute
    return @{ Accepted = $false }
}

# ==========================================================================
# Picking folders
# ==========================================================================

function Test-FolderPickerAvailable {
    <#  Whether a native folder picker can be opened in this session. A
        locked-down endpoint (WDAC or AppLocker, which put PowerShell in
        ConstrainedLanguage) blocks the .NET types it needs, and so does a
        session with no desktop -- both are ordinary here, so this is asked
        rather than assumed and the typed prompt is a first-class route rather
        than an error path. #>

    if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { return $false }
    try {
        Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
        $null = New-Object System.Windows.Forms.FolderBrowserDialog
        return $true
    } catch { return $false }
}

function Select-HostFolder {
    <#  A folder from the operator, through the picker where the session allows
        one and a typed path where it does not. Returns an empty string when the
        operator declines. #>
    param([string] $Prompt)

    if (Test-FolderPickerAvailable) {
        try {
            Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
            $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
            $dialog.Description = $Prompt
            $dialog.ShowNewFolderButton = $true
            if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
                return $dialog.SelectedPath
            }
            return ''
        } catch {
            Show-Note 'The folder picker would not open; type the path instead.'
        }
    }

    Write-Host ''
    Write-Host $Prompt
    Write-Host 'Click once in the File Explorer address bar to copy it as text.'
    return (Read-Host 'Folder')
}

# ==========================================================================
# The console
# ==========================================================================

function Test-ConsoleAnswering {
    <#  Whether anything answers on the loopback port.

        Test-NetConnection rather than a web request: it asks the port itself,
        where a request would be routed through whatever proxy this machine's
        settings name, and it is a cmdlet rather than a .NET type, so it also
        works in a session whose language mode is constrained. The web request
        is the fallback for a Windows without the NetTCPIP module. #>
    param([int] $ConsolePort)

    if (Get-Command Test-NetConnection -ErrorAction SilentlyContinue) {
        try {
            return [bool](Test-NetConnection -ComputerName '127.0.0.1' -Port $ConsolePort `
                    -InformationLevel Quiet -WarningAction SilentlyContinue -ErrorAction Stop)
        } catch { return $false }
    }
    try {
        $null = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$ConsolePort/" -TimeoutSec 5
        return $true
    } catch { return $false }
}

function Wait-ForConsole {
    param([int] $ConsolePort, [int] $TimeoutSeconds = 600)

    $waited = 0
    while ($waited -lt $TimeoutSeconds) {
        if (Test-ConsoleAnswering -ConsolePort $ConsolePort) { return $true }
        Start-Sleep -Seconds 2
        $waited += 2
    }
    return $false
}

function Get-RendezvousFolderName {
    <#  The name of the folder shared with the partner, as the operator knows
        it, for the console to mint into the invitation.

        The console cannot work this out for itself here. It sees only the
        container's side of the mount, and this script picks that side: every
        folder an operator chooses is bound at the same /rendezvous, and a
        single-folder run rendezvouses out of /data. So the last segment of what
        the container sees names this script's layout, not the operator's
        folder, and the name has to be passed in beside the mount.

        A network share is not mounted by path at all -- the volume stands for a
        server and share -- so the name comes from the resolved share: the last
        segment of the subfolder within it, or the share itself when the folder
        IS the share root.

        Returns an empty string when there is no folder name to give: a drive
        root has none, and neither has a path this script could not read a last
        segment out of. That empty string is passed to the console as it stands,
        which is what leaves the console with no name for the folder at all;
        naming the drive letter instead would be a name no partner could match. #>
    param(
        [string] $Path = '',
        [string] $Share = '',
        [string] $SubPath = ''
    )

    $source = if ($Share) { if ($SubPath) { $SubPath } else { $Share } } else { $Path }
    $segments = @($source -split '[\\/]+' | Where-Object { $_ })
    if ($segments.Count -eq 0) { return '' }
    $name = $segments[-1].Trim()
    # A bare drive designator (C:) is what a drive root reduces to, and it names
    # a drive rather than a folder.
    if ($name -match '^[A-Za-z]:$') { return '' }
    return $name
}

function Get-ConsoleEngineArgs {
    <#  The engine's argument vector for the console.

        The publish binding carries the whole of the console's reachability: the
        job API has no authentication, and the 127.0.0.1: prefix is what keeps
        it on this machine. --rm is the other half of the posture -- the
        container keeps nothing, and everything the exchange produces is in the
        operator's own folders.

        The rendezvous folder's name is passed whether or not a rendezvous mount
        is, and whether or not this script could work one out. A single-folder
        console rendezvouses out of the data mount, and the operator's folder
        still has a name the partner's copy of the invitation should carry; an
        empty value is what tells the console this script could not name the
        folder. Omitting the variable would instead have the console name the
        folder after the mount point THIS script picked -- "rendezvous" or
        "data", a name no partner could match. #>
    param(
        [Parameter(Mandatory = $true)][string] $ContainerName,
        [Parameter(Mandatory = $true)][int] $ConsolePort,
        [Parameter(Mandatory = $true)][string] $DataMount,
        [string] $InputMount = '',
        [string] $RendezvousMount = '',
        [string] $RendezvousName = ''
    )

    $engineArgs = @(
        'run', '--rm', '--detach', '--name', $ContainerName,
        '--publish', "127.0.0.1:${ConsolePort}:3000",
        '--env', 'JOB_DATA_ROOT=/data', '--volume', "${DataMount}:/data")
    if ($InputMount) {
        $engineArgs += @('--env', 'JOB_INPUT_DIR=/input', '--volume', "${InputMount}:/input")
    }
    if ($RendezvousMount) {
        $engineArgs += @('--env', 'JOB_RENDEZVOUS_DIR=/rendezvous', '--volume', "${RendezvousMount}:/rendezvous")
    }
    $engineArgs += @('--env', "JOB_RENDEZVOUS_NAME=$RendezvousName")
    return $engineArgs + @((Get-PsilinkImage), 'serve')
}

# ==========================================================================
# The setup script's functions
# ==========================================================================

function Get-ScriptParameterName {
    <#  The parameter names a script declares, read out of the file itself
        rather than from a list kept here: it is the two param() blocks that
        collide when this script dot-sources the other, so the names they
        collide over are theirs to state and not this script's to remember. #>
    param([string] $Path)

    $ast = [System.Management.Automation.Language.Parser]::ParseFile($Path, [ref] $null, [ref] $null)
    if (-not $ast -or -not $ast.ParamBlock) { return @() }
    return @($ast.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath })
}

# Everything above defines something; everything below runs the launcher. A
# dot-source that asked for the definitions alone stops here.
if ($LoadFunctionsOnly) { return }

# ==========================================================================
# Preflight
# ==========================================================================
Show-Head 'psilink console'

if (-not (Assert-PsilinkImageStamp)) { exit 1 }

$script:PsilinkEngine = Find-ContainerEngine
if (-not $script:PsilinkEngine) {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue) -and
        -not (Get-Command podman -ErrorAction SilentlyContinue)) {
        Show-Fail 'Neither docker nor podman is installed on this PC.'
        Show-Note 'Install Docker Desktop, start it, and run this again.'
    } else {
        Show-Fail 'A container engine is installed but is not answering.'
        Show-Note 'Start Docker Desktop and wait for the whale icon to stop'
        Show-Note 'animating. "Access is denied" instead means your account is'
        Show-Note 'not in the local docker-users group, which an administrator'
        Show-Note 'has to add you to.'
    }
    exit 1
}
if (Test-WindowsContainerMode -Engine $script:PsilinkEngine) {
    Show-Fail 'Docker Desktop is in Windows containers mode.'
    Show-Note 'psilink and these checks are Linux containers. In this mode the'
    Show-Note 'engine answers normally and then every container fails to start.'
    Show-Info ''
    Show-Info 'Right-click the Docker whale icon in the notification area and'
    Show-Info 'choose "Switch to Linux containers...", then run this again.'
    exit 1
}
Show-Ok "Using $script:PsilinkEngine."

# Setup-PsilinkFileDrop.ps1 owns the Explorer-path-to-server-and-share
# resolution, and this script reuses it rather than carrying a second copy. It
# is loaded with -LoadFunctionsOnly, which defines its functions and runs none
# of its setup flow.
$setupScript = Join-Path $PSScriptRoot 'Setup-PsilinkFileDrop.ps1'
$canResolveNetworkPaths = $false
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
    Show-Alert "PowerShell is in $($ExecutionContext.SessionState.LanguageMode) mode."
    Show-Note 'An application-control policy on this PC has restricted what'
    Show-Note 'scripts may do. A folder on this PC still works; a network folder'
    Show-Note 'needs the Command Prompt setup script, which the same policy does'
    Show-Note "not reach. See $PsilinkTroubleshootingUrl, 'The script will not run'."
} elseif (-not (Test-Path -LiteralPath $setupScript)) {
    Show-Alert 'Setup-PsilinkFileDrop.ps1 is not in this folder.'
    Show-Note 'It has to sit beside this script: it is what works out the real'
    Show-Note 'server behind a mapped drive or a network path. Without it, only'
    Show-Note 'a folder on this PC can be used.'
} else {
    # A dot-source runs the other script's own param() block in this scope. Left
    # alone, that resets every name the two scripts share -- -VolumeName -- to
    # the setup script's default, discarding what the operator typed here, and
    # leaves the rest of its parameters behind as variables this script never
    # declared. Both are undone around the dot-source, and the names come from
    # asking each script for its own parameters rather than from a list kept by
    # hand, so that a parameter added to either one later cannot collide in
    # silence.
    $launcherParameterNames = @(Get-ScriptParameterName -Path $PSCommandPath)
    $launcherParameterValues = @{}
    foreach ($name in $launcherParameterNames) {
        $held = Get-Variable -Name $name -Scope 0 -ErrorAction SilentlyContinue
        if ($held) { $launcherParameterValues[$name] = $held.Value }
    }
    $importedNames = @()
    foreach ($name in @(Get-ScriptParameterName -Path $setupScript)) {
        if ($launcherParameterNames -contains $name) { continue }
        if (Get-Variable -Name $name -Scope 0 -ErrorAction SilentlyContinue) { continue }
        $importedNames += $name
    }

    . $setupScript -LoadFunctionsOnly

    foreach ($name in @($launcherParameterValues.Keys)) {
        Set-Variable -Name $name -Scope 0 -Value $launcherParameterValues[$name]
    }
    foreach ($name in $importedNames) {
        Remove-Variable -Name $name -Scope 0 -ErrorAction SilentlyContinue
    }
    $canResolveNetworkPaths = $true
}

# ==========================================================================
# Part 1: the folders
# ==========================================================================
Show-Head 'Part 1: the folders the console works in'

Write-Host 'The console needs somewhere to keep this exchange: your input CSV,'
Write-Host 'the key file, and the results it writes back.'
Write-Host ''
Write-Host 'One folder for all of it is the simplest console, and the one to'
Write-Host 'start with. Separate folders keep the partner-written rendezvous away'
Write-Host 'from your own files, which is worth doing once this works.'

if (-not $DataRoot) {
    Write-Host ''
    $answer = Read-Host 'Use one folder for everything? [Y/n]'
    $splitFolders = $answer -and $answer -notmatch '^\s*(y|yes)\s*$'
    $dataRootPrompt = 'The folder this exchange works in'
    if ($splitFolders) { $dataRootPrompt = 'The working folder (key file and results)' }
    $DataRoot = Select-HostFolder -Prompt $dataRootPrompt
    if (-not $DataRoot) {
        Show-Fail 'No folder chosen.'
        exit 1
    }
    if ($splitFolders) {
        $InputDir = Select-HostFolder -Prompt 'The folder holding your input CSVs'
        if (-not $InputDir) {
            Show-Fail 'No folder chosen.'
            exit 1
        }
        $RendezvousDir = Select-HostFolder -Prompt 'The folder shared with your partner'
        if (-not $RendezvousDir) {
            Show-Fail 'No folder chosen.'
            exit 1
        }
    }
}

# The working folder holds the key file and the results the exchange writes
# back, and the input folder holds data the CLI reads in place: both are yours
# and stay on this PC. Only the folder shared with the partner may be a network
# share, which is the one the volume below exists for.
foreach ($pair in @(@{ Label = 'working folder'; Path = $DataRoot },
        @{ Label = 'input folder'; Path = $InputDir })) {
    if (-not $pair.Path) { continue }
    $resolvedKind = 'Local'
    if ($canResolveNetworkPaths) { $resolvedKind = (Resolve-DropPath -Raw $pair.Path).Kind }
    if ($resolvedKind -ne 'Local') {
        Show-Fail "The $($pair.Label) is not a folder on this PC."
        Show-Note 'It holds your own files -- the key file, your input CSV, and the'
        Show-Note 'results -- so it has to be local. Only the folder you share with'
        Show-Note 'your partner can be a network share.'
        exit 1
    }
    if (-not (Test-Path -LiteralPath $pair.Path)) {
        Show-Fail "There is no folder at $($pair.Path) (the $($pair.Label))."
        Show-Note 'Create it first, then run this again.'
        exit 1
    }
}

# The rendezvous folder is the one the partner writes into and the one the
# exchange's own rendezvous semantics have to hold over, so it is the folder the
# checks below are run against. Absent a separate one, that is the data root.
$rendezvousPath = if ($RendezvousDir) { $RendezvousDir } else { $DataRoot }

$rendezvousResolved = @{ Kind = 'Local'; LocalPath = $rendezvousPath }
if ($canResolveNetworkPaths) { $rendezvousResolved = Resolve-DropPath -Raw $rendezvousPath }

if ($rendezvousResolved.Kind -eq 'Unknown') {
    Show-Fail 'Could not use that folder.'
    Write-Host ''
    Show-Note "$($rendezvousResolved.Reason)."
    exit 1
}

$inputLabel = "$DataRoot (the working folder)"
if ($InputDir) { $inputLabel = $InputDir }

Write-Host ''
Show-Ok "Working folder:    $DataRoot"
Show-Ok "Input folder:      $inputLabel"
Show-Ok "Rendezvous folder: $rendezvousPath"

# ==========================================================================
# Part 2: make the rendezvous folder reachable from the container
# ==========================================================================
$rendezvousMount = $rendezvousPath
$usingVolume = $false
# The folder's own name, worked out here and passed to the console, because the
# container is shown this script's mount points rather than the operator's folder.
$rendezvousFolderName = Get-RendezvousFolderName -Path $rendezvousPath

if ($rendezvousResolved.Kind -eq 'Network') {
    Show-Head 'Part 2: the network folder'

    $server = $rendezvousResolved.Server
    $share = $rendezvousResolved.Share
    $subPath = $rendezvousResolved.SubPath

    Write-Host 'Docker cannot open a network folder directly -- its engine runs in'
    Write-Host 'a Linux virtual machine that cannot see Windows drive letters or'
    Write-Host 'network paths. It has to be given the server and share instead, and'
    Write-Host 'a username and password of its own to reach them with.'
    Write-Host ''
    Show-Ok "Server:       $server"
    Show-Ok "Share:        $share"
    Show-Ok "Subdirectory: $(if ($subPath) { $subPath } else { '(share root)' })"
    Write-Host ''
    Write-Host 'Everything below depends on those three being right, and one case'
    Write-Host 'where they will not be is a DFS path: it names a namespace rather'
    Write-Host 'than a machine, and the real server, share and folder can all be'
    Write-Host 'different.'
    Write-Host ''

    $answer = Read-Host 'Are those correct? [Y/n]'
    if ($answer -and $answer -notmatch '^\s*(y|yes)\s*$') {
        $suggestion = Resolve-DfsSuggestion -NamespaceServer $server -NamespaceShare $share
        if (-not $suggestion.Accepted) { exit 1 }
        $server = $suggestion.Server
        $share = $suggestion.Share
        Write-Host ''
        Show-Ok "Server:       $server"
        Show-Ok "Share:        $share"
        Show-Ok "Subdirectory: $(if ($subPath) { $subPath } else { '(share root)' })"
    }

    # From the share as resolved, and after any correction above: the drive letter
    # or namespace path the operator typed is theirs alone, and a volume is mounted
    # by server and share rather than by that path.
    $rendezvousFolderName = Get-RendezvousFolderName -Share $share -SubPath $subPath

    Show-Head 'Credentials for the file server'
    # Read-ShareCredential, and New-ShareVolume below, come from the setup script
    # dot-sourced above: those two sequences have been run against a real file
    # server there, and a second copy here would be a second copy to drift. This
    # branch cannot be reached without that dot-source, because classifying a
    # folder as a network path is the setup script's own function.
    $credential = Read-ShareCredential
    if (-not $credential) { exit 1 }
    $username = $credential.Username
    $domain = $credential.Domain
    $plainPass = $credential.Password

    $token = [Guid]::NewGuid().ToString('N')

    Show-Head 'Checking the share from inside a container'
    try {
        $env:SMB_SERVER = $server
        $env:SMB_SHARE = $share
        $env:SMB_PATH = $subPath
        $env:SMB_USER = $username
        $env:SMB_DOMAIN = $domain
        $env:SMB_MARKER = $PsilinkMarkerName
        $env:SMB_TOKEN = $token
        $env:SMB_PASS = $plainPass

        # The probe battery is the one that applies to a share nothing has
        # mounted yet: it asks the server directly over smbclient. The names are
        # passed by name rather than by value, so the password never becomes an
        # argv element any process listing on this PC could read.
        $probeEnvArgs = @(
            '--env', 'SMB_SERVER', '--env', 'SMB_SHARE', '--env', 'SMB_PATH',
            '--env', 'SMB_USER', '--env', 'SMB_DOMAIN', '--env', 'SMB_PASS',
            '--env', 'SMB_MARKER', '--env', 'SMB_TOKEN')
        if (-not (Invoke-DoctorLoop -EngineArgs $probeEnvArgs -BatteryArgs @('doctor', 'probe'))) {
            exit 1
        }

        Show-Head 'Creating the network-share volume'
        if ($script:PsilinkEngine -ne 'docker') {
            Show-Alert 'The volume options below have only ever been driven against docker.'
            Show-Note "$script:PsilinkEngine may reject or read them differently. If it"
            Show-Note 'does, its own message is the answer -- nothing here predicts'
            Show-Note 'what it will make of them.'
        }

        $volumeMade = New-ShareVolume -VolumeName $VolumeName `
            -Server $server -Share $share -SubPath $subPath `
            -Username $username -Password $plainPass -Domain $domain `
            -Engine $script:PsilinkEngine
        if (-not $volumeMade) { exit 1 }
        $rendezvousMount = $VolumeName
        $usingVolume = $true

        # The mount battery over the volume, carrying the same marker and token
        # the probe left behind. That cross-check is what catches a wrong
        # server, share or subfolder -- the DFS case -- before an exchange does,
        # and it is the backstop behind the suggestion offered above.
        Show-Head 'Checking the volume'
        if (-not (Invoke-DoctorLoop -EngineArgs @('--env', 'SMB_MARKER', '--env', 'SMB_TOKEN',
                    '--volume', "${VolumeName}:/rz") -BatteryArgs @('doctor', 'mount', '/rz'))) {
            exit 1
        }
    } finally {
        foreach ($name in 'SMB_SERVER', 'SMB_SHARE', 'SMB_PATH', 'SMB_USER', 'SMB_DOMAIN',
            'SMB_PASS', 'SMB_MARKER', 'SMB_TOKEN') {
            Remove-Item "env:$name" -ErrorAction SilentlyContinue
        }
        $plainPass = $null
        $credential = $null
    }
} else {
    # A folder on this PC is bind-mounted as it stands, so the kernel's view is
    # the only view there is -- and that is what the mount battery checks: the
    # write, the exclusive create, and the rename onto an existing file that
    # psilink's rendezvous is built on. There is no share to ask over the
    # network, so the probe battery does not apply.
    Show-Head 'Part 2: checking the rendezvous folder'
    if (-not (Invoke-DoctorLoop -EngineArgs @('--volume', "${rendezvousPath}:/rz") `
                -BatteryArgs @('doctor', 'mount', '/rz'))) {
        exit 1
    }
}

# ==========================================================================
# Part 3: the console
# ==========================================================================
Show-Head 'Part 3: starting the console'

Write-Host 'Nothing is kept between runs: the container is removed when it stops,'
Write-Host 'and everything the exchange produces is in your own folders.'
Write-Host ''

$containerName = "psilink-console-$PID"
# A rendezvous mount is passed only when the operator gave the partner-shared
# folder its own home; with one folder for everything the console falls back to
# JOB_DATA_ROOT, which is the shape docs/DEPLOYMENT.md calls the simplest one.
$rendezvousMountArgument = ''
if ($usingVolume -or $RendezvousDir) { $rendezvousMountArgument = $rendezvousMount }

$consoleArgs = Get-ConsoleEngineArgs -ContainerName $containerName -ConsolePort $Port `
    -DataMount $DataRoot -InputMount $InputDir -RendezvousMount $rendezvousMountArgument `
    -RendezvousName $rendezvousFolderName

$started = Invoke-EngineQuiet -EngineArgs $consoleArgs
if ($started.ExitCode -ne 0) {
    Show-Fail 'The console container would not start.'
    Write-Host ''
    Write-Host $started.Output
    exit 1
}

# The finally is what stops the detached container when Ctrl-C lands in the
# wait below. A window closed outright kills this process with no finally, so
# the on-screen line names the by-hand stop for that case.
try {
    $url = "http://127.0.0.1:$Port"
    if (Wait-ForConsole -ConsolePort $Port) {
        Show-Ok "The console is at $url"
        if (-not $NoBrowser) { Start-Process $url | Out-Null }
        Write-Host ''
        Show-Info 'Leave this window open while you use it.'
        Show-Info "If it closes without stopping the console, run: $script:PsilinkEngine stop $containerName"
    } else {
        Show-Fail "Nothing answered on $url."
        Write-Host ''
        Write-Host (Invoke-EngineQuiet -EngineArgs @('logs', $containerName)).Output
    }

    Write-Host ''
    Read-Host 'Press Enter to stop the console' | Out-Null
} finally {
    Invoke-EngineQuiet -EngineArgs @('stop', $containerName) | Out-Null
}
Write-Host ''
Write-Host 'The console has stopped.'
if ($usingVolume) {
    Write-Host ''
    Show-Alert "Docker stored the share password in cleartext in the volume's"
    Show-Note "metadata: '$script:PsilinkEngine volume inspect $VolumeName' shows it"
    Show-Note 'to anyone who can run Docker on this PC. When you are finished:'
    Show-Info ''
    Show-Info "    $script:PsilinkEngine volume rm $VolumeName"
    Show-Info ''
    Show-Info 'That removes the volume but not every trace of the password, so'
    Show-Info 'retire or rotate the account when the exchanges are done. The'
    Show-Info 'passwords page, "Ending the exposure", says why.'
}
