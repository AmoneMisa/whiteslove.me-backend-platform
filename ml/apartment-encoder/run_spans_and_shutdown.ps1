# Trains the span tagger; optionally shuts the PC down afterwards.
#
#   powershell -ExecutionPolicy Bypass -File run_spans_and_shutdown.ps1 [-Shutdown] [-Out span-model]
#                                                [-Data data\span-splits] [-InitFrom span-model-v3]
#
# -InitFrom starts from an already trained span model (its entities must be a prefix of the current list),
# so only the new entities need to be learned from scratch.
# While it runs the machine is kept from idle-sleeping (the hold ends with this
# process; no power setting is changed). With -Shutdown the PC is shut down 120
# seconds after training ends, whatever the result; cancel with:  shutdown /a
param(
    [switch]$Shutdown,
    [string]$Out = 'span-model',
    [string]$Data = 'data\span-splits',
    [string]$InitFrom = ''
)

$ErrorActionPreference = 'Continue'
Set-Location $PSScriptRoot

Add-Type -Namespace Win32 -Name Power -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("kernel32.dll")]
public static extern uint SetThreadExecutionState(uint flags);
'@
# ES_CONTINUOUS | ES_SYSTEM_REQUIRED
[void][Win32.Power]::SetThreadExecutionState(0x80000001)

$env:PYTHONUNBUFFERED = '1'
$log = Join-Path $PSScriptRoot 'data\span-train.log'
"started $(Get-Date -Format s)" | Out-File $log -Encoding utf8

$extra = @()
if ($InitFrom) { $extra += @('--init-from', $InitFrom) }

& .\.venv\Scripts\python.exe train_spans.py `
    --data $Data --out $Out `
    --epochs 2 --limit-train 200000 --batch-size 32 --max-len 256 @extra *>> $log

"finished $(Get-Date -Format s) exit=$LASTEXITCODE" | Out-File $log -Append -Encoding utf8
[void][Win32.Power]::SetThreadExecutionState(0x80000000)
if ($Shutdown) {
    shutdown.exe /s /t 120 /c "Span tagger training finished; shutting down (cancel: shutdown /a)"
}
