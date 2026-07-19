param(
  [Parameter(Mandatory = $true)][string]$Msi,
  [switch]$Purge,
  [switch]$Passive
)
$ErrorActionPreference = 'Stop'
$Identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$Principal = [Security.Principal.WindowsPrincipal]::new($Identity)
if (-not $Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run this uninstaller as Administrator.' }
if (-not (Test-Path -LiteralPath $Msi -PathType Leaf)) { throw "MSI does not exist: $Msi" }
$UiMode = if ($Passive) { '/passive' } else { '/qn' }
$MsiPath = [IO.Path]::GetFullPath($Msi)
$Process = Start-Process -FilePath msiexec.exe -ArgumentList "/x `"$MsiPath`" $UiMode /norestart" -Wait -PassThru
if ($Process.ExitCode -notin @(0, 1605, 3010)) { throw "MSI uninstall failed with exit code $($Process.ExitCode)." }
if ($Purge) { Remove-Item -LiteralPath (Join-Path $env:ProgramData 'Fleet Canvas\agent') -Recurse -Force -ErrorAction SilentlyContinue }
Write-Host 'Fleet Canvas Agent MSI removed.'
