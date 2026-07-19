$ErrorActionPreference = 'Stop'
# Backward-compatible launcher for installations created before the self-contained
# Windows runtime. New MSI and PowerShell installations invoke service-host.mjs
# with the bundled node.exe directly.
$Base = Split-Path -Parent $MyInvocation.MyCommand.Path
& (Join-Path $Base 'node.exe') (Join-Path $Base 'service-host.mjs')
exit $LASTEXITCODE
