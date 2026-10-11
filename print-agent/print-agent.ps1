param([string]$ConfigPath = (Join-Path $PSScriptRoot 'config.json'))
$ErrorActionPreference = 'Stop'

if (-not (Test-Path $ConfigPath)) { throw "config.json غير موجود. انسخ config.example.json إلى config.json ثم اضبط الرمز." }
$config = Get-Content $ConfigPath -Raw | ConvertFrom-Json
$server = ([string]$config.serverUrl).TrimEnd('/')
$headers = @{ 'x-print-agent-token' = [string]$config.token }
$sumatra = Join-Path $env:LOCALAPPDATA 'SumatraPDF\SumatraPDF.exe'
if (-not (Test-Path $sumatra)) { $sumatra = Join-Path $env:ProgramFiles 'SumatraPDF\SumatraPDF.exe' }
if (-not (Test-Path $sumatra)) { throw 'SumatraPDF غير مثبت' }
$work = Join-Path $env:ProgramData 'EngineeringLibrary\PrintAgent'
New-Item -ItemType Directory -Path $work -Force | Out-Null

function Send-Result([long]$Id,[bool]$Success,[string]$Message='') {
  $body = @{success=$Success;error=$Message;agentId=[string]$config.agentId} | ConvertTo-Json
  Invoke-RestMethod -Method Post -Uri "$server/api/print-agent/jobs/$Id/result" -Headers $headers -ContentType 'application/json' -Body $body | Out-Null
}
function Download-JobFile([string]$Url,[string]$BaseName) {
  $uri=[uri]$Url;$ext=[IO.Path]::GetExtension($uri.AbsolutePath);if(-not $ext){$ext='.pdf'}
  $target=Join-Path $work ($BaseName+$ext)
  Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $target
  return $target
}
function Make-IdPdf([string]$Front,[string]$Back,[string]$Passport,[long]$Id) {
  $html=Join-Path $work "$Id-id.html";$pdf=Join-Path $work "$Id-id.pdf"
  $frontUri=([uri]$Front).AbsoluteUri;$backUri=([uri]$Back).AbsoluteUri;$passportMarkup=''
  if($Passport){$passportUri=([uri]$Passport).AbsoluteUri;$passportMarkup="<img class='passport' src='$passportUri'>"}
  $markup="<html><head><meta charset='utf-8'><style>@page{size:A4;margin:0}body{margin:0}.sheet{width:210mm;height:297mm;padding:20mm;box-sizing:border-box;display:flex;gap:10mm;align-content:flex-start;justify-content:center;flex-wrap:wrap}.card{width:85.6mm;height:54mm;object-fit:contain}.passport{width:90mm;height:125mm;object-fit:contain;flex-basis:100%}</style></head><body><div class='sheet'><img class='card' src='$frontUri'><img class='card' src='$backUri'>$passportMarkup</div></body></html>"
  Set-Content -Path $html -Value $markup -Encoding UTF8
  $edge=Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'
  if(-not(Test-Path $edge)){$edge=Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'}
  if(-not(Test-Path $edge)){throw 'Microsoft Edge غير موجود لتنسيق الهوية'}
  Start-Process -FilePath $edge -ArgumentList '--headless','--disable-gpu',"--print-to-pdf=$pdf",([uri]$html).AbsoluteUri -Wait
  if(-not(Test-Path $pdf)){throw 'تعذر تجهيز صفحة الهوية'}
  return $pdf
}
function Make-CoverPdf($Cover,[long]$Id) {
  $html=Join-Path $work "$Id-cover.html";$pdf=Join-Path $work "$Id-cover.pdf"
  $title=[System.Net.WebUtility]::HtmlEncode([string]$Cover.title)
  $doctorValue=if([string]$Cover.doctorName){[string]$Cover.doctorName}else{'غير مذكور'}
  $pagesValue=if($Cover.pageCount){[string]$Cover.pageCount}else{'غير محسوب'}
  $doctor=[System.Net.WebUtility]::HtmlEncode($doctorValue)
  $pages=[System.Net.WebUtility]::HtmlEncode($pagesValue)
  $markup="<html dir='rtl'><head><meta charset='utf-8'><style>@page{size:A4;margin:0}*{box-sizing:border-box}body{margin:0;font-family:Tahoma,Arial,sans-serif;color:#10233e}.sheet{width:210mm;height:297mm;padding:25mm;display:flex;align-items:center;justify-content:center}.box{width:100%;border:3px solid #0759a5;border-radius:18px;padding:24mm 16mm;text-align:center}.brand{font-size:18pt;color:#0759a5;margin-bottom:18mm}.label{font-size:16pt;color:#59697d;margin-top:10mm}.value{font-size:27pt;font-weight:700;margin-top:4mm;line-height:1.5}.pages{font-size:22pt}.footer{margin-top:20mm;border-top:1px solid #a9b6c5;padding-top:8mm;font-size:13pt;color:#66758a}</style></head><body><div class='sheet'><div class='box'><div class='brand'>مكتبة كلية الهندسة الرقمية</div><div class='label'>اسم الملزمة</div><div class='value'>$title</div><div class='label'>اسم التدريسي</div><div class='value'>$doctor</div><div class='label'>عدد صفحات الملزمة</div><div class='value pages'>$pages صفحة</div><div class='footer'>ورقة تعريف تلقائية — لا تدخل ضمن عدد صفحات الملزمة</div></div></div></body></html>"
  Set-Content -Path $html -Value $markup -Encoding UTF8
  $edge=Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'
  if(-not(Test-Path $edge)){$edge=Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'}
  if(-not(Test-Path $edge)){throw 'Microsoft Edge غير موجود لتجهيز ورقة التعريف'}
  if(Test-Path $pdf){Remove-Item $pdf -Force}
  Start-Process -FilePath $edge -ArgumentList '--headless','--disable-gpu','--no-pdf-header-footer',"--print-to-pdf=$pdf",([uri]$html).AbsoluteUri -Wait
  if(-not(Test-Path $pdf)){throw 'تعذر تجهيز ورقة تعريف الملزمة'}
  return $pdf
}
function Print-Job($Job) {
  $printerProperty=$config.printers.PSObject.Properties[[string]$Job.printerNumber]
  if(-not $printerProperty){throw "الطابعة رقم $($Job.printerNumber) غير معرفة"}
  $printer=[string]$printerProperty.Value
  if(-not(Get-Printer -Name $printer -ErrorAction SilentlyContinue)){throw "الطابعة غير مثبتة في Windows: $printer"}
  $first=Download-JobFile ([string]$Job.url) ("$($Job.id)-1")
  $toPrint=$first
  if($Job.printType -in @('ID_CARD','ID_PASSPORT')){
    if(-not $Job.secondUrl){throw 'صورة ظهر الهوية غير موجودة'}
    $second=Download-JobFile ([string]$Job.secondUrl) ("$($Job.id)-2")
    $third=$null
    if($Job.thirdUrl){$third=Download-JobFile ([string]$Job.thirdUrl) ("$($Job.id)-3")}
    $toPrint=Make-IdPdf $first $second $third ([long]$Job.id)
  }
  if($Job.cover -and [bool]$Job.cover.enabled){
    $coverPdf=Make-CoverPdf $Job.cover ([long]$Job.id)
    $coverSettings='1x,paper=A4,fit,bin=auto,ignore-pdf-print-settings,monochrome,simplex'
    & $sumatra -silent -print-to $printer -print-settings $coverSettings $coverPdf
    if($LASTEXITCODE -ne 0){throw "تعذر طباعة ورقة التعريف: SumatraPDF exit code $LASTEXITCODE"}
  }
  $ext=[IO.Path]::GetExtension($toPrint).ToLowerInvariant();$copies=[Math]::Max(1,[int]$Job.copies)
  if($ext -in @('.doc','.docx')){
    $word=New-Object -ComObject Word.Application
    try{$word.Visible=$false;$word.DisplayAlerts=0;$doc=$word.Documents.Open($toPrint,$false,$true);$word.ActivePrinter=$printer;$doc.PrintOut($false,$false,0,'','',$null,0,$copies);$doc.Close($false)}finally{$word.Quit()}
  }else{
    $colorSetting=if($Job.colorMode -eq 'COLOR'){'color'}else{'monochrome'}
    $paperSetting=if($Job.paperSize -eq 'A3'){'paper=A3'}else{'paper=A4'}
    $duplexSetting=switch([string]$Job.duplexMode){'DUPLEX_LONG'{'duplexlong'}'DUPLEX_SHORT'{'duplexshort'}default{'simplex'}}
    $printSettings=("{0}x,{1},fit,bin=auto,ignore-pdf-print-settings,{2},{3}" -f $copies,$paperSetting,$colorSetting,$duplexSetting)
    & $sumatra -silent -print-to $printer -print-settings $printSettings $toPrint
    if($LASTEXITCODE -ne 0){throw "SumatraPDF exit code $LASTEXITCODE"}
  }
}

Write-Host "وكيل طباعة مكتبة الهندسة — $($config.agentId)" -ForegroundColor Cyan
if(-not [bool]$config.enabled){Write-Host 'الوضع الآمن مفعل: غيّر enabled إلى true بعد إكمال الاختبار.' -ForegroundColor Yellow;exit 2}
while($true){
  try{
    $response=Invoke-WebRequest -UseBasicParsing -Uri "$server/api/print-agent/next?agentId=$([uri]::EscapeDataString([string]$config.agentId))" -Headers $headers
    if($response.StatusCode -eq 200 -and $response.Content){
      $payload=$response.Content|ConvertFrom-Json;$job=$payload.job
      Write-Host "طباعة الطلب $($job.id) على الطابعة $($job.printerNumber)..."
      try{Print-Job $job;Send-Result ([long]$job.id) $true;Write-Host 'تمت الطباعة بنجاح' -ForegroundColor Green}
      catch{Send-Result ([long]$job.id) $false $_.Exception.Message;Write-Host $_.Exception.Message -ForegroundColor Red}
    }
  }catch{
    if($_.Exception.Response.StatusCode.value__ -ne 204){Write-Host "تعذر الاتصال بالخادم: $($_.Exception.Message)" -ForegroundColor DarkYellow}
  }
  Start-Sleep -Seconds ([Math]::Max(2,[int]$config.pollSeconds))
}
