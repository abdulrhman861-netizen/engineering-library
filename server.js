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
function safeName(name) {
  const ext = path.extname(name).toLowerCase();
  return `${Date.now()}-${crypto.randomUUID()}${ext}`;
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
  const stored=await storeFile(req.file,'materials');
  const client=await pool.connect();
  try {await client.query('begin');await client.query('select pg_advisory_xact_lock(hashtext($1))',[`${department}:${stage}`]);const n=await client.query('select coalesce(max(material_number),0)+1 n from study_materials where department_code=$1 and stage_code=$2',[department,stage]);const r=await client.query('insert into study_materials(department_code,stage_code,subject_name,title,doctor_name,file_path,storage_path,uploaded_by,material_number,mime_type,file_size_bytes) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *',[department,stage,title||req.file.originalname,title||req.file.originalname,doctorName||'',stored.url,stored.storagePath,req.user.userId,n.rows[0].n,req.file.mimetype,req.file.size||req.file.buffer?.length||0]);await client.query('commit');res.json({success:true,message:'تم رفع الملزمة بنجاح',material:r.rows[0]}); }
  catch(e){await client.query('rollback');await removeStored(stored.storagePath,stored.url);throw e;}finally{client.release();}
});
app.get('/api/materials/department/:deptId',async(req,res)=>{if(!configured(res))return;const values=[req.params.deptId];let sql='select material_id,material_number,department_code,stage_code,subject_name,title,doctor_name,file_path,mime_type,created_at from study_materials where department_code=$1';if(req.query.stage){values.push(req.query.stage);sql+=` and stage_code=$${values.length}`;}if(req.query.q){values.push(`%${String(req.query.q).trim()}%`);sql+=` and (title ilike $${values.length} or doctor_name ilike $${values.length} or subject_name ilike $${values.length})`;}sql+=req.query.sort==='oldest'?' order by created_at asc':' order by created_at desc';const r=await pool.query(sql,values);res.json(r.rows);});
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
app.get('/api/staff/materials',auth,async(_req,res)=>{const r=await pool.query(`select m.material_id,m.material_number,m.title,m.doctor_name,m.department_code,m.stage_code,m.created_at,m.file_path,m.mime_type,m.file_size_bytes,coalesce(d.name,m.department_code) department_name,coalesce(s.name,m.stage_code) stage_name from study_materials m left join departments d on d.code=m.department_code left join stages s on s.code=m.stage_code order by m.created_at desc`);const used=r.rows.reduce((sum,x)=>sum+Number(x.file_size_bytes||0),0),quota=Math.max(1,Number(process.env.STORAGE_QUOTA_MB||1024))*1024*1024;res.json({success:true,materials:r.rows,storage:{usedBytes:used,quotaBytes:quota,materialCount:r.rowCount}})});
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
  const material=await pool.query('select title,file_path from study_materials where material_id=$1',[materialId]);
  if(!material.rowCount)return res.status(404).json({success:false,error:'الملزمة غير موجودة'});
  const item=material.rows[0];
  const order=await pool.query(
    "insert into student_print_files(original_name,file_path,storage_path,copies,color_mode,student_name,phone,notes) values($1,$2,null,1,'BW','','','طلب طباعة ملزمة من المكتبة الرقمية') returning file_id",
    [item.title,item.file_path]
  );
  res.json({success:true,message:'تم إرسال طلب الطباعة إلى موظفي المكتبة',orderId:order.rows[0].file_id});
});

app.post('/upload-student-file',upload.array('files',20),async(req,res)=>{
  if(!configured(res))return;
  const files=req.files||[];
  if(!files.length)return res.status(400).json({success:false,message:'يرجى اختيار ملف واحد على الأقل'});
  const printType=req.body.printType==='ID_CARD'?'ID_CARD':'DOCUMENT';
  if(printType==='ID_CARD'&&(files.length!==2||files.some(f=>!f.mimetype.startsWith('image/'))))return res.status(400).json({success:false,message:'طباعة الهوية تحتاج صورتين فقط: الوجه والظهر'});
  const common=[Math.max(1,Number(req.body.copies||1)),req.body.colorMode==='COLOR'?'COLOR':'BW',String(req.body.studentName||'').trim(),String(req.body.phone||'').trim(),String(req.body.notes||'').trim()];
  const created=[];
  if(printType==='ID_CARD'){
    const front=await storeFile(files[0],'print-orders');
    const back=await storeFile(files[1],'print-orders');
    try{
      const r=await pool.query("insert into student_print_files(original_name,file_path,storage_path,second_file_path,second_storage_path,print_type,copies,color_mode,student_name,phone,notes) values($1,$2,$3,$4,$5,'ID_CARD',$6,$7,$8,$9,$10) returning file_id",['هوية - الوجه والظهر',front.url,front.storagePath,back.url,back.storagePath,...common]);
      created.push(r.rows[0].file_id);
    }catch(e){await removeStored(front.storagePath,front.url);await removeStored(back.storagePath,back.url);throw e;}
  }else{
    for(const file of files){
      const stored=await storeFile(file,'print-orders');
      try{const r=await pool.query("insert into student_print_files(original_name,file_path,storage_path,print_type,copies,color_mode,student_name,phone,notes) values($1,$2,$3,'DOCUMENT',$4,$5,$6,$7,$8) returning file_id",[file.originalname,stored.url,stored.storagePath,...common]);created.push(r.rows[0].file_id);}
      catch(e){await removeStored(stored.storagePath,stored.url);throw e;}
    }
  }
  res.json({success:true,message:`تم إرسال ${created.length} طلب للطباعة`,orderIds:created});
});
app.get('/api/student-files',auth,async(_req,res)=>{ const r=await pool.query("select file_id as id,original_name as \"originalName\",file_path as url,second_file_path as \"secondUrl\",print_type as \"printType\",copies,color_mode,status,student_name,phone,notes,created_at as time from student_print_files where status<>'CANCELLED' and archived_at is null order by created_at desc limit 200"); res.json(r.rows); });
app.get('/api/student-files/:id',auth,async(req,res)=>{const r=await pool.query('select file_id as id,original_name as "originalName",file_path as url,second_file_path as "secondUrl",print_type as "printType",copies,color_mode,student_name,phone,notes from student_print_files where file_id=$1',[req.params.id]);if(!r.rowCount)return res.status(404).json({success:false,error:'الطلب غير موجود'});res.json(r.rows[0]);});
app.patch('/api/student-files/:id/status',auth,async(req,res)=>{ const status=['QUEUED','PRINTING','COMPLETED','CANCELLED'].includes(req.body.status)?req.body.status:'QUEUED'; await pool.query("update student_print_files set status=$1,completed_by=case when $1='COMPLETED' then $2 else completed_by end,completed_at=case when $1='COMPLETED' then now() else completed_at end where file_id=$3",[status,req.user.userId,req.params.id]); res.json({success:true}); });
app.delete('/api/student-files/:id',auth,async(req,res)=>{ const r=await pool.query('delete from student_print_files where file_id=$1 returning storage_path,file_path,second_storage_path,second_file_path',[req.params.id]); if(r.rowCount){await removeStored(r.rows[0].storage_path,r.rows[0].file_path);await removeStored(r.rows[0].second_storage_path,r.rows[0].second_file_path);} res.json({success:true}); });
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
  try{const r=await pool.query('insert into study_materials(department_code,stage_code,subject_name,title,doctor_name,file_path,storage_path,uploaded_by) values($1,$2,$3,$4,$5,$6,$7,$8) returning material_id',[department,stage,title,title,doctorName||'',stored.url,stored.storagePath,req.user.userId]);res.json({success:true,message:'تمت إضافة الملف إلى الملازم',materialId:r.rows[0].material_id});}
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
    (t.assigned_to=$1) is_mine
    from tasks t left join users creator on creator.user_id=t.created_by left join users assignee on assignee.user_id=t.assigned_to
    where t.status in ('PENDING','IN_PROGRESS') and t.archived_at is null
    order by case when t.status='IN_PROGRESS' and t.assigned_to=$1 then 0 when t.status='PENDING' then 1 else 2 end,
             t.created_at asc`,[req.user.userId]);
  res.json({success:true,tasks:r.rows,userId:req.user.userId});
});
app.post('/api/work-tasks/batch',auth,upload.single('attachment'),async(req,res)=>{
  const customerName=String(req.body.customerName||'').trim(),customerPhone=String(req.body.customerPhone||'').trim();
  const rawTypes=req.body.types??req.body['types[]'];
  const types=(Array.isArray(rawTypes)?rawTypes:[rawTypes]).filter(Boolean).map(x=>String(x).trim()).slice(0,12);
  const allowed=['طباعة','تنضيد','استنساخ','تجليد','توزيع','تصميم','أخرى'];
  if(!customerName||!customerPhone||!types.length)return res.status(400).json({success:false,error:'اسم الطالب ورقم الهاتف ونوع مهمة واحد على الأقل مطلوبة'});
  if(types.some(x=>!allowed.includes(x)))return res.status(400).json({success:false,error:'نوع مهمة غير صحيح'});
  const total=Math.max(0,Number(req.body.amountTotal||0)),paid=Math.max(0,Number(req.body.amountPaid||0));
  if(paid>total)return res.status(400).json({success:false,error:'المبلغ المدفوع لا يمكن أن يتجاوز المبلغ الكلي'});
  const perTotal=total/types.length,perPaid=paid/types.length,created=[];
  const attachment=req.file?await storeFile(req.file,'task-attachments'):null;
  const client=await pool.connect();
  try{await client.query('begin');for(const type of types){const r=await client.query(`insert into tasks(task_type,title,description,created_by,customer_name,customer_phone,notes,amount_total,amount_paid,expected_completion_at,attachment_name,attachment_path,attachment_storage_path)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning task_id`,[type,`${type} - ${customerName}`,String(req.body.description||'').trim(),req.user.userId,customerName,customerPhone,String(req.body.notes||'').trim(),perTotal,perPaid,req.body.dueAt||null,req.file?.originalname||null,attachment?.url||null,attachment?.storagePath||null]);created.push(r.rows[0].task_id);}await client.query('commit');res.json({success:true,taskIds:created,message:`تمت إضافة ${created.length} مهام منفصلة`});}
  catch(e){await client.query('rollback');if(attachment)await removeStored(attachment.storagePath,attachment.url);throw e;}finally{client.release();}
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
app.post('/api/work-tasks/:id/to-print',auth,async(req,res)=>{const t=await pool.query('select * from tasks where task_id=$1',[req.params.id]);if(!t.rowCount)return res.status(404).json({success:false,error:'المهمة غير موجودة'});const x=t.rows[0];if(!x.attachment_path)return res.status(400).json({success:false,error:'لا يوجد ملف مرفق بهذه المهمة'});try{const r=await pool.query(`insert into student_print_files(original_name,file_path,storage_path,copies,color_mode,student_name,phone,notes,source_task_id,queued_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning file_id`,[x.attachment_name||x.title,x.attachment_path,x.attachment_storage_path,Math.max(1,Number(req.body.copies||1)),req.body.colorMode==='COLOR'?'COLOR':'BW',x.customer_name||'',x.customer_phone||'',`تحويل من المهمة رقم ${x.task_id}`,x.task_id,req.user.userId]);res.json({success:true,fileId:r.rows[0].file_id,message:'تم تحويل الملف إلى طابور الطباعة'});}catch(e){if(e.code==='23505')return res.status(409).json({success:false,error:'تم تحويل هذه المهمة إلى الطباعة مسبقاً'});throw e;}});
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
app.get('/api/chat/:token/messages',async(req,res)=>{const c=await pool.query('select conversation_id,student_name,phone,status,closed_at from chat_conversations where public_token=$1 and archived_at is null',[req.params.token]);if(!c.rowCount)return res.status(404).json({success:false,error:'المحادثة غير موجودة'});const m=await pool.query("select m.message_id,m.sender_type,coalesce(u.full_name,case when m.sender_type='STUDENT' then 'الطالب' else 'كادر المكتبة' end) sender_name,m.message_text,m.attachment_name,m.attachment_path,m.attachment_type,m.created_at from chat_messages m left join users u on u.user_id=m.sender_user_id where m.conversation_id=$1 order by m.created_at",[c.rows[0].conversation_id]);res.json({success:true,conversation:c.rows[0],messages:m.rows});});
app.post('/api/chat/:token/messages',upload.single('attachment'),async(req,res)=>{const c=await pool.query("select conversation_id from chat_conversations where public_token=$1 and status='OPEN' and archived_at is null",[req.params.token]);if(!c.rowCount)return res.status(404).json({success:false,error:'المحادثة مغلقة أو غير موجودة'});const text=String(req.body.message||'').trim();if(!text&&!req.file)return res.status(400).json({success:false,error:'اكتب رسالة أو أرفق ملفاً'});const stored=req.file?await storeFile(req.file,'chat-files'):null;const r=await pool.query("insert into chat_messages(conversation_id,sender_type,message_text,attachment_name,attachment_path,attachment_storage_path,attachment_type) values($1,'STUDENT',$2,$3,$4,$5,$6) returning message_id",[c.rows[0].conversation_id,text,req.file?.originalname||null,stored?.url||null,stored?.storagePath||null,req.file?.mimetype||null]);await pool.query('update chat_conversations set updated_at=now() where conversation_id=$1',[c.rows[0].conversation_id]);res.json({success:true,messageId:r.rows[0].message_id});});
app.get('/api/staff/chats',auth,async(_req,res)=>{const r=await pool.query(`select c.*,count(m.message_id) message_count,max(m.created_at) last_message from chat_conversations c left join chat_messages m using(conversation_id) where c.archived_at is null group by c.conversation_id order by c.status,coalesce(max(m.created_at),c.created_at) desc`);res.json({success:true,conversations:r.rows});});
app.get('/api/staff/chats/:id/messages',auth,async(req,res)=>{const m=await pool.query("select m.message_id,m.sender_type,coalesce(u.full_name,case when m.sender_type='STUDENT' then 'الطالب' else 'كادر المكتبة' end) sender_name,m.message_text,m.attachment_name,m.attachment_path,m.attachment_type,m.created_at from chat_messages m left join users u on u.user_id=m.sender_user_id where m.conversation_id=$1 order by m.created_at",[req.params.id]);res.json({success:true,messages:m.rows});});
app.post('/api/staff/chats/:id/messages',auth,upload.single('attachment'),async(req,res)=>{const text=String(req.body.message||'').trim();if(!text&&!req.file)return res.status(400).json({success:false,error:'اكتب رسالة أو أرفق ملفاً'});const stored=req.file?await storeFile(req.file,'chat-files'):null;await pool.query("insert into chat_messages(conversation_id,sender_type,sender_user_id,message_text,attachment_name,attachment_path,attachment_storage_path,attachment_type) values($1,'STAFF',$2,$3,$4,$5,$6,$7)",[req.params.id,req.user.userId,text,req.file?.originalname||null,stored?.url||null,stored?.storagePath||null,req.file?.mimetype||null]);await pool.query('update chat_conversations set updated_at=now() where conversation_id=$1',[req.params.id]);res.json({success:true});});
app.post('/api/staff/chats/:id/to-task',auth,async(req,res)=>{const c=await pool.query('select student_name,phone from chat_conversations where conversation_id=$1',[req.params.id]);if(!c.rowCount)return res.status(404).json({success:false,error:'المحادثة غير موجودة'});const m=await pool.query('select message_text,attachment_name,attachment_path,attachment_storage_path from chat_messages where conversation_id=$1 order by (attachment_path is not null) desc,created_at desc limit 1',[req.params.id]);const x=m.rows[0]||{},r=await pool.query(`insert into tasks(task_type,title,description,created_by,customer_name,customer_phone,notes,attachment_name,attachment_path,attachment_storage_path) values('طباعة',$1,$2,$3,$4,$5,$6,$7,$8,$9) returning task_id`,[`طلب من المحادثة - ${c.rows[0].student_name}`,x.message_text||'',req.user.userId,c.rows[0].student_name,c.rows[0].phone,'تم التحويل من محادثة الطالب',x.attachment_name||null,x.attachment_path||null,x.attachment_storage_path||null]);res.json({success:true,taskId:r.rows[0].task_id});});
app.post('/api/staff/chats/:id/to-print',auth,async(req,res)=>{const c=await pool.query('select student_name,phone from chat_conversations where conversation_id=$1',[req.params.id]);if(!c.rowCount)return res.status(404).json({success:false,error:'المحادثة غير موجودة'});const m=await pool.query('select message_text,attachment_name,attachment_path,attachment_storage_path from chat_messages where conversation_id=$1 and attachment_path is not null order by created_at desc limit 1',[req.params.id]);if(!m.rowCount)return res.status(400).json({success:false,error:'لا يوجد ملف مرفق في هذه المحادثة'});const x=m.rows[0],r=await pool.query(`insert into student_print_files(original_name,file_path,storage_path,copies,color_mode,student_name,phone,notes) values($1,$2,$3,1,'BW',$4,$5,$6) returning file_id`,[x.attachment_name||'ملف محادثة',x.attachment_path,x.attachment_storage_path,c.rows[0].student_name,c.rows[0].phone,x.message_text||'تم التحويل من المحادثة']);res.json({success:true,fileId:r.rows[0].file_id});});
app.patch('/api/staff/chats/:id/close',auth,async(req,res)=>{await pool.query("update chat_conversations set status='CLOSED',closed_by=$1,closed_at=now(),updated_at=now() where conversation_id=$2",[req.user.userId,req.params.id]);res.json({success:true});});

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

app.use((err,_req,res,_next)=>{ console.error(err); if(err instanceof multer.MulterError)return res.status(400).json({success:false,error:`حجم الملف يتجاوز ${MAX_UPLOAD_MB}MB`}); if(String(err.message||'').startsWith('نوع الملف غير مدعوم'))return res.status(400).json({success:false,error:err.message}); if(String(err.message||'').startsWith('فشل تخزين الملف'))return res.status(502).json({success:false,error:'تعذر تخزين الملف. تحقق من مساحة Supabase ونوع الملف المسموح'}); res.status(500).json({success:false,error:'حدث خطأ في الخادم',detail:process.env.NODE_ENV==='development'?err.message:undefined}); });
app.listen(PORT,'0.0.0.0',()=>{
  console.log(`Engineering Library: http://localhost:${PORT}`);
  if (IS_PRODUCTION) console.log('Online production mode enabled');
});
