param([string]$ProjectPath = (Split-Path $PSScriptRoot -Parent))
$ErrorActionPreference='Stop'
$agentScript=Join-Path $ProjectPath 'print-agent\print-agent.ps1'
$configPath=Join-Path $ProjectPath 'print-agent\config.json'
if(-not(Test-Path $agentScript)){throw "print-agent.ps1 غير موجود"}
if(-not(Test-Path $configPath)){throw "config.json غير موجود"}
$action=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$agentScript`" -ConfigPath `"$configPath`""
$currentUser=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$trigger=New-ScheduledTaskTrigger -AtLogOn -User $currentUser
$settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 3650) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal=New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Highest
Register-ScheduledTask -TaskName 'EngineeringLibraryPrintAgent' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'وكيل الطباعة التلقائي لمكتبة الهندسة' -Force | Out-Null
Write-Host 'تم تثبيت التشغيل التلقائي. سيبدأ وكيل الطباعة تلقائياً عند دخول Windows.' -ForegroundColor Green
Start-ScheduledTask -TaskName 'EngineeringLibraryPrintAgent'
