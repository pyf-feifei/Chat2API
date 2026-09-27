<#
.SYNOPSIS
    Build the Chat2API server image for linux/amd64 and push it to Docker Hub.

.DESCRIPTION
    The production server runs the container from a Docker Hub image and never
    builds from source, so the image is the deployment artifact:

        this script (build + push)  ->  Docker Hub  ->  server-update.sh (pull + recreate)

    The tag defaults to the short git SHA, suffixed with -dirty when the working
    tree has uncommitted changes, so an image can always be traced back to the
    source that produced it. Override it with -Tag for a descriptive release tag.

.PARAMETER Image
    Docker Hub repository. Defaults to $env:CHAT2API_DEPLOY_IMAGE, then 'skatef/chat2api'.

.PARAMETER Tag
    Image tag. Defaults to the short git SHA.

.PARAMETER NoPush
    Build only. Useful for verifying the build before spending a multi-GB push.

.PARAMETER Provenance
    Keep the buildx attestation/SBOM manifest. Off by default: it adds an extra
    unknown/unknown manifest entry for a single-platform internal image.

.PARAMETER Deploy
    After a successful push, copy server-update.sh to the server and run it.
    Set -Server and -ServerUser to match the target host.

.EXAMPLE
    .\scripts\deploy\build-push.ps1 -Deploy -Server 195.242.178.82

.EXAMPLE
    .\scripts\deploy\build-push.ps1 -Tag quota-rotate -NoPush
#>
[CmdletBinding()]
param(
    [string] $Image = $(if ($env:CHAT2API_DEPLOY_IMAGE) { $env:CHAT2API_DEPLOY_IMAGE } else { 'skatef/chat2api' }),
    [string] $Tag,
    [string] $Server = '195.242.178.82',
    [string] $ServerUser = 'root',
    [switch] $NoPush,
    [switch] $Provenance,
    [switch] $Deploy
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path

function Write-Step($message) { Write-Host "`n==> $message" -ForegroundColor Cyan }
function Write-Warn2($message) { Write-Host "[warn] $message" -ForegroundColor Yellow }
function Fail($message) { throw $message }

# Docker and buildx report progress on stderr. Under ErrorActionPreference=Stop
# PowerShell promotes that to a terminating NativeCommandError, which kills the
# script on the first progress line. Native calls therefore run with the
# preference relaxed and are judged on the exit code alone.
function Invoke-Native {
    param([string] $Exe, [string[]] $Arguments, [switch] $Quiet)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        if ($Quiet) { & $Exe @Arguments *> $null } else { & $Exe @Arguments }
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
    return $code
}

# Same, but captures stdout instead of streaming it. Keeps the exit code and the
# output separate: a bare `return $LASTEXITCODE` after a command that prints
# would hand back an array of both.
function Get-NativeOutput {
    param([string] $Exe, [string[]] $Arguments)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = @(& $Exe @Arguments 2>$null)
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
    return [pscustomobject]@{ ExitCode = $code; Output = $output }
}

# --------------------------------------------------------------- toolchain --
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Fail 'docker is not on PATH'
}
if ((Invoke-Native 'docker' @('info') -Quiet) -ne 0) { Fail 'the docker daemon is not reachable (is Docker Desktop running?)' }

if ((Invoke-Native 'docker' @('buildx', 'version') -Quiet) -ne 0) {
    Fail 'docker buildx is required. Docker Desktop 29+ ships it; otherwise run: docker buildx create --use'
}

# --------------------------------------------------------------------- tag --
Push-Location $repoRoot

$head = Get-NativeOutput 'git' @('rev-parse', '--short', 'HEAD')
if ($head.ExitCode -ne 0) { Fail 'not a git repository, or git is unavailable' }
$sha = ($head.Output | Select-Object -First 1).Trim()

$dirty = $false
if ((Invoke-Native 'git' @('diff', '--quiet', '--ignore-submodules', 'HEAD') -Quiet) -ne 0) { $dirty = $true }
if (-not $dirty) {
    $untracked = Get-NativeOutput 'git' @('ls-files', '--others', '--exclude-standard')
    if ($untracked.Output) { $dirty = $true }
}

if (-not $Tag) {
    $Tag = if ($dirty) { "$sha-dirty" } else { $sha }
}
$Ref = "$Image`:$Tag"

# ------------------------------------------------------------------ build --
Write-Step "Building $Ref for linux/amd64"
Write-Host "    source: $sha$(if ($dirty) { ' (uncommitted changes present)' })"
if ($dirty -and -not $Tag) { Write-Warn2 'tag carries -dirty; the image includes uncommitted work' }

$buildArgs = @(
    'buildx', 'build',
    '--platform', 'linux/amd64',
    '--tag', $Ref,
    '--file', 'Dockerfile',
    '--progress', 'plain'
)
if ($Provenance) { $buildArgs += '--provenance=true' } else { $buildArgs += '--provenance=false' }
if (-not $NoPush) { $buildArgs += '--push' }
$buildArgs += '.'

Write-Host "    docker $($buildArgs -join ' ')"
$sw = [Diagnostics.Stopwatch]::StartNew()
if ((Invoke-Native 'docker' $buildArgs) -ne 0) { Fail "docker buildx build failed for $Ref" }
Write-Host "    build+push took $($sw.Elapsed.ToString('hh\:mm\:ss'))"

# ----------------------------------------------------------------- report --
if ($NoPush) {
    Write-Step "Built (not pushed)"
    Write-Host "    $Ref is in the local daemon only. Re-run without -NoPush to publish."
    Pop-Location
    return
}

Write-Step "Pushed $Ref"
Invoke-Native 'docker' @('image', 'inspect', $Ref, '--format', '    id {{.Id}}  size {{.Size}}')

if ((Invoke-Native 'docker' @('manifest', 'inspect', $Ref) -Quiet) -eq 0) {
    Write-Host '    remote manifest verified'
} else {
    Write-Warn2 'could not verify the remote manifest; check the push output above'
}

# ----------------------------------------------------------------- deploy --
if (-not $Deploy) {
    Write-Step 'Next'
    Write-Host "    scp scripts/deploy/server-update.sh ${ServerUser}@${Server}:/opt/chat2api/server-update.sh"
    Write-Host "    ssh ${ServerUser}@${Server} 'bash /opt/chat2api/server-update.sh $Ref'"
    Write-Host ''
    Write-Host '  or re-run with -Deploy to do both steps.'
    Pop-Location
    return
}

Write-Step "Deploying to ${ServerUser}@${Server}"
$remoteScript = '/opt/chat2api/server-update.sh'
if ((Invoke-Native 'scp' @('-q', (Join-Path $PSScriptRoot 'server-update.sh'), "${ServerUser}@${Server}:${remoteScript}")) -ne 0) {
    Fail "could not copy server-update.sh to ${ServerUser}@${Server}"
}

Write-Host "    ssh ${ServerUser}@${Server} bash ${remoteScript} ${Ref}"
if ((Invoke-Native 'ssh' @('-t', "${ServerUser}@${Server}", "bash ${remoteScript} ${Ref}")) -ne 0) {
    Fail "server-side update failed. The previous container was restored automatically; see the output above."
}

Write-Step "Live: $Ref"
Pop-Location
