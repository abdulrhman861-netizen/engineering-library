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
$materialsRoot=if([string]$config.materialsRoot){[string]$config.materialsRoot}else{'D:\EngineeringLibrary\Materials'}
$materialSyncMinutes=if([int]$config.materialSyncMinutes -gt 0){[int]$config.materialSyncMinutes}else{5}
New-Item -ItemType Directory -Path $materialsRoot -Force|Out-Null
$materialIndexPath=Join-Path $materialsRoot 'materials-index.json'
$materialIndex=@{}
if(Test-Path $materialIndexPath){
  try{foreach($entry in @((Get-Content $materialIndexPath -Raw|ConvertFrom-Json))){$materialIndex[[string]$entry.materialId]=$entry}}catch{Write-Host 'تعذر قراءة فهرس الملازم المحلي؛ سيعاد بناؤه.' -ForegroundColor Yellow}
}

function Safe-Part([string]$Value,[string]$Fallback='غير مصنف'){
  $clean=($Value -replace '[<>:"/\\|?*]','-' -replace '\s+',' ').Trim().TrimEnd('.')
  if(-not $clean){$clean=$Fallback}
  if($clean.Length -gt 90){$clean=$clean.Substring(0,90).Trim()}
  return $clean
}
function Material-Extension($Material){
  try{$ext=[IO.Path]::GetExtension(([uri][string]$Material.url).AbsolutePath)}catch{$ext=''}
  if($ext){return $ext.ToLowerInvariant()}
  $mime=[string]$Material.mimeType
  if($mime -like '*wordprocessingml*'){return '.docx'}
  if($mime -like '*msword*'){return '.doc'}
  if($mime -like '*pdf*'){return '.pdf'}
  if($mime -like 'image/png*'){return '.png'}
  return '.jpg'
}
function Save-MaterialIndex(){
  @($materialIndex.Values)|Sort-Object {[long]$_.materialId}|ConvertTo-Json -Depth 5|Set-Content $materialIndexPath -Encoding UTF8
}
function Sync-Materials([int]$MaxDownloads=10){
  $catalog=Invoke-RestMethod -Uri "$server/api/print-agent/materials-catalog" -Headers $headers
  $downloaded=0
  foreach($m in @($catalog.materials)){
    $key=[string]$m.materialId;$known=$materialIndex[$key]
    if($known -and $known.url -eq $m.url -and (Test-Path ([string]$known.path))){continue}
    if($downloaded -ge $MaxDownloads){break}
    $department=Safe-Part ([string]$m.departmentName) ([string]$m.departmentCode)
    $stage=Safe-Part ([string]$m.stageName) ([string]$m.stageCode)
    $number=if($m.materialNumber){'{0:D4}' -f [int]$m.materialNumber}else{'0000'}
    $fileName=Safe-Part "$number - $([string]$m.title)" 'ملزمة'
    $folder=Join-Path (Join-Path $materialsRoot $department) $stage
    New-Item -ItemType Directory -Path $folder -Force|Out-Null
    $target=Join-Path $folder ($fileName+(Material-Extension $m));$temp="$target.download"
    Write-Host "مزامنة الملزمة #$($m.materialId): $($m.title)..." -ForegroundColor Cyan
    Invoke-WebRequest -UseBasicParsing -Uri ([string]$m.url) -OutFile $temp
    if((Get-Item $temp).Length -lt 1){Remove-Item $temp -Force;throw "ملف الملزمة #$($m.materialId) فارغ"}
    $hash=(Get-FileHash $temp -Algorithm SHA256).Hash
    Move-Item $temp $target -Force
    $materialIndex[$key]=[PSCustomObject]@{materialId=[long]$m.materialId;url=[string]$m.url;path=$target;sha256=$hash;size=(Get-Item $target).Length;syncedAt=(Get-Date).ToString('o')}
    Save-MaterialIndex
    $downloaded++
  }
  if($downloaded){Write-Host "تمت مزامنة $downloaded ملزمة إلى $materialsRoot" -ForegroundColor Green}
}
function Get-LocalMaterial([long]$MaterialId){
  if($MaterialId -le 0){return $null}
  $entry=$materialIndex[[string]$MaterialId]
  if($entry -and (Test-Path ([string]$entry.path))){
    $actual=(Get-FileHash ([string]$entry.path) -Algorithm SHA256).Hash
    if($actual -eq [string]$entry.sha256){return [string]$entry.path}
    Write-Host "فشل فحص سلامة النسخة المحلية للملزمة #$MaterialId؛ سيتم تنزيلها من السحابة." -ForegroundColor Yellow
  }
  return $null
}

function Send-Result([long]$Id,[bool]$Success,[string]$Message='',[int]$PageCount=0,[long]$MaterialId=0) {
  $body = @{success=$Success;error=$Message;agentId=[string]$config.agentId;pageCount=$PageCount;materialId=$MaterialId} | ConvertTo-Json
  Invoke-RestMethod -Method Post -Uri "$server/api/print-agent/jobs/$Id/result" -Headers $headers -ContentType 'application/json' -Body $body | Out-Null
}
function Download-JobFile([string]$Url,[string]$BaseName) {
  $uri=[uri]$Url;$ext=[IO.Path]::GetExtension($uri.AbsolutePath);if(-not $ext){$ext='.pdf'}
  $target=Join-Path $work ($BaseName+$ext)
  Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $target
  return $target
}
function Convert-WordToPdf([string]$WordPath,[long]$Id) {
  $pdf=Join-Path $work "$Id-word.pdf"
  if(Test-Path $pdf){Remove-Item $pdf -Force}
  $soffice=Join-Path $env:ProgramFiles 'LibreOffice\program\soffice.com'
  if(-not(Test-Path $soffice)){$soffice=Join-Path ${env:ProgramFiles(x86)} 'LibreOffice\program\soffice.com'}
  if(-not(Test-Path $soffice)){throw 'LibreOffice غير مثبت. ثبته مرة واحدة حتى تعمل طباعة ملفات Word تلقائياً'}
  $profile=Join-Path $work "LibreOfficeProfile-$Id"
  New-Item -ItemType Directory -Path $profile -Force|Out-Null
  $profileUri=([uri]$profile).AbsoluteUri
  $generated=[IO.Path]::ChangeExtension($WordPath,'.pdf')
  if(Test-Path $generated){Remove-Item $generated -Force}
  & $soffice "-env:UserInstallation=$profileUri" '--headless' '--nologo' '--nodefault' '--nolockcheck' '--convert-to' 'pdf:writer_pdf_Export' '--outdir' $work $WordPath|Out-Null
  if($LASTEXITCODE -ne 0 -or -not(Test-Path $generated)){throw "فشل LibreOffice في تحويل Word إلى PDF (exit code $LASTEXITCODE)"}
  Move-Item $generated $pdf -Force
  if((Get-Item $pdf).Length -lt 100){throw 'أنشأ LibreOffice ملف PDF غير صالح'}
  # ملفات PDF الناتجة من LibreOffice تحفظ كائن صفحة واضحاً لكل صفحة.
  $ascii=[Text.Encoding]::ASCII.GetString([IO.File]::ReadAllBytes($pdf))
  $pageCount=[regex]::Matches($ascii,'/Type\s*/Page(?!s)\b').Count
  return [PSCustomObject]@{Path=$pdf;PageCount=[Math]::Max(1,$pageCount)}
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
  $logoMarkup=''
  try{
    $logoPath=Join-Path $work 'engineering-college-logo.jpg'
    Invoke-WebRequest -UseBasicParsing -Uri "$server/assets/college_logo.png" -OutFile $logoPath
    $logoUri=([uri]$logoPath).AbsoluteUri
    $logoMarkup="<img class='logo' src='$logoUri' alt='شعار كلية الهندسة'>"
  }catch{Write-Host 'تعذر جلب شعار كلية الهندسة؛ ستُطبع الواجهة النصية.' -ForegroundColor DarkYellow}
  $markup="<html dir='rtl'><head><meta charset='utf-8'><style>@page{size:A4;margin:0}*{box-sizing:border-box}body{margin:0;font-family:Tahoma,Arial,sans-serif;color:#10233e}.sheet{width:210mm;height:297mm;padding:18mm 25mm;display:flex;align-items:center;justify-content:center}.box{width:100%;border:3px solid #0759a5;border-radius:18px;padding:14mm 16mm 18mm;text-align:center}.logo{width:58mm;height:35mm;object-fit:contain;display:block;margin:0 auto 6mm}.brand{font-size:21pt;font-weight:700;color:#087f4f;margin-bottom:11mm}.label{font-size:15pt;color:#59697d;margin-top:8mm}.value{font-size:26pt;font-weight:700;margin-top:3mm;line-height:1.45}.pages{font-size:21pt}.footer{margin-top:14mm;border-top:2px solid #d0a124;padding-top:7mm;font-size:12pt;color:#66758a}</style></head><body><div class='sheet'><div class='box'>$logoMarkup<div class='brand'>مكتبة كلية الهندسة الرقمية</div><div class='label'>اسم الملزمة</div><div class='value'>$title</div><div class='label'>اسم التدريسي</div><div class='value'>$doctor</div><div class='label'>عدد صفحات الملزمة</div><div class='value pages'>$pages صفحة</div><div class='footer'>ورقة تعريف تلقائية — لا تدخل ضمن عدد صفحات الملزمة</div></div></div></body></html>"
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
  $first=Get-LocalMaterial ([long]$Job.materialId)
  if($first){Write-Host "استخدام النسخة المحلية: $first" -ForegroundColor Green}else{$first=Download-JobFile ([string]$Job.url) ("$($Job.id)-1")}
  $toPrint=$first
  if($Job.printType -in @('ID_CARD','ID_PASSPORT')){
    if(-not $Job.secondUrl){throw 'صورة ظهر الهوية غير موجودة'}
    $second=Download-JobFile ([string]$Job.secondUrl) ("$($Job.id)-2")
    $third=$null
    if($Job.thirdUrl){$third=Download-JobFile ([string]$Job.thirdUrl) ("$($Job.id)-3")}
    $toPrint=Make-IdPdf $first $second $third ([long]$Job.id)
  }
  $calculatedPages=0
  $ext=[IO.Path]::GetExtension($toPrint).ToLowerInvariant();$copies=[Math]::Max(1,[int]$Job.copies)
  if($ext -in @('.doc','.docx')){
    $converted=Convert-WordToPdf $toPrint ([long]$Job.id)
    $toPrint=[string]$converted.Path
    $calculatedPages=[int]$converted.PageCount
    if($Job.cover){$Job.cover.pageCount=$calculatedPages}
  }
  if($Job.cover -and [bool]$Job.cover.enabled){
    $coverPdf=Make-CoverPdf $Job.cover ([long]$Job.id)
    $coverSettings='1x,paper=A4,fit,bin=auto,ignore-pdf-print-settings,monochrome,simplex'
    & $sumatra -silent -print-to $printer -print-settings $coverSettings $coverPdf
    # بعض تعريفات Canon تعيد رمز خروج غير صفري رغم نجاح إرسال الغلاف للطابعة.
    # لا نوقف الطلب هنا حتى تستمر طباعة الملزمة الأصلية مباشرة بعد الغلاف.
    Start-Sleep -Seconds 2
  }
  $colorSetting=if($Job.colorMode -eq 'COLOR'){'color'}else{'monochrome'}
  $paperSetting=if($Job.paperSize -eq 'A3'){'paper=A3'}else{'paper=A4'}
  $duplexSetting=switch([string]$Job.duplexMode){'DUPLEX_LONG'{'duplexlong'}'DUPLEX_SHORT'{'duplexshort'}default{'simplex'}}
  $printSettings=("{0}x,{1},fit,bin=auto,ignore-pdf-print-settings,{2},{3}" -f $copies,$paperSetting,$colorSetting,$duplexSetting)
  & $sumatra -silent -print-to $printer -print-settings $printSettings $toPrint
  if($LASTEXITCODE -ne 0){throw "SumatraPDF exit code $LASTEXITCODE"}
  return [PSCustomObject]@{PageCount=$calculatedPages;MaterialId=[long]$Job.materialId}
}

Write-Host "وكيل طباعة مكتبة الهندسة — $($config.agentId)" -ForegroundColor Cyan
if(-not [bool]$config.enabled){Write-Host 'الوضع الآمن مفعل: غيّر enabled إلى true بعد إكمال الاختبار.' -ForegroundColor Yellow;exit 2}
$nextMaterialSync=Get-Date
while($true){
  try{
    if((Get-Date) -ge $nextMaterialSync){
      try{Sync-Materials 10}catch{Write-Host "تعذرت مزامنة الملازم: $($_.Exception.Message)" -ForegroundColor DarkYellow}
      $nextMaterialSync=(Get-Date).AddMinutes($materialSyncMinutes)
    }
    $response=Invoke-WebRequest -UseBasicParsing -Uri "$server/api/print-agent/next?agentId=$([uri]::EscapeDataString([string]$config.agentId))" -Headers $headers
    if($response.StatusCode -eq 200 -and $response.Content){
      $payload=$response.Content|ConvertFrom-Json;$job=$payload.job
      Write-Host "طباعة الطلب $($job.id) على الطابعة $($job.printerNumber)..."
      try{$printResult=Print-Job $job;Send-Result ([long]$job.id) $true '' ([int]$printResult.PageCount) ([long]$printResult.MaterialId);Write-Host 'تمت الطباعة بنجاح' -ForegroundColor Green}
      catch{Send-Result ([long]$job.id) $false $_.Exception.Message;Write-Host $_.Exception.Message -ForegroundColor Red}
    }
  }catch{
    if($_.Exception.Response.StatusCode.value__ -ne 204){Write-Host "تعذر الاتصال بالخادم: $($_.Exception.Message)" -ForegroundColor DarkYellow}
  }
  Start-Sleep -Seconds ([Math]::Max(2,[int]$config.pollSeconds))
}
