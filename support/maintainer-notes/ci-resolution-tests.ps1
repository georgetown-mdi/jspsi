<#
.SYNOPSIS
    Runs this folder's Pester suites -- Setup-PsilinkFileDrop.Tests.ps1 and
    Start-Psilink.Tests.ps1 -- and reports the run as check-run annotations.
    Maintainer-facing: an operator following the setup page never touches it.

.DESCRIPTION
    .github/workflows/windows_resolution.yaml runs this on a windows-latest
    runner. Unlike ci-resolution-rig.ps1, which measures and is always green,
    this asserts: a failed test fails the job.

    Reporting contract, set by this run's reader rather than by taste: the
    session that reads it can read check-run annotations and nothing else, so a
    fact that reaches only the log is a fact nobody receives. Everything a
    reader needs is therefore an annotation, each on a single line:

      - one ::error per failed test, carrying the test's full name and the
        expectation that failed;
      - one ::notice summarising pass, fail and skip counts, with the Pester
        version the run used and where it came from;
      - one ::notice per rig premise, so that a runner which could not build the
        share, the mapped letter or the DFS namespace is distinguishable from a
        script that resolved a path wrongly;
      - ::error titled Harness for this script itself breaking, which means the
        run established nothing rather than that anything failed.

    The error annotations are capped below GitHub's per-step limit (documented
    as ten of each type) with a final line naming the remainder, so that a run
    with many failures still delivers its summary and its premises rather than
    crowding them out.

    Values are whitespace-collapsed and only '%' is escaped, because %25
    round-trips through GitHub's decoder while %0A and %0D would reintroduce the
    line breaks this format exists to avoid. The four formatting functions below
    are the same contract as ci-resolution-rig.ps1's, deliberately restated:
    that harness runs on its own and neither script should acquire a load order.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\ci-resolution-tests.ps1
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$script:MaxFieldLength = 320
$script:MaxLineLength = 800
$script:MaxErrorAnnotations = 9

function Format-FieldValue {
    <#  One field of a report, as a single token carrying no space. $null and the
        empty string both report as 'empty'. #>
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
    <# One fact, one annotation, one line. #>
    param(
        [Parameter(Mandatory = $true)] [string] $Title,
        [Parameter(Mandatory = $true)] [System.Collections.IDictionary] $Fields
    )

    $parts = @()
    foreach ($key in $Fields.Keys) {
        $parts += "$key=$(Format-FieldValue $Fields[$key])"
    }
    Write-Output "::notice title=${Title}::$($parts -join ' ')"
}

function Write-Failure {
    <# One failed test. #>
    param($Text)

    Write-Output "::error title=Test_failed::$(Format-Line $Text)"
}

function Write-HarnessError {
    <# This script broke. It is not a verdict on any test. #>
    param($Text)

    Write-Output "::error title=Harness::$(Format-Line $Text)"
}

function Get-TestTitle {
    <#  The full name of a test, block path included. Pester has spelled this
        more than one way across its 5.x line, so each spelling is tried rather
        than assumed. #>
    param($Test)

    if ($Test.PSObject.Properties.Match('ExpandedPath').Count -gt 0 -and $Test.ExpandedPath) {
        return [string] $Test.ExpandedPath
    }
    if ($Test.PSObject.Properties.Match('Path').Count -gt 0 -and $Test.Path) {
        return (@($Test.Path) -join ' > ')
    }
    return [string] $Test.Name
}

function Get-TestReason {
    <# What the test says failed, preferring Pester's own rendering of it. #>
    param($Test)

    $record = @($Test.ErrorRecord) | Select-Object -First 1
    if (-not $record) { return 'no error record on the failed test' }

    $reason = [string] $record
    if ($record.PSObject.Properties.Match('DisplayErrorMessage').Count -gt 0 -and $record.DisplayErrorMessage) {
        $reason = [string] $record.DisplayErrorMessage
    } elseif ($record.Exception -and $record.Exception.Message) {
        $reason = [string] $record.Exception.Message
    }

    # The annotation is the only diagnostic that leaves the runner, so a
    # thrown (non-assertion) failure must say where it threw.
    $stack = $null
    if ($record.PSObject.Properties.Match('DisplayStackTrace').Count -gt 0 -and $record.DisplayStackTrace) {
        $stack = [string] $record.DisplayStackTrace
    } elseif ($record.ScriptStackTrace) {
        $stack = [string] $record.ScriptStackTrace
    }
    if ($stack) {
        $firstFrame = @($stack -split "`r?`n")[0]
        $reason = "$reason at $firstFrame"
    }
    return $reason
}

function Write-RigPremises {
    <#  The rig the suite built, as the suite recorded it. Absent means the rig
        block was never entered -- a different fact from a rig that failed to
        build, and one only this annotation carries. #>

    $premises = Get-Variable -Name 'PsilinkRigPremises' -Scope Global -ValueOnly -ErrorAction SilentlyContinue
    if (-not $premises) {
        Write-Measurement -Title 'Rig' -Fields ([ordered]@{ state = 'absent' })
        return
    }
    foreach ($group in $premises.Keys) {
        Write-Measurement -Title "Rig_$group" -Fields $premises[$group]
    }
}

$failedJob = $false

try {
    # Named one by one rather than discovered by mask: a suite that was renamed
    # or lost would otherwise leave the job green having run whatever remained.
    $testFiles = @('Setup-PsilinkFileDrop.Tests.ps1', 'Start-Psilink.Tests.ps1') |
        ForEach-Object { Join-Path $PSScriptRoot $_ }
    foreach ($file in $testFiles) {
        if (-not (Test-Path -LiteralPath $file)) { throw "a suite is not at $file" }
    }

    # --- Pester -------------------------------------------------------------
    # The runner image is expected to carry Pester 5; Windows PowerShell also
    # ships 3.4.0 in the box, which cannot run this suite, so the version is
    # chosen rather than imported by name. Which of the two paths a run took is
    # reported, because a gallery install is a network dependency this job would
    # otherwise appear not to have.
    $pesterSource = 'preinstalled'
    $pester = Get-Module -ListAvailable -Name Pester |
        Where-Object { $_.Version.Major -ge 5 } |
        Sort-Object Version -Descending |
        Select-Object -First 1

    if (-not $pester) {
        $pesterSource = 'gallery'
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Install-PackageProvider -Name NuGet -MinimumVersion '2.8.5.201' -Force -Scope CurrentUser | Out-Null
        Install-Module -Name Pester -MinimumVersion '5.0.0' -Force -SkipPublisherCheck -Scope CurrentUser
        $pester = Get-Module -ListAvailable -Name Pester |
            Where-Object { $_.Version.Major -ge 5 } |
            Sort-Object Version -Descending |
            Select-Object -First 1
    }
    if (-not $pester) { throw 'no Pester 5 is available on this runner and none could be installed' }

    Import-Module -Name $pester.Path -Force

    if (Get-Command New-PesterConfiguration -ErrorAction SilentlyContinue) {
        $configuration = New-PesterConfiguration
    } else {
        $configuration = [PesterConfiguration]::Default
    }
    $configuration.Run.Path = $testFiles
    $configuration.Run.PassThru = $true
    # This script owns the exit code, so that the annotations below are emitted
    # before the job ends.
    $configuration.Run.Exit = $false
    $configuration.Output.Verbosity = 'Detailed'

    $result = Invoke-Pester -Configuration $configuration

    # --- the report ---------------------------------------------------------
    # Counts are taken from the tests themselves rather than from the result's
    # count properties, which have moved across the 5.x line.
    $tests = @($result.Tests)
    $failed = @($tests | Where-Object { $_.Result -eq 'Failed' })
    $passed = @($tests | Where-Object { $_.Result -eq 'Passed' })
    $skipped = @($tests | Where-Object { $_.Result -eq 'Skipped' })

    foreach ($test in ($failed | Select-Object -First $script:MaxErrorAnnotations)) {
        Write-Failure "$(Get-TestTitle $test) -- $(Get-TestReason $test)"
    }
    if ($failed.Count -gt $script:MaxErrorAnnotations) {
        $remainder = $failed.Count - $script:MaxErrorAnnotations
        Write-Failure "$remainder further failed test(s) are not annotated: GitHub surfaces a bounded number per step. Read the job log for them."
    }

    $duration = 'unknown'
    if ($result.PSObject.Properties.Match('Duration').Count -gt 0 -and $result.Duration) {
        $duration = [string] [math]::Round($result.Duration.TotalSeconds, 1)
    }

    Write-Measurement -Title 'Pester_summary' -Fields ([ordered]@{
            passed     = $passed.Count
            failed     = $failed.Count
            skipped    = $skipped.Count
            total      = $tests.Count
            duration_s = $duration
            pester     = [string] $pester.Version
            source     = $pesterSource
            powershell = $PSVersionTable.PSVersion.ToString()
        })

    # A suite that discovered nothing must not pass: the job would be green
    # having asserted nothing at all.
    if ($tests.Count -eq 0) {
        Write-HarnessError 'the suite ran no tests, so nothing was established'
        $failedJob = $true
    }
    if ($failed.Count -gt 0) { $failedJob = $true }
} catch {
    Write-HarnessError $_.Exception.Message
    $failedJob = $true
} finally {
    Write-RigPremises
}

if ($failedJob) { exit 1 }
exit 0
