# Amendment 14 (2.0.2): run by installer-hooks.nsh before install / uninstall (hidden, nsExec).
# Stops only AutoMate Taskboard's own leftover processes:
#   - under AUTOMATE_STOP_INSTDIR (set only when that folder holds the launcher exe): the launcher
#     exe named by AUTOMATE_STOP_LAUNCHER, node.exe, ConPtyAttachSend.exe;
#   - under AUTOMATE_STOP_RUNTIME (%APPDATA%\AutoMate Taskboard\codex-runtime): codex.exe,
#     codex-*.exe helpers, rg.exe.
# AUTOMATE_STOP_SELF (the running installer / uninstaller) is never stopped.
# Uses Get-Process (no WMI, which can hang). Exit 0 = none left, 2 = still running, 3 = error.
# Keep this file ASCII: Windows PowerShell 5.1 reads a .ps1 without BOM in the ANSI code page.
$ErrorActionPreference = 'Stop'
try {
  $installRoot = $env:AUTOMATE_STOP_INSTDIR
  $runtimeRoot = $env:AUTOMATE_STOP_RUNTIME
  $self = $env:AUTOMATE_STOP_SELF
  $launcher = $env:AUTOMATE_STOP_LAUNCHER
  $installNames = @('node.exe', 'conptyattachsend.exe')
  if ($launcher) { $installNames += $launcher.ToLowerInvariant() }

  function Get-RootPrefix($root) {
    if (-not $root) { return $null }
    return $root.TrimEnd('\').ToLowerInvariant() + '\'
  }
  $installPrefix = Get-RootPrefix $installRoot
  $runtimePrefix = Get-RootPrefix $runtimeRoot

  function Test-OwnProcess($path) {
    if (-not $path) { return $false }
    $lower = $path.ToLowerInvariant()
    if ($self -and $lower -eq $self.ToLowerInvariant()) { return $false }
    $leaf = Split-Path -Leaf $lower
    if ($installPrefix -and $lower.StartsWith($installPrefix) -and ($installNames -contains $leaf)) { return $true }
    if ($runtimePrefix -and $lower.StartsWith($runtimePrefix) -and ($leaf -eq 'codex.exe' -or $leaf -eq 'rg.exe' -or $leaf -like 'codex-*.exe')) { return $true }
    return $false
  }

  function Get-OwnProcesses {
    Get-Process | Where-Object { Test-OwnProcess $_.Path }
  }

  $targets = @(Get-OwnProcesses)
  foreach ($process in $targets) {
    Write-Output ('stopping ' + $process.Id + ' ' + $process.Path)
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
  }
  $deadline = (Get-Date).AddSeconds(15)
  while ($true) {
    $left = @(Get-OwnProcesses)
    if ($left.Count -eq 0) { exit 0 }
    if ((Get-Date) -ge $deadline) { break }
    Start-Sleep -Milliseconds 250
  }
  foreach ($process in $left) {
    Write-Output ('still running ' + $process.Id + ' ' + $process.Path)
  }
  exit 2
} catch {
  Write-Output ('error ' + $_.Exception.Message)
  exit 3
}
