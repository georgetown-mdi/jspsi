@echo off
rem ==========================================================================
rem  Makes a network file-drop folder usable by psilink running in Docker.
rem  Run this once, from a Command Prompt window, before your first exchange.
rem
rem  This is the Command Prompt version of Setup-PsilinkFileDrop.ps1, for
rem  machines where Windows PowerShell is absent or blocked. It does the same
rem  four things: works out the real server behind the path you see in
rem  Explorer, tests the share from inside a container, creates the Docker
rem  volume, and checks that the volume mounts the folder that was tested.
rem
rem  About the password. The checks receive it through an inherited environment
rem  variable, so it never reaches a command line there. Creating the volume is
rem  different -- Docker takes the credentials only as a mount option, which is
rem  a command-line argument -- so it appears on one command line, and is then
rem  stored in cleartext in the volume metadata. See the passwords page.
rem
rem  https://github.com/georgetown-mdi/jspsi/blob/main/support/windows-network-filedrop/troubleshooting.md
rem  https://github.com/georgetown-mdi/jspsi/blob/main/support/windows-network-filedrop/passwords.md
rem ==========================================================================

setlocal disabledelayedexpansion

rem Delayed expansion stays OFF for the whole run. With it on, a password
rem containing "!" is silently emptied of it -- "Pa!ss" becomes "Pass", which
rem reports as a wrong password with nothing on screen to explain why.

set "SCRIPT_DIR=%~dp0"
set "VOLUME_NAME=psilink-sync"
rem The checks run in the same image the exchange itself runs, at the same
rem floating tag: it carries smbclient, so the checks do not have to fetch it on
rem a network that may be the reason they are being run. Floating is deliberate
rem -- this script is downloaded on its own rather than shipped with a release,
rem so pinning the diagnostic tighter than the thing it diagnoses buys nothing.
rem
rem Every docker run below overrides the image entrypoint with sh. That image's
rem own entrypoint hands its argument vector to psilink, so a helper script
rem passed to it would be read as exchange arguments; a stock Alpine passed with
rem -HelperImage takes the same override without caring.
set "HELPER_IMAGE=vdorie/psi-link:latest"
set "MARKER_NAME=psilink-setup-check.tmp"
set "WORK=%TEMP%\psilink-cmd-%RANDOM%%RANDOM%.txt"

set "DROP_PATH="
set "SERVER="
set "SHARE="
set "SUBPATH="
set "SUBPATH_GIVEN="
set "SMB_USERNAME="
set "SMB_DOMAINNAME="
set "DOMAIN_GIVEN="
set "DIALECT="
set "SKIP_CONFIRM="
set "SKIP_VOLUME_TEST="
set "DEGRADED="

rem ---------------------------------------------------------------- arguments
:parse
if "%~1"=="" goto parsed
set "ARG=%~1"
if "%ARG:~0,1%"=="/" set "ARG=-%ARG:~1%"
if /i "%ARG%"=="-?"              goto usage
if /i "%ARG%"=="-help"           goto usage
if /i "%ARG%"=="-skipconfirm"    set "SKIP_CONFIRM=1" & shift & goto parse
if /i "%ARG%"=="-skipvolumetest" set "SKIP_VOLUME_TEST=1" & shift & goto parse
if /i "%ARG%"=="-droppath"       goto a_droppath
if /i "%ARG%"=="-server"         goto a_server
if /i "%ARG%"=="-share"          goto a_share
if /i "%ARG%"=="-subpath"        goto a_subpath
if /i "%ARG%"=="-username"       goto a_username
if /i "%ARG%"=="-domain"         goto a_domain
if /i "%ARG%"=="-dialect"        goto a_dialect
if /i "%ARG%"=="-volumename"     goto a_volumename
if /i "%ARG%"=="-helperimage"    goto a_helperimage
echo   FAIL  Unrecognised option "%ARG%".
echo(
goto usage

:a_droppath
set "DROP_PATH=%~2"
shift
shift
goto parse
:a_server
set "SERVER=%~2"
shift
shift
goto parse
:a_share
set "SHARE=%~2"
shift
shift
goto parse
:a_subpath
set "SUBPATH=%~2"
set "SUBPATH_GIVEN=1"
shift
shift
goto parse
:a_username
set "SMB_USERNAME=%~2"
shift
shift
goto parse
:a_domain
set "SMB_DOMAINNAME=%~2"
set "DOMAIN_GIVEN=1"
shift
shift
goto parse
:a_dialect
set "DIALECT=%~2"
shift
shift
goto parse
:a_volumename
set "VOLUME_NAME=%~2"
shift
shift
goto parse
:a_helperimage
set "HELPER_IMAGE=%~2"
shift
shift
goto parse

:usage
echo Usage: cmd_Setup-PsilinkFileDrop.cmd [options]
echo(
echo   -DropPath ^<path^>     the folder as you see it in Explorer (H:\Exchange)
echo   -Server ^<name^>       the real file server, if you already know it
echo   -Share ^<name^>        the share, which is the FIRST path component only
echo   -SubPath ^<folder^>    the folder inside the share
echo   -Username ^<name^>     the account the container will use
echo   -Domain ^<name^>       its domain, if it has one
echo   -Dialect ^<d^>         pin the SMB dialect: SMB3, SMB2, or NT1
echo   -VolumeName ^<name^>   the Docker volume to create (psilink-sync)
echo   -HelperImage ^<image^> the image the checks run in
echo   -SkipConfirm         do not ask you to confirm the server and share
echo   -SkipVolumeTest      run the checks but do not create the volume
echo(
echo Run it with no options and it will ask for what it needs.
endlocal
exit /b 1

:parsed

rem ================================================================= preflight
call :head "psilink file-drop setup"

echo Checking Docker...
docker version --format "{{.Server.Os}} {{.Server.Version}}" >"%WORK%" 2>&1
if errorlevel 1 goto no_docker

set "DOCKER_OS="
set "DOCKER_VER="
for /f "usebackq tokens=1,2" %%a in ("%WORK%") do (
  set "DOCKER_OS=%%a"
  set "DOCKER_VER=%%b"
)
if not defined DOCKER_OS goto no_docker
if /i "%DOCKER_OS%"=="windows" goto windows_containers
call :good "Docker engine %DOCKER_VER% is running."

rem Pulled here rather than left to the first docker run: an image that cannot
rem be fetched exits 125, which is indistinguishable from the checks deciding
rem something about the share, and would be reported as a share problem with no
rem diagnosis printed above it.
docker image inspect "%HELPER_IMAGE%" >nul 2>&1
if errorlevel 1 (
  echo Fetching the psilink image ^(first run only^). It is a few hundred
  echo megabytes -- the same image the exchange itself runs -- so this can
  echo take several minutes with nothing on screen.
  docker pull --quiet "%HELPER_IMAGE%" >"%WORK%" 2>&1
  if errorlevel 1 goto no_image
)

rem =========================================== part 1: locate the file drop
call :head "Part 1: locating the file drop"

set "EXPLICIT="
if defined SERVER if defined SHARE set "EXPLICIT=1"
if defined EXPLICIT goto have_target

if not defined DROP_PATH (
  echo Enter the file-drop folder exactly as you see it in File Explorer.
  echo Examples:  H:\Exchange\psilink
  echo            \\fileserver.agency.gov\exchange\psilink
  echo(
  set /p "DROP_PATH=File-drop folder: "
)
if not defined DROP_PATH (
  call :bad "No folder given."
  goto fail_generic
)

call :resolve_drop "%DROP_PATH%"
if "%RESOLVE_KIND%"=="Local"   goto is_local
if "%RESOLVE_KIND%"=="Unknown" goto cannot_use

set "SERVER=%RESOLVE_SERVER%"
set "SHARE=%RESOLVE_SHARE%"
if not defined SUBPATH_GIVEN set "SUBPATH=%RESOLVE_SUBPATH%"

rem Worth knowing before the container is blamed for not reaching a path
rem Windows itself cannot reach.
if defined RESOLVE_FULL (
  echo Checking that Windows itself can reach it...
  if not exist "%RESOLVE_FULL%" (
    call :warn "Windows cannot open %RESOLVE_FULL% either."
    call :note "The checks below will probably fail. Confirm the path opens in"
    call :note "File Explorer before reading too much into what they say."
  )
)

:have_target
rem Everything downstream -- the SMB path and the Docker device string -- wants
rem forward slashes.
if defined SUBPATH set "SUBPATH=%SUBPATH:\=/%"
call :trim_slashes

echo(
call :good "Server:       %SERVER%"
call :good "Share:        %SHARE%"
if defined SUBPATH (
  call :good "Subdirectory: %SUBPATH%"
) else (
  call :good "Subdirectory: (share root)"
)

if defined EXPLICIT     goto credentials
if defined SKIP_CONFIRM goto credentials

echo(
echo Everything below depends on those three being right, and one case
echo where they will not be is a DFS path: it names a namespace rather
echo than a machine, and the real server, share and folder can all be
echo different. Windows will tell you -- open the folder in Explorer,
echo right-click, Properties, and read the DFS tab if there is one.
echo(
set "CONFIRM="
set /p "CONFIRM=Are those correct? [Y/n]: "
if not defined CONFIRM goto credentials
if /i "%CONFIRM%"=="y"   goto credentials
if /i "%CONFIRM%"=="yes" goto credentials
echo(
call :note "Run the script again with the real values:"
echo(
echo     cmd_Setup-PsilinkFileDrop.cmd -Server fs-04.agency.gov -Share exchange$ -SubPath dropbox
echo(
call :info "See the troubleshooting page, 'Reading the real path from Windows'."
goto done_ok

rem ============================================== part 2: credentials
:credentials
call :head "Part 2: credentials for the file server"

echo These are the credentials the CONTAINER will use to reach the share.
echo Windows signs you in to it as yourself; Docker cannot borrow that, so
echo it needs a username and password of its own.
echo(
call :warn "Prefer an account scoped to this share, or one you are prepared to"
call :note "retire. Docker stores this password in cleartext in the volume"
call :note "metadata and puts it on a command line while creating the volume."
call :note "Do not use a domain administrator account, and do not use one whose"
call :note "password protects anything else you care about."
call :info ""
call :info "See the passwords page, 'Where the password ends up'."
echo(

if not defined SMB_USERNAME set /p "SMB_USERNAME=Username: "
if not defined DOMAIN_GIVEN set /p "SMB_DOMAINNAME=Domain (press Enter if you do not have one): "

if not defined SMB_USERNAME (
  call :bad "No username entered."
  goto fail_generic
)

rem The password is read straight into the variable the container inherits, and
rem is never expanded into a command line before the volume is created. cmd
rem re-parses whatever an expansion produces, so a password containing "&" or
rem ">" would end the command and abort the script mid-run.
set "SMB_PASS="
call :warn "Command Prompt cannot hide typing, so the password will be visible"
call :note "on screen as you type it. Close this window when you are finished,"
call :note "or clear it with the cls command."
echo(
set /p "SMB_PASS=Password: "
echo(

set "VERDICT="
set "PWWARN="
set "TOKEN="
docker run --rm -i --env SMB_PASS --entrypoint sh "%HELPER_IMAGE%" -c "tr -d '\r' | sh" <"%SCRIPT_DIR%cmd_psilink-credcheck.sh" >"%WORK%" 2>nul
if errorlevel 1 goto credcheck_failed
for /f "usebackq tokens=1,* delims==" %%a in ("%WORK%") do (
  if "%%a"=="VERDICT" set "VERDICT=%%b"
  if "%%a"=="WARN"    set "PWWARN=%%b"
  if "%%a"=="TOKEN"   set "TOKEN=%%b"
)

if "%VERDICT%"=="EMPTY" goto pw_empty
if "%VERDICT%"=="COMMA" goto pw_comma
if "%VERDICT%"=="QUOTE" goto pw_quote
if not "%VERDICT%"=="OK" goto credcheck_failed

if "%PWWARN%"=="LEADSPACE" (
  call :warn "That password begins with a space."
  call :note "The credentials file the checks use drops leading spaces, so it will"
  call :note "be tried without one and reported as a wrong password. If step 3"
  call :note "below says LOGON_FAILURE, that is why, and it is not your mistake."
)

rem ================================ part 3: test the share from a container
call :head "Part 3: testing the share from inside a container"

set "SMB_SERVER=%SERVER%"
set "SMB_SHARE=%SHARE%"
set "SMB_PATH=%SUBPATH%"
set "SMB_USER=%SMB_USERNAME%"
set "SMB_DOMAIN=%SMB_DOMAINNAME%"
set "SMB_DIALECT=%DIALECT%"
set "SMB_TOKEN=%TOKEN%"
set "SMB_MARKER=%MARKER_NAME%"
if defined SKIP_VOLUME_TEST set "SMB_MARKER="

rem The probe streams to the console: its output is the thing the operator
rem reads. It is fed on standard input through "tr -d '\r'" so that a checkout
rem with core.autocrlf on cannot break it -- sh does not treat a carriage
rem return as whitespace, and a CRLF copy reaching sh directly dies with an
rem unterminated if.
docker run --rm -i --env SMB_SERVER --env SMB_SHARE --env SMB_PATH --env SMB_USER --env SMB_DOMAIN --env SMB_PASS --env SMB_DIALECT --env SMB_MARKER --env SMB_TOKEN --entrypoint sh "%HELPER_IMAGE%" -c "tr -d '\r' | sh" <"%SCRIPT_DIR%cmd_psilink-probe.sh"
set "PROBE_RC=%errorlevel%"

set "SMB_SERVER="
set "SMB_SHARE="
set "SMB_PATH="
set "SMB_USER="
set "SMB_DOMAIN="
set "SMB_DIALECT="
set "SMB_MARKER="
set "SMB_TOKEN="

if %PROBE_RC% GEQ 125 goto docker_broke
if "%PROBE_RC%"=="11" goto probe_degraded
if not "%PROBE_RC%"=="0" goto probe_failed

call :good "The share is reachable, writable, and supports rename."
goto probe_verdict_done

rem Exit 11 is the probe saying it could not run the checks, as opposed to
rem running them and refusing the share: steps 1 and 2 passed and smbclient
rem could not be had. The volume is still worth creating -- the engine mounts
rem the share itself and needs nothing the container was missing -- so the run
rem carries on and finishes at 12 rather than 0.
:probe_degraded
set "DEGRADED=1"
call :warn "The checks stopped after step 2, so the share itself has not been"
call :note "tested. What that leaves unchecked is listed at the end."
if defined SKIP_VOLUME_TEST goto probe_verdict_done
call :note "Carrying on to create the volume anyway: Docker mounts the share"
call :note "itself and needs nothing that was missing above."

:probe_verdict_done
if defined SKIP_VOLUME_TEST (
  call :note "Skipping volume creation as requested."
  goto volume_test_skipped
)

rem =========================================== part 4: create the volume
call :head "Part 4: creating the Docker volume"

set "DEVICE=//%SERVER%/%SHARE%"
if defined SUBPATH set "DEVICE=//%SERVER%/%SHARE%/%SUBPATH%"

rem Existence is established from the volume list rather than from the exit
rem code of the inspection below. Anything that stops the inspection running
rem also exits non-zero, and reading that as "no such volume" walks straight
rem past the guard and into the removal further down.
set "VOLUME_EXISTS="
docker volume ls --quiet >"%WORK%" 2>nul
if errorlevel 1 goto volume_list_failed
for /f "usebackq delims=" %%v in ("%WORK%") do (
  if "%%v"=="%VOLUME_NAME%" set "VOLUME_EXISTS=1"
)

if not defined VOLUME_EXISTS goto create_volume

set "EXISTING="
docker volume inspect --format "{{.Driver}} {{.Options.type}}" "%VOLUME_NAME%" >"%WORK%" 2>nul
if errorlevel 1 goto volume_not_ours
for /f "usebackq delims=" %%v in ("%WORK%") do set "EXISTING=%%v"
if not "%EXISTING%"=="local cifs" goto volume_not_ours

rem docker volume create on an existing name exits 0 and silently keeps the
rem options the volume already has, so a run after a password change would
rem quietly go on using the old one. Removing it first is what makes a re-run
rem mean anything.
docker volume rm "%VOLUME_NAME%" >"%WORK%" 2>&1
if errorlevel 1 goto volume_rm_failed
call :info "Replaced the existing '%VOLUME_NAME%' volume."

:create_volume
echo Creating volume '%VOLUME_NAME%' for %DEVICE%

rem The whole option is one quoted argument. Measured against docker: quoting
rem carries "&", "|", ">", "%", "^", ";", "(" and a space through intact. A
rem double quote is the one character that cannot be carried, which is why the
rem check above refuses it -- unquoted, it ends the argument and docker creates
rem an unnamed volume instead of the one asked for.
set "VOL_OPTS=username=%SMB_USERNAME%,password=%SMB_PASS%"
if defined SMB_DOMAINNAME set "VOL_OPTS=username=%SMB_USERNAME%,password=%SMB_PASS%,domain=%SMB_DOMAINNAME%"
call :dialect_opt

docker volume create --driver local --opt type=cifs --opt "device=%DEVICE%" --opt "o=%VOL_OPTS%" "%VOLUME_NAME%" >"%WORK%" 2>&1
if errorlevel 1 goto volume_create_failed
set "VOL_OPTS="
call :good "Volume created. Docker mounts it the first time it is used."

echo Mounting it and testing what psilink needs...
set "MARKER=%MARKER_NAME%"
docker run --rm -i -v "%VOLUME_NAME%:/rz" --env MARKER --env TOKEN --entrypoint sh "%HELPER_IMAGE%" -c "tr -d '\r' | sh" <"%SCRIPT_DIR%cmd_psilink-volcheck.sh" >"%WORK%" 2>&1
set "VOL_RC=%errorlevel%"
set "MARKER="

rem "Did not mount" and "mounted, then refused the write" are different answers
rem and used to share one message. A volume that reported any marker line has
rem demonstrably reached a directory, so calling that a mount failure sent the
rem operator round the -Dialect loop for what is a permissions or quota problem
rem on the share.
findstr /c:"WRITE_OK" "%WORK%" >nul 2>&1
if not errorlevel 1 goto volume_write_ok
findstr /c:"MARKER_OK" /c:"MARKER_MISMATCH" /c:"MARKER_MISSING" "%WORK%" >nul 2>&1
if not errorlevel 1 goto volume_not_writable
goto volume_mount_failed

:volume_write_ok
if not "%VOL_RC%"=="0" goto volume_mount_failed

call :good "The volume mounts and psilink can write to it."

findstr /c:"MARKER_MISSING" "%WORK%" >nul 2>&1
if not errorlevel 1 goto marker_absent

findstr /c:"MARKER_MISMATCH" "%WORK%" >nul 2>&1
if not errorlevel 1 (
  call :warn "The check file in the folder is not the one part 3 wrote."
  call :note "Either someone else is setting up this same share right now, or"
  call :note "an earlier run of this script left the file behind. The volume"
  call :note "itself reached the folder either way."
  call :note "To tell the two apart, delete %MARKER_NAME% from the drop folder"
  call :note "and run this again: if it comes back, you have company."
  goto marker_done
)

rem The reassuring line waits for the positive verdict rather than being
rem inferred from the absence of the other two. With the checks stopped at
rem step 2 there is no marker to find, and "the volume and the checks agree"
rem would then be a claim nothing established.
findstr /c:"MARKER_OK" "%WORK%" >nul 2>&1
if not errorlevel 1 call :good "The volume and the checks agree on which folder this is."
goto marker_done

:marker_absent
if not defined DEGRADED goto marker_missing
call :warn "Nothing has checked that the volume opens the folder you named."
call :note "That test is a file the checks leave in the folder for the volume"
call :note "to find, and they did not get that far."

:marker_done

findstr /c:"RENAME_FAIL" "%WORK%" >nul 2>&1
if not errorlevel 1 (
  call :warn "This share will not rename a file onto an existing one."
  call :note "psilink does that when two sides meet at once. Pass"
  call :note "--lockless-rendezvous on BOTH sides of the exchange."
)

findstr /c:"EXCL_WEAK" "%WORK%" >nul 2>&1
if not errorlevel 1 (
  call :warn "This share does not refuse to create a file that already exists."
  call :note "psilink uses that refusal to decide which side goes first, so"
  call :note "without it both sides can believe they did. Pass"
  call :note "--lockless-rendezvous on BOTH sides of the exchange."
)

findstr /c:"EXCL_UNTESTED" "%WORK%" >nul 2>&1
if not errorlevel 1 (
  call :note "Could not test exclusive create on this share. If the exchange"
  call :note "hangs at the start, try --lockless-rendezvous on both sides."
)

rem The positive counterpart of the three warnings above, and the only one that
rem tells an operator whose share is fine that it is fine. It is stated only
rem when both halves held: a share that refuses a duplicate create but will not
rem rename onto an existing file still needs --lockless-rendezvous, so the
rem rename result gates the message.
findstr /c:"RENAME_FAIL" "%WORK%" >nul 2>&1
if not errorlevel 1 goto skip_excl_ok
findstr /c:"EXCL_OK" "%WORK%" >nul 2>&1
if not errorlevel 1 call :good "Exclusive create and rename behave the way psilink needs."
:skip_excl_ok

rem ===================================================================== done
if defined DEGRADED goto ready_head_degraded
call :head "Ready to run an exchange"
echo The volume '%VOLUME_NAME%' is set up and survives reboots. You do not
echo need to run this script again unless the password changes.
goto ready_head_done

:ready_head_degraded
call :head "Set up, but the checks did not run"
echo The volume '%VOLUME_NAME%' is created and survives reboots. Run this
echo script again once the container can get smbclient: part 3 is what
echo tests the share itself.

:ready_head_done
echo(
echo Run your exchange like this, on one line:
echo(
echo   docker run --rm -v "C:\path\to\your\work:/work" -v "%VOLUME_NAME%:/sync" vdorie/psi-link:latest file:///sync input.csv matches.csv
echo(
if not defined DEGRADED goto ready_pointer_done
call :warn "Before you run that, read 'Set up, but not fully checked' below."
echo(
:ready_pointer_done
call :info "C:\path\to\your\work is a LOCAL folder on this PC holding your input"
call :info "CSV; results are written back there. It must not be a network path."
call :info "input.csv and matches.csv are named relative to that folder. Keep the"
call :info "quotes -- a work folder under OneDrive has a space in its path."
echo(
call :warn "The exchange also writes a psilink-record-....keys.json file into that"
call :note "folder. It is not a result: it holds the keys to the exchange and"
call :note "should be treated like the input data, not sent on with the matches."
echo(
call :warn "One exchange per folder. Running a second one against this file drop"
call :note "before the first has finished and been cleared will fail on both"
call :note "sides. Agree with your partner who goes when."
echo(
call :warn "Check with your exchange partner: if this folder is kept in step by a"
call :note "sync service rather than being a live file server, both sides must"
call :note "pass --lockless-rendezvous at the end of the command line."
call :info ""
call :info "See the troubleshooting page, 'Synced folders'."
echo(
echo There is also a browser console, on one line:
echo(
echo   docker run --rm -p 127.0.0.1:3000:3000 --env JOB_DATA_ROOT=/data --env JOB_RENDEZVOUS_DIR=/sync -v "C:\path\to\your\work:/data" -v "%VOLUME_NAME%:/sync" vdorie/psi-link:latest serve
echo(
call :info "then open http://127.0.0.1:3000"
call :info ""
call :info "The console cannot set --lockless-rendezvous. If you were told above"
call :info "that you need it, or this is a synced folder, use the command-line"
call :info "form instead."
echo(
call :warn "Docker stored the share password in cleartext in this volume's"
call :note "metadata: 'docker volume inspect %VOLUME_NAME%' shows it to anyone"
call :note "who can run Docker on this PC. When you are finished:"
call :info ""
call :info "    docker volume rm %VOLUME_NAME%"
call :info ""
call :info "That removes the volume but not every trace of the password, so"
call :info "retire or rotate the account when the exchanges are done. See the"
call :info "passwords page, 'Ending the exposure'."
echo(
rem No redirection character appears in the text below, and none may be added.
rem One survives being passed to a subroutine as a quoted argument, but not the
rem echo that prints it there: the line redirects into a file instead of
rem appearing, and the run ends with "'1' is not recognized as an internal or
rem external command".
call :info "To send this output to whoever is helping you, copy it out of"
call :info "this window: right-click the title bar, open the Edit menu and"
call :info "choose Select All, then open it again and choose Copy."
call :info ""
call :info "Start the selection below the Password: line. Command Prompt"
call :info "cannot hide typing, so what you typed there is still on screen."

if defined DEGRADED goto degraded_summary

:done_ok
call :cleanup
endlocal
exit /b 0

:volume_test_skipped
if defined DEGRADED goto degraded_skipped
goto done_ok

rem ============================================== set up, checks incomplete
:degraded_summary
call :head "Set up, but not fully checked"
call :warn "The volume is ready and was tested: it mounts, and the writing,"
call :note "renaming and exclusive create that psilink depends on all work"
call :note "over it. It is the checks in part 3 that did not run past step 2."
call :info ""
call :info "So one thing about the volume is unproven: that it opens the folder"
call :info "you named rather than a different one. Part 3 normally leaves a file"
call :info "in the folder for the volume to find, and that comparison is the"
call :info "only test of it."
goto degraded_exit

:degraded_skipped
call :head "Checks incomplete"
call :warn "The checks in part 3 did not run past step 2, and no volume was"
call :note "created because you asked for none. All that was established is"
call :note "that the server answers on port 445 from inside Docker."
goto degraded_exit

:degraded_exit
call :degraded_losses
echo(
call :note "Status 12: set up as far as it went, checks incomplete."
call :cleanup
endlocal
exit /b 12

rem ================================================================= failures
:no_docker
call :bad "Docker is not running, or is not installed, or you cannot use it."
call :note "Start Docker Desktop and wait for the whale icon to stop animating."
call :note "If it is already running, the message below usually says which of"
call :note "the three it is -- 'access is denied' means your account is not in"
call :note "the local docker-users group, which an administrator has to add"
call :note "you to before Docker will talk to you."
echo(
if exist "%WORK%" type "%WORK%"
goto fail_generic

:windows_containers
call :bad "Docker Desktop is in Windows containers mode."
call :note "psilink and these checks are Linux containers. In this mode the"
call :note "engine answers normally and then every container fails to start."
call :info ""
call :info "Right-click the Docker whale icon in the notification area and"
call :info "choose 'Switch to Linux containers...', then run this again."
goto fail_generic

:no_image
call :bad "Could not fetch the helper image the checks run in."
echo(
if exist "%WORK%" type "%WORK%"
echo(
call :note "Nothing about your file drop has been tested yet -- this is Docker"
call :note "being unable to reach its registry. A corporate proxy intercepting"
call :note "HTTPS is the usual cause; Docker Desktop needs its certificate under"
call :note "Settings, then Resources, then Proxies."
call :info ""
call :info "The checks run in the same image as the exchange itself, so nothing"
call :info "will run until Docker can fetch it. If your site keeps its own copy"
call :info "of the psilink image, name that copy with -HelperImage."
goto fail_generic

:is_local
call :head "This folder is already local"
call :good "%RESOLVE_LOCAL% is on this PC, not a network server."
if not exist "%RESOLVE_LOCAL%" (
  call :warn "It does not exist yet -- create it before running the exchange,"
  call :note "or Docker will report 'bind source path does not exist'."
)
echo(
echo That means you do not need a Docker volume at all -- you can mount
echo the folder directly. Run your exchange like this, on one line:
echo(
echo   docker run --rm -v "C:\path\to\your\work:/work" -v "%RESOLVE_LOCAL%:/sync" vdorie/psi-link:latest file:///sync input.csv matches.csv
echo(
call :warn "If this folder is kept in step with your partner by a sync client"
call :note "(OneDrive, Dropbox, Egnyte, ShareFile), both sides must also pass"
call :note "--lockless-rendezvous at the end of that command line."
call :info ""
call :info "See the troubleshooting page, 'Synced folders'."
goto done_ok

:cannot_use
call :bad "Could not use that path."
echo(
call :note "%RESOLVE_REASON%"
call :info ""
call :info "Enter it as a drive letter path (H:\Exchange) or a network path"
call :info "(\\server\share\folder). Copy it from the Explorer address bar."
goto fail_generic

:credcheck_failed
call :bad "Could not check the password in a container."
call :note "Nothing about your file drop has been tested. This is Docker failing"
call :note "to run the helper image, not a verdict about your share."
echo(
if exist "%WORK%" type "%WORK%"
goto fail_generic

:pw_empty
call :bad "No password entered."
call :note "If you never type a password when opening this folder in Explorer,"
call :note "Windows signs you in automatically and this approach may not work at"
call :note "all. Read the troubleshooting page, 'The share never asks for a"
call :note "password', first."
goto fail_generic

:pw_comma
call :bad "That password contains a comma, and Docker cannot carry it."
call :note "Mount options are separated by commas, so the password is cut off at"
call :note "the first one and the mount fails with 'invalid argument'. There is"
call :note "no way to quote or escape it -- this is a limit of Docker volumes,"
call :note "not of psilink, and doing it by hand hits exactly the same wall."
call :info ""
call :info "Use an account whose password has no comma. The troubleshooting"
call :info "page has a ready-made request for one, under 'What to ask your IT"
call :info "department for'."
goto fail_generic

:pw_quote
call :bad "That password contains a double quote, which cannot be carried here."
call :note "The mount options go to Docker as one quoted argument, and a quote"
call :note "inside the password ends that argument early: Docker then reads the"
call :note "rest as separate words and creates an unnamed volume instead of the"
call :note "one asked for. Refusing now avoids leaving that stray behind."
call :info ""
call :info "Use an account whose password has no double quote. The"
call :info "troubleshooting page has a ready-made request for one, under"
call :info "'What to ask your IT department for'."
goto fail_generic

:docker_broke
call :head "Could not run the checks"
call :bad "Docker could not start the container (exit %PROBE_RC%)."
call :note "Nothing was tested. This is Docker itself failing, not a verdict"
call :note "about your file drop -- so there is no ACTION above to follow."
call :note "The message Docker printed is the one to read."
call :cleanup
endlocal
exit /b 1

:probe_failed
call :head "Not ready yet"
call :bad "The file drop is not usable from Docker. Follow the ACTION above."
call :info ""
call :info "The troubleshooting page explains every one of these in detail:"
call :info "https://github.com/georgetown-mdi/jspsi/blob/main/support/windows-network-filedrop/troubleshooting.md"
call :cleanup
endlocal
exit /b 1

:volume_list_failed
call :bad "Could not list the Docker volumes."
call :note "The volume was not created. Docker answered the version check and"
call :note "then refused this, which is unusual -- the message below is the one"
call :note "to read."
echo(
if exist "%WORK%" type "%WORK%"
if defined DEGRADED call :degraded_losses
goto fail_generic

:volume_not_ours
call :bad "A Docker volume called '%VOLUME_NAME%' already exists and was not"
call :note "made by this script -- it is not a network-share volume. It has"
call :note "been left alone; removing it could destroy data belonging to"
call :note "something else on this PC."
call :info ""
call :info "Run this script again with -VolumeName set to another name, or"
call :info "remove that volume yourself if you are certain:"
call :info ""
call :info "    docker volume rm %VOLUME_NAME%"
if defined DEGRADED call :degraded_losses
goto fail_generic

:volume_rm_failed
call :bad "Could not replace the existing '%VOLUME_NAME%' volume."
echo(
call :show_safely
echo(
call :note "A container is probably still using it. Stop any exchange that is"
call :note "running, then try again: docker ps"
if defined DEGRADED call :degraded_losses
goto fail_generic

:volume_create_failed
set "VOL_OPTS="
call :bad "Could not create the volume."
echo(
call :show_safely
if defined DEGRADED call :degraded_losses
goto fail_generic

:volume_not_writable
call :bad "The volume mounted, but psilink cannot write in that folder."
echo(
call :show_safely
echo(
call :note "The share was reached, so this is not a mount or a dialect"
call :note "problem and -Dialect will not change it. Either the account"
call :note "can open the folder but not create files in it, or the share"
call :note "is out of space."
call :info ""
call :info "See the troubleshooting page, 'The folder cannot be written to'."
if defined DEGRADED call :degraded_partial_losses
docker volume rm "%VOLUME_NAME%" >nul 2>&1
goto fail_generic

:volume_mount_failed
call :bad "The volume could not be mounted."
echo(
call :show_safely
echo(
rem The message being classified is the one the Docker daemon prints, which is
rem the mount(2) errno rendered from Go's own table -- lowercase throughout,
rem where mount.cifs and glibc capitalise the same errors. findstr is
rem case-sensitive unless told otherwise, so every arm below takes /i and
rem carries the literal as the daemon prints it. The arms are also chained
rem rather than independent, so that output naming two of these produces one
rem diagnosis, as it does in the PowerShell script.
findstr /i /c:"invalid argument" "%WORK%" >nul 2>&1
if errorlevel 1 goto mount_arm_denied
call :note "The mount options were malformed. An equals sign or a special"
call :note "character in the password or the domain is the usual cause."
goto mount_arms_done

:mount_arm_denied
findstr /i /c:"permission denied" "%WORK%" >nul 2>&1
if errorlevel 1 goto mount_arm_dialect
if defined DEGRADED goto mount_denied_untested
call :note "The kernel refused the mount even though the checks in part 3"
call :note "authenticated. The SMB dialect is the most likely difference:"
call :note "run again with -Dialect SMB3, and if that fails, -Dialect SMB2."
goto mount_arms_done

rem With the checks stopped at step 2 this mount is the first thing to have
rem presented the credentials, so a refusal is the ordinary answer to a wrong
rem password rather than the dialect mismatch it means when part 3
rem authenticated. The -Dialect retries would spend two more real sign-ins
rem against an account that may be counting them.
:mount_denied_untested
call :note "This mount is the first thing to have tried these credentials at"
call :note "all: the checks in part 3 stopped before they reached them."
call :note "'permission denied' is what a wrong password and an account that"
call :note "is refused this folder both look like, and nothing here can tell"
call :note "them apart. The attempt reached the server as a real sign-in, so"
call :note "do NOT work through candidate passwords from here."
goto mount_arms_done

:mount_arm_dialect
findstr /i /c:"mount error(112)" /c:"host is down" "%WORK%" >nul 2>&1
if errorlevel 1 goto mount_arm_unsupported
call :note "The server accepted the connection and then dropped it, which"
call :note "almost always means it requires a newer SMB dialect than the"
call :note "mount asked for. Run again with -Dialect SMB3."
if defined DEGRADED call :degraded_dialect_retry
goto mount_arms_done

:mount_arm_unsupported
findstr /i /c:"operation not supported" "%WORK%" >nul 2>&1
if errorlevel 1 goto mount_arm_nokey
call :note "The server refused an option the mount asked for -- usually SMB"
call :note "encryption or signing. Run again with -Dialect SMB3."
if defined DEGRADED call :degraded_dialect_retry
goto mount_arms_done

:mount_arm_nokey
findstr /i /c:"required key not available" "%WORK%" >nul 2>&1
if errorlevel 1 goto mount_arms_done
call :note "The mount wanted a Kerberos ticket and the Docker VM has none."
call :note "The server is refusing password authentication. See the"
call :note "troubleshooting page, 'The share never asks for a password'."

:mount_arms_done
if defined DEGRADED call :degraded_losses
docker volume rm "%VOLUME_NAME%" >nul 2>&1
goto fail_generic

:marker_missing
call :bad "The volume is not mounting the folder that was just tested."
call :note "A file left in the folder by part 3 is not visible through the"
call :note "volume, so the two are pointing at different directories. The"
call :note "server, share, or subfolder is wrong somewhere -- a DFS path is"
call :note "the usual reason, because the namespace and the real location can"
call :note "differ in all three."
call :info ""
call :info "Read the real path from the folder Properties, DFS tab, and run"
call :info "again with -Server, -Share and -SubPath. See the troubleshooting"
call :info "page, 'Reading the real path from Windows'."
docker volume rm "%VOLUME_NAME%" >nul 2>&1
goto fail_generic

:fail_generic
call :cleanup
endlocal
exit /b 1

rem ============================================================== subroutines

rem Every one of these opens with "echo(" rather than "echo ". With a plain
rem "echo ", an empty argument leaves the command with nothing to print and it
rem reports the echo setting instead -- "ECHO is off." appears in the middle of
rem the guidance wherever a blank line was meant.
:head
echo(
echo ========================================================================
echo(%~1
echo ========================================================================
exit /b 0

:good
echo(  OK    %~1
exit /b 0

:bad
echo(  FAIL  %~1
exit /b 0

:warn
echo(  WARN  %~1
exit /b 0

:note
echo(        %~1
exit /b 0

:info
echo(        %~1
exit /b 0

:cleanup
set "SMB_PASS="
set "VOL_OPTS="
if exist "%WORK%" del /q "%WORK%" >nul 2>&1
exit /b 0

:show_safely
rem Docker echoes the whole option string back in several of its errors, and
rem that string carries the password. Lines mentioning it are dropped rather
rem than masked: cmd has no way to substitute inside a variable that may itself
rem contain the characters cmd parses.
findstr /v /i /c:"password=" "%WORK%"
findstr /i /c:"password=" "%WORK%" >nul 2>&1
if not errorlevel 1 (
  call :note "(a line naming the mount options was withheld: it contains the"
  call :note "password in the clear)"
)
exit /b 0

rem What the operator is owed when the checks could not run. Named rather than
rem summarised: mount.cifs collapses the server's reasons into one message, so
rem the split the checks make between a password that is wrong and an account
rem that is refused cannot be recovered from a failed mount afterwards, and that
rem split is what decides who has to fix it. A subroutine because the mount
rem failure that reaches it exits differently from the two paths that set up a
rem volume.
:degraded_losses
call :info ""
call :info "Nothing was established about the share itself:"
call :info ""
call :info "  - Whether the username and password are right, and whether this"
call :info "    account is allowed into the folder. A mount that fails says"
call :info "    'permission denied' for either, and they have different fixes:"
call :info "    a password that works, or rights from whoever administers the"
call :info "    share. Telling those two apart is what the checks are for."
call :info "  - So if an exchange cannot reach the folder, do NOT work through"
call :info "    passwords. Each attempt is a real failed sign-in against the"
call :info "    account, and a handful of them locks a domain account out. Get"
call :info "    the checks running first and let them name the reason."
call :info "  - Free space on the share, and whether the folder already holds"
call :info "    more than 8192 files, which psilink will not read."
call :info ""
call :info "The checks need smbclient in the image they run in: see the"
call :info "troubleshooting page, 'The container cannot install its tools',"
call :info "then run this script again."
exit /b 0

rem What the operator is owed when the checks could not run but the mount then
rem succeeded. Not :degraded_losses, whose list opens by saying nothing was
rem established about the share: the mount that reached it established that the
rem credentials do.
:degraded_partial_losses
call :info ""
call :info "The checks in part 3 did not run, and two things they would have"
call :info "settled are still open: whether this volume opens the folder you"
call :info "named rather than a different one -- the file they leave behind"
call :info "for the volume to find is the only test of that -- and whether"
call :info "the folder already holds more than 8192 files, which psilink"
call :info "will not read."
call :info ""
call :info "The checks need smbclient in the image they run in: see the"
call :info "troubleshooting page, 'The container cannot install its tools',"
call :info "then run this script again."
exit /b 0

rem What a -Dialect retry means when the checks never reached the credentials.
rem Measured against Samba 4.21 with authentication auditing on: a mount refused
rem over the dialect -- 'host is down' from an SMB1-only server, 'operation not
rem supported' from one either side of the dialect asked for -- produces no
rem authentication event at all, because the dialect is settled before a
rem credential is sent. Only an attempt that gets past it reaches session setup,
rem and that one is a real sign-in.
:degraded_dialect_retry
call :info ""
call :note "Make that retry, but not more than that: the checks in part 3 never"
call :note "reached the credentials, so nothing here has tried them. A dialect"
call :note "the server will not take is refused before any password is sent, so"
call :note "this failure cost the account nothing -- but the first attempt that"
call :note "gets past the dialect is the first real sign-in against it. If one"
call :note "comes back 'permission denied', stop there rather than working"
call :note "through candidate passwords."
exit /b 0

:dialect_opt
rem smbclient's SMB3 is 3.1.1, not 3.0, and pinning the mount to 3.0 while the
rem checks ran at 3.1.1 produces exactly the "step 3 passed, step 4 failed"
rem confusion the flag exists to remove.
if not defined DIALECT exit /b 0
if /i "%DIALECT%"=="SMB3" set "VOL_OPTS=%VOL_OPTS%,vers=3.1.1"
if /i "%DIALECT%"=="SMB2" set "VOL_OPTS=%VOL_OPTS%,vers=2.1"
if /i "%DIALECT%"=="NT1" (
  set "VOL_OPTS=%VOL_OPTS%,vers=1.0"
  call :warn "The Docker VM kernel is built without SMB1, so the mount below"
  call :note "will be refused however well the checks went. -Dialect NT1 is"
  call :note "useful for diagnosis only. If the server speaks nothing newer,"
  call :note "ask IT for a scheduled mirror to a local folder instead -- the"
  call :note "troubleshooting page has the request, under 'What to ask your"
  call :note "IT department for'."
)
exit /b 0

:trim_slashes
if not defined SUBPATH exit /b 0
if "%SUBPATH:~0,1%"=="/" set "SUBPATH=%SUBPATH:~1%"
if not defined SUBPATH exit /b 0
if "%SUBPATH:~-1%"=="/" set "SUBPATH=%SUBPATH:~0,-1%"
exit /b 0

:resolve_drop
rem Classify the path the operator sees in Explorer, setting RESOLVE_KIND to
rem Local, Network or Unknown, plus RESOLVE_SERVER / RESOLVE_SHARE /
rem RESOLVE_SUBPATH / RESOLVE_FULL / RESOLVE_LOCAL / RESOLVE_REASON.
rem
rem There is deliberately no attempt to work out the file server behind a DFS
rem namespace. Reading the SMB connection list needs Administrator rights, an
rem elevated window cannot see the mapped drives this depends on, and a
rem namespace path holds a connection to the namespace root as well as to the
rem target -- so the answer is at best the name already in hand. The
rem confirmation step is what covers this instead.
set "RESOLVE_KIND=Unknown"
set "RESOLVE_SERVER="
set "RESOLVE_SHARE="
set "RESOLVE_SUBPATH="
set "RESOLVE_FULL="
set "RESOLVE_LOCAL="
set "RESOLVE_REASON=could not interpret '%~1'"

set "RAW=%~1"
if not defined RAW (
  set "RESOLVE_REASON=empty path"
  exit /b 0
)
rem Windows accepts either slash, and a path copied out of a ticket often
rem arrives with forward ones. Fold them so only one separator is matched on.
set "RAW=%RAW:/=\%"
if "%RAW:~-1%"=="\" set "RAW=%RAW:~0,-1%"
if not defined RAW (
  set "RESOLVE_REASON=empty path"
  exit /b 0
)

if "%RAW:~1,1%"==":" goto rd_letter
if "%RAW:~0,2%"=="\\" goto rd_unc
exit /b 0

:rd_letter
set "DL=%RAW:~0,1%"
set "REST=%RAW:~2%"
if "%REST:~0,1%"=="\" set "REST=%REST:~1%"

call :resolve_mapped "%DL%" MAPPED
if defined MAPPED goto rd_mapped

rem Not a mapping this session can see. Establish what the letter is
rem positively rather than inferring a local folder from the absence of one --
rem reporting a network drive as local sends the operator off to bind-mount a
rem path that does not exist.
set "DKIND="
for /f "tokens=2 delims=-" %%k in ('fsutil fsinfo drivetype %DL%: 2^>nul') do set "DKIND=%%k"
echo %DKIND% | findstr /i /c:"Fixed" >nul 2>&1
if not errorlevel 1 goto rd_local
echo %DKIND% | findstr /i /c:"Removable" >nul 2>&1
if not errorlevel 1 goto rd_local
echo %DKIND% | findstr /i /c:"Remote" >nul 2>&1
if not errorlevel 1 (
  set "RESOLVE_REASON=%DL%: is a network drive but Windows will not say what it maps to. Run 'net use' in this window and pass the answer with -Server and -Share"
  exit /b 0
)
set "RESOLVE_REASON=there is no %DL%: drive on this PC. If it is a network drive that is not connected right now, open it in File Explorer first, then run the script again"
exit /b 0

:rd_local
set "RESOLVE_KIND=Local"
set "RESOLVE_LOCAL=%RAW%"
exit /b 0

:rd_mapped
call :good "%DL%: is mapped to %MAPPED%"
if defined REST (
  set "RAW=%MAPPED%\%REST%"
) else (
  set "RAW=%MAPPED%"
)
goto rd_unc

:rd_unc
if not "%RAW:~0,2%"=="\\" exit /b 0
set "BODY=%RAW:~2%"

rem Split on backslashes by trimming prefixes rather than by tokenising: a
rem share or folder name may legitimately contain spaces, which for /f would
rem break into separate tokens.
set "SRV="
for /f "tokens=1 delims=\" %%s in ("%BODY%") do set "SRV=%%s"
if not defined SRV exit /b 0

set "AFTERSRV=%BODY:*\=%"
if "%AFTERSRV%"=="%BODY%" (
  set "RESOLVE_REASON=that path names the server '%SRV%' but no share. Include the share as well, as in \\%SRV%\exchange"
  exit /b 0
)

set "SHR="
for /f "tokens=1 delims=\" %%s in ("%AFTERSRV%") do set "SHR=%%s"
if not defined SHR (
  set "RESOLVE_REASON=that path names the server '%SRV%' but no share. Include the share as well, as in \\%SRV%\exchange"
  exit /b 0
)

rem No further backslash leaves the string unchanged, which is how "no
rem subfolder" is told apart from one.
set "SUB=%AFTERSRV:*\=%"
if "%SUB%"=="%AFTERSRV%" set "SUB="
if defined SUB set "SUB=%SUB:\=/%"

set "RESOLVE_KIND=Network"
set "RESOLVE_SERVER=%SRV%"
set "RESOLVE_SHARE=%SHR%"
set "RESOLVE_SUBPATH=%SUB%"
set "RESOLVE_FULL=%RAW%"
exit /b 0

:resolve_mapped
rem %1 = drive letter, %2 = name of the variable to receive the UNC root.
rem
rem net use is the only lookup available here; the PowerShell script has three
rem and falls back between them. All of them read the drive table of the logon
rem session they run in, so none sees a drive mapped by a different session --
rem which is what makes an elevated window blind to the operator's own
rem mappings.
rem
rem The line is found by its "\\" prefix rather than by the words "Remote
rem name", which are translated on a localised Windows.
setlocal enabledelayedexpansion
set "FOUND="
net use "%~1:" >nul 2>&1
if errorlevel 1 goto rm_done
for /f "tokens=1,2,*" %%a in ('net use "%~1:" 2^>nul') do (
  if not defined FOUND (
    set "CAND=%%c"
    if defined CAND (
      if "!CAND:~0,2!"=="\\" set "FOUND=!CAND!"
    )
  )
)
:rm_done
endlocal & set "%~2=%FOUND%"
exit /b 0
