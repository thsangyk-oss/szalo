$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$logDir = Join-Path $root ".zalo-manager"
$outLog = Join-Path $root "prod.out.log"
$errLog = Join-Path $root "prod.err.log"
$npm = "C:\PROGRA~1\nodejs\npm.cmd"
if (-not (Test-Path $npm)) {
  $npm = Join-Path $env:ProgramFiles "nodejs\npm.cmd"
}
if (-not (Test-Path $npm)) {
  $npm = "npm.cmd"
}

New-Item -ItemType Directory -Path $logDir -Force | Out-Null

$machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$cleanPath = @($machinePath, $userPath) -join ";"
$psi = [System.Diagnostics.ProcessStartInfo]::new()
$psi.FileName = "$env:SystemRoot\System32\cmd.exe"
$psi.Arguments = '/d /c {0} start 1> {1} 2> {2}' -f $npm, $outLog, $errLog
$psi.WorkingDirectory = $root
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.Environment.Clear()
$psi.Environment["Path"] = $cleanPath
$psi.Environment["SystemRoot"] = $env:SystemRoot
$psi.Environment["ComSpec"] = "$env:SystemRoot\System32\cmd.exe"
$psi.Environment["TEMP"] = $env:TEMP
$psi.Environment["TMP"] = $env:TMP

$process = [System.Diagnostics.Process]::Start($psi)
Write-Host "Started Szalo server process $($process.Id). Logs: $outLog"
Start-Sleep -Milliseconds 500
if ($process.HasExited) {
  Write-Host "Server process exited immediately with code $($process.ExitCode). Args: $($psi.Arguments)"
}
