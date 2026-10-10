# Starts (or restarts) the throwaway Foundry used to test Table Talk. It lives in .qa-foundry,
# serves on port 30005 and only ever stops its own process, never the live game on 30000.
#   powershell -File qa\foundry.ps1 [-Stop] [-World ffc-skill-test] [-Port 30005]
param([switch]$Stop, [string]$World = "ffc-skill-test", [int]$Port = 30005)
$root = Join-Path (Split-Path $PSScriptRoot -Parent) '.qa-foundry'
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like "*--dataPath=$root*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
if ($Stop) { return }
Start-Sleep -Milliseconds 800
Remove-Item "$root\Config\options.json.lock" -Force -ErrorAction SilentlyContinue
$log = "$root\Logs\server.log"
Start-Process -FilePath node -ArgumentList '"D:\apps\FoundryVTT\App\resources\app\main.mjs"', "--dataPath=$root", "--port=$Port", '--noupnp', "--world=$World" -RedirectStandardOutput $log -RedirectStandardError "$log.err" -WindowStyle Hidden
for ($i = 0; $i -lt 90; $i++) {
  Start-Sleep -Milliseconds 500
  if ((Get-Content $log -Raw -ErrorAction SilentlyContinue) -match 'listening on port') { break }
}
Get-Content $log | Select-String 'error|listening|Launching World' | Select-Object -Last 6
