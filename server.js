'use strict';
require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const multer = require('multer');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 50);
const JWT_SECRET = process.env.JWT_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = process.env.SUPABASE_BUCKET || 'library-files';
const PRINT_AGENT_TOKEN = process.env.PRINT_AGENT_TOKEN || '';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const APP_BASE_URL = String(process.env.RENDER_EXTERNAL_URL || process.env.APP_BASE_URL || '').replace(/\/$/,'');
const TELEGRAM_WEBHOOK_SECRET = TELEGRAM_BOT_TOKEN ? crypto.createHash('sha256').update(TELEGRAM_BOT_TOKEN).digest('hex') : '';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const localUploads = path.join(__dirname, 'public', 'uploads');
fs.mkdirSync(localUploads, { recursive: true });

const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } }) : null;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowedMime = ['application/pdf','image/jpeg','image/png','image/webp','image/heic','image/heif','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document','audio/webm','audio/mp4','audio/mpeg','audio/ogg','audio/wav'];
    const allowedExt = ['.pdf','.jpg','.jpeg','.png','.webp','.heic','.heif','.doc','.docx','.webm','.m4a','.mp3','.ogg','.wav'];
    const ok = allowedMime.includes(String(file.mimetype||'').toLowerCase()) || allowedExt.includes(path.extname(file.originalname||'').toLowerCase());
    cb(ok ? null : new Error('نوع الملف غير مدعوم. استخدم PDF أو Word أو صورة أو تسجيلاً صوتياً'), ok);
  }
});

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/assets', express.static(path.join(__dirname, 'assets')));

function configured(res) {
  if (!pool) { res.status(503).json({ success:false, error:'يلزم ربط المشروع بـ Supabase أولاً. راجع ملف SETUP_AR.md' }); return false; }
  return true;
}
function sign(user) {
  if (!JWT_SECRET) throw new Error('JWT_SECRET غير مضبوط');
  return jwt.sign({ userId:user.user_id, role:user.role, name:user.full_name }, JWT_SECRET, { expiresIn:'12h' });
}
async function auth(req,res,next) {
  try {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i,'');
    const decoded = jwt.verify(token, JWT_SECRET);
    if(!pool)return res.status(503).json({success:false,error:'قاعدة البيانات غير متصلة'});
    const active=await pool.query('select user_id,full_name,role from users where user_id=$1 and is_active=true',[decoded.userId]);
    if(!active.rowCount)return res.status(401).json({success:false,error:'الحساب معطّل أو غير موجود'});
    req.user={...decoded,userId:active.rows[0].user_id,name:active.rows[0].full_name,role:active.rows[0].role};
    next();
  } catch { res.status(401).json({ success:false, error:'يجب تسجيل الدخول' }); }
}
function admin(req,res,next) {
  if (req.user?.role !== 'ADMIN') return res.status(403).json({ success:false,error:'هذه العملية للمدير فقط' });
  next();
}
function accounting(req,res,next) {
  if (!['ADMIN','ACCOUNTANT'].includes(req.user?.role)) return res.status(403).json({success:false,error:'هذه العملية للمدير أو المحاسب فقط'});
  next();
}
function printAgentAuth(req,res,next) {
  const supplied = String(req.headers['x-print-agent-token'] || '');
  if (!PRINT_AGENT_TOKEN || supplied.length !== PRINT_AGENT_TOKEN.length || !crypto.timingSafeEqual(Buffer.from(supplied),Buffer.from(PRINT_AGENT_TOKEN))) {
    return res.status(401).json({success:false,error:'وكيل الطباعة غير مصرح له'});
  }
  next();
}
function safeName(name) {
  const ext = path.extname(name).toLowerCase();
  return `${Date.now()}-${crypto.randomUUID()}${ext}`;
}
function estimatePageCount(file) {
  const mime=String(file?.mimetype||'').toLowerCase(),ext=path.extname(file?.originalname||'').toLowerCase();
  if(mime.startsWith('image/')||['.jpg','.jpeg','.png','.webp','.heic','.heif'].includes(ext))return 1;
  if(mime==='application/pdf'||ext==='.pdf'){
    try{
      const raw=file.buffer.toString('latin1');
      const matches=raw.match(/\/Type\s*\/Page\b/g);
      return Math.max(1,matches?.length||1);
    }catch{return null;}
  }
  return null;
}
const ACTIVE_PRINTERS={BW:[1,2,3,9],COLOR:[8,5]};
function normalizePrintSettings(body={}){
  return {
    copies:Math.min(100,Math.max(1,Number(body.copies||1))),
    colorMode:body.colorMode==='COLOR'?'COLOR':'BW',
    paperSize:body.paperSize==='A3'?'A3':'A4',
    duplexMode:['DUPLEX_LONG','DUPLEX_SHORT'].includes(body.duplexMode)?body.duplexMode:'SIMPLEX'
  };
}
async function leastBusyPrinter(client,colorMode){
  const candidates=ACTIVE_PRINTERS[colorMode]||ACTIVE_PRINTERS.BW;
  const r=await client.query(`select p printer_number,count(f.file_id)::integer load from unnest($1::int[]) p left join student_print_files f on f.printer_number=p and f.direct_print_status in ('QUEUED','CLAIMED') group by p order by load,p limit 1`,[candidates]);
  return Number(r.rows[0]?.printer_number||candidates[0]);
}
function storageHeaders(contentType) {
  const headers = { apikey:SERVICE_KEY };
  if (SERVICE_KEY?.startsWith('eyJ')) headers.authorization = `Bearer ${SERVICE_KEY}`;
  if (contentType) headers['content-type'] = contentType;
  return headers;
}
async function storeFile(file, folder) {
  const key = `${folder}/${safeName(file.originalname)}`;
  if (SUPABASE_URL && SERVICE_KEY) {
    const response = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${encodeURI(key)}`, {
      method:'POST', headers:{ ...storageHeaders(file.mimetype), 'x-upsert':'false' }, body:file.buffer
    });
    if (!response.ok) throw new Error(`فشل تخزين الملف: ${await response.text()}`);
    return { storagePath:key, url:`${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${encodeURI(key)}` };
  }
  const filename = safeName(file.originalname);
  fs.writeFileSync(path.join(localUploads, filename), file.buffer);
  return { storagePath:null, url:`/uploads/${filename}` };
}
async function removeStored(storagePath, url) {
  if (storagePath && SUPABASE_URL && SERVICE_KEY) {
    await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${encodeURI(storagePath)}`, { method:'DELETE', headers:storageHeaders() });
  } else if (url?.startsWith('/uploads/')) {
    const file = path.join(localUploads, path.basename(url));
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
}

async function telegramApi(method,payload={}){
  if(!TELEGRAM_BOT_TOKEN)throw new Error('Telegram bot is not configured');
  const response=await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
  const data=await response.json();
  if(!data.ok)throw new Error(`Telegram ${method} failed: ${data.description||response.status}`);
  return data.result;
}
function tgSend(chatId,text,reply_markup){return telegramApi('sendMessage',{chat_id:chatId,text,...(reply_markup?{reply_markup}:{})});}
function tgButtons(rows){return {inline_keyboard:rows};}
async function tgSession(chatId){const r=await pool.query('select * from telegram_sessions where chat_id=$1',[chatId]);return r.rows[0]||null;}
async function tgSaveSession(chatId,user,state,data={}){await pool.query(`insert into telegram_sessions(chat_id,telegram_user_id,username,state,data,updated_at) values($1,$2,$3,$4,$5,now()) on conflict(chat_id) do update set telegram_user_id=excluded.telegram_user_id,username=excluded.username,state=excluded.state,data=excluded.data,updated_at=now()`,[chatId,user?.id||null,user?.username||null,state,JSON.stringify(data)]);}
function tgPrice(pageCount,copies,colorMode,paperSize,duplexMode){const pages=Math.max(1,Number(pageCount||1))*Math.max(1,Number(copies||1));if(paperSize==='A3')return pages*500;if(colorMode==='COLOR'&&duplexMode!=='SIMPLEX')return Math.ceil(pages/2)*250;if(colorMode==='COLOR')return pages*150;return pages*50;}
function tgSummary(d){const color=d.colorMode==='COLOR'?'ملون':'أسود وأبيض',duplex=d.duplexMode==='SIMPLEX'?'وجه واحد':'وجهين';return `الملف: ${d.originalName}\nالصفحات: ${d.pageCount||1}\nالنسخ: ${d.copies}\nالطباعة: ${color}\nالورق: ${d.paperSize}\nالنوع: ${duplex}\nالسعر التقديري: ${Number(d.price||0).toLocaleString('ar-IQ')} دينار`}
async function tgDownloadFile(fileId,originalName,mimeType,fileSize){
  if(Number(fileSize||0)>20*1024*1024)return {tooLarge:true};
  const meta=await telegramApi('getFile',{file_id:fileId});
  const response=await fetch(`https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${meta.file_path}`);
  if(!response.ok)throw new Error('تعذر تنزيل ملف Telegram');
  const buffer=Buffer.from(await response.arrayBuffer());
  if(buffer.length>20*1024*1024)return {tooLarge:true};
  const ext=path.extname(originalName||meta.file_path||'')||'.jpg';
  const file={originalname:originalName||`telegram-${Date.now()}${ext}`,mimetype:mimeType||response.headers.get('content-type')||'application/octet-stream',buffer};
  const allowed=['.pdf','.doc','.docx','.jpg','.jpeg','.png','.webp','.heic','.heif'];
  if(!allowed.includes(path.extname(file.originalname).toLowerCase()))throw new Error('نوع الملف غير مدعوم');
  const stored=await storeFile(file,'telegram-print-orders');
  return {file,stored,pageCount:estimatePageCount(file)||1};
}
async function handleTelegramMessage(message){
  const chatId=message.chat.id,user=message.from,text=String(message.text||'').trim();
  if(['/start','/print'].some(c=>text.startsWith(c))){await tgSaveSession(chatId,user,'AWAITING_NAME',{});return tgSend(chatId,'أهلاً بك في بوت مكتبة الهندسة الرقمية للطباعة 📚\nاكتب اسمك الثلاثي للبدء.');}
  if(text==='/price')return tgSend(chatId,'الأسعار:\nA4 أسود وأبيض: 50 دينار للصفحة\nA4 ملون: 150 دينار للصفحة\nA4 ملون وجهين: 250 دينار للورقة\nA3: 500 دينار للصفحة\nالحد الأعلى: 100 صفحة مطبوعة.');
  if(text==='/cancel'){const s=await tgSession(chatId);if(s?.data?.storagePath)await removeStored(s.data.storagePath,s.data.url);await tgSaveSession(chatId,user,'AWAITING_NAME',{});return tgSend(chatId,'تم إلغاء الطلب الحالي. أرسل /print لبدء طلب جديد.');}
  if(text==='/status'){const r=await pool.query('select file_id,status,original_name,estimated_price_iqd,created_at from student_print_files where telegram_chat_id=$1 order by created_at desc limit 5',[chatId]);return tgSend(chatId,r.rowCount?r.rows.map(x=>`#${x.file_id} — ${x.original_name} — ${x.status} — ${x.estimated_price_iqd} د.ع`).join('\n'):'لا توجد طلبات سابقة.');}
  let s=await tgSession(chatId);if(!s){await tgSaveSession(chatId,user,'AWAITING_NAME',{});return tgSend(chatId,'اضغط Start أو أرسل /print لبدء طلب طباعة.');}
  const d=s.data||{};
  if(s.state==='AWAITING_NAME'&&text){d.studentName=text.slice(0,150);await tgSaveSession(chatId,user,'AWAITING_PHONE',d);return tgSend(chatId,'أرسل رقم هاتفك، مثال: 07xxxxxxxxx');}
  if(s.state==='AWAITING_PHONE'&&text){if(!/^\+?\d[\d\s-]{6,18}$/.test(text))return tgSend(chatId,'رقم الهاتف غير صحيح. أرسله بالأرقام فقط.');d.phone=text;await tgSaveSession(chatId,user,'AWAITING_FILE',d);return tgSend(chatId,'أرسل الآن ملف PDF أو Word أو صورة للطباعة.\nللملفات الأكبر من 20MB استخدم رابط الرفع:\n'+`${APP_BASE_URL}/upload.html`);}
  const doc=message.document,photo=message.photo?.[message.photo.length-1];
  if(s.state==='AWAITING_FILE'&&(doc||photo)){
    const result=await tgDownloadFile(doc?.file_id||photo.file_id,doc?.file_name||`photo-${Date.now()}.jpg`,doc?.mime_type||'image/jpeg',doc?.file_size||photo.file_size);
    if(result.tooLarge)return tgSend(chatId,`حجم الملف أكبر من حد الاستقبال المباشر للبوت. ارفعه من هنا ثم اكتب رقم هاتفك نفسه:\n${APP_BASE_URL}/upload.html`);
    Object.assign(d,{requestKey:crypto.randomUUID(),originalName:result.file.originalname,mimeType:result.file.mimetype,url:result.stored.url,storagePath:result.stored.storagePath,pageCount:result.pageCount});await tgSaveSession(chatId,user,'AWAITING_COLOR',d);return tgSend(chatId,'اختر نوع الطباعة:',tgButtons([[{text:'⚫ أسود وأبيض',callback_data:'color:BW'},{text:'🌈 ملون',callback_data:'color:COLOR'}]]));
  }
  if(s.state==='AWAITING_COPIES'&&text){const copies=Math.min(100,Math.max(1,Number(text)));if(!Number.isInteger(copies))return tgSend(chatId,'اكتب عدد النسخ رقماً صحيحاً.');if(Number(d.pageCount||1)*copies>100)return tgSend(chatId,'إجمالي الصفحات يتجاوز 100. قلل عدد النسخ.');d.copies=copies;d.price=tgPrice(d.pageCount,copies,d.colorMode,d.paperSize,d.duplexMode);await tgSaveSession(chatId,user,'AWAITING_CONFIRM',d);return tgSend(chatId,tgSummary(d),tgButtons([[{text:'✅ تأكيد الطلب',callback_data:'confirm:yes'},{text:'❌ إلغاء',callback_data:'confirm:no'}]]));}
  return tgSend(chatId,'أكمل الخطوة المطلوبة أو أرسل /cancel ثم /print للبدء من جديد.');
}
async function handleTelegramCallback(q){
  const chatId=q.message.chat.id,user=q.from,s=await tgSession(chatId);await telegramApi('answerCallbackQuery',{callback_query_id:q.id});if(!s)return tgSend(chatId,'انتهت الجلسة. أرسل /print للبدء من جديد.');const d=s.data||{},[kind,value]=String(q.data||'').split(':');
  if(kind==='color'&&s.state==='AWAITING_COLOR'){d.colorMode=value==='COLOR'?'COLOR':'BW';await tgSaveSession(chatId,user,'AWAITING_PAPER',d);return tgSend(chatId,'اختر حجم الورق:',tgButtons([[{text:'A4',callback_data:'paper:A4'},{text:'A3',callback_data:'paper:A3'}]]));}
  if(kind==='paper'&&s.state==='AWAITING_PAPER'){d.paperSize=value==='A3'?'A3':'A4';await tgSaveSession(chatId,user,'AWAITING_DUPLEX',d);return tgSend(chatId,'اختر طريقة الطباعة:',tgButtons([[{text:'وجه واحد',callback_data:'duplex:SIMPLEX'},{text:'وجهين',callback_data:'duplex:DUPLEX_LONG'}]]));}
  if(kind==='duplex'&&s.state==='AWAITING_DUPLEX'){d.duplexMode=value==='DUPLEX_LONG'?'DUPLEX_LONG':'SIMPLEX';await tgSaveSession(chatId,user,'AWAITING_COPIES',d);return tgSend(chatId,'اكتب عدد النسخ المطلوبة. الحد الأعلى لإجمالي الصفحات 100.');}
  if(kind==='confirm'&&s.state==='AWAITING_CONFIRM'){
    if(value!=='yes'){if(d.storagePath)await removeStored(d.storagePath,d.url);await tgSaveSession(chatId,user,'AWAITING_NAME',{});return tgSend(chatId,'تم إلغاء الطلب. أرسل /print لبدء طلب جديد.');}
    const r=await pool.query(`insert into student_print_files(original_name,file_path,storage_path,print_type,copies,color_mode,paper_size,duplex_mode,student_name,phone,notes,page_count,telegram_chat_id,telegram_user_id,estimated_price_iqd,payment_status,telegram_request_key) values($1,$2,$3,'DOCUMENT',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'UNPAID',$15) on conflict(telegram_request_key) where telegram_request_key is not null do update set telegram_request_key=excluded.telegram_request_key returning file_id`,[d.originalName,d.url,d.storagePath,d.copies,d.colorMode,d.paperSize,d.duplexMode,d.studentName,d.phone,'طلب وارد من بوت Telegram',d.pageCount,chatId,user.id,d.price,d.requestKey||`${chatId}-${q.id}`]);await tgSaveSession(chatId,user,'COMPLETED',{});return tgSend(chatId,`✅ تم تسجيل طلبك رقم #${r.rows[0].file_id}\nالسعر التقديري: ${Number(d.price).toLocaleString('ar-IQ')} دينار\nسيظهر الطلب الآن لدى كادر المكتبة. يمكنك متابعة حالته بواسطة /status`);
  }
}
app.post('/api/telegram/webhook',async(req,res)=>{
  if(!TELEGRAM_BOT_TOKEN)return res.sendStatus(503);
  const supplied=String(req.headers['x-telegram-bot-api-secret-token']||'');
  if(supplied.length!==TELEGRAM_WEBHOOK_SECRET.length||!crypto.timingSafeEqual(Buffer.from(supplied),Buffer.from(TELEGRAM_WEBHOOK_SECRET)))return res.sendStatus(401);
  res.sendStatus(200);
  Promise.resolve(req.body.callback_query?handleTelegramCallback(req.body.callback_query):req.body.message?handleTelegramMessage(req.body.message):null).catch(e=>console.error('Telegram update failed:',e.message));
});
app.get('/api/telegram/status',(_req,res)=>res.json({success:true,configured:Boolean(TELEGRAM_BOT_TOKEN),username:'EngineeringLibraryPrintBot'}));

app.get('/api/health', async (_req,res) => {
  if (!pool) return res.json({ success:true, database:false, mode:'setup-required' });
  try { await pool.query('select 1'); res.json({success:true,database:true,storage:Boolean(SUPABASE_URL && SERVICE_KEY)}); }
  catch(e){ res.status(503).json({success:false,database:false,error:e.message}); }
});
app.get('/api/get-qr-url', (req,res) => res.json({success:true,url:`${req.protocol}://${req.get('host')}/students.html`}));

app.post('/api/admin/verify-pin', async (req,res) => {
  if (!configured(res)) return;
  if (!process.env.ADMIN_SETUP_PIN || req.body.pin !== process.env.ADMIN_SETUP_PIN) return res.status(401).json({success:false,error:'رمز المدير غير صحيح'});
  let result = await pool.query("select * from users where role='ADMIN' and is_active=true order by user_id limit 1");
  if (!result.rowCount) {
    const hash = await bcrypt.hash(crypto.randomBytes(18).toString('hex'),10);
    result = await pool.query("insert into users(full_name,username,password_hash,role) values('مدير النظام','admin-initial',$1,'ADMIN') returning *",[hash]);
  }
  res.json({success:true,token:sign(result.rows[0]),name:result.rows[0].full_name,role:'ADMIN'});
});

app.post('/api/auth/login', async (req,res) => {
  if (!configured(res)) return;
  const { username,password } = req.body;
  const result = await pool.query('select * from users where username=$1 and is_active=true',[String(username||'').trim()]);
  if (!result.rowCount || !(await bcrypt.compare(String(password||''),result.rows[0].password_hash))) return res.status(401).json({success:false,error:'اسم المستخدم أو كلمة المرور غير صحيحة'});
  const user=result.rows[0];let attendanceId=null;
  if(user.role!=='ADMIN'){const a=await pool.query(`insert into attendance(user_id) select $1 where not exists(select 1 from attendance where user_id=$1 and check_out is null) returning attendance_id`,[user.user_id]);if(a.rowCount)attendanceId=a.rows[0].attendance_id;else{const open=await pool.query('select attendance_id from attendance where user_id=$1 and check_out is null order by check_in desc limit 1',[user.user_id]);attendanceId=open.rows[0]?.attendance_id||null;}}
  res.json({success:true,token:sign(user),name:user.full_name,role:user.role,userId:user.user_id,attendanceId});
});
app.get('/api/admin/session',auth,admin,(req,res)=>res.json({success:true,role:req.user.role,name:req.user.name}));
app.post('/api/auth/logout',auth,async(req,res)=>{const r=await pool.query(`with open_shift as (select attendance_id,check_in,now() out_at,date_trunc('day',check_in at time zone 'Asia/Baghdad') local_day from attendance where user_id=$1 and check_out is null order by check_in desc limit 1 for update),calc as (select *,greatest(0,extract(epoch from (least(out_at,(local_day+interval '16 hours') at time zone 'Asia/Baghdad')-greatest(check_in,(local_day+interval '8 hours') at time zone 'Asia/Baghdad')))/3600) regular,extract(epoch from(out_at-check_in))/3600 total from open_shift) update attendance a set check_out=c.out_at,regular_hours=round(c.regular::numeric,2),overtime_hours=round(greatest(0,c.total-c.regular)::numeric,2) from calc c where a.attendance_id=c.attendance_id returning a.*`,[req.user.userId]);res.json({success:true,attendance:r.rows[0]||null});});

app.post('/api/admin/create-employee', auth, admin, async (req,res) => {
  const { phone,password,fullName,role='STAFF' }=req.body;
  if (!phone || !password || !fullName) return res.status(400).json({success:false,error:'جميع الحقول مطلوبة'});
  if(String(password).length<6)return res.status(400).json({success:false,error:'كلمة المرور يجب ألا تقل عن 6 أحرف'});
  const hash=await bcrypt.hash(password,10);
  try { const r=await pool.query('insert into users(full_name,username,password_hash,role) values($1,$2,$3,$4) returning user_id,full_name,username,role',[fullName,phone,hash,['STAFF','TYPIST','ACCOUNTANT','ADMIN'].includes(role)?role:'STAFF']); res.json({success:true,user:r.rows[0]}); }
  catch(e){ res.status(400).json({success:false,error:e.code==='23505'?'اسم المستخدم موجود مسبقاً':e.message}); }
});
app.get('/api/admin/employees',auth,admin,async(_req,res)=>{const r=await pool.query("select user_id,full_name,username,role,is_active,hourly_rate,overtime_hourly_rate,created_at from users order by created_at desc");res.json({success:true,employees:r.rows});});
app.patch('/api/admin/employees/:id/password',auth,admin,async(req,res)=>{const password=String(req.body.password||'');if(password.length<6)return res.status(400).json({success:false,error:'كلمة المرور يجب ألا تقل عن 6 أحرف'});const hash=await bcrypt.hash(password,10);const r=await pool.query('update users set password_hash=$1 where user_id=$2 returning user_id,full_name',[hash,req.params.id]);if(!r.rowCount)return res.status(404).json({success:false,error:'الموظف غير موجود'});res.json({success:true,employee:r.rows[0]});});
app.patch('/api/admin/employees/:id/rates',auth,admin,async(req,res)=>{const normal=Number(req.body.hourlyRate),overtime=Number(req.body.overtimeHourlyRate);if(!Number.isFinite(normal)||normal<0||!Number.isFinite(overtime)||overtime<0)return res.status(400).json({success:false,error:'أسعار الساعات غير صحيحة'});const r=await pool.query('update users set hourly_rate=$1,overtime_hourly_rate=$2 where user_id=$3 returning user_id,full_name,hourly_rate,overtime_hourly_rate',[normal,overtime,req.params.id]);res.json({success:Boolean(r.rowCount),employee:r.rows[0]});});
app.patch('/api/admin/employees/:id/status',auth,admin,async(req,res)=>{const id=Number(req.params.id),isActive=Boolean(req.body.isActive);if(id===Number(req.user.userId))return res.status(400).json({success:false,error:'لا يمكنك تعطيل حساب المدير الذي تستخدمه الآن'});const r=await pool.query("update users set is_active=$1 where user_id=$2 and role<>'ADMIN' returning user_id,full_name,is_active",[isActive,id]);if(!r.rowCount)return res.status(404).json({success:false,error:'الموظف غير موجود أو الحساب حساب مدير'});res.json({success:true,employee:r.rows[0]});});
app.post('/api/auth/change-password',auth,async(req,res)=>{const current=String(req.body.currentPassword||''),next=String(req.body.newPassword||'');if(next.length<6)return res.status(400).json({success:false,error:'كلمة المرور الجديدة يجب ألا تقل عن 6 أحرف'});if(current===next)return res.status(400).json({success:false,error:'اختر كلمة مرور جديدة مختلفة'});const r=await pool.query('select password_hash from users where user_id=$1 and is_active=true',[req.user.userId]);if(!r.rowCount||!(await bcrypt.compare(current,r.rows[0].password_hash)))return res.status(401).json({success:false,error:'كلمة المرور الحالية غير صحيحة'});const hash=await bcrypt.hash(next,10);await pool.query('update users set password_hash=$1 where user_id=$2',[hash,req.user.userId]);res.json({success:true,message:'تم تغيير كلمة المرور بنجاح'});});
app.post('/api/admin/set-location',auth,admin,async(req,res)=>{ await pool.query("insert into settings(setting_key,setting_value) values('library_location',$1::jsonb) on conflict(setting_key) do update set setting_value=excluded.setting_value,updated_at=now()",[JSON.stringify({lat:req.body.lat,lng:req.body.lng,radiusMeters:req.body.radiusMeters||50})]);res.json({success:true}); });
app.post('/api/admin/upload-template',auth,admin,upload.fields([{name:'univLogo',maxCount:1},{name:'collegeLogo',maxCount:1},{name:'background',maxCount:1}]),async(req,res)=>{ const out={}; for(const [field,items] of Object.entries(req.files||{})){out[field]=await storeFile(items[0],'templates');} res.json({success:true,univUrl:out.univLogo?.url,collegeUrl:out.collegeLogo?.url,backgroundUrl:out.background?.url}); });

app.get('/api/departments', async (_req,res) => { if(!configured(res))return; const r=await pool.query('select * from departments where is_active=true order by sort_order,name'); res.json(r.rows); });
app.post('/api/admin/departments',auth,admin,async(req,res)=>{ const {code,name,icon,sortOrder}=req.body; const r=await pool.query('insert into departments(code,name,icon,sort_order) values($1,$2,$3,$4) returning *',[code,name,icon||'fa-graduation-cap',Number(sortOrder||0)]); res.json({success:true,department:r.rows[0]}); });
app.delete('/api/admin/departments/:code',auth,admin,async(req,res)=>{try{const r=await pool.query('delete from departments where code=$1 returning code,name',[req.params.code]);if(!r.rowCount)return res.status(404).json({success:false,error:'القسم غير موجود'});res.json({success:true,department:r.rows[0]});}catch(e){if(e.code==='23503')return res.status(409).json({success:false,error:'لا يمكن حذف القسم لأنه يحتوي على ملازم. احذف أو انقل الملازم أولاً'});throw e;}});
app.get('/api/stages',async(_req,res)=>{ if(!configured(res))return; const r=await pool.query('select * from stages where is_active=true order by sort_order'); res.json(r.rows); });
app.post('/api/admin/stages',auth,admin,async(req,res)=>{ const {code,name,sortOrder}=req.body; const r=await pool.query('insert into stages(code,name,sort_order) values($1,$2,$3) returning *',[code,name,Number(sortOrder||0)]); res.json({success:true,stage:r.rows[0]}); });
app.delete('/api/admin/stages/:code',auth,admin,async(req,res)=>{try{const r=await pool.query('delete from stages where code=$1 returning code,name',[req.params.code]);if(!r.rowCount)return res.status(404).json({success:false,error:'المرحلة غير موجودة'});res.json({success:true,stage:r.rows[0]});}catch(e){if(e.code==='23503')return res.status(409).json({success:false,error:'لا يمكن حذف المرحلة لأنها تحتوي على ملازم. احذف أو انقل الملازم أولاً'});throw e;}});

app.post('/api/materials/upload',auth,upload.single('file'),async(req,res)=>{
  if(!req.file)return res.status(400).json({success:false,message:'يرجى اختيار PDF أو Word أو صورة'});
  if(String(req.file.mimetype).startsWith('audio/'))return res.status(400).json({success:false,message:'التسجيلات الصوتية مخصصة للدردشة فقط'});
  const {title,doctorName,department,stage}=req.body;
  if(!department||!stage)return res.status(400).json({success:false,message:'القسم والمرحلة مطلوبان'});
  const stored=await storeFile(req.file,'materials'),pageCount=estimatePageCount(req.file);
  const client=await pool.connect();
  try {await client.query('begin');await client.query('select pg_advisory_xact_lock(hashtext($1))',[`${department}:${stage}`]);const n=await client.query('select coalesce(max(material_number),0)+1 n from study_materials where department_code=$1 and stage_code=$2',[department,stage]);const r=await client.query('insert into study_materials(department_code,stage_code,subject_name,title,doctor_name,file_path,storage_path,uploaded_by,material_number,mime_type,file_size_bytes,page_count) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *',[department,stage,title||req.file.originalname,title||req.file.originalname,doctorName||'',stored.url,stored.storagePath,req.user.userId,n.rows[0].n,req.file.mimetype,req.file.size||req.file.buffer?.length||0,pageCount]);await client.query('commit');res.json({success:true,message:'تم رفع الملزمة بنجاح',material:r.rows[0]}); }
  catch(e){await client.query('rollback');await removeStored(stored.storagePath,stored.url);throw e;}finally{client.release();}
});
app.get('/api/materials/department/:deptId',async(req,res)=>{if(!configured(res))return;const values=[req.params.deptId];let sql='select material_id,material_number,department_code,stage_code,subject_name,title,doctor_name,file_path,mime_type,page_count,created_at from study_materials where department_code=$1';if(req.query.stage){values.push(req.query.stage);sql+=` and stage_code=$${values.length}`;}if(req.query.q){values.push(`%${String(req.query.q).trim()}%`);sql+=` and (title ilike $${values.length} or doctor_name ilike $${values.length} or subject_name ilike $${values.length})`;}sql+=req.query.sort==='oldest'?' order by created_at asc':' order by created_at desc';const r=await pool.query(sql,values);res.json(r.rows);});
app.get('/api/materials/recent',async(_req,res)=>{const r=await pool.query(`select m.material_id,m.material_number,m.title,m.doctor_name,m.department_code,m.stage_code,m.created_at,coalesce(d.name,m.department_code) department_name,coalesce(s.name,m.stage_code) stage_name from study_materials m left join departments d on d.code=m.department_code left join stages s on s.code=m.stage_code where m.created_at>=now()-interval '24 hours' order by m.created_at desc limit 30`);res.json({success:true,materials:r.rows});});
app.get('/api/materials/:id/preview-content',async(req,res)=>{const r=await pool.query('select file_path,mime_type from study_materials where material_id=$1',[req.params.id]);if(!r.rowCount)return res.sendStatus(404);const x=r.rows[0];try{const upstream=await fetch(x.file_path);if(!upstream.ok)return res.status(502).send('تعذر جلب ملف المعاينة');res.set('Content-Type',x.mime_type||upstream.headers.get('content-type')||'application/octet-stream');res.set('Cache-Control','public, max-age=3600');res.send(Buffer.from(await upstream.arrayBuffer()));}catch{return res.status(502).send('تعذر جلب ملف المعاينة')}});
app.patch('/api/materials/:id',auth,async(req,res)=>{const old=await pool.query('select * from study_materials where material_id=$1',[req.params.id]);if(!old.rowCount)return res.status(404).json({success:false,error:'الملزمة غير موجودة'});const x=old.rows[0],department=String(req.body.department||x.department_code),stage=String(req.body.stage||x.stage_code),changed=department!==x.department_code||stage!==x.stage_code;const client=await pool.connect();try{await client.query('begin');let number=x.material_number;if(changed){await client.query('select pg_advisory_xact_lock(hashtext($1))',[`${department}:${stage}`]);const n=await client.query('select coalesce(max(material_number),0)+1 n from study_materials where department_code=$1 and stage_code=$2',[department,stage]);number=n.rows[0].n;}const r=await client.query('update study_materials set title=$1,subject_name=$1,doctor_name=$2,department_code=$3,stage_code=$4,material_number=$5,updated_by=$6,updated_at=now() where material_id=$7 returning *',[String(req.body.title||x.title).trim(),String(req.body.doctorName??x.doctor_name).trim(),department,stage,number,req.user.userId,req.params.id]);await client.query("insert into material_audit(material_id,action,old_values,new_values,changed_by) values($1,'UPDATE',$2,$3,$4)",[req.params.id,x,r.rows[0],req.user.userId]);await client.query('commit');res.json({success:true,material:r.rows[0]});}catch(e){await client.query('rollback');throw e;}finally{client.release();}});
app.get('/api/admin/materials',auth,admin,async(req,res)=>{
  if(!configured(res))return;
  const r=await pool.query(`
    select m.material_id,m.material_number,m.title,m.doctor_name,m.department_code,m.stage_code,m.created_at,m.file_path,m.mime_type,m.file_size_bytes,
           coalesce(d.name,m.department_code) department_name,
           coalesce(s.name,m.stage_code) stage_name
    from study_materials m
    left join departments d on d.code=m.department_code
    left join stages s on s.code=m.stage_code
    order by m.created_at desc
  `);
  const used=r.rows.reduce((sum,x)=>sum+Number(x.file_size_bytes||0),0),quota=Math.max(1,Number(process.env.STORAGE_QUOTA_MB||1024))*1024*1024;
  res.json({success:true,materials:r.rows,storage:{usedBytes:used,quotaBytes:quota,materialCount:r.rowCount}});
});
app.get('/api/admin/materials/:id',auth,admin,async(req,res)=>{const r=await pool.query(`select m.*,coalesce(d.name,m.department_code) department_name,coalesce(s.name,m.stage_code) stage_name from study_materials m left join departments d on d.code=m.department_code left join stages s on s.code=m.stage_code where m.material_id=$1`,[req.params.id]);if(!r.rowCount)return res.status(404).json({success:false,error:'الملزمة غير موجودة'});res.json({success:true,material:r.rows[0]});});
app.get('/api/staff/materials',auth,async(_req,res)=>{const r=await pool.query(`select m.material_id,m.material_number,m.title,m.doctor_name,m.department_code,m.stage_code,m.created_at,m.file_path,m.mime_type,m.file_size_bytes,m.page_count,coalesce(d.name,m.department_code) department_name,coalesce(s.name,m.stage_code) stage_name from study_materials m left join departments d on d.code=m.department_code left join stages s on s.code=m.stage_code order by m.created_at desc`);const used=r.rows.reduce((sum,x)=>sum+Number(x.file_size_bytes||0),0),quota=Math.max(1,Number(process.env.STORAGE_QUOTA_MB||1024))*1024*1024;res.json({success:true,materials:r.rows,storage:{usedBytes:used,quotaBytes:quota,materialCount:r.rowCount}})});
app.get('/api/staff/materials/:id',auth,async(req,res)=>{const r=await pool.query(`select m.*,coalesce(d.name,m.department_code) department_name,coalesce(s.name,m.stage_code) stage_name from study_materials m left join departments d on d.code=m.department_code left join stages s on s.code=m.stage_code where m.material_id=$1`,[req.params.id]);if(!r.rowCount)return res.status(404).json({success:false,error:'الملزمة غير موجودة'});res.json({success:true,material:r.rows[0]})});
app.delete('/api/materials/:id',auth,admin,async(req,res)=>{
  const id=Number(req.params.id);
  if(!Number.isInteger(id)||id<1)return res.status(400).json({success:false,error:'رقم الملزمة غير صحيح'});
  const r=await pool.query('delete from study_materials where material_id=$1 returning title,storage_path,file_path',[id]);
  if(!r.rowCount)return res.status(404).json({success:false,error:'الملزمة غير موجودة'});
  await removeStored(r.rows[0].storage_path,r.rows[0].file_path);
  res.json({success:true,message:'تم حذف الملزمة وملفها نهائياً',title:r.rows[0].title});
});
app.post('/api/materials/print',async(req,res)=>{
  if(!configured(res))return;
  const materialId=Number(req.body.materialId);
  if(!Number.isInteger(materialId)||materialId<1)return res.status(400).json({success:false,error:'رقم الملزمة غير صحيح'});
  const material=await pool.query('select title,doctor_name,file_path,page_count from study_materials where material_id=$1',[materialId]);
  if(!material.rowCount)return res.status(404).json({success:false,error:'الملزمة غير موجودة'});
  const item=material.rows[0];
  const order=await pool.query(
    "insert into student_print_files(original_name,file_path,storage_path,copies,color_mode,student_name,phone,notes,page_count) values($1,$2,null,$3,$4,$5,$6,'طلب طباعة ملزمة من المكتبة الرقمية',$7) returning file_id",
    [item.title,item.file_path,Math.max(1,Number(req.body.copies||1)),req.body.colorMode==='COLOR'?'COLOR':'BW',String(req.body.studentName||'').trim(),String(req.body.phone||'').trim(),item.page_count]
  );
  await pool.query("insert into print_job_events(file_id,action,details) values($1,'MATERIAL_REQUESTED',$2)",[order.rows[0].file_id,JSON.stringify({materialId,printCover:true,title:item.title,doctorName:item.doctor_name||'',pageCount:item.page_count||null})]);
  res.json({success:true,message:'تم إرسال طلب الطباعة إلى موظفي المكتبة',orderId:order.rows[0].file_id});
});

app.post('/api/materials/:id/direct-print',auth,async(req,res)=>{
  const materialId=Number(req.params.id),settings=normalizePrintSettings(req.body),client=await pool.connect();
  if(!Number.isInteger(materialId)||materialId<1){client.release();return res.status(400).json({success:false,error:'رقم الملزمة غير صحيح'});}
  try{
    await client.query('begin');
    const material=await client.query('select material_id,title,doctor_name,file_path,page_count from study_materials where material_id=$1 for share',[materialId]);
    if(!material.rowCount){await client.query('rollback');return res.status(404).json({success:false,error:'الملزمة غير موجودة'});}
    let printerNumber=Number(req.body.printerNumber);
    if(req.body.distribution==='AUTO'||!printerNumber)printerNumber=await leastBusyPrinter(client,settings.colorMode);
    const allowed=ACTIVE_PRINTERS[settings.colorMode]||[];
    if(!allowed.includes(printerNumber)){await client.query('rollback');return res.status(400).json({success:false,error:settings.colorMode==='COLOR'?'للطباعة الملونة اختر الطابعة 8 أو 5':'للأسود والأبيض اختر الطابعة 1 أو 2 أو 3 أو 9'});}
    const m=material.rows[0];
    const order=await client.query(`insert into student_print_files(original_name,file_path,storage_path,print_type,copies,color_mode,paper_size,duplex_mode,status,direct_print_status,printer_number,queued_by,queued_at,notes,page_count) values($1,$2,null,'DOCUMENT',$3,$4,$5,$6,'QUEUED','QUEUED',$7,$8,now(),'طباعة مباشرة من إدارة الملازم',$9) returning file_id`,[m.title,m.file_path,settings.copies,settings.colorMode,settings.paperSize,settings.duplexMode,printerNumber,req.user.userId,m.page_count]);
    await client.query("insert into print_job_events(file_id,action,to_printer,details,performed_by) values($1,'MATERIAL_DIRECT_QUEUED',$2,$3,$4)",[order.rows[0].file_id,printerNumber,JSON.stringify({...settings,materialId,printCover:req.body.printCover!==false,title:m.title,doctorName:m.doctor_name||'',pageCount:m.page_count||null}),req.user.userId]);
    await client.query('commit');
    res.json({success:true,orderId:order.rows[0].file_id,printerNumber,message:`تم إرسال الملزمة مباشرة إلى الطابعة رقم ${printerNumber}`});
  }catch(e){await client.query('rollback');throw e;}finally{client.release();}
});

app.post('/upload-student-file',upload.array('files',20),async(req,res)=>{
  if(!configured(res))return;
  const files=req.files||[];
  if(!files.length)return res.status(400).json({success:false,message:'يرجى اختيار ملف واحد على الأقل'});
  const printType=['ID_CARD','ID_PASSPORT'].includes(req.body.printType)?req.body.printType:'DOCUMENT';
  if(printType==='ID_CARD'&&(files.length!==2||files.some(f=>!f.mimetype.startsWith('image/'))))return res.status(400).json({success:false,message:'طباعة الهوية تحتاج صورتين فقط: الوجه والظهر'});
  if(printType==='ID_PASSPORT'&&(files.length!==3||files.some(f=>!f.mimetype.startsWith('image/'))))return res.status(400).json({success:false,message:'هذا التنسيق يحتاج 3 صور: وجه الهوية، ظهر الهوية، والجواز'});
  const common=[Math.max(1,Number(req.body.copies||1)),req.body.colorMode==='COLOR'?'COLOR':'BW',String(req.body.studentName||'').trim(),String(req.body.phone||'').trim(),String(req.body.notes||'').trim()];
  const created=[];
  if(printType==='ID_CARD'||printType==='ID_PASSPORT'){
    const front=await storeFile(files[0],'print-orders');
    const back=await storeFile(files[1],'print-orders');
    const passport=files[2]?await storeFile(files[2],'print-orders'):null;
    try{
      const r=await pool.query("insert into student_print_files(original_name,file_path,storage_path,second_file_path,second_storage_path,third_file_path,third_storage_path,print_type,copies,color_mode,student_name,phone,notes,page_count) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,1) returning file_id",[passport?'هوية وجواز - منسقة':'هوية - الوجه والظهر',front.url,front.storagePath,back.url,back.storagePath,passport?.url||null,passport?.storagePath||null,printType,...common]);
      created.push(r.rows[0].file_id);
    }catch(e){await removeStored(front.storagePath,front.url);await removeStored(back.storagePath,back.url);if(passport)await removeStored(passport.storagePath,passport.url);throw e;}
  }else{
    for(const file of files){
      const stored=await storeFile(file,'print-orders');
      try{const r=await pool.query("insert into student_print_files(original_name,file_path,storage_path,print_type,copies,color_mode,student_name,phone,notes,page_count) values($1,$2,$3,'DOCUMENT',$4,$5,$6,$7,$8,$9) returning file_id",[file.originalname,stored.url,stored.storagePath,...common,estimatePageCount(file)]);created.push(r.rows[0].file_id);}
      catch(e){await removeStored(stored.storagePath,stored.url);throw e;}
    }
  }
  res.json({success:true,message:`تم إرسال ${created.length} طلب للطباعة`,orderIds:created});
});
app.get('/api/student-files',auth,async(_req,res)=>{ const r=await pool.query(`select f.file_id as id,f.original_name as "originalName",f.file_path as url,f.second_file_path as "secondUrl",f.third_file_path as "thirdUrl",f.print_type as "printType",f.copies,f.color_mode,f.page_count as "pageCount",f.paper_size as "paperSize",f.duplex_mode as "duplexMode",f.status,f.student_name,f.phone,f.notes,f.created_at as time,f.direct_print_status as "directPrintStatus",f.printer_number as "printerNumber",f.print_error as "printError",f.telegram_chat_id as "telegramChatId",f.estimated_price_iqd as "estimatedPriceIqd",f.payment_status as "paymentStatus",q.full_name as "queuedByName",c.full_name as "completedByName",x.full_name as "cancelledByName" from student_print_files f left join users q on q.user_id=f.queued_by left join users c on c.user_id=f.completed_by left join users x on x.user_id=f.cancelled_by where f.status<>'CANCELLED' and f.archived_at is null order by f.created_at desc limit 1000`); res.json(r.rows); });
app.get('/api/student-files/:id',auth,async(req,res)=>{const r=await pool.query('select file_id as id,original_name as "originalName",file_path as url,second_file_path as "secondUrl",print_type as "printType",copies,color_mode,student_name,phone,notes from student_print_files where file_id=$1',[req.params.id]);if(!r.rowCount)return res.status(404).json({success:false,error:'الطلب غير موجود'});res.json(r.rows[0]);});
app.patch('/api/student-files/:id/status',auth,async(req,res)=>{ const status=['QUEUED','PRINTING','COMPLETED','CANCELLED'].includes(req.body.status)?req.body.status:'QUEUED'; await pool.query("update student_print_files set status=$1,completed_by=case when $1='COMPLETED' then $2 else completed_by end,completed_at=case when $1='COMPLETED' then now() else completed_at end where file_id=$3",[status,req.user.userId,req.params.id]); res.json({success:true}); });
app.post('/api/student-files/:id/direct-print',auth,async(req,res)=>{
  const client=await pool.connect();try{await client.query('begin');const item=await client.query('select * from student_print_files where file_id=$1 for update',[req.params.id]);if(!item.rowCount){await client.query('rollback');return res.status(404).json({success:false,error:'ملف الطباعة غير موجود'});}const settings=normalizePrintSettings({...item.rows[0],...req.body,colorMode:req.body.colorMode||item.rows[0].color_mode,copies:req.body.copies||item.rows[0].copies,paperSize:req.body.paperSize||item.rows[0].paper_size,duplexMode:req.body.duplexMode||item.rows[0].duplex_mode});let printerNumber=Number(req.body.printerNumber);if(req.body.distribution==='AUTO'||!printerNumber)printerNumber=await leastBusyPrinter(client,settings.colorMode);const allowed=ACTIVE_PRINTERS[settings.colorMode];if(!allowed.includes(printerNumber)){await client.query('rollback');return res.status(400).json({success:false,error:settings.colorMode==='COLOR'?'الطلب ملون؛ اختر الطابعة 8 أو 5':'الطلب أسود وأبيض؛ اختر الطابعة 1 أو 2 أو 3 أو 9'});}const r=await client.query(`update student_print_files set direct_print_status='QUEUED',printer_number=$1,copies=$2,color_mode=$3,paper_size=$4,duplex_mode=$5,print_error=null,queued_at=now(),claimed_at=null,agent_id=null,status='QUEUED',queued_by=$6 where file_id=$7 and direct_print_status not in ('CLAIMED','COMPLETED') and status<>'CANCELLED' returning file_id,color_mode,printer_number`,[printerNumber,settings.copies,settings.colorMode,settings.paperSize,settings.duplexMode,req.user.userId,req.params.id]);if(!r.rowCount){await client.query('rollback');return res.status(409).json({success:false,error:'الطلب بدأ أو اكتمل ولا يمكن إرساله مرة ثانية'});}await client.query("insert into print_job_events(file_id,action,to_printer,details,performed_by) values($1,'QUEUED',$2,$3,$4)",[req.params.id,printerNumber,JSON.stringify(settings),req.user.userId]);await client.query('commit');res.json({success:true,message:`أُرسل الطلب إلى الطابعة رقم ${printerNumber}`,job:r.rows[0]});}catch(e){await client.query('rollback');throw e;}finally{client.release();}
});
app.post('/api/student-files/batch-direct-print',auth,async(req,res)=>{const ids=[...new Set((Array.isArray(req.body.ids)?req.body.ids:[]).map(Number).filter(Number.isInteger))].slice(0,100);if(!ids.length)return res.status(400).json({success:false,error:'حدد ملفاً واحداً على الأقل'});const client=await pool.connect(),queued=[],failed=[];try{await client.query('begin');for(const id of ids){const q=await client.query('select * from student_print_files where file_id=$1 for update',[id]);if(!q.rowCount||['CLAIMED','COMPLETED'].includes(q.rows[0].direct_print_status)){failed.push(id);continue;}const settings=normalizePrintSettings({...q.rows[0],...req.body,colorMode:req.body.overrideColor?req.body.colorMode:q.rows[0].color_mode});let printer=Number(req.body.printerNumber);if(req.body.distribution!=='SINGLE'||!(ACTIVE_PRINTERS[settings.colorMode]||[]).includes(printer))printer=await leastBusyPrinter(client,settings.colorMode);await client.query(`update student_print_files set direct_print_status='QUEUED',status='QUEUED',printer_number=$1,copies=$2,color_mode=$3,paper_size=$4,duplex_mode=$5,queued_by=$6,queued_at=now(),claimed_at=null,agent_id=null,print_error=null where file_id=$7`,[printer,settings.copies,settings.colorMode,settings.paperSize,settings.duplexMode,req.user.userId,id]);await client.query("insert into print_job_events(file_id,action,to_printer,details,performed_by) values($1,'BATCH_QUEUED',$2,$3,$4)",[id,printer,JSON.stringify(settings),req.user.userId]);queued.push({id,printer});}await client.query('commit');res.json({success:true,queued,failed,message:`تم إرسال ${queued.length} ملف للطباعة${failed.length?` وتعذر ${failed.length}`:''}`});}catch(e){await client.query('rollback');throw e;}finally{client.release();}});
app.patch('/api/student-files/:id/reassign',auth,async(req,res)=>{const to=Number(req.body.printerNumber),client=await pool.connect();try{await client.query('begin');const q=await client.query("select printer_number,color_mode from student_print_files where file_id=$1 and direct_print_status in ('QUEUED','FAILED') for update",[req.params.id]);if(!q.rowCount){await client.query('rollback');return res.status(409).json({success:false,error:'لا يمكن تحويل طلب بدأ طباعته أو اكتمل'});}if(!(ACTIVE_PRINTERS[q.rows[0].color_mode]||[]).includes(to)){await client.query('rollback');return res.status(400).json({success:false,error:'الطابعة البديلة لا تطابق نوع اللون'});}await client.query("update student_print_files set printer_number=$1,direct_print_status='QUEUED',print_error=null,queued_at=now() where file_id=$2",[to,req.params.id]);await client.query("insert into print_job_events(file_id,action,from_printer,to_printer,performed_by) values($1,'REASSIGNED',$2,$3,$4)",[req.params.id,q.rows[0].printer_number,to,req.user.userId]);await client.query('commit');res.json({success:true,message:`تم تحويل الطلب إلى الطابعة ${to}`});}catch(e){await client.query('rollback');throw e;}finally{client.release();}});
app.post('/api/student-files/:id/cancel-direct',auth,async(req,res)=>{
  const r=await pool.query("update student_print_files set direct_print_status='CANCELLED',print_error='ألغاه الموظف',cancelled_by=$2,cancelled_at=now() where file_id=$1 and direct_print_status in ('QUEUED','FAILED') returning file_id,printer_number",[req.params.id,req.user.userId]);
  if(!r.rowCount)return res.status(409).json({success:false,error:'تعذر الإلغاء؛ ربما بدأت الطباعة بالفعل'});
  await pool.query("insert into print_job_events(file_id,action,from_printer,performed_by) values($1,'CANCELLED',$2,$3)",[req.params.id,r.rows[0].printer_number,req.user.userId]);
  res.json({success:true,message:'تم إلغاء أمر الطباعة المباشرة'});
});
app.get('/api/student-files/:id/events',auth,async(req,res)=>{const r=await pool.query(`select e.*,u.full_name performed_by_name from print_job_events e left join users u on u.user_id=e.performed_by where e.file_id=$1 order by e.created_at`,[req.params.id]);res.json({success:true,events:r.rows});});
app.post('/api/student-files/bulk-delete',auth,async(req,res)=>{
  const removeAll=Boolean(req.body.all);
  if(removeAll&&req.user.role!=='ADMIN')return res.status(403).json({success:false,error:'حذف جميع الملفات متاح للمدير فقط'});
  const ids=[...new Set((Array.isArray(req.body.ids)?req.body.ids:[]).map(Number).filter(Number.isInteger))].slice(0,500);
  if(!removeAll&&!ids.length)return res.status(400).json({success:false,error:'حدد ملفاً واحداً على الأقل'});
  const client=await pool.connect();let rows=[];
  try{
    await client.query('begin');
    const result=removeAll
      ?await client.query("delete from student_print_files where archived_at is null and direct_print_status<>'CLAIMED' returning file_id,source_task_attachment_id,storage_path,file_path,second_storage_path,second_file_path,third_storage_path,third_file_path")
      :await client.query("delete from student_print_files where file_id=any($1::bigint[]) and direct_print_status<>'CLAIMED' returning file_id,source_task_attachment_id,storage_path,file_path,second_storage_path,second_file_path,third_storage_path,third_file_path",[ids]);
    rows=result.rows;
    await client.query('commit');
  }catch(e){await client.query('rollback');throw e;}finally{client.release();}
  for(const x of rows){if(!x.source_task_attachment_id){await removeStored(x.storage_path,x.file_path);await removeStored(x.second_storage_path,x.second_file_path);await removeStored(x.third_storage_path,x.third_file_path);}}
  const skipped=removeAll?0:Math.max(0,ids.length-rows.length);
  res.json({success:true,deleted:rows.length,skipped,message:`تم حذف ${rows.length} ملف${skipped?`، وتعذر حذف ${skipped} لأنه قيد الطباعة أو غير موجود`:''}`});
});
app.delete('/api/student-files/:id',auth,async(req,res)=>{ const r=await pool.query("delete from student_print_files where file_id=$1 and direct_print_status<>'CLAIMED' returning source_task_attachment_id,storage_path,file_path,second_storage_path,second_file_path,third_storage_path,third_file_path",[req.params.id]); if(!r.rowCount)return res.status(409).json({success:false,error:'لا يمكن حذف ملف قيد الطباعة'});if(!r.rows[0].source_task_attachment_id){await removeStored(r.rows[0].storage_path,r.rows[0].file_path);await removeStored(r.rows[0].second_storage_path,r.rows[0].second_file_path);await removeStored(r.rows[0].third_storage_path,r.rows[0].third_file_path);}res.json({success:true}); });
app.post('/api/student-files/:id/promote-to-material',auth,async(req,res)=>{
  const {title,doctorName,department,stage}=req.body;
  if(!title||!department||!stage)return res.status(400).json({success:false,error:'اسم الملزمة والقسم والمرحلة مطلوبة'});
  const source=await pool.query('select original_name,file_path,print_type from student_print_files where file_id=$1',[req.params.id]);
  if(!source.rowCount)return res.status(404).json({success:false,error:'ملف الطباعة غير موجود'});
  if(source.rows[0].print_type==='ID_CARD')return res.status(400).json({success:false,error:'لا يمكن تحويل طلب هوية إلى ملزمة'});
  const response=await fetch(source.rows[0].file_path);
  if(!response.ok)return res.status(502).json({success:false,error:'تعذر قراءة الملف الأصلي'});
  const buffer=Buffer.from(await response.arrayBuffer());
  if(buffer.length>MAX_UPLOAD_MB*1024*1024)return res.status(400).json({success:false,error:`حجم الملف يتجاوز ${MAX_UPLOAD_MB}MB`});
  const stored=await storeFile({originalname:source.rows[0].original_name,mimetype:response.headers.get('content-type')||'application/octet-stream',buffer},'materials');
  const pageCount=estimatePageCount({originalname:source.rows[0].original_name,mimetype:response.headers.get('content-type')||'',buffer});
  try{const r=await pool.query('insert into study_materials(department_code,stage_code,subject_name,title,doctor_name,file_path,storage_path,uploaded_by,page_count) values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning material_id',[department,stage,title,title,doctorName||'',stored.url,stored.storagePath,req.user.userId,pageCount]);res.json({success:true,message:'تمت إضافة الملف إلى الملازم',materialId:r.rows[0].material_id});}
  catch(e){await removeStored(stored.storagePath,stored.url);throw e;}
});

app.get('/api/tasks',auth,async(_req,res)=>{ const r=await pool.query("select t.*,coalesce(u.full_name,'كادر المكتبة') assigned_to_name,cu.full_name completed_by_name from tasks t left join users u on u.user_id=t.assigned_to left join users cu on cu.user_id=t.completed_by where t.archived_at is null order by t.created_at desc"); res.json(r.rows); });
app.post('/api/tasks/create',auth,admin,async(req,res)=>{ const {taskType,title,description,assignedTo,expectedCompletionAt}=req.body; let userId=null; if(assignedTo){const u=await pool.query('select user_id from users where username=$1 or full_name=$1 limit 1',[assignedTo]);userId=u.rows[0]?.user_id||null;} const r=await pool.query('insert into tasks(task_type,title,description,assigned_to,expected_completion_at) values($1,$2,$3,$4,$5) returning *',[taskType||'عام',title,description||'',userId,expectedCompletionAt||null]); res.json({success:true,task:r.rows[0]}); });
app.post('/api/tasks/complete',auth,async(req,res)=>{ await pool.query("update tasks set status='COMPLETED',completed_by=$1,completed_at=now() where task_id=$2",[req.user.userId,req.body.taskId]); res.json({success:true}); });

// نظام المهام التشغيلي: الإنشاء للجميع، الاستلام لموظف واحد، والإنجاز لمن استلم فقط.
app.get('/api/work-tasks',auth,async(req,res)=>{
  const r=await pool.query(`select t.*,creator.full_name created_by_name,assignee.full_name assigned_to_name,
    extract(epoch from(now()-t.created_at))/3600 age_hours,
    greatest(0,coalesce(t.amount_total,0)-coalesce(t.amount_paid,0)) balance,
    (t.assigned_to=$1) is_mine,
    coalesce((select json_agg(json_build_object('id',a.attachment_id,'name',a.original_name,'url',a.file_path) order by a.created_at,a.attachment_id) from task_attachments a where a.task_id=t.task_id),'[]'::json) attachments
    from tasks t left join users creator on creator.user_id=t.created_by left join users assignee on assignee.user_id=t.assigned_to
    where t.status in ('PENDING','IN_PROGRESS') and t.archived_at is null
    order by case when t.status='IN_PROGRESS' and t.assigned_to=$1 then 0 when t.status='PENDING' then 1 else 2 end,
             t.created_at asc`,[req.user.userId]);
  res.json({success:true,tasks:r.rows,userId:req.user.userId});
});
app.post('/api/work-tasks/batch',auth,upload.fields([{name:'attachments',maxCount:10},{name:'attachment',maxCount:1}]),async(req,res)=>{
  const customerName=String(req.body.customerName||'').trim(),customerPhone=String(req.body.customerPhone||'').trim();
  const rawTypes=req.body.types??req.body['types[]'];
  const types=(Array.isArray(rawTypes)?rawTypes:[rawTypes]).filter(Boolean).map(x=>String(x).trim()).slice(0,12);
  const allowed=['طباعة','تنضيد','استنساخ','تجليد','توزيع','تصميم','أخرى'];
  if(!customerName||!customerPhone||!types.length)return res.status(400).json({success:false,error:'اسم الطالب ورقم الهاتف ونوع مهمة واحد على الأقل مطلوبة'});
  if(types.some(x=>!allowed.includes(x)))return res.status(400).json({success:false,error:'نوع مهمة غير صحيح'});
  const total=Math.max(0,Number(req.body.amountTotal||0)),paid=Math.max(0,Number(req.body.amountPaid||0));
  if(paid>total)return res.status(400).json({success:false,error:'المبلغ المدفوع لا يمكن أن يتجاوز المبلغ الكلي'});
  const perTotal=total/types.length,perPaid=paid/types.length,created=[];
  const files=[...(req.files?.attachments||[]),...(req.files?.attachment||[])].slice(0,10),attachments=[];
  for(const file of files)attachments.push({file,stored:await storeFile(file,'task-attachments')});
  const client=await pool.connect();
  try{await client.query('begin');for(const type of types){const first=attachments[0];const r=await client.query(`insert into tasks(task_type,title,description,created_by,customer_name,customer_phone,notes,amount_total,amount_paid,expected_completion_at,attachment_name,attachment_path,attachment_storage_path)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning task_id`,[type,`${type} - ${customerName}`,String(req.body.description||'').trim(),req.user.userId,customerName,customerPhone,String(req.body.notes||'').trim(),perTotal,perPaid,req.body.dueAt||null,first?.file.originalname||null,first?.stored.url||null,first?.stored.storagePath||null]);const taskId=r.rows[0].task_id;created.push(taskId);for(const a of attachments)await client.query('insert into task_attachments(task_id,original_name,file_path,storage_path,mime_type) values($1,$2,$3,$4,$5)',[taskId,a.file.originalname,a.stored.url,a.stored.storagePath,a.file.mimetype||null]);}await client.query('commit');res.json({success:true,taskIds:created,attachmentCount:attachments.length,message:`تمت إضافة ${created.length} مهام مع ${attachments.length} مرفقات`});}
  catch(e){await client.query('rollback');for(const a of attachments)await removeStored(a.stored.storagePath,a.stored.url);throw e;}finally{client.release();}
});
app.patch('/api/work-tasks/:id/claim',auth,async(req,res)=>{
  const r=await pool.query("update tasks set assigned_to=$1,status='IN_PROGRESS',claimed_at=now(),updated_at=now() where task_id=$2 and status='PENDING' and assigned_to is null returning task_id",[req.user.userId,req.params.id]);
  if(!r.rowCount)return res.status(409).json({success:false,error:'المهمة استلمها موظف آخر أو لم تعد متاحة'});
  res.json({success:true});
});
app.patch('/api/work-tasks/:id/complete',auth,async(req,res)=>{
  const r=await pool.query("update tasks set status='COMPLETED',completed_by=$1,completed_at=now(),updated_at=now() where task_id=$2 and status='IN_PROGRESS' and assigned_to=$1 returning task_id",[req.user.userId,req.params.id]);
  if(!r.rowCount)return res.status(403).json({success:false,error:'لا يستطيع إكمال المهمة إلا الموظف الذي استلمها'});
  res.json({success:true});
});
app.patch('/api/work-tasks/:id/payment',auth,async(req,res)=>{
  const paid=Math.max(0,Number(req.body.amountPaid||0));
  const r=await pool.query("update tasks set amount_paid=least(amount_total,$1),notes=case when $2='' then notes else concat_ws(E'\\n',notes,$2) end,updated_at=now() where task_id=$3 and (assigned_to=$4 or $5='ADMIN') returning amount_total,amount_paid",[paid,String(req.body.note||'').trim(),req.params.id,req.user.userId,req.user.role]);
  if(!r.rowCount)return res.status(403).json({success:false,error:'لا تملك صلاحية تعديل هذه المهمة'});res.json({success:true,task:r.rows[0]});
});
app.post('/api/work-tasks/:id/to-print',auth,async(req,res)=>{const t=await pool.query('select * from tasks where task_id=$1',[req.params.id]);if(!t.rowCount)return res.status(404).json({success:false,error:'المهمة غير موجودة'});const x=t.rows[0],a=await pool.query('select * from task_attachments where task_id=$1 order by created_at,attachment_id',[x.task_id]);let items=a.rows;if(!items.length&&x.attachment_path)items=[{attachment_id:null,original_name:x.attachment_name,file_path:x.attachment_path,storage_path:x.attachment_storage_path}];if(!items.length)return res.status(400).json({success:false,error:'لا توجد ملفات مرفقة بهذه المهمة'});const settings=normalizePrintSettings(req.body),created=[];for(const item of items){try{const r=await pool.query(`insert into student_print_files(original_name,file_path,storage_path,copies,color_mode,paper_size,duplex_mode,student_name,phone,notes,source_task_id,source_task_attachment_id,queued_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning file_id`,[item.original_name||x.title,item.file_path,item.storage_path,settings.copies,settings.colorMode,settings.paperSize,settings.duplexMode,x.customer_name||'',x.customer_phone||'',`تحويل من المهمة رقم ${x.task_id}`,x.task_id,item.attachment_id,req.user.userId]);created.push(r.rows[0].file_id);}catch(e){if(e.code!=='23505')throw e;}}if(!created.length)return res.status(409).json({success:false,error:'تم تحويل جميع مرفقات هذه المهمة مسبقاً'});res.json({success:true,fileIds:created,count:created.length,message:`تم تحويل ${created.length} ملف إلى طابور الطباعة`});});
app.get('/api/admin/work-tasks',auth,admin,async(req,res)=>{
  const limit=Math.min(1000,Math.max(1,Number(req.query.limit||500)));
  const r=await pool.query(`select t.*,creator.full_name created_by_name,assignee.full_name assigned_to_name,finisher.full_name completed_by_name,
    greatest(0,coalesce(t.amount_total,0)-coalesce(t.amount_paid,0)) balance
    from tasks t left join users creator on creator.user_id=t.created_by left join users assignee on assignee.user_id=t.assigned_to left join users finisher on finisher.user_id=t.completed_by where t.archived_at is null
    order by case when t.status='PENDING' then 0 when t.status='IN_PROGRESS' then 1 else 2 end,t.created_at desc limit $1`,[limit]);res.json({success:true,tasks:r.rows});
});
app.get('/api/admin/debts',auth,admin,async(_req,res)=>{
  const r=await pool.query(`select coalesce(customer_name,'غير محدد') customer_name,coalesce(customer_phone,'-') customer_phone,
    sum(greatest(0,coalesce(amount_total,0)-coalesce(amount_paid,0))) balance,count(*) task_count,max(created_at) last_task
    from tasks where coalesce(amount_total,0)>coalesce(amount_paid,0) and status<>'CANCELLED'
    group by customer_name,customer_phone order by balance desc,last_task desc`);res.json({success:true,debts:r.rows});
});
app.post('/api/admin/debts/payment',auth,admin,async(req,res)=>{const name=String(req.body.customerName||'').trim(),phone=String(req.body.customerPhone||'').trim(),clearAll=Boolean(req.body.clearAll),requested=Number(req.body.amount||0);if(!name||!phone||(!clearAll&&(!Number.isFinite(requested)||requested<=0)))return res.status(400).json({success:false,error:'بيانات التسديد غير صحيحة'});const client=await pool.connect();try{await client.query('begin');const debts=await client.query(`select task_id,amount_total,amount_paid,greatest(0,coalesce(amount_total,0)-coalesce(amount_paid,0)) balance from tasks where coalesce(customer_name,'')=$1 and coalesce(customer_phone,'')=$2 and coalesce(amount_total,0)>coalesce(amount_paid,0) and status<>'CANCELLED' order by created_at,task_id for update`,[name,phone]);const total=debts.rows.reduce((s,x)=>s+Number(x.balance),0);if(total<=0){await client.query('rollback');return res.status(400).json({success:false,error:'لا يوجد مبلغ متبقٍ على هذا الطالب'});}let remaining=clearAll?total:Math.min(requested,total),paid=remaining;for(const d of debts.rows){if(remaining<=0)break;const part=Math.min(remaining,Number(d.balance));await client.query('update tasks set amount_paid=coalesce(amount_paid,0)+$1,updated_at=now() where task_id=$2',[part,d.task_id]);remaining-=part;}await client.query('insert into debt_payments(customer_name,customer_phone,amount,payment_kind,notes,created_by) values($1,$2,$3,$4,$5,$6)',[name,phone,paid,clearAll||paid===total?'FULL':'PARTIAL',String(req.body.notes||'').trim(),req.user.userId]);await client.query('commit');res.json({success:true,paidAmount:paid,remainingBalance:Math.max(0,total-paid),message:total-paid<=0?'تم تصفير الحساب':'تم تسجيل الدفعة وتحديث الرصيد'});}catch(e){await client.query('rollback');throw e;}finally{client.release();}});
app.get('/api/admin/debt-payments',auth,admin,async(_req,res)=>{const r=await pool.query('select p.*,u.full_name created_by_name from debt_payments p left join users u on u.user_id=p.created_by order by p.created_at desc limit 500');res.json({success:true,payments:r.rows});});

function dateRange(req){
  const today=new Date().toISOString().slice(0,10);
  return {from:/^\d{4}-\d{2}-\d{2}$/.test(req.query.from||'')?req.query.from:today,to:/^\d{4}-\d{2}-\d{2}$/.test(req.query.to||'')?req.query.to:today};
}
app.post('/api/accounting/entries',auth,accounting,async(req,res)=>{
  const type=['INCOME','EXPENSE'].includes(req.body.entryType)?req.body.entryType:null;
  const category=['SALES','SALARY','RENT','ELECTRICITY','POS_COMMISSION','SUPPLIES','OTHER'].includes(req.body.category)?req.body.category:null;
  const method=['CASH','GREEN_CARD','BLACK_CARD','BANK'].includes(req.body.paymentMethod)?req.body.paymentMethod:'CASH';
  const amount=Number(req.body.amount);
  if(!type||!category||!Number.isFinite(amount)||amount<0)return res.status(400).json({success:false,error:'بيانات الحركة المالية غير صحيحة'});
  const r=await pool.query('insert into financial_entries(entry_date,entry_type,category,description,amount,payment_method,created_by,spent_by,entry_source) values(coalesce($1,current_date),$2,$3,$4,$5,$6,$7,$8,$9) returning *',[req.body.entryDate||null,type,category,String(req.body.description||'').trim(),amount,method,req.user.userId,String(req.body.spentBy||'').trim()||null,'MANUAL']);
  res.json({success:true,entry:r.rows[0]});
});
app.get('/api/accounting/entries',auth,accounting,async(req,res)=>{const {from,to}=dateRange(req);const r=await pool.query(`select f.*,u.full_name created_by_name from financial_entries f left join users u on u.user_id=f.created_by where entry_date between $1 and $2 order by entry_date desc,created_at desc limit 1000`,[from,to]);res.json({success:true,entries:r.rows,from,to});});
app.delete('/api/accounting/entries/:id',auth,admin,async(req,res)=>{const r=await pool.query('delete from financial_entries where entry_id=$1 returning entry_id',[req.params.id]);res.json({success:Boolean(r.rowCount)});});
app.post('/api/staff/daily-closing',auth,async(req,res)=>{
  const reportDate=/^\d{4}-\d{2}-\d{2}$/.test(req.body.reportDate||'')?req.body.reportDate:null;
  const income=Number(req.body.incomeAmount||0),expense=Number(req.body.expenseAmount||0);
  const category=['SALARY','RENT','ELECTRICITY','POS_COMMISSION','SUPPLIES','OTHER'].includes(req.body.expenseCategory)?req.body.expenseCategory:'OTHER';
  const description=String(req.body.description||'').trim(),spentBy=String(req.body.spentBy||'').trim();
  if(!reportDate||!Number.isFinite(income)||income<0||!Number.isFinite(expense)||expense<0||(!income&&!expense))return res.status(400).json({success:false,error:'حدد التاريخ وأدخل مبلغ وارد أو مصروف صحيح'});
  if(expense>0&&(!spentBy||!description))return res.status(400).json({success:false,error:'عند تسجيل المصروف يجب ذكر من صرف ونوع/تفاصيل الصرف'});
  const client=await pool.connect();
  try{
    await client.query('begin');
    const entries=[];
    if(income>0){const r=await client.query("insert into financial_entries(entry_date,entry_type,category,description,amount,payment_method,created_by,entry_source) values($1,'INCOME','SALES',$2,$3,'CASH',$4,'DAILY_CLOSING') returning *",[reportDate,description||'جرد الوارد اليومي',income,req.user.userId]);entries.push(r.rows[0]);}
    if(expense>0){const r=await client.query("insert into financial_entries(entry_date,entry_type,category,description,amount,payment_method,created_by,spent_by,entry_source) values($1,'EXPENSE',$2,$3,$4,'CASH',$5,$6,'DAILY_CLOSING') returning *",[reportDate,category,description,expense,req.user.userId,spentBy]);entries.push(r.rows[0]);}
    await client.query('commit');
    res.json({success:true,entries,message:'تم تسجيل الجرد اليومي بنجاح'});
  }catch(e){await client.query('rollback');throw e;}finally{client.release();}
});
app.get('/api/accounting/trends',auth,accounting,async(req,res)=>{
  const {from,to}=dateRange(req),group=['day','week','month','year'].includes(req.query.group)?req.query.group:'day';
  const trunc={day:'day',week:'week',month:'month',year:'year'}[group];
  const r=await pool.query(`select date_trunc('${trunc}',entry_date)::date period,
    coalesce(sum(amount) filter(where entry_type='INCOME'),0) income,
    coalesce(sum(amount) filter(where entry_type='EXPENSE'),0) expenses
    from financial_entries where entry_date between $1 and $2 group by 1 order by 1`,[from,to]);
  res.json({success:true,from,to,group,points:r.rows.map(x=>({period:x.period,income:Number(x.income),expenses:Number(x.expenses),profit:Number(x.income)-Number(x.expenses)}))});
});
app.post('/api/accounting/pos',auth,accounting,async(req,res)=>{
  const card=['GREEN_CARD','BLACK_CARD'].includes(req.body.cardType)?req.body.cardType:null,direction=req.body.direction==='OUT'?'OUT':'IN';
  const transfer=Number(req.body.transferAmount),commission=Number(req.body.commission||0);
  if(!card||!Number.isFinite(transfer)||transfer<0||!Number.isFinite(commission)||commission<0)return res.status(400).json({success:false,error:'بيانات حركة POS غير صحيحة'});
  const r=await pool.query('insert into pos_transactions(transaction_date,card_type,direction,transfer_amount,commission,notes,created_by) values(coalesce($1,current_date),$2,$3,$4,$5,$6,$7) returning *',[req.body.transactionDate||null,card,direction,transfer,commission,String(req.body.notes||'').trim(),req.user.userId]);res.json({success:true,transaction:r.rows[0]});
});
app.get('/api/accounting/pos',auth,accounting,async(req,res)=>{const {from,to}=dateRange(req);const r=await pool.query(`select p.*,u.full_name created_by_name from pos_transactions p left join users u on u.user_id=p.created_by where transaction_date between $1 and $2 order by transaction_date desc,created_at desc limit 1000`,[from,to]);res.json({success:true,transactions:r.rows,from,to});});
app.get('/api/accounting/summary',auth,accounting,async(req,res)=>{
  const {from,to}=dateRange(req);
  const [f,p,partners]=await Promise.all([
    pool.query(`select coalesce(sum(amount) filter(where entry_type='INCOME'),0) income,coalesce(sum(amount) filter(where entry_type='EXPENSE'),0) expenses,
      coalesce(sum(case when payment_method='CASH' then case when entry_type='INCOME' then amount else -amount end else 0 end),0) cash_net,
      coalesce(sum(case when payment_method='GREEN_CARD' then case when entry_type='INCOME' then amount else -amount end else 0 end),0) green_net,
      coalesce(sum(case when payment_method='BLACK_CARD' then case when entry_type='INCOME' then amount else -amount end else 0 end),0) black_net
      from financial_entries where entry_date between $1 and $2`,[from,to]),
    pool.query(`select coalesce(sum(commission),0) commissions,
      coalesce(sum(case when card_type='GREEN_CARD' then case when direction='IN' then transfer_amount else -transfer_amount end else 0 end),0) green_transfers,
      coalesce(sum(case when card_type='BLACK_CARD' then case when direction='IN' then transfer_amount else -transfer_amount end else 0 end),0) black_transfers
      from pos_transactions where transaction_date between $1 and $2`,[from,to]),
    pool.query(`select p.partner_id,p.partner_name,p.share_percent,coalesce(sum(pp.amount),0) amount_paid from partners p left join partner_payments pp using(partner_id) where p.is_active=true group by p.partner_id order by p.partner_id`)
  ]);
  const a=f.rows[0],b=p.rows[0],profit=Number(a.income)-Number(a.expenses)+Number(b.commissions);
  res.json({success:true,from,to,income:Number(a.income),expenses:Number(a.expenses),posCommissions:Number(b.commissions),netProfit:profit,cash:Number(a.cash_net),greenCard:Number(a.green_net)+Number(b.green_transfers),blackCard:Number(a.black_net)+Number(b.black_transfers),partners:partners.rows.map(x=>{const share=profit*Number(x.share_percent)/100,paid=Number(x.amount_paid||0);return {...x,profitShare:share,amountPaid:paid,remaining:share-paid};})});
});
app.get('/api/accounting/partners',auth,accounting,async(_req,res)=>{const r=await pool.query('select * from partners where is_active=true order by partner_id');res.json({success:true,partners:r.rows});});
app.post('/api/accounting/partners',auth,admin,async(req,res)=>{const name=String(req.body.partnerName||'').trim(),share=Number(req.body.sharePercent);if(!name||!Number.isFinite(share)||share<=0||share>100)return res.status(400).json({success:false,error:'اسم الشريك والنسبة الصحيحة مطلوبان'});const total=await pool.query('select coalesce(sum(share_percent),0) total from partners where is_active=true');if(Number(total.rows[0].total)+share>100)return res.status(400).json({success:false,error:'مجموع نسب الشركاء لا يمكن أن يتجاوز 100%'});const r=await pool.query('insert into partners(partner_name,share_percent) values($1,$2) returning *',[name,share]);res.json({success:true,partner:r.rows[0]});});
app.post('/api/accounting/partners/:id/payments',auth,accounting,async(req,res)=>{const amount=Number(req.body.amount),method=['CASH','GREEN_CARD','BLACK_CARD','BANK'].includes(req.body.paymentMethod)?req.body.paymentMethod:'CASH';if(!Number.isFinite(amount)||amount<=0)return res.status(400).json({success:false,error:'أدخل مبلغ تسديد صحيح'});const r=await pool.query('insert into partner_payments(partner_id,payment_date,amount,payment_method,notes,created_by) values($1,coalesce($2,current_date),$3,$4,$5,$6) returning *',[req.params.id,req.body.paymentDate||null,amount,method,String(req.body.notes||'').trim(),req.user.userId]);res.json({success:true,payment:r.rows[0]});});
app.get('/api/accounting/partner-payments',auth,accounting,async(_req,res)=>{const r=await pool.query(`select pp.*,p.partner_name,u.full_name created_by_name from partner_payments pp join partners p using(partner_id) left join users u on u.user_id=pp.created_by order by payment_date desc,pp.created_at desc limit 1000`);res.json({success:true,payments:r.rows});});
app.post('/api/accounting/pos-closing',auth,accounting,async(req,res)=>{const vals=['cashAmount','greenCardAmount','blackCardAmount'].map(k=>Math.max(0,Number(req.body[k]||0)));const r=await pool.query(`insert into pos_daily_closings(closing_date,cash_amount,green_card_amount,black_card_amount,notes,created_by) values(coalesce($1,current_date),$2,$3,$4,$5,$6) on conflict(closing_date) do update set cash_amount=excluded.cash_amount,green_card_amount=excluded.green_card_amount,black_card_amount=excluded.black_card_amount,notes=excluded.notes,created_by=excluded.created_by,updated_at=now() returning *`,[req.body.closingDate||null,...vals,String(req.body.notes||'').trim(),req.user.userId]);res.json({success:true,closing:r.rows[0]});});
app.get('/api/accounting/pos-closing',auth,accounting,async(req,res)=>{const {from,to}=dateRange(req);const r=await pool.query('select * from pos_daily_closings where closing_date between $1 and $2 order by closing_date desc',[from,to]);res.json({success:true,closings:r.rows});});

app.get('/api/notifications/public',async(_req,res)=>{const r=await pool.query("select notification_id,message,audience,created_at from notifications where is_active=true and audience in ('ALL','STUDENTS') and starts_at<=now() and (ends_at is null or ends_at>now()) order by created_at desc limit 10");res.json({success:true,notifications:r.rows});});
app.get('/api/notifications/staff',auth,async(_req,res)=>{const r=await pool.query("select notification_id,message,audience,created_at from notifications where is_active=true and audience in ('ALL','STAFF') and starts_at<=now() and (ends_at is null or ends_at>now()) order by created_at desc limit 20");res.json({success:true,notifications:r.rows});});
app.get('/api/admin/notifications',auth,admin,async(_req,res)=>{const r=await pool.query('select notification_id,message,audience,is_active,created_at from notifications order by created_at desc limit 100');res.json({success:true,notifications:r.rows});});
app.post('/api/admin/notifications',auth,admin,async(req,res)=>{const audience=['ALL','STUDENTS','STAFF'].includes(req.body.audience)?req.body.audience:'ALL',message=String(req.body.message||'').trim();if(!message)return res.status(400).json({success:false,error:'نص الإشعار مطلوب'});const r=await pool.query('insert into notifications(audience,message,ends_at,created_by) values($1,$2,$3,$4) returning *',[audience,message,req.body.endsAt||null,req.user.userId]);res.json({success:true,notification:r.rows[0]});});
app.delete('/api/admin/notifications/:id',auth,admin,async(req,res)=>{await pool.query('update notifications set is_active=false where notification_id=$1',[req.params.id]);res.json({success:true});});
app.get('/api/advertisements',async(req,res)=>{const target=['HOME','STUDENTS'].includes(req.query.target)?req.query.target:'HOME';const r=await pool.query("select advertisement_id,title,image_path,target,starts_at,ends_at from advertisements where is_active=true and target in ('ALL',$1) and starts_at<=now() and (ends_at is null or ends_at>now()) order by created_at desc",[target]);res.json({success:true,advertisements:r.rows});});
app.get('/api/staff/advertisements',auth,async(_req,res)=>{const r=await pool.query('select * from advertisements order by created_at desc limit 200');res.json({success:true,advertisements:r.rows});});
app.post('/api/staff/advertisements',auth,upload.single('image'),async(req,res)=>{if(!req.file||!String(req.file.mimetype).startsWith('image/'))return res.status(400).json({success:false,error:'اختر صورة إعلان'});const stored=await storeFile(req.file,'advertisements');try{const target=['ALL','HOME','STUDENTS'].includes(req.body.target)?req.body.target:'ALL',r=await pool.query('insert into advertisements(title,image_path,storage_path,target,starts_at,ends_at,created_by) values($1,$2,$3,$4,coalesce($5,now()),$6,$7) returning *',[String(req.body.title||req.file.originalname).trim(),stored.url,stored.storagePath,target,req.body.startsAt||null,req.body.endsAt||null,req.user.userId]);res.json({success:true,advertisement:r.rows[0]});}catch(e){await removeStored(stored.storagePath,stored.url);throw e;}});
app.delete('/api/staff/advertisements/:id',auth,async(req,res)=>{const r=await pool.query('update advertisements set is_active=false where advertisement_id=$1 returning advertisement_id',[req.params.id]);res.json({success:Boolean(r.rowCount)});});
app.post('/api/admin/employee-adjustments',auth,admin,async(req,res)=>{const userId=Number(req.body.userId),type=req.body.type==='DEDUCTION'?'DEDUCTION':'BONUS',amount=Number(req.body.amount),reason=String(req.body.reason||'').trim();if(!userId||!Number.isFinite(amount)||amount<=0||!reason)return res.status(400).json({success:false,error:'الموظف والمبلغ والسبب مطلوبة'});const client=await pool.connect();try{await client.query('begin');const r=await client.query('insert into employee_adjustments(user_id,adjustment_type,amount,reason,effective_date,created_by) values($1,$2,$3,$4,coalesce($5,current_date),$6) returning *',[userId,type,amount,reason,req.body.effectiveDate||null,req.user.userId]);await client.query('insert into user_notifications(user_id,title,message,notification_type,reference_type,reference_id) values($1,$2,$3,$4,$5,$6)',[userId,type==='BONUS'?'مكافأة مالية':'خصم مالي',`${reason} — ${amount.toLocaleString('ar-IQ')} د.ع`,type,'ADJUSTMENT',r.rows[0].adjustment_id]);await client.query('commit');res.json({success:true,adjustment:r.rows[0]});}catch(e){await client.query('rollback');throw e;}finally{client.release();}});
app.get('/api/admin/employee-adjustments',auth,admin,async(req,res)=>{const {from,to}=dateRange(req),r=await pool.query('select a.*,u.full_name employee_name,c.full_name created_by_name from employee_adjustments a join users u on u.user_id=a.user_id left join users c on c.user_id=a.created_by where a.effective_date between $1 and $2 order by a.effective_date desc,a.created_at desc',[from,to]);res.json({success:true,adjustments:r.rows});});
app.patch('/api/admin/employee-adjustments/:id/cancel',auth,admin,async(req,res)=>{const r=await pool.query("update employee_adjustments set status='CANCELLED' where adjustment_id=$1 returning adjustment_id",[req.params.id]);res.json({success:Boolean(r.rowCount)});});
app.get('/api/staff/my-finance',auth,async(req,res)=>{const {from,to}=dateRange(req),[p,a,n]=await Promise.all([payrollReport(from,to),pool.query("select * from employee_adjustments where user_id=$1 and effective_date between $2 and $3 order by effective_date desc",[req.user.userId,from,to]),pool.query('select * from user_notifications where user_id=$1 order by created_at desc limit 50',[req.user.userId])]);res.json({success:true,payroll:p.rows.find(x=>Number(x.user_id)===Number(req.user.userId))||null,adjustments:a.rows,notifications:n.rows});});
app.patch('/api/staff/notifications/:id/read',auth,async(req,res)=>{await pool.query('update user_notifications set is_read=true where notification_id=$1 and user_id=$2',[req.params.id,req.user.userId]);res.json({success:true});});
app.post('/api/admin/operational-reset/:kind',auth,admin,async(req,res)=>{const kind=req.params.kind;let result;if(kind==='chats')result=await pool.query('update chat_conversations set archived_at=now(),status=\'CLOSED\' where archived_at is null');else if(kind==='notifications')result=await pool.query('update notifications set is_active=false where is_active=true');else if(kind==='print-files')result=await pool.query("update student_print_files set archived_at=now() where archived_at is null and status in ('COMPLETED','CANCELLED')");else if(kind==='tasks')result=await pool.query("update tasks set archived_at=now(),updated_at=now() where archived_at is null and status in ('COMPLETED','CANCELLED')");else return res.status(400).json({success:false,error:'نوع التصفير غير صحيح'});res.json({success:true,count:result.rowCount,message:'تمت أرشفة البيانات التشغيلية بنجاح، ولم تتأثر الحسابات المالية'});});

app.post('/api/chat/start',async(req,res)=>{const name=String(req.body.studentName||'').trim(),phone=String(req.body.phone||'').trim();if(!name||!phone)return res.status(400).json({success:false,error:'الاسم ورقم الهاتف مطلوبان'});const r=await pool.query('insert into chat_conversations(student_name,phone) values($1,$2) returning conversation_id,public_token',[name,phone]);res.json({success:true,...r.rows[0]});});
app.get('/api/chat/:token/messages',async(req,res)=>{const c=await pool.query('select conversation_id,student_name,phone,status,closed_at from chat_conversations where public_token=$1 and archived_at is null',[req.params.token]);if(!c.rowCount)return res.status(404).json({success:false,error:'المحادثة غير موجودة'});const m=await pool.query("select m.message_id,m.sender_type,coalesce(u.full_name,case when m.sender_type='STUDENT' then 'الطالب' else 'كادر المكتبة' end) sender_name,m.message_text,m.attachment_name,m.attachment_path,m.attachment_type,m.created_at from chat_messages m left join users u on u.user_id=m.sender_user_id where m.conversation_id=$1 order by m.created_at",[c.rows[0].conversation_id]);await pool.query('update chat_conversations set student_last_read_at=now() where conversation_id=$1',[c.rows[0].conversation_id]);res.json({success:true,conversation:c.rows[0],messages:m.rows});});
app.post('/api/chat/:token/messages',upload.single('attachment'),async(req,res)=>{const c=await pool.query("select conversation_id from chat_conversations where public_token=$1 and status<>'CLOSED' and archived_at is null",[req.params.token]);if(!c.rowCount)return res.status(404).json({success:false,error:'المحادثة مغلقة أو غير موجودة'});const text=String(req.body.message||'').trim();if(!text&&!req.file)return res.status(400).json({success:false,error:'اكتب رسالة أو أرفق ملفاً'});const stored=req.file?await storeFile(req.file,'chat-files'):null;const r=await pool.query("insert into chat_messages(conversation_id,sender_type,message_text,attachment_name,attachment_path,attachment_storage_path,attachment_type) values($1,'STUDENT',$2,$3,$4,$5,$6) returning message_id",[c.rows[0].conversation_id,text,req.file?.originalname||null,stored?.url||null,stored?.storagePath||null,req.file?.mimetype||null]);await pool.query("update chat_conversations set status=case when claimed_by is null then 'OPEN' else 'CLAIMED' end,updated_at=now() where conversation_id=$1",[c.rows[0].conversation_id]);res.json({success:true,messageId:r.rows[0].message_id});});
app.get('/api/staff/chats',auth,async(_req,res)=>{const r=await pool.query(`select c.*,owner.full_name claimed_by_name,count(m.message_id) message_count,max(m.created_at) last_message,count(m.message_id) filter(where m.sender_type='STUDENT' and m.created_at>coalesce(c.staff_last_read_at,'epoch')) unread_count from chat_conversations c left join chat_messages m using(conversation_id) left join users owner on owner.user_id=c.claimed_by where c.archived_at is null group by c.conversation_id,owner.full_name order by case c.status when 'OPEN' then 0 when 'CLAIMED' then 1 when 'WAITING_STUDENT' then 2 else 3 end,coalesce(max(m.created_at),c.created_at) desc`);res.json({success:true,conversations:r.rows});});
app.get('/api/staff/chats/:id/messages',auth,async(req,res)=>{const m=await pool.query("select m.message_id,m.sender_type,coalesce(u.full_name,case when m.sender_type='STUDENT' then 'الطالب' else 'كادر المكتبة' end) sender_name,m.message_text,m.attachment_name,m.attachment_path,m.attachment_type,m.created_at from chat_messages m left join users u on u.user_id=m.sender_user_id where m.conversation_id=$1 order by m.created_at",[req.params.id]);await pool.query('update chat_conversations set staff_last_read_at=now() where conversation_id=$1',[req.params.id]);res.json({success:true,messages:m.rows});});
app.patch('/api/staff/chats/:id/claim',auth,async(req,res)=>{const r=await pool.query("update chat_conversations set claimed_by=$1,claimed_at=coalesce(claimed_at,now()),status='CLAIMED',updated_at=now() where conversation_id=$2 and status<>'CLOSED' and (claimed_by is null or claimed_by=$1) returning conversation_id",[req.user.userId,req.params.id]);if(!r.rowCount)return res.status(409).json({success:false,error:'استلم هذه المحادثة موظف آخر'});await pool.query("insert into chat_events(conversation_id,action,performed_by) values($1,'CLAIMED',$2)",[req.params.id,req.user.userId]);res.json({success:true});});
app.post('/api/staff/chats/:id/messages',auth,upload.single('attachment'),async(req,res)=>{const text=String(req.body.message||'').trim();if(!text&&!req.file)return res.status(400).json({success:false,error:'اكتب رسالة أو أرفق ملفاً'});const claim=await pool.query("update chat_conversations set claimed_by=coalesce(claimed_by,$1),claimed_at=coalesce(claimed_at,now()),status='WAITING_STUDENT',updated_at=now() where conversation_id=$2 and status<>'CLOSED' and (claimed_by is null or claimed_by=$1 or $3='ADMIN') returning conversation_id",[req.user.userId,req.params.id,req.user.role]);if(!claim.rowCount)return res.status(409).json({success:false,error:'المحادثة مستلمة من موظف آخر أو مغلقة'});const stored=req.file?await storeFile(req.file,'chat-files'):null;await pool.query("insert into chat_messages(conversation_id,sender_type,sender_user_id,message_text,attachment_name,attachment_path,attachment_storage_path,attachment_type) values($1,'STAFF',$2,$3,$4,$5,$6,$7)",[req.params.id,req.user.userId,text,req.file?.originalname||null,stored?.url||null,stored?.storagePath||null,req.file?.mimetype||null]);res.json({success:true});});
app.post('/api/staff/chats/:id/to-task',auth,async(req,res)=>{const c=await pool.query('select student_name,phone from chat_conversations where conversation_id=$1',[req.params.id]);if(!c.rowCount)return res.status(404).json({success:false,error:'المحادثة غير موجودة'});const m=await pool.query('select message_text,attachment_name,attachment_path,attachment_storage_path from chat_messages where conversation_id=$1 order by (attachment_path is not null) desc,created_at desc limit 1',[req.params.id]);const x=m.rows[0]||{},r=await pool.query(`insert into tasks(task_type,title,description,created_by,customer_name,customer_phone,notes,attachment_name,attachment_path,attachment_storage_path) values('طباعة',$1,$2,$3,$4,$5,$6,$7,$8,$9) returning task_id`,[`طلب من المحادثة - ${c.rows[0].student_name}`,x.message_text||'',req.user.userId,c.rows[0].student_name,c.rows[0].phone,'تم التحويل من محادثة الطالب',x.attachment_name||null,x.attachment_path||null,x.attachment_storage_path||null]);res.json({success:true,taskId:r.rows[0].task_id});});
app.post('/api/staff/chats/:id/to-print',auth,async(req,res)=>{const c=await pool.query('select student_name,phone from chat_conversations where conversation_id=$1',[req.params.id]);if(!c.rowCount)return res.status(404).json({success:false,error:'المحادثة غير موجودة'});const m=await pool.query('select message_text,attachment_name,attachment_path,attachment_storage_path from chat_messages where conversation_id=$1 and attachment_path is not null order by created_at desc limit 1',[req.params.id]);if(!m.rowCount)return res.status(400).json({success:false,error:'لا يوجد ملف مرفق في هذه المحادثة'});const x=m.rows[0],r=await pool.query(`insert into student_print_files(original_name,file_path,storage_path,copies,color_mode,student_name,phone,notes) values($1,$2,$3,1,'BW',$4,$5,$6) returning file_id`,[x.attachment_name||'ملف محادثة',x.attachment_path,x.attachment_storage_path,c.rows[0].student_name,c.rows[0].phone,x.message_text||'تم التحويل من المحادثة']);res.json({success:true,fileId:r.rows[0].file_id});});
app.patch('/api/staff/chats/:id/close',auth,async(req,res)=>{await pool.query("update chat_conversations set status='CLOSED',closed_by=$1,closed_at=now(),updated_at=now() where conversation_id=$2",[req.user.userId,req.params.id]);await pool.query("insert into chat_events(conversation_id,action,performed_by) values($1,'CLOSED',$2)",[req.params.id,req.user.userId]);res.json({success:true});});

app.post('/api/discussions/create',auth,async(req,res)=>{
  const {studentName,gender,degreeType,thesisTitle,discussionDate,locationHall,specialization,supervisorName,scientificAssistantName,deanName,committee=[]}=req.body;
  const required=degreeType==='MASTER'?4:6;
  if(committee.length!==required)return res.status(400).json({success:false,error:`عدد أعضاء اللجنة المطلوب ${required}`});
  const client=await pool.connect();
  try{await client.query('begin'); const d=await client.query('insert into discussions(student_name,gender,degree_type,thesis_title,discussion_date,location_hall,specialization,supervisor_name,scientific_assistant_name,dean_name,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning discussion_id',[studentName,gender==='FEMALE'?'FEMALE':'MALE',degreeType==='MASTER'?'MASTER':'DOCTORATE',thesisTitle,discussionDate,locationHall,specialization||'',supervisorName||'',scientificAssistantName||'',deanName||'',req.user.userId]); for(let i=0;i<committee.length;i++){const m=committee[i];await client.query('insert into discussion_committee(discussion_id,member_name,academic_title,workplace,role_in_committee,member_order) values($1,$2,$3,$4,$5,$6)',[d.rows[0].discussion_id,m.memberName,m.academicTitle||'',m.workplace||'',m.role||'MEMBER',i+1]);} await client.query('commit');res.json({success:true,discussionId:d.rows[0].discussion_id,documentsUrl:`/discussion-documents.html?id=${d.rows[0].discussion_id}`});}catch(e){await client.query('rollback');throw e;}finally{client.release();}
});
app.get('/api/discussions/:id/documents',auth,async(req,res)=>{const [d,c]=await Promise.all([pool.query('select * from discussions where discussion_id=$1',[req.params.id]),pool.query('select * from discussion_committee where discussion_id=$1 order by member_order',[req.params.id])]);if(!d.rowCount)return res.status(404).json({success:false,error:'المناقشة غير موجودة'});res.json({success:true,discussion:d.rows[0],committee:c.rows});});

app.post('/api/attendance/check-in',auth,async(req,res)=>{const r=await pool.query('insert into attendance(user_id) select $1 where not exists(select 1 from attendance where user_id=$1 and check_out is null) returning *',[req.user.userId]);res.json({success:true,data:r.rows[0]||null,message:r.rowCount?'تم تسجيل الدخول':'لديك دوام مفتوح مسبقاً'});});
app.post('/api/attendance/check-out',auth,async(req,res)=>{const r=await pool.query(`with open_shift as (select attendance_id,check_in,now() out_at,date_trunc('day',check_in at time zone 'Asia/Baghdad') local_day from attendance where user_id=$1 and check_out is null order by check_in desc limit 1 for update),calc as (select *,greatest(0,extract(epoch from (least(out_at,(local_day+interval '16 hours') at time zone 'Asia/Baghdad')-greatest(check_in,(local_day+interval '8 hours') at time zone 'Asia/Baghdad')))/3600) regular,extract(epoch from(out_at-check_in))/3600 total from open_shift) update attendance a set check_out=c.out_at,regular_hours=round(c.regular::numeric,2),overtime_hours=round(greatest(0,c.total-c.regular)::numeric,2) from calc c where a.attendance_id=c.attendance_id returning a.*`,[req.user.userId]);res.json({success:Boolean(r.rowCount),data:r.rows[0]||null});});
app.post('/api/attendance/check',auth,async(req,res)=>{if(req.body.type==='خروج'){const r=await pool.query(`with open_shift as (select attendance_id,check_in,now() out_at,date_trunc('day',check_in at time zone 'Asia/Baghdad') local_day from attendance where user_id=$1 and check_out is null order by check_in desc limit 1 for update),calc as (select *,greatest(0,extract(epoch from (least(out_at,(local_day+interval '16 hours') at time zone 'Asia/Baghdad')-greatest(check_in,(local_day+interval '8 hours') at time zone 'Asia/Baghdad')))/3600) regular,extract(epoch from(out_at-check_in))/3600 total from open_shift) update attendance a set check_out=c.out_at,regular_hours=round(c.regular::numeric,2),overtime_hours=round(greatest(0,c.total-c.regular)::numeric,2) from calc c where a.attendance_id=c.attendance_id returning a.*`,[req.user.userId]);return res.json({success:Boolean(r.rowCount),data:r.rows[0]||null});}const r=await pool.query('insert into attendance(user_id) select $1 where not exists(select 1 from attendance where user_id=$1 and check_out is null) returning *',[req.user.userId]);res.json({success:true,data:r.rows[0]||null});});
async function payrollReport(from,to){return pool.query(`with hours as (select user_id,coalesce(sum(regular_hours),0) regular_hours,coalesce(sum(overtime_hours),0) overtime_hours from attendance where check_out is not null and (check_in at time zone 'Asia/Baghdad')::date between $1 and $2 group by user_id),adjustments as (select user_id,coalesce(sum(amount) filter(where adjustment_type='BONUS'),0) bonuses,coalesce(sum(amount) filter(where adjustment_type='DEDUCTION'),0) deductions from employee_adjustments where status='ACTIVE' and effective_date between $1 and $2 group by user_id) select u.user_id,u.full_name,u.username,u.hourly_rate,u.overtime_hourly_rate,coalesce(h.regular_hours,0) regular_hours,coalesce(h.overtime_hours,0) overtime_hours,round((coalesce(h.regular_hours,0)*u.hourly_rate)::numeric,2) regular_pay,round((coalesce(h.overtime_hours,0)*u.overtime_hourly_rate)::numeric,2) overtime_pay,coalesce(x.bonuses,0) bonuses,coalesce(x.deductions,0) deductions,round((coalesce(h.regular_hours,0)*u.hourly_rate+coalesce(h.overtime_hours,0)*u.overtime_hourly_rate+coalesce(x.bonuses,0)-coalesce(x.deductions,0))::numeric,2) total_pay from users u left join hours h using(user_id) left join adjustments x using(user_id) where u.is_active=true and u.role<>'ADMIN' order by u.full_name`,[from,to]);}
app.get('/api/admin/attendance-reports',auth,admin,async(req,res)=>{const {from,to}=dateRange(req),[logs,summary]=await Promise.all([pool.query(`select a.*,u.full_name employee_name from attendance a join users u using(user_id) where (a.check_in at time zone 'Asia/Baghdad')::date between $1 and $2 order by check_in desc limit 1000`,[from,to]),payrollReport(from,to)]);res.json({success:true,from,to,logs:logs.rows,summary:summary.rows});});
app.get('/api/accounting/payroll',auth,accounting,async(req,res)=>{const {from,to}=dateRange(req),r=await payrollReport(from,to);res.json({success:true,from,to,employees:r.rows,total:r.rows.reduce((s,x)=>s+Number(x.total_pay||0),0)});});
app.get('/api/admin/productivity',auth,admin,async(req,res)=>{const {from,to}=dateRange(req),r=await pool.query(`select u.user_id,u.full_name,count(t.task_id) completed_tasks,coalesce(sum(t.amount_total),0) work_value,coalesce(sum(t.amount_paid),0) collected,coalesce(avg(extract(epoch from(t.completed_at-t.claimed_at))/3600) filter(where t.claimed_at is not null),0) avg_completion_hours from users u left join tasks t on t.completed_by=u.user_id and t.status='COMPLETED' and (t.completed_at at time zone 'Asia/Baghdad')::date between $1 and $2 where u.role<>'ADMIN' group by u.user_id order by completed_tasks desc,u.full_name`,[from,to]);res.json({success:true,from,to,employees:r.rows});});

app.get('/api/print-agent/next',printAgentAuth,async(req,res)=>{
  const agentId=String(req.query.agentId||'library-main').slice(0,100),client=await pool.connect();
  try{
    await client.query('begin');
    const r=await client.query(`select f.file_id,f.original_name,f.file_path,f.second_file_path,f.third_file_path,f.print_type,f.copies,f.color_mode,f.paper_size,f.duplex_mode,f.printer_number,f.notes,f.page_count,cover.details cover_details
      from student_print_files f
      left join lateral(select e.details from print_job_events e where e.file_id=f.file_id and e.action in ('MATERIAL_DIRECT_QUEUED','MATERIAL_REQUESTED') order by e.created_at desc limit 1) cover on true
      where f.direct_print_status='QUEUED' and f.status<>'CANCELLED'
      order by f.queued_at nulls last,f.created_at for update of f skip locked limit 1`);
    if(!r.rowCount){await client.query('commit');return res.status(204).end();}
    const job=r.rows[0];
    await client.query("update student_print_files set direct_print_status='CLAIMED',status='PRINTING',claimed_at=now(),agent_id=$1 where file_id=$2",[agentId,job.file_id]);
    await client.query('commit');
    const cover=job.cover_details&&job.cover_details.printCover!==false?{enabled:true,title:job.cover_details.title||job.original_name,doctorName:job.cover_details.doctorName||'',pageCount:job.cover_details.pageCount||job.page_count||null}:null;
    res.json({success:true,job:{id:job.file_id,originalName:job.original_name,url:job.file_path,secondUrl:job.second_file_path,thirdUrl:job.third_file_path,printType:job.print_type,copies:job.copies,colorMode:job.color_mode,paperSize:job.paper_size,duplexMode:job.duplex_mode,printerNumber:job.printer_number,notes:job.notes,cover}});
  }catch(e){await client.query('rollback');throw e;}finally{client.release();}
});
app.post('/api/print-agent/jobs/:id/result',printAgentAuth,async(req,res)=>{
  const ok=Boolean(req.body.success),agentId=String(req.body.agentId||'library-main').slice(0,100),error=String(req.body.error||'').slice(0,1000);
  const r=await pool.query(ok?`with done as (update student_print_files set direct_print_status='COMPLETED',status='COMPLETED',completed_at=now(),print_error=null,agent_id=$1 where file_id=$2 and direct_print_status='CLAIMED' returning *), history as (insert into print_history(file_id,printer_number,color_mode,page_count,copies,total_pages,agent_id) select file_id,printer_number,color_mode,coalesce(page_count,1),copies,coalesce(page_count,1)*copies,$1 from done) insert into print_job_events(file_id,action,details) select file_id,'COMPLETED',jsonb_build_object('agentId',$1) from done returning file_id`:`with failed as (update student_print_files set direct_print_status='FAILED',status='QUEUED',print_error=$1,agent_id=$2 where file_id=$3 and direct_print_status='CLAIMED' returning file_id) insert into print_job_events(file_id,action,details) select file_id,'FAILED',jsonb_build_object('agentId',$2,'error',$1) from failed returning file_id`,ok?[agentId,req.params.id]:[error||'فشلت الطباعة',agentId,req.params.id]);
  res.json({success:Boolean(r.rowCount)});
});
app.get('/api/admin/print-stats',auth,admin,async(req,res)=>{const {from,to}=dateRange(req);const r=await pool.query(`select (printed_at at time zone 'Asia/Baghdad')::date day,sum(total_pages)::bigint total_pages,sum(case when color_mode='COLOR' then total_pages else 0 end)::bigint color_pages,sum(case when color_mode='BW' then total_pages else 0 end)::bigint bw_pages,count(*)::integer jobs from print_history where (printed_at at time zone 'Asia/Baghdad')::date between $1 and $2 group by 1 order by 1`,[from,to]);res.json({success:true,from,to,days:r.rows,totals:r.rows.reduce((a,x)=>({jobs:a.jobs+Number(x.jobs),pages:a.pages+Number(x.total_pages),color:a.color+Number(x.color_pages),bw:a.bw+Number(x.bw_pages)}),{jobs:0,pages:0,color:0,bw:0})})});
app.get('/api/print-agent/health',printAgentAuth,(_req,res)=>res.json({success:true,server:true,time:new Date().toISOString()}));

app.use((err,_req,res,_next)=>{ console.error(err); if(err instanceof multer.MulterError)return res.status(400).json({success:false,error:`حجم الملف يتجاوز ${MAX_UPLOAD_MB}MB`}); if(String(err.message||'').startsWith('نوع الملف غير مدعوم'))return res.status(400).json({success:false,error:err.message}); if(String(err.message||'').startsWith('فشل تخزين الملف'))return res.status(502).json({success:false,error:'تعذر تخزين الملف. تحقق من مساحة Supabase ونوع الملف المسموح'}); res.status(500).json({success:false,error:'حدث خطأ في الخادم',detail:process.env.NODE_ENV==='development'?err.message:undefined}); });
app.listen(PORT,'0.0.0.0',async()=>{
  console.log(`Engineering Library: http://localhost:${PORT}`);
  if (IS_PRODUCTION) console.log('Online production mode enabled');
  if(TELEGRAM_BOT_TOKEN&&APP_BASE_URL){
    try{await telegramApi('setWebhook',{url:`${APP_BASE_URL}/api/telegram/webhook`,secret_token:TELEGRAM_WEBHOOK_SECRET,allowed_updates:['message','callback_query'],drop_pending_updates:false});console.log('Telegram webhook enabled');}
    catch(e){console.error('Telegram webhook setup failed:',e.message);}
  }
});
