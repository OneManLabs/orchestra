param(
  [string]$Path = 'C:\FleetBootstrap\enrollment-token'
)

$ErrorActionPreference = 'Stop'
$Identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$Principal = [Security.Principal.WindowsPrincipal]::new($Identity)
if (-not $Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run this command as Administrator.' }
$SystemDirectoryAcl = '*S-1-5-18:(OI)(CI)F'
$AdministratorsDirectoryAcl = '*S-1-5-32-544:(OI)(CI)F'
$SystemFileAcl = '*S-1-5-18:F'
$AdministratorsFileAcl = '*S-1-5-32-544:F'
$CurrentAdministratorDirectoryAcl = "*$($Identity.User.Value):(OI)(CI)F"
$CurrentAdministratorFileAcl = "*$($Identity.User.Value):F"

$Value = [Console]::In.ReadToEnd().Trim()
if ([string]::IsNullOrWhiteSpace($Value) -or $Value.Contains("`r") -or $Value.Contains("`n") -or $Value.Contains([char]0)) {
  throw 'Enrollment token input must contain exactly one non-empty line.'
}

$Path = [IO.Path]::GetFullPath($Path)
$Parent = Split-Path -Parent $Path
if (-not $Parent -or $Parent -eq [IO.Path]::GetPathRoot($Parent)) { throw 'Enrollment token must be stored in a dedicated non-root directory.' }
New-Item -ItemType Directory -Force -Path $Parent | Out-Null
$ParentInformation = Get-Item -LiteralPath $Parent -Force
if (($ParentInformation.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Enrollment token directory must not be a symbolic link or reparse point.' }
& icacls.exe $Parent /inheritance:r /grant:r $SystemDirectoryAcl $AdministratorsDirectoryAcl $CurrentAdministratorDirectoryAcl /C | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Unable to secure the enrollment token directory.' }

$Temporary = Join-Path $Parent ("enrollment-token.{0}.tmp" -f [Guid]::NewGuid().ToString('N'))
try {
  [IO.File]::WriteAllText($Temporary, $Value, [Text.UTF8Encoding]::new($false))
  & icacls.exe $Temporary /inheritance:r /grant:r $SystemFileAcl $AdministratorsFileAcl $CurrentAdministratorFileAcl /C | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Unable to secure the enrollment token file.' }
  & icacls.exe $Temporary /setowner '*S-1-5-32-544' /C | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Unable to assign the enrollment token file owner.' }
  if (Test-Path -LiteralPath $Path) {
    $Existing = Get-Item -LiteralPath $Path -Force
    if (($Existing.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Enrollment token path must not be a symbolic link or reparse point.' }
    Remove-Item -LiteralPath $Path -Force
  }
  Move-Item -LiteralPath $Temporary -Destination $Path
} finally {
  Remove-Item -LiteralPath $Temporary -Force -ErrorAction SilentlyContinue
}
