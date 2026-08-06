<#
.SYNOPSIS
    Pester suite over the pure functions in Start-Psilink.ps1 -- the doctor
    verdict reader, the release stamp, the DFS candidate selection, and the
    console's argument vector. Maintainer-facing: it lives outside the guide
    folder, and an operator following the setup page never receives it.

.DESCRIPTION
    The script under test is dot-sourced with -LoadFunctionsOnly, which defines
    its functions and stops before the launcher flow. Two tests hold that switch
    to its contract from both sides -- a dot-source prints nothing, and an
    ordinary run reaches the banner -- because a guard that silently swallowed
    the flow would leave every operator with a launcher that does nothing.

    Everything here is pure. Nothing in this file starts a container, reaches a
    network, or opens a picker: the launcher's engine calls, its prompts and its
    folder picker are verified by running it, and by nothing else. The POSIX
    launcher's share of this ground -- the same verdict contract, driven end to
    end against a stub engine -- is covered by
    scripts/start-psilink-launcher.test.mjs, which runs on Linux CI.

    Run it through ci-resolution-tests.ps1 rather than Invoke-Pester directly:
    that script is what reports results as annotations, which is all the CI
    reader can see.
#>

BeforeAll {
    $launcherScript = (Resolve-Path (Join-Path $PSScriptRoot '..\windows-network-filedrop\Start-Psilink.ps1')).Path
    . $launcherScript -LoadFunctionsOnly

    # Its own name rather than the setup suite's Start-PowerShellChild: both
    # files run in one Pester invocation, and two helpers sharing a name would
    # give the pair a load order that neither should acquire.
    function Start-LauncherChild {
        <#  Run powershell.exe and return its exit code and both streams.

            $PSHOME rather than the bare name, and a temporary file rather than
            the console for standard input, so that a guard which failed and let
            the flow reach a prompt ends the run rather than blocking it. #>
        param([string[]] $Arguments, [int] $TimeoutSeconds = 60)

        $outFile = [IO.Path]::GetTempFileName()
        $errFile = [IO.Path]::GetTempFileName()
        $inFile = [IO.Path]::GetTempFileName()
        try {
            $process = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') `
                -ArgumentList $Arguments -NoNewWindow -PassThru `
                -RedirectStandardInput $inFile `
                -RedirectStandardOutput $outFile -RedirectStandardError $errFile
            # Touch the handle before the wait: without it the Start-Process
            # wrapper can report ExitCode as null after a timed WaitForExit.
            try { $null = $process.Handle } catch { }
            $exited = $process.WaitForExit($TimeoutSeconds * 1000)
            if ($exited) { $process.WaitForExit() }
            if (-not $exited) {
                $process.Kill()
                $process.WaitForExit(10000) | Out-Null
            }
            $exitCode = $null
            if ($exited) { $exitCode = $process.ExitCode }
            $stdout = Get-Content -LiteralPath $outFile -Raw
            if ($null -eq $stdout) { $stdout = '' }
            $stderr = Get-Content -LiteralPath $errFile -Raw
            if ($null -eq $stderr) { $stderr = '' }
            return [ordered]@{
                TimedOut = (-not $exited)
                Exit     = $exitCode
                Output   = [string] $stdout
                Errors   = [string] $stderr
            }
        } finally {
            Remove-Item -LiteralPath $outFile, $errFile, $inFile -Force -ErrorAction SilentlyContinue
        }
    }

    function New-SmbConnectionFixture {
        param([string] $ServerName, [string] $ShareName)
        return [PSCustomObject]@{ ServerName = $ServerName; ShareName = $ShareName }
    }

    $script:StampedDigest = 'sha256:' + ('a1b2c3d4' * 8)
}

Describe 'The -LoadFunctionsOnly guard' {
    It 'defines the launcher functions and runs nothing else' {
        $command = ". '$launcherScript' -LoadFunctionsOnly; " +
            "if (Get-Command Read-DoctorVerdict -ErrorAction SilentlyContinue) { 'LOADED' }"
        $run = Start-LauncherChild -Arguments @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $command)

        # Null-safe reads and a -Because carrying the run's shape: the failure
        # annotation is the only diagnostic that leaves the runner, so an
        # assertion here must describe the run it judged, never throw.
        $stdout = ([string] $run.Output).Trim()
        $stderr = ([string] $run.Errors).Trim()
        $shape = "timedout=$($run.TimedOut) exit=$($run.Exit) " +
            "out_null=$($null -eq $run.Output) err_null=$($null -eq $run.Errors)"
        $run.TimedOut | Should -BeFalse -Because $shape
        $run.Exit | Should -Be 0 -Because $shape
        $stderr | Should -BeNullOrEmpty -Because $shape
        # Exactly the one word: the flow announces itself with a banner before
        # it does anything, so any of it running shows up here.
        $stdout | Should -Be 'LOADED' -Because $shape
    }

    It 'leaves an ordinary run running the flow, which refuses this unstamped copy' {
        $run = Start-LauncherChild -Arguments @(
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$launcherScript`"")

        $run.TimedOut | Should -BeFalse
        $run.Output | Should -Match 'psilink console'
        # The copy in this repository carries the placeholder, so the flow must
        # stop before it reaches an engine at all.
        $run.Output | Should -Match 'did not come from a release'
        # A null exit must not satisfy "not zero": the guard would then pass
        # vacuously on the same helper fault the dot-source test catches.
        $run.Exit | Should -Not -BeNullOrEmpty
        $run.Exit | Should -Not -Be 0
    }
}

Describe 'The release stamp' {
    It 'refuses the placeholder this repository carries' {
        Test-PsilinkImageStamp | Should -BeFalse
        Test-PsilinkImageStamp -Digest '@@PSILINK_IMAGE_DIGEST@@' | Should -BeFalse
    }

    It 'accepts a real digest' {
        Test-PsilinkImageStamp -Digest $script:StampedDigest | Should -BeTrue
    }

    It 'refuses a digest that is the wrong length, algorithm, or case' {
        Test-PsilinkImageStamp -Digest ('sha256:' + ('ab' * 31)) | Should -BeFalse
        Test-PsilinkImageStamp -Digest ('sha512:' + ('ab' * 32)) | Should -BeFalse
        Test-PsilinkImageStamp -Digest ('sha256:' + ('AB' * 32)) | Should -BeFalse
        Test-PsilinkImageStamp -Digest '' | Should -BeFalse
    }

    It 'names the registry in the reference it builds' {
        # podman requires the registry prefix and docker accepts it, so the
        # reference is fully qualified rather than relying on a default.
        Get-PsilinkImage | Should -BeLike 'docker.io/vdorie/psi-link@*'
    }
}

Describe 'Read-DoctorVerdict' {
    It 'reads a version 1 verdict and its overall value' {
        $verdict = Read-DoctorVerdict -Json '{"version":1,"mode":"mount","overall":"ok","checks":[]}'

        $verdict.Ok | Should -BeTrue
        $verdict.Overall | Should -Be 'ok'
    }

    It 'refuses a version it does not know rather than parsing on' {
        $verdict = Read-DoctorVerdict -Json '{"version":2,"mode":"mount","overall":"ok","checks":[]}'

        $verdict.Ok | Should -BeFalse
        $verdict.Reason | Should -Match 'version 2'
    }

    It 'refuses a document carrying no version at all' {
        $verdict = Read-DoctorVerdict -Json '{"mode":"mount","overall":"ok","checks":[]}'

        $verdict.Ok | Should -BeFalse
        $verdict.Reason | Should -Match 'no version'
    }

    It 'reads each of the three overall values' {
        foreach ($value in @('ok', 'fix_and_retry', 'fatal')) {
            $verdict = Read-DoctorVerdict -Json "{`"version`":1,`"mode`":`"mount`",`"overall`":`"$value`",`"checks`":[]}"
            $verdict.Ok | Should -BeTrue -Because $value
            $verdict.Overall | Should -Be $value
        }
    }

    It 'refuses an overall value outside the closed vocabulary' {
        $verdict = Read-DoctorVerdict -Json '{"version":1,"mode":"mount","overall":"probably","checks":[]}'

        $verdict.Ok | Should -BeFalse
        $verdict.Reason | Should -Match 'probably'
    }

    It 'refuses a check status outside the closed vocabulary' {
        $verdict = Read-DoctorVerdict -Json '{"version":1,"mode":"mount","overall":"ok","checks":[{"id":"a","status":"maybe"}]}'

        $verdict.Ok | Should -BeFalse
        $verdict.Reason | Should -Match 'maybe'
    }

    It 'carries each check id, status, meaning and action' {
        $json = '{"version":1,"mode":"probe","overall":"fix_and_retry","checks":[' +
            '{"id":"tcp_445","status":"ok"},' +
            '{"id":"write","status":"fail","meaning":"cannot write here.","action":"ask for write permission."}]}'
        $verdict = Read-DoctorVerdict -Json $json

        $verdict.Ok | Should -BeTrue
        @($verdict.Checks).Count | Should -Be 2
        $failing = Select-DoctorChecks -Verdict $verdict -Status @('fail')
        @($failing).Count | Should -Be 1
        $failing[0].Id | Should -Be 'write'
        $failing[0].Meaning | Should -Be 'cannot write here.'
        $failing[0].Action | Should -Be 'ask for write permission.'
    }

    It 'reports an absent optional field as absent' {
        $verdict = Read-DoctorVerdict -Json '{"version":1,"mode":"mount","overall":"ok","checks":[{"id":"a","status":"ok"}]}'

        $verdict.Checks[0].Meaning | Should -BeNullOrEmpty
        $verdict.Checks[0].Action | Should -BeNullOrEmpty
    }

    It 'reports an explicit null as absent rather than as a value' {
        # The verdict omits what it has nothing to say about, so a null is a
        # document this does not understand rather than something to display.
        $verdict = Read-DoctorVerdict -Json '{"version":1,"mode":"mount","overall":"ok","checks":[{"id":"a","status":"warn","meaning":"x","action":null}]}'

        $verdict.Checks[0].Meaning | Should -Be 'x'
        $verdict.Checks[0].Action | Should -BeNullOrEmpty
    }

    It 'refuses a line that is not a verdict' {
        (Read-DoctorVerdict -Json 'docker: command not found').Ok | Should -BeFalse
        (Read-DoctorVerdict -Json '').Ok | Should -BeFalse
        (Read-DoctorVerdict -Json '   ').Ok | Should -BeFalse
    }

    It 'keeps prose that holds a brace, a comma and a quote intact' {
        $json = '{"version":1,"mode":"mount","overall":"fix_and_retry","checks":[' +
            '{"id":"write_rename","status":"fail","meaning":"a folder named \"q3,final\" {here} cannot be written.","action":"x"}]}'
        $verdict = Read-DoctorVerdict -Json $json

        $verdict.Checks[0].Meaning | Should -Be 'a folder named "q3,final" {here} cannot be written.'
    }
}

Describe 'Show-FromContainer' {
    It 'blanks a raw carriage return rather than letting it rewrite the line' {
        # A raw CR is not JSON-escaped prose -- the decoder never saw it -- so
        # it reaches the byte filter directly, and left alone it pulls the
        # cursor back over classified output already on the line.
        $records = Show-FromContainer -Text ('before' + [char]13 + 'after') 6>&1
        $text = @($records | ForEach-Object { [string] $_ }) -join ''

        $text | Should -Match 'before after'
        $text | Should -Not -Match ([string] [char]13)
    }
}

Describe 'Select-DoctorChecks' {
    BeforeAll {
        $script:Verdict = Read-DoctorVerdict -Json (
            '{"version":1,"mode":"mount","overall":"fix_and_retry","checks":[' +
            '{"id":"added_later","status":"ok"},' +
            '{"id":"marker","status":"warn","meaning":"a marker from another run.","action":"x"},' +
            '{"id":"write_rename","status":"fail","meaning":"m","action":"a"}]}')
    }

    It 'selects by status rather than by position' {
        # A check added to a mode appears as an extra entry, so a consumer keys
        # on ids and statuses rather than on where an entry sits.
        $selected = Select-DoctorChecks -Verdict $script:Verdict -Status @('fail', 'warn')

        @($selected).Count | Should -Be 2
        @($selected | ForEach-Object { $_.Id }) | Should -Be @('marker', 'write_rename')
    }

    It 'returns an empty array when nothing matches' {
        # Bare, an empty result unrolls to nothing, and "foreach ($x in $null)"
        # then runs its body once with a null -- printing a check that is not
        # there.
        $selected = Select-DoctorChecks -Verdict $script:Verdict -Status @('skipped')

        $selected -is [array] | Should -BeTrue -Because 'an empty result has to stay an array'
        @($selected).Count | Should -Be 0
    }
}

Describe 'Select-DfsCandidate' {
    It 'offers a single connection that is not the namespace''s own' {
        $connections = @(
            (New-SmbConnectionFixture -ServerName 'namespace' -ShareName 'dfs'),
            (New-SmbConnectionFixture -ServerName 'fs-04' -ShareName 'exchange'))

        $candidate = Select-DfsCandidate -Connections $connections -NamespaceServer 'namespace' -NamespaceShare 'dfs'

        $candidate.Outcome | Should -Be 'offer'
        $candidate.Server | Should -Be 'fs-04'
        $candidate.Share | Should -Be 'exchange'
    }

    It 'matches server and share together, never the server alone' {
        # Substituting only the server, keeping the namespace's share, produces
        # a device that cannot exist -- the defect that had the automatic
        # resolution removed.
        $connections = @(
            (New-SmbConnectionFixture -ServerName 'namespace' -ShareName 'dfs'),
            (New-SmbConnectionFixture -ServerName 'namespace' -ShareName 'exchange$'))

        $candidate = Select-DfsCandidate -Connections $connections -NamespaceServer 'namespace' -NamespaceShare 'dfs'

        $candidate.Outcome | Should -Be 'offer'
        $candidate.Server | Should -Be 'namespace'
        $candidate.Share | Should -Be 'exchange$'
    }

    It 'falls back when the only connection is the namespace itself' {
        $connections = @((New-SmbConnectionFixture -ServerName 'namespace' -ShareName 'dfs'))

        (Select-DfsCandidate -Connections $connections -NamespaceServer 'namespace' -NamespaceShare 'dfs').Outcome |
            Should -Be 'none'
    }

    It 'falls back on an empty list, which is what a non-elevated session sees' {
        # Reading the connection list needs Administrator rights, and an
        # elevated window cannot see the drive letters the operator mapped as
        # themselves -- so the empty answer is the ordinary case, not the edge.
        (Select-DfsCandidate -Connections @() -NamespaceServer 'namespace' -NamespaceShare 'dfs').Outcome |
            Should -Be 'none'
        (Select-DfsCandidate -Connections $null -NamespaceServer 'namespace' -NamespaceShare 'dfs').Outcome |
            Should -Be 'none'
    }

    It 'falls back when several connections could be the one' {
        $connections = @(
            (New-SmbConnectionFixture -ServerName 'fs-04' -ShareName 'exchange'),
            (New-SmbConnectionFixture -ServerName 'fs-09' -ShareName 'projects'))

        $candidate = Select-DfsCandidate -Connections $connections -NamespaceServer 'namespace' -NamespaceShare 'dfs'

        $candidate.Outcome | Should -Be 'several'
        $candidate.Count | Should -Be 2
    }

    It 'ignores the IPC$ share every connection carries' {
        $connections = @(
            (New-SmbConnectionFixture -ServerName 'fs-04' -ShareName 'IPC$'),
            (New-SmbConnectionFixture -ServerName 'fs-04' -ShareName 'exchange'))

        $candidate = Select-DfsCandidate -Connections $connections -NamespaceServer 'namespace' -NamespaceShare 'dfs'

        $candidate.Outcome | Should -Be 'offer'
        $candidate.Share | Should -Be 'exchange'
    }

    It 'counts one server and share once however many connections name it' {
        $connections = @(
            (New-SmbConnectionFixture -ServerName 'fs-04' -ShareName 'exchange'),
            (New-SmbConnectionFixture -ServerName 'FS-04' -ShareName 'Exchange'))

        (Select-DfsCandidate -Connections $connections -NamespaceServer 'namespace' -NamespaceShare 'dfs').Outcome |
            Should -Be 'offer'
    }
}

Describe 'The console argument vector' {
    It 'publishes to host loopback and keeps nothing' {
        $engineArgs = Get-ConsoleEngineArgs -ContainerName 'psilink-console-1' -ConsolePort 3000 `
            -DataMount 'C:\work'

        # The publish binding is the console's whole reachability control: the
        # job API carries no authentication.
        $engineArgs | Should -Contain '127.0.0.1:3000:3000'
        $engineArgs | Should -Contain '--rm'
        $engineArgs | Should -Contain 'JOB_DATA_ROOT=/data'
        $engineArgs | Should -Contain 'C:\work:/data'
        $engineArgs[-1] | Should -Be 'serve'
    }

    It 'leaves the input and rendezvous mounts out of a single-folder console' {
        $engineArgs = Get-ConsoleEngineArgs -ContainerName 'psilink-console-1' -ConsolePort 3000 `
            -DataMount 'C:\work'

        ($engineArgs -join ' ') | Should -Not -Match 'JOB_INPUT_DIR'
        ($engineArgs -join ' ') | Should -Not -Match 'JOB_RENDEZVOUS_DIR'
    }

    It 'mounts the split folders when they are given' {
        $engineArgs = Get-ConsoleEngineArgs -ContainerName 'psilink-console-1' -ConsolePort 8080 `
            -DataMount 'C:\work' -InputMount 'C:\input' -RendezvousMount 'psilink-sync'

        $engineArgs | Should -Contain '127.0.0.1:8080:3000'
        $engineArgs | Should -Contain 'JOB_INPUT_DIR=/input'
        $engineArgs | Should -Contain 'C:\input:/input'
        $engineArgs | Should -Contain 'JOB_RENDEZVOUS_DIR=/rendezvous'
        # A named volume mounts by name exactly as a host path does.
        $engineArgs | Should -Contain 'psilink-sync:/rendezvous'
    }
}
