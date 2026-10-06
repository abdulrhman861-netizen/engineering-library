$ErrorActionPreference='Stop'
Unregister-ScheduledTask -TaskName 'EngineeringLibraryPrintAgent' -Confirm:$false -ErrorAction SilentlyContinue
Write-Host 'تمت إزالة التشغيل التلقائي لوكيل الطباعة.' -ForegroundColor Yellow
