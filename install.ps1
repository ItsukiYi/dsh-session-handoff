# dsh-session-handoff - one-click installer
# Usage (on the other PC, PowerShell):
#   irm https://raw.githubusercontent.com/ItsukiYi/dsh-session-handoff/main/install.ps1 | iex
# Or from a local folder:
#   powershell -ExecutionPolicy Bypass -File install.ps1 -LocalSource "D:\dsh-plugins\dsh-session-handoff"
param(
  [string]$Profile = 'desktop',
  [string]$DshHome = '',
  [string]$InstallDir = '',
  [string]$DshCmd = '',
  [string]$LocalSource = '',
  [string]$Repo = 'ItsukiYi/dsh-session-handoff',
  [string]$Branch = 'main',
  [string]$BranchZip = '',
  [switch]$NoBundleEdit
)

$ErrorActionPreference = 'Stop'
$PluginName = 'dsh-session-handoff'

function Write-Step([string]$text) { Write-Host "==> $text" -ForegroundColor Cyan }
function Write-Ok([string]$text)   { Write-Host "    $text" -ForegroundColor Green }
function Write-Warn2([string]$text){ Write-Host "    $text" -ForegroundColor Yellow }

function Resolve-DshHome {
  param([string]$hint)
  if ($hint) { return (Resolve-Path $hint).Path }
  if ($env:DSH_HOME -and (Test-Path $env:DSH_HOME)) { return $env:DSH_HOME }
  $candidates = @(
    (Join-Path $env:USERPROFILE '.dsh'),
    (Join-Path $env:LOCALAPPDATA 'dsh'),
    (Join-Path $env:APPDATA 'dsh')
  )
  foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
  throw "Cannot find DSH data dir (.dsh). Pass -DshHome, e.g. -DshHome C:\Users\you\.dsh"
}

function Resolve-DshCmd {
  param([string]$hint)
  if ($hint) {
    if (Test-Path $hint) { return (Resolve-Path $hint).Path }
    throw "dsh.cmd not found at: $hint"
  }
  $candidates = @(
    'D:\deepseek-harness-desktop\resources\runtime\cli\bin\dsh.cmd',
    (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'),
    (Join-Path $env:LOCALAPPDATA 'Programs\deepseek-harness-desktop\resources\runtime\cli\bin\dsh.cmd'),
    (Join-Path $env:ProgramFiles 'DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd')
  )
  foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
  $found = Get-Command dsh.cmd -ErrorAction SilentlyContinue
  if ($found) { return $found.Source }
  foreach ($drive in @('C','D','E','F')) {
    $root = $drive + ':\deepseek-harness-desktop\resources\runtime\cli\bin\dsh.cmd'
    if (Test-Path $root) { return $root }
  }
  throw "Cannot find dsh.cmd (DSH CLI). Pass -DshCmd, e.g. -DshCmd 'D:\deepseek-harness-desktop\resources\runtime\cli\bin\dsh.cmd'"
}

function Install-FromZip {
  param([string]$url, [string]$target)
  $tmp = Join-Path $env:TEMP ("dsh-handoff-" + [guid]::NewGuid().ToString('N') + '.zip')
  $extract = Join-Path $env:TEMP ("dsh-handoff-x-" + [guid]::NewGuid().ToString('N'))
  Write-Step "Downloading plugin from $url"
  try {
    Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing -TimeoutSec 120
  } catch {
    throw "Download failed (network): $($_.Exception.Message). Alternatively use -LocalSource with a copied folder."
  }
  Write-Ok ("Downloaded " + [math]::Round((Get-Item $tmp).Length / 1KB) + " KB")
  Expand-Archive -Path $tmp -DestinationPath $extract -Force
  $inner = Get-ChildItem $extract -Directory | Select-Object -First 1
  if (-not $inner) { throw "Zip has no folder; download may be wrong" }
  if (Test-Path $target) { Remove-Item $target -Recurse -Force }
  New-Item -ItemType Directory -Path (Split-Path $target) -Force | Out-Null
  Move-Item $inner.FullName $target
  Remove-Item $tmp, $extract -Recurse -Force -ErrorAction SilentlyContinue
  Write-Ok "Extracted to $target"
}

function Add-BundleEntry {
  param([string]$profileDir, [string]$name)
  $pkgPath = Join-Path $profileDir 'package.json'
  if (-not (Test-Path $pkgPath)) { throw "profile package.json missing: $pkgPath (start DSH once to initialize the profile)" }
  $json = Get-Content $pkgPath -Raw | ConvertFrom-Json
  if (-not ($json.PSObject.Properties.Name -contains 'dsh')) {
    $json | Add-Member -NotePropertyName 'dsh' -NotePropertyValue ([pscustomobject]@{}) -Force
  }
  if (-not ($json.dsh.PSObject.Properties.Name -contains 'profile')) {
    $json.dsh | Add-Member -NotePropertyName 'profile' -NotePropertyValue ([pscustomobject]@{}) -Force
  }
  $bundles = @()
  if ($json.dsh.profile.PSObject.Properties.Name -contains 'bundles' -and $null -ne $json.dsh.profile.bundles) {
    $bundles = @($json.dsh.profile.bundles)
  }
  if ($bundles -contains $name) {
    Write-Ok "bundles already contains $name"
  } else {
    $bundles += $name
    $json.dsh.profile | Add-Member -NotePropertyName 'bundles' -NotePropertyValue $bundles -Force
    $json | ConvertTo-Json -Depth 30 | Set-Content $pkgPath -Encoding UTF8
    Write-Ok "Added $name to bundles"
  }
}

Write-Host ""
Write-Host "dsh-session-handoff one-click install" -ForegroundColor Magenta
Write-Host ""

$dshHome = Resolve-DshHome $DshHome
Write-Ok "DSH_HOME: $dshHome"

$cmd = Resolve-DshCmd $DshCmd
Write-Ok "dsh.cmd: $cmd"

$profileDir = Join-Path (Join-Path $dshHome 'profiles') $Profile
Write-Ok "profile: $profileDir"

if (-not $InstallDir) {
  $InstallDir = Join-Path (Join-Path $env:LOCALAPPDATA 'dsh-plugins') $PluginName
}

# When launched from a copied folder (install.cmd), prefer that folder over downloading.
if (-not $LocalSource -and $PSScriptRoot) {
  if (Test-Path (Join-Path $PSScriptRoot 'package.json')) { $LocalSource = $PSScriptRoot }
}

if ($LocalSource) {
  if (-not (Test-Path (Join-Path $LocalSource 'package.json'))) {
    throw "LocalSource is not a plugin folder (no package.json): $LocalSource"
  }
  $InstallDir = (Resolve-Path $LocalSource).Path
  Write-Step "Using local folder $InstallDir (skip download)"
} else {
  if (-not $BranchZip) { $BranchZip = "https://github.com/$Repo/archive/refs/heads/$Branch.zip" }
  Install-FromZip $BranchZip $InstallDir
}

Write-Step "Installing into profile (CLI path, bypasses GUI dependency check)"
& $cmd plugin --profile $Profile add "link:$InstallDir"
if ($LASTEXITCODE -ne 0) {
  throw "dsh plugin add failed (exit $LASTEXITCODE). Send me the output above."
}
Write-Ok "Dependency installed"

if (-not $NoBundleEdit) {
  Write-Step "Adding plugin to profile bundles"
  if (-not (Test-Path $profileDir)) {
    Write-Warn2 "profile dir does not exist yet; start DSH once then re-run, or add bundles manually"
  } else {
    Add-BundleEntry $profileDir $PluginName
  }
}

Write-Host ""
Write-Host "Install complete!" -ForegroundColor Green
Write-Host "Fully quit DSH (including tray/background processes), then start it again." -ForegroundColor Yellow
Write-Host "Then: click the floating ball -> workspace = local FinalProject folder -> remote = https://github.com/ItsukiYi/FinalProject -> click Pull" -ForegroundColor Yellow
Write-Host ""