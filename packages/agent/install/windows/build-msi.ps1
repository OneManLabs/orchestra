param(
  [Parameter(Mandatory = $true)][string]$Bundle,
  [Parameter(Mandatory = $true)][string]$WinSw,
  [string]$WinSwSha256 = '05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da',
  [string]$NodeExe = '',
  [string]$NodeLicense = '',
  [string]$Version = '2.0.0',
  [string]$Output = ''
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not (Test-Path (Join-Path $Bundle 'dist\cli.js') -PathType Leaf)) { throw 'Bundle must be created on Windows by build-bundle.mjs.' }
$PtyOmittedMarker = Join-Path $Bundle '.fleet-agent-omit-pty'
$PtyIntentionallyOmitted = (Test-Path $PtyOmittedMarker -PathType Leaf) -and ((Get-Content -LiteralPath $PtyOmittedMarker -Raw).Trim() -eq 'fleet-agent-omit-pty-v1')
if (-not (Test-Path (Join-Path $Bundle 'node_modules\node-pty\package.json') -PathType Leaf) -and -not $PtyIntentionallyOmitted) { throw 'Bundle is missing node-pty without the appliance-mode marker.' }
if (-not (Test-Path (Join-Path $Bundle 'node_modules\ws\package.json') -PathType Leaf)) { throw 'Bundle is missing the WebSocket runtime.' }
if (-not (Test-Path $WinSw -PathType Leaf)) { throw 'WinSW executable was not found.' }
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $WinSw).Hash.ToLowerInvariant() -ne $WinSwSha256.ToLowerInvariant()) { throw 'WinSW SHA-256 verification failed.' }
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw 'MSI Version must contain exactly three numeric components.' }
if (-not $NodeExe) { $NodeExe = (Get-Command node.exe -ErrorAction Stop).Source }
if (-not (Test-Path $NodeExe -PathType Leaf)) { throw 'Node executable was not found.' }
if (-not $NodeLicense) { $NodeLicense = Join-Path (Split-Path -Parent $NodeExe) 'LICENSE' }
if (-not (Test-Path $NodeLicense -PathType Leaf)) { throw 'Node.js license file was not found. Supply -NodeLicense with the license distributed with node.exe.' }
$NodeMajor = [int](& $NodeExe -p "Number(process.versions.node.split('.')[0])")
if ($NodeMajor -lt 22) { throw 'Node.js 22 or newer is required to build the self-contained MSI.' }
if (-not (Get-Command wix.exe -ErrorAction SilentlyContinue)) { throw 'WiX v5 is required (dotnet tool install --global wix --version 5.0.2).' }

$Work = Join-Path ([IO.Path]::GetTempPath()) ("fleet-agent-msi-{0}" -f [Guid]::NewGuid().ToString('N'))
$Staging = Join-Path $Work 'staging'
$Generated = Join-Path $Work 'RuntimeFiles.wxs'
New-Item -ItemType Directory -Force $Staging | Out-Null
try {
  Copy-Item -Recurse -Force (Join-Path $Bundle '*') $Staging
  Copy-Item -Force $NodeExe (Join-Path $Staging 'node.exe')
  Copy-Item -Force $NodeLicense (Join-Path $Staging 'NODE-LICENSE.txt')
  Copy-Item -Force $WinSw (Join-Path $Staging 'FleetCanvasAgentService.exe')
  foreach ($Asset in @('FleetCanvasAgentService.xml', 'service-host.mjs', 'configure.ps1', 'WINSW-LICENSE.txt')) {
    Copy-Item -Force (Join-Path $Root $Asset) (Join-Path $Staging $Asset)
  }
  & (Join-Path $Staging 'node.exe') (Join-Path $Root 'generate-wix-fragment.mjs') $Staging $Generated
  if (-not $Output) { $Output = Join-Path (Get-Location) "fleet-canvas-agent-$Version-x64.msi" }
  $Output = [IO.Path]::GetFullPath($Output)
  New-Item -ItemType Directory -Force (Split-Path -Parent $Output) | Out-Null
  & wix.exe build (Join-Path $Root 'Product.wxs') $Generated -arch x64 "-dStagingDir=$Staging" "-dProductVersion=$Version" -o $Output
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $Output -PathType Leaf)) { throw 'WiX failed to produce the MSI.' }
  foreach ($Companion in @('configure.ps1', 'install-msi.ps1', 'uninstall-msi.ps1', 'service-config.example.json')) {
    Copy-Item -Force (Join-Path $Root $Companion) (Join-Path (Split-Path -Parent $Output) $Companion)
  }
  Write-Host "Built unsigned MSI: $Output"
} finally {
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $Work
}
