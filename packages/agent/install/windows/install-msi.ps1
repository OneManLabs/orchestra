param(
  [Parameter(Mandatory = $true)][string]$Msi,
  [string]$ConfigFile = '',
  [string]$CoreUrl = '',
  [string]$Role = '',
  [string]$DeviceName = '',
  [string]$ProjectRoots = '',
  [string]$CodexCommand = '',
  [string]$CodexHome = '',
  [string]$EnrollmentTokenFile = '',
  [string]$TokenFile = '',
  [switch]$AllowPowerActions,
  [switch]$PreventSleepDuringJobs,
  [switch]$ConsumeSecretFiles,
  [switch]$ConsumeInputFiles,
  [switch]$Passive
)
$ErrorActionPreference = 'Stop'
$Identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$Principal = [Security.Principal.WindowsPrincipal]::new($Identity)
if (-not $Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run this installer as Administrator.' }
if (-not (Test-Path -LiteralPath $Msi -PathType Leaf)) { throw "MSI does not exist: $Msi" }

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Configure = Join-Path $Root 'configure.ps1'
if (-not (Test-Path -LiteralPath $Configure -PathType Leaf)) { throw 'configure.ps1 must be distributed beside install-msi.ps1.' }
$ConfigureArguments = @{ NoRestart = $true }
if ($ConfigFile) { $ConfigureArguments.ConfigFile = $ConfigFile }
if ($CoreUrl) { $ConfigureArguments.CoreUrl = $CoreUrl }
if ($Role) { $ConfigureArguments.Role = $Role }
if ($DeviceName) { $ConfigureArguments.DeviceName = $DeviceName }
if ($ProjectRoots) { $ConfigureArguments.ProjectRoots = $ProjectRoots }
if ($CodexCommand) { $ConfigureArguments.CodexCommand = $CodexCommand }
if ($CodexHome) { $ConfigureArguments.CodexHome = $CodexHome }
if ($EnrollmentTokenFile) { $ConfigureArguments.EnrollmentTokenFile = $EnrollmentTokenFile }
if ($TokenFile) { $ConfigureArguments.TokenFile = $TokenFile }
if ($AllowPowerActions) { $ConfigureArguments.AllowPowerActions = $true }
if ($PreventSleepDuringJobs) { $ConfigureArguments.PreventSleepDuringJobs = $true }
if ($ConsumeSecretFiles) { $ConfigureArguments.ConsumeSecretFiles = $true }
if ($ConsumeInputFiles) { $ConfigureArguments.ConsumeInputFiles = $true }
& $Configure @ConfigureArguments

$UiMode = if ($Passive) { '/passive' } else { '/qn' }
$MsiPath = [IO.Path]::GetFullPath($Msi)
$Process = Start-Process -FilePath msiexec.exe -ArgumentList "/i `"$MsiPath`" $UiMode /norestart" -Wait -PassThru
if ($Process.ExitCode -notin @(0, 3010)) { throw "MSI installation failed with exit code $($Process.ExitCode)." }
Write-Host 'Fleet Canvas Agent MSI installed and configured.'
