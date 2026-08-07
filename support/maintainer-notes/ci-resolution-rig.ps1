<#
.SYNOPSIS
    CI measurement harness. Not part of the operator guide: this file is run by
    .github/workflows/windows_resolution.yaml on a throwaway windows-latest
    runner, on manual dispatch, and an operator following the setup page never
    touches it.

.DESCRIPTION
    Two of the environments the file-drop guide describes had never been tested
    anywhere when this was written: a drive letter mapped to an SMB share, and a
    DFS namespace. This harness asks whether a GitHub windows-latest runner can
    host a rig for them, by building one and reporting what each step actually
    did. Setup-PsilinkFileDrop.Tests.ps1 is what asserts against the rig it
    proved possible.

    It measures; it does not assert. "No" is a result rather than a failure, so
    every question emits its annotation on both the success and the failure path,
    and the script always exits 0 -- a red job buries its annotations behind a
    failed check and answers nothing.

      Q1  Create a directory, share it with New-SmbShare, and write through
          \\localhost\<share>.
      Q2  Map a drive letter to that share with net use, then resolve the letter
          back to its UNC through each lookup surface separately.
      Q3  Install FS-DFS-Namespace, create a standalone namespace over a second
          share, link the Q1 share into it, and resolve through the namespace.

    Q2 mirrors Resolve-MappedDrive in Setup-PsilinkFileDrop.ps1 rather than
    calling it, by choice rather than by necessity: that script dot-sources with
    -LoadFunctionsOnly, and Setup-PsilinkFileDrop.Tests.ps1 drives the function
    itself. What the copy buys is the difference between the two questions.
    Resolve-MappedDrive returns the first surface that answers,
    while this reports all of them separately -- including the WScript.Network
    COM surface the script does not use -- because which surfaces answer is what
    this harness exists to measure. A change to the script's lookups still has to
    be made here too, or the measurement describes a script that no longer
    exists.

    Reporting contract, set by this run's reader rather than by taste: the session
    that reads it can read check-run annotations and nothing else, so a fact that
    reaches only the log is a fact nobody receives. Every measurement is therefore
    a single-line workflow-command annotation, at most nine of them, one per
    question, in "key=value key=value" form with any error last. Values are
    whitespace-collapsed and their spaces become underscores so that a field stays
    one token; only '%' is escaped, because %25 round-trips through GitHub's
    decoder while %0A and %0D would reintroduce the line breaks this format exists
    to avoid. The count is fixed rather than growing with the failures: GitHub
    surfaces only a bounded number of annotations per step (documented as ten of
    each type -- a figure this spike is itself the first chance to confirm), and a
    run whose errors crowded out its measurements would answer nothing.

    ::notice carries outcomes, including negative ones. ::error is reserved for
    the harness itself breaking -- a failure outside any question's own try/catch,
    which means the run measured nothing and the answer is "unknown", not "no".

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\ci-resolution-rig.ps1
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

# Long enough for a Windows error message to arrive whole, short enough that one
# annotation stays readable on a single line.
$script:MaxFieldLength = 320
$script:MaxLineLength = 800

function Format-FieldValue {
    <#  One field of a measurement, as a single token carrying no space. $null and
        the empty string both report as 'empty', which is itself a measurement --
        "this surface answered nothing" -- and is not the same as a field that was
        never emitted. #>
    param($Value)

    if ($null -eq $Value) { return 'empty' }
    if ($Value -is [bool]) {
        if ($Value) { return 'true' }
        return 'false'
    }

    $text = (([string] $Value) -replace '\s+', ' ').Trim()
    if ($text.Length -eq 0) { return 'empty' }
    if ($text.Length -gt $script:MaxFieldLength) {
        $text = $text.Substring(0, $script:MaxFieldLength) + '[cut]'
    }
    ($text -replace ' ', '_') -replace '%', '%25'
}

function Format-Line {
    <# A whole annotation body, collapsed onto one line. #>
    param($Text)

    $line = (([string] $Text) -replace '\s+', ' ').Trim()
    if ($line.Length -eq 0) { return 'empty' }
    if ($line.Length -gt $script:MaxLineLength) {
        $line = $line.Substring(0, $script:MaxLineLength) + '[cut]'
    }
    $line -replace '%', '%25'
}

function Write-Measurement {
    <# One question, one annotation, one line. #>
    param(
        [Parameter(Mandatory = $true)] [string] $Title,
        [Parameter(Mandatory = $true)] [System.Collections.IDictionary] $Fields
    )

    $parts = @()
    foreach ($key in $Fields.Keys) {
        $value = Format-FieldValue $Fields[$key]
        $parts += "$key=$value"
    }
    $body = $parts -join ' '
    Write-Output "::notice title=${Title}::${body}"
}

function Write-HarnessError {
    <# The harness broke. This is not an answer to any question. #>
    param($Text)

    $body = Format-Line $Text
    Write-Output "::error title=Harness::${body}"
}

function Invoke-Net {
    <#  Run net.exe and return its exit code and output together.

        $ErrorActionPreference is relaxed for the call: under 'Stop', Windows
        PowerShell turns a native command's stderr into an ErrorRecord and the
        merge makes it terminating, so capturing the failure text the way this
        harness wants would abort the very question that is trying to report
        it. #>
    param([string[]] $Arguments)

    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & net @Arguments 2>&1
        $exit = $LASTEXITCODE
        $text = ($output | ForEach-Object { [string] $_ }) -join ' '
        return [ordered]@{ Exit = $exit; Output = $text }
    } finally {
        $ErrorActionPreference = $previous
    }
}

function Get-ComNetworkDriveEntries {
    <#  The WScript.Network drive table, flattened to local, remote, local,
        remote... Enumeration is tried first and the Count/Item form second,
        because the PowerShell COM adapter surfaces WshCollection.Count as a
        property on some hosts and as a method on others, and an empty result
        from the wrong one would read as "this surface knows nothing" -- a wrong
        answer to the question the harness exists to settle. #>

    $network = New-Object -ComObject WScript.Network
    $collection = $network.EnumNetworkDrives()

    $entries = @($collection)
    if ($entries.Count -lt 2) {
        $entries = @()
        $count = [int] $collection.Count
        for ($i = 0; $i -lt $count; $i++) {
            $entries += [string] $collection.Item($i)
        }
    }
    , $entries
}

function Get-DriveLookups {
    <#  Every surface that can name the UNC behind a mapped drive letter, each
        reported on its own: the value it returned, 'empty' when it returned
        nothing, or 'failed:<message>' when it threw. Mirrors Resolve-MappedDrive
        in Setup-PsilinkFileDrop.ps1; the header says why it is a copy. #>
    param([string] $Letter)

    $lookups = [ordered]@{
        psdrive     = $null
        cim         = $null
        netuse      = $null
        com         = $null
        com_entries = 0
    }

    try {
        $psd = Get-PSDrive -Name $Letter -ErrorAction SilentlyContinue
        if ($psd -and $psd.DisplayRoot -and $psd.DisplayRoot -like '\\*') {
            $lookups.psdrive = $psd.DisplayRoot
        }
    } catch {
        $lookups.psdrive = "failed: $($_.Exception.Message)"
    }

    try {
        $connection = Get-CimInstance -ClassName Win32_NetworkConnection -ErrorAction SilentlyContinue |
            Where-Object { $_.LocalName -eq "${Letter}:" } |
            Select-Object -First 1
        if ($connection -and $connection.RemoteName) { $lookups.cim = $connection.RemoteName }
    } catch {
        $lookups.cim = "failed: $($_.Exception.Message)"
    }

    try {
        $netUse = Invoke-Net -Arguments @('use', "${Letter}:")
        if ($netUse.Exit -eq 0) {
            if ($netUse.Output -match '\\\\[^\s]+') { $lookups.netuse = $Matches[0] }
        } else {
            $lookups.netuse = "failed: net use exit $($netUse.Exit)"
        }
    } catch {
        $lookups.netuse = "failed: $($_.Exception.Message)"
    }

    try {
        $entries = Get-ComNetworkDriveEntries
        $lookups.com_entries = $entries.Count
        for ($i = 0; $i + 1 -lt $entries.Count; $i += 2) {
            if ($entries[$i] -eq "${Letter}:") {
                $lookups.com = $entries[$i + 1]
                break
            }
        }
    } catch {
        $lookups.com = "failed: $($_.Exception.Message)"
    }

    $lookups
}

function Get-DriveTypeName {
    <# What IO.DriveInfo calls the letter -- the reading Get-DriveKind in
       Setup-PsilinkFileDrop.ps1 classifies a drop path from. #>
    param([string] $Letter)

    try {
        return [string] (New-Object IO.DriveInfo("${Letter}:")).DriveType
    } catch {
        return "failed: $($_.Exception.Message)"
    }
}

function Find-FreeDriveLetter {
    <# A letter no drive and no PowerShell drive currently holds. #>
    param([string[]] $Exclude = @())

    foreach ($letter in @('Y', 'X', 'W', 'V', 'U', 'T', 'S', 'R')) {
        if ($Exclude -contains $letter) { continue }
        if (Test-Path -LiteralPath "${letter}:\" -ErrorAction SilentlyContinue) { continue }
        if (Get-PSDrive -Name $letter -ErrorAction SilentlyContinue) { continue }
        return $letter
    }
    return $null
}

function Test-WriteThrough {
    <#  Write a token through $ViaPath and confirm the bytes landed in $LandsIn --
        the only evidence that a path resolves to the storage it is supposed to
        resolve to, rather than merely accepting a write. #>
    param([string] $ViaPath, [string] $FileName, [string] $LandsIn)

    $result = [ordered]@{ Wrote = $false; Readback = $false; Landed = $false; Error = $null }
    try {
        $token = [guid]::NewGuid().ToString('N')
        $target = Join-Path $ViaPath $FileName
        Set-Content -LiteralPath $target -Value $token -Encoding Ascii
        $result.Wrote = $true
        $result.Readback = ((Get-Content -LiteralPath $target -Raw).Trim() -eq $token)
        $local = Join-Path $LandsIn $FileName
        if (Test-Path -LiteralPath $local) {
            $result.Landed = ((Get-Content -LiteralPath $local -Raw).Trim() -eq $token)
        }
    } catch {
        $result.Error = $_.Exception.Message
    }
    $result
}

# --- state the cleanup pass needs, whatever the run reaches -----------------
$suffix = [guid]::NewGuid().ToString('N').Substring(0, 8)
$dataShareName = "psilinkci$suffix"
$dfsShareName = "psilinkdfs$suffix"
$dataShareRoot = Join-Path $env:TEMP "psilink-ci-data-$suffix"
$dfsShareRoot = Join-Path $env:TEMP "psilink-ci-dfs-$suffix"
$dataUnc = "\\localhost\$dataShareName"
# The same share under the server's own name. DFS names its targets by server, so
# the namespace link cannot be pointed at the loopback form above.
$dataUncByServer = "\\$env:COMPUTERNAME\$dataShareName"
$mappedLetter = $null
$dfsLetter = $null
$namespacePath = $null
$namespaceLink = $null

# --- what the summary annotation reports ------------------------------------
$answers = [ordered]@{ q1 = 'unknown'; q2 = 'unknown'; q3 = 'unknown' }

try {
    # --- Q0: what this runner is --------------------------------------------
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    $operatingSystem = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction SilentlyContinue
    $computerSystem = Get-CimInstance -ClassName Win32_ComputerSystem -ErrorAction SilentlyContinue

    $runner = [ordered]@{
        caption      = $null
        version      = $null
        # 1 workstation, 2 domain controller, 3 server. Install-WindowsFeature,
        # and so the whole of Q3, exists only on the server product types.
        product_type = $null
        domain_role  = $null
        powershell   = $PSVersionTable.PSVersion.ToString()
        elevated     = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
        user         = $identity.Name
        computer     = $env:COMPUTERNAME
        mod_smbshare = [bool] (Get-Module -ListAvailable -Name SmbShare -ErrorAction SilentlyContinue)
        mod_srvmgr   = [bool] (Get-Module -ListAvailable -Name ServerManager -ErrorAction SilentlyContinue)
        mod_dfsn     = [bool] (Get-Module -ListAvailable -Name DFSN -ErrorAction SilentlyContinue)
    }
    if ($operatingSystem) {
        $runner.caption = $operatingSystem.Caption
        $runner.version = $operatingSystem.Version
        $runner.product_type = $operatingSystem.ProductType
    }
    if ($computerSystem) { $runner.domain_role = $computerSystem.DomainRole }
    Write-Measurement -Title 'Q0_runner' -Fields $runner

    # --- Q1: can the runner serve itself an SMB share? ----------------------
    try {
        # A hosted runner has no reason to be serving SMB, so the Server service
        # may be stopped. Start it rather than let Q1 answer "no" for a reason
        # the launcher-phase rig would simply have fixed -- and report both
        # states, since needing the start is itself part of the answer.
        $serverService = Get-Service -Name LanmanServer -ErrorAction SilentlyContinue
        $serverServiceBefore = 'absent'
        if ($serverService) {
            $serverServiceBefore = [string] $serverService.Status
            if ($serverService.Status -ne 'Running') {
                Start-Service -Name LanmanServer -ErrorAction SilentlyContinue
                $serverService = Get-Service -Name LanmanServer -ErrorAction SilentlyContinue
            }
        }
        $serverServiceNow = 'absent'
        if ($serverService) { $serverServiceNow = [string] $serverService.Status }

        New-Item -ItemType Directory -Path $dataShareRoot -Force | Out-Null
        # Full access for the runner's own account rather than Everyone: the rig
        # only ever reaches this share as itself, over loopback.
        New-SmbShare -Name $dataShareName -Path $dataShareRoot -FullAccess $identity.Name | Out-Null
        $share = Get-SmbShare -Name $dataShareName -ErrorAction SilentlyContinue
        $shareWrite = Test-WriteThrough -ViaPath $dataUnc -FileName 'q1-probe.txt' -LandsIn $dataShareRoot

        $sharePath = $null
        if ($share) { $sharePath = $share.Path }
        if ($share -and $shareWrite.Landed) { $answers.q1 = 'yes' } else { $answers.q1 = 'no' }

        Write-Measurement -Title 'Q1_share' -Fields ([ordered]@{
                server_service_before = $serverServiceBefore
                server_service        = $serverServiceNow
                created               = [bool] $share
                share                 = $dataShareName
                get_smbshare_path     = $sharePath
                unc                   = $dataUnc
                write_through_unc     = $shareWrite.Wrote
                readback_matches      = $shareWrite.Readback
                landed_in_dir         = $shareWrite.Landed
                error                 = $shareWrite.Error
            })
    } catch {
        $answers.q1 = 'no'
        Write-Measurement -Title 'Q1_share' -Fields ([ordered]@{
                created           = $false
                share             = $dataShareName
                unc               = $dataUnc
                write_through_unc = $false
                error             = $_.Exception.Message
            })
    }

    # --- Q2: does a mapped letter resolve back to its UNC? ------------------
    try {
        $candidate = Find-FreeDriveLetter
        if (-not $candidate) { throw 'no free drive letter on this runner' }

        $mapping = Invoke-Net -Arguments @('use', "${candidate}:", $dataUnc, '/persistent:no')
        if ($mapping.Exit -eq 0) { $mappedLetter = $candidate }

        if ($mappedLetter) {
            $lookups = Get-DriveLookups -Letter $mappedLetter
            $answered = @($lookups.psdrive, $lookups.cim, $lookups.netuse, $lookups.com) |
                Where-Object { $_ -and ($_ -notlike 'failed:*') }
            $agreeing = @($answered | Where-Object { $_ -eq $dataUnc })
            if ($agreeing.Count -gt 0) {
                $answers.q2 = "yes_$($agreeing.Count)_of_4"
            } else {
                $answers.q2 = 'no'
            }

            Write-Measurement -Title 'Q2_mapped' -Fields ([ordered]@{
                    letter      = "${mappedLetter}:"
                    target      = $dataUnc
                    netuse_exit = $mapping.Exit
                    psdrive     = $lookups.psdrive
                    cim         = $lookups.cim
                    netuse      = $lookups.netuse
                    com         = $lookups.com
                    com_entries = $lookups.com_entries
                })

            $letterWrite = Test-WriteThrough -ViaPath "${mappedLetter}:\" -FileName 'q2-probe.txt' -LandsIn $dataShareRoot
            $driveType = Get-DriveTypeName -Letter $mappedLetter
            Write-Measurement -Title 'Q2_letter' -Fields ([ordered]@{
                    letter               = "${mappedLetter}:"
                    drive_type           = $driveType
                    test_path            = [bool] (Test-Path -LiteralPath "${mappedLetter}:\" -ErrorAction SilentlyContinue)
                    write_through_letter = $letterWrite.Wrote
                    landed_in_dir        = $letterWrite.Landed
                    error                = $letterWrite.Error
                })
        } else {
            $answers.q2 = 'no'
            Write-Measurement -Title 'Q2_mapped' -Fields ([ordered]@{
                    letter      = $null
                    target      = $dataUnc
                    netuse_exit = $mapping.Exit
                    error       = $mapping.Output
                })
            Write-Measurement -Title 'Q2_letter' -Fields ([ordered]@{
                    letter = $null
                    error  = 'letter not mapped'
                })
        }
    } catch {
        $answers.q2 = 'no'
        Write-Measurement -Title 'Q2_mapped' -Fields ([ordered]@{
                letter = $mappedLetter
                target = $dataUnc
                error  = $_.Exception.Message
            })
        Write-Measurement -Title 'Q2_letter' -Fields ([ordered]@{
                letter = $mappedLetter
                error  = 'question aborted'
            })
    }

    # --- Q3a: is the DFS namespace role installable here? -------------------
    $dfsInstalled = $false
    try {
        Import-Module ServerManager -ErrorAction Stop
        $install = Install-WindowsFeature -Name FS-DFS-Namespace -IncludeManagementTools
        $service = Get-Service -Name Dfs -ErrorAction SilentlyContinue
        if ($service -and $service.Status -ne 'Running') {
            Start-Service -Name Dfs -ErrorAction SilentlyContinue
            $service = Get-Service -Name Dfs -ErrorAction SilentlyContinue
        }

        $installVerdict = 'FAILED'
        if ($install.Success) {
            $installVerdict = 'ok'
            $dfsInstalled = $true
        }
        $serviceStatus = $null
        if ($service) { $serviceStatus = $service.Status }

        Write-Measurement -Title 'Q3_install' -Fields ([ordered]@{
                install        = $installVerdict
                exit_code      = $install.ExitCode
                restart_needed = $install.RestartNeeded
                features       = (@($install.FeatureResult | ForEach-Object { $_.Name })) -join ','
                dfs_service    = $serviceStatus
                mod_dfsn       = [bool] (Get-Module -ListAvailable -Name DFSN -ErrorAction SilentlyContinue)
            })
    } catch {
        Write-Measurement -Title 'Q3_install' -Fields ([ordered]@{
                install = 'FAILED'
                error   = $_.Exception.Message
            })
    }

    # --- Q3b: does a standalone namespace come up over a share? -------------
    $namespaceUp = $false
    try {
        if (-not $dfsInstalled) { throw 'FS-DFS-Namespace is not installed' }

        New-Item -ItemType Directory -Path $dfsShareRoot -Force | Out-Null
        New-SmbShare -Name $dfsShareName -Path $dfsShareRoot -FullAccess $identity.Name | Out-Null

        # A standalone root is named by the share that hosts it, on the server's
        # own name: localhost is not accepted as a namespace server.
        $namespacePath = "\\$env:COMPUTERNAME\$dfsShareName"
        $root = New-DfsnRoot -TargetPath $namespacePath -Type Standalone
        $namespaceLink = "$namespacePath\drop"
        $folder = New-DfsnFolder -Path $namespaceLink -TargetPath $dataUncByServer
        $folderTarget = Get-DfsnFolderTarget -Path $namespaceLink -ErrorAction SilentlyContinue |
            Select-Object -First 1
        $namespaceUp = [bool] $folder

        $rootState = $null
        $rootType = $null
        if ($root) {
            $rootState = $root.State
            $rootType = $root.Type
        }
        $targetPath = $null
        $targetState = $null
        if ($folderTarget) {
            $targetPath = $folderTarget.TargetPath
            $targetState = $folderTarget.State
        }

        Write-Measurement -Title 'Q3_namespace' -Fields ([ordered]@{
                newdfsnroot   = 'ok'
                namespace     = $namespacePath
                root_state    = $rootState
                root_type     = $rootType
                newdfsnfolder = [bool] $folder
                link          = $namespaceLink
                folder_target = $targetPath
                target_state  = $targetState
            })
    } catch {
        Write-Measurement -Title 'Q3_namespace' -Fields ([ordered]@{
                newdfsnroot = 'FAILED'
                namespace   = $namespacePath
                error       = $_.Exception.Message
            })
    }

    # --- Q3c: what does a path through the namespace resolve to? ------------
    try {
        if (-not $namespaceUp) { throw 'no namespace to resolve through' }

        $namespaceWrite = Test-WriteThrough -ViaPath $namespaceLink -FileName 'q3-probe.txt' -LandsIn $dataShareRoot

        $dfsLookups = $null
        $dfsMapping = $null
        $candidate = Find-FreeDriveLetter -Exclude @($mappedLetter)
        if ($candidate) {
            $dfsMapping = Invoke-Net -Arguments @('use', "${candidate}:", $namespaceLink, '/persistent:no')
            if ($dfsMapping.Exit -eq 0) {
                $dfsLetter = $candidate
                $dfsLookups = Get-DriveLookups -Letter $dfsLetter
            }
        }

        # Whether Windows holds a connection to the namespace root, to the target,
        # or to both is an auto-resolution premise that has never been measured.
        $connections = (@(Get-SmbConnection -ErrorAction SilentlyContinue |
                    ForEach-Object { "$($_.ServerName)\$($_.ShareName)" }) | Sort-Object -Unique) -join '|'

        $resolve = [ordered]@{
            write_through_ns = $namespaceWrite.Wrote
            landed_in_target = $namespaceWrite.Landed
            letter           = $null
            netuse_exit      = $null
            psdrive          = $null
            cim              = $null
            netuse           = $null
            com              = $null
            smb_connections  = $connections
            error            = $namespaceWrite.Error
        }
        if ($dfsMapping) { $resolve.netuse_exit = $dfsMapping.Exit }
        if ($dfsLetter) { $resolve.letter = "${dfsLetter}:" }
        if ($dfsLookups) {
            $resolve.psdrive = $dfsLookups.psdrive
            $resolve.cim = $dfsLookups.cim
            $resolve.netuse = $dfsLookups.netuse
            $resolve.com = $dfsLookups.com
        }

        if ($namespaceWrite.Landed) { $answers.q3 = 'yes' } else { $answers.q3 = 'no' }
        Write-Measurement -Title 'Q3_resolve' -Fields $resolve
    } catch {
        $answers.q3 = 'no'
        Write-Measurement -Title 'Q3_resolve' -Fields ([ordered]@{
                write_through_ns = $false
                error            = $_.Exception.Message
            })
    }

    Write-Measurement -Title 'Q_summary' -Fields $answers
} catch {
    Write-HarnessError $_.Exception.Message
} finally {
    # Hygiene rather than necessity -- the runner is thrown away -- but it keeps a
    # re-run on any other host from meeting its own leftovers.
    $cleanup = [ordered]@{
        mapped     = 'skipped'
        dfs_letter = 'skipped'
        dfsn       = 'skipped'
        shares     = 'skipped'
        dirs       = 'skipped'
    }

    if ($mappedLetter) {
        $unmap = Invoke-Net -Arguments @('use', "${mappedLetter}:", '/delete', '/y')
        $cleanup.mapped = "exit_$($unmap.Exit)"
    }
    if ($dfsLetter) {
        $unmapDfs = Invoke-Net -Arguments @('use', "${dfsLetter}:", '/delete', '/y')
        $cleanup.dfs_letter = "exit_$($unmapDfs.Exit)"
    }

    if ($namespacePath) {
        try {
            if ($namespaceLink) {
                Remove-DfsnFolder -Path $namespaceLink -Force -ErrorAction SilentlyContinue
            }
            Remove-DfsnRoot -Path $namespacePath -Force -ErrorAction SilentlyContinue
            $cleanup.dfsn = 'ok'
        } catch {
            $cleanup.dfsn = 'failed'
        }
    }

    try {
        Remove-SmbShare -Name $dataShareName -Force -ErrorAction SilentlyContinue
        Remove-SmbShare -Name $dfsShareName -Force -ErrorAction SilentlyContinue
        $cleanup.shares = 'ok'
    } catch {
        $cleanup.shares = 'failed'
    }

    try {
        Remove-Item -LiteralPath $dataShareRoot -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $dfsShareRoot -Recurse -Force -ErrorAction SilentlyContinue
        $cleanup.dirs = 'ok'
    } catch {
        $cleanup.dirs = 'failed'
    }

    Write-Measurement -Title 'Q_cleanup' -Fields $cleanup
}

# Always green: the annotations above are the deliverable, and a failed job would
# bury them behind a red check.
exit 0
