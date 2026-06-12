param(
  [string]$ShortcutPath = 'C:\ProgramData\Microsoft\Windows\Start Menu\Programs\LM Studio.lnk',
  [string]$LmsExe = "$env:USERPROFILE\.lmstudio\bin\lms.exe",
  [string]$ModelPath = $(if ($env:P2AI_LMSTUDIO_MODEL_PATH) { $env:P2AI_LMSTUDIO_MODEL_PATH } else { 'google/gemma-4-e4b' }),
  [string]$ModelIdentifier = $(if ($env:P2AI_LMSTUDIO_MODEL_IDENTIFIER) { $env:P2AI_LMSTUDIO_MODEL_IDENTIFIER } else { 'gemma-4-E4B-it-GGUF' }),
  [int]$ContextLength = $(if ($env:P2AI_LMSTUDIO_CONTEXT_LENGTH) { [int]$env:P2AI_LMSTUDIO_CONTEXT_LENGTH } else { 32768 }),
  [string]$GpuOffload = $(if ($env:P2AI_LMSTUDIO_GPU_OFFLOAD) { $env:P2AI_LMSTUDIO_GPU_OFFLOAD } else { 'max' }),
  [int]$ExpectedGpuLayers = $(if ($env:P2AI_LMSTUDIO_EXPECTED_GPU_LAYERS) { [int]$env:P2AI_LMSTUDIO_EXPECTED_GPU_LAYERS } else { 43 }),
  [switch]$SkipGpuLayerVerification,
  [switch]$SkipModelLoad
)

$ErrorActionPreference = 'Stop'
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
  $PSNativeCommandUseErrorActionPreference = $false
}

function Invoke-LmsText([string[]]$Arguments) {
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = & $script:LmsExe @Arguments 2>&1 | ForEach-Object { $_.ToString() }
    return ($output -join [Environment]::NewLine)
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
}

function Get-LmsModels {
  $raw = Invoke-LmsText @('ps', '--json')
  if ([string]::IsNullOrWhiteSpace($raw)) {
    return @()
  }
  try {
    return @($raw | ConvertFrom-Json)
  } catch {
    Write-Warning "Could not parse lms ps --json output:"
    Write-Warning $raw
    throw
  }
}

function Test-LmsServerRunning([string]$StatusText) {
  return ($StatusText -match 'running' -and $StatusText -notmatch 'not running')
}

function Wait-LmsServerRunning([int]$TimeoutSeconds = 45) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    $status = Invoke-LmsText @('server', 'status')
    Write-Host $status
    if (Test-LmsServerRunning $status) {
      return $true
    }
    Start-Sleep -Seconds 1
  } while ((Get-Date) -lt $deadline)
  return $false
}

function Get-LatestLmStudioServerLog {
  $root = Join-Path $env:USERPROFILE '.lmstudio\server-logs'
  if (-not (Test-Path -LiteralPath $root)) {
    return $null
  }
  return Get-ChildItem -LiteralPath $root -Recurse -File |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
}

function Read-LmStudioLogDelta($BeforeLog, [int]$BeforeLineCount) {
  $latest = Get-LatestLmStudioServerLog
  if (-not $latest) {
    return ''
  }
  $lines = @(Get-Content -LiteralPath $latest.FullName)
  if ($BeforeLog -and $latest.FullName -eq $BeforeLog.FullName -and $lines.Count -gt $BeforeLineCount) {
    return (($lines | Select-Object -Skip $BeforeLineCount) -join [Environment]::NewLine)
  }
  return ($lines -join [Environment]::NewLine)
}

function Assert-ExpectedGpuLayers([string]$LogText, [int]$ExpectedLayers) {
  if ($SkipGpuLayerVerification) {
    return
  }
  $expectedLine = "offloaded $ExpectedLayers/$ExpectedLayers layers to GPU"
  if ($LogText -notmatch [regex]::Escape($expectedLine)) {
    Write-Error "LM Studio did not prove GPU max offload. Expected server log line: '$expectedLine'."
    exit 2
  }
  Write-Host "Verified LM Studio GPU max offload: $expectedLine"
}

if (-not (Test-Path -LiteralPath $ShortcutPath)) {
  Write-Error "LM Studio shortcut not found: $ShortcutPath"
  exit 1
}

if (-not (Test-Path -LiteralPath $LmsExe)) {
  $cmd = Get-Command lms.exe -ErrorAction SilentlyContinue
  if (-not $cmd) {
    Write-Error "LM Studio CLI not found: $LmsExe"
    exit 1
  }
  $LmsExe = $cmd.Source
}

$script:LmsExe = $LmsExe

Write-Host "Starting LM Studio GUI through shortcut..."
Start-Process -FilePath explorer.exe -ArgumentList "`"$ShortcutPath`""
Start-Sleep -Seconds 8

$serverStatus = Invoke-LmsText @('server', 'status')
Write-Host $serverStatus
if (-not (Test-LmsServerRunning $serverStatus)) {
  Write-Host "Starting LM Studio server..."
  Write-Host (Invoke-LmsText @('server', 'start'))
  if (-not (Wait-LmsServerRunning 45)) {
    Write-Error "LM Studio server did not become running."
    exit 1
  }
}

if (-not $SkipModelLoad -and $env:P2AI_LMSTUDIO_SKIP_MODEL_LOAD -ne '1') {
  $beforeLoadLog = Get-LatestLmStudioServerLog
  $beforeLoadLineCount = if ($beforeLoadLog) { @(Get-Content -LiteralPath $beforeLoadLog.FullName).Count } else { 0 }
  $models = Get-LmsModels
  $loaded = $models | Where-Object { $_.identifier -eq $ModelIdentifier } | Select-Object -First 1

  if ($loaded) {
    Write-Host "Reloading LM Studio golden model alias to force golden runtime config..."
    Write-Host (Invoke-LmsText @('unload', $ModelIdentifier))
  }

  Write-Host "Loading LM Studio golden model alias..."
  Write-Host "  model path: $ModelPath"
  Write-Host "  identifier: $ModelIdentifier"
  Write-Host "  context: $ContextLength"
  Write-Host "  gpu offload: $GpuOffload"
  Write-Host "  expected gpu layers: $ExpectedGpuLayers/$ExpectedGpuLayers"
  Write-Host (Invoke-LmsText @(
    'load',
    $ModelPath,
    '--identifier',
    $ModelIdentifier,
    '--context-length',
    "$ContextLength",
    '--gpu',
    $GpuOffload,
    '-y'
  ))

  $loadLogText = Read-LmStudioLogDelta -BeforeLog $beforeLoadLog -BeforeLineCount $beforeLoadLineCount
  Assert-ExpectedGpuLayers -LogText $loadLogText -ExpectedLayers $ExpectedGpuLayers
} else {
  Write-Host "Skipping LM Studio model load."
}

$finalServerStatus = Invoke-LmsText @('server', 'status')
Write-Host $finalServerStatus
if (-not (Test-LmsServerRunning $finalServerStatus)) {
  Write-Error "LM Studio server is not running after model load."
  exit 1
}
Write-Host (Invoke-LmsText @('ps', '--json'))
exit 0
