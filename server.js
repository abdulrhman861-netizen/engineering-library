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
    const allowedMime = ['application/pdf','image/jpeg','image/png','image/webp','image/heic','image/heif','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
    const allowedExt = ['.pdf','.jpg','.jpeg','.png','.webp','.heic','.heif','.doc','.docx'];
    const ok = allowedMime.includes(String(file.mimetype||'').toLowerCase()) || allowedExt.includes(path.extname(file.originalname||'').toLowerCase());
    cb(ok ? null : new Error('نوع الملف غير مدعوم. استخدم PDF أو Word أو صورة'), ok);
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
function auth(req,res,next) {
  try {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i,'');
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch { res.status(401).json({ success:false, error:'يجب تسجيل الدخول' }); }
}
function admin(req,res,next) {
  if (req.user?.role !== 'ADMIN') return res.status(403).json({ success:false,error:'هذه العملية للمدير فقط' });
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
  const user=result.rows[0]; res.json({success:true,token:sign(user),name:user.full_name,role:user.role,userId:user.user_id});
});

app.post('/api/admin/create-employee', auth, admin, async (req,res) => {
  const { phone,password,fullName,role='STAFF' }=req.body;
  if (!phone || !password || !fullName) return res.status(400).json({success:false,error:'جميع الحقول مطلوبة'});
  const hash=await bcrypt.hash(password,10);
  try { const r=await pool.query('insert into users(full_name,username,password_hash,role) values($1,$2,$3,$4) returning user_id,full_name,username,role',[fullName,phone,hash,['STAFF','TYPIST','ADMIN'].includes(role)?role:'STAFF']); res.json({success:true,user:r.rows[0]}); }
  catch(e){ res.status(400).json({success:false,error:e.code==='23505'?'اسم المستخدم موجود مسبقاً':e.message}); }
});
app.post('/api/admin/set-location',auth,admin,async(req,res)=>{ await pool.query("insert into settings(setting_key,setting_value) values('library_location',$1::jsonb) on conflict(setting_key) do update set setting_value=excluded.setting_value,updated_at=now()",[JSON.stringify({lat:req.body.lat,lng:req.body.lng,radiusMeters:req.body.radiusMeters||50})]);res.json({success:true}); });
app.post('/api/admin/upload-template',auth,admin,upload.fields([{name:'univLogo',maxCount:1},{name:'collegeLogo',maxCount:1},{name:'background',maxCount:1}]),async(req,res)=>{ const out={}; for(const [field,items] of Object.entries(req.files||{})){out[field]=await storeFile(items[0],'templates');} res.json({success:true,univUrl:out.univLogo?.url,collegeUrl:out.collegeLogo?.url,backgroundUrl:out.background?.url}); });

app.get('/api/departments', async (_req,res) => { if(!configured(res))return; const r=await pool.query('select * from departments where is_active=true order by sort_order,name'); res.json(r.rows); });
app.post('/api/admin/departments',auth,admin,async(req,res)=>{ const {code,name,icon,sortOrder}=req.body; const r=await pool.query('insert into departments(code,name,icon,sort_order) values($1,$2,$3,$4) returning *',[code,name,icon||'fa-graduation-cap',Number(sortOrder||0)]); res.json({success:true,department:r.rows[0]}); });
app.get('/api/stages',async(_req,res)=>{ if(!configured(res))return; const r=await pool.query('select * from stages where is_active=true order by sort_order'); res.json(r.rows); });
app.post('/api/admin/stages',auth,admin,async(req,res)=>{ const {code,name,sortOrder}=req.body; const r=await pool.query('insert into stages(code,name,sort_order) values($1,$2,$3) returning *',[code,name,Number(sortOrder||0)]); res.json({success:true,stage:r.rows[0]}); });

app.post('/api/materials/upload',auth,upload.single('file'),async(req,res)=>{
  if(!req.file)return res.status(400).json({success:false,message:'يرجى اختيار ملف PDF'});
  if(req.file.mimetype!=='application/pdf')return res.status(400).json({success:false,message:'الملازم يجب أن تكون PDF'});
  const {title,doctorName,department,stage}=req.body;
  const stored=await storeFile(req.file,'materials');
  try { const r=await pool.query('insert into study_materials(department_code,stage_code,subject_name,title,doctor_name,file_path,storage_path,uploaded_by) values($1,$2,$3,$4,$5,$6,$7,$8) returning *',[department,stage,title||req.file.originalname,title||req.file.originalname,doctorName||'',stored.url,stored.storagePath,req.user.userId]); res.json({success:true,message:'تم رفع الملزمة بنجاح',material:r.rows[0]}); }
  catch(e){ await removeStored(stored.storagePath,stored.url); throw e; }
});
app.get('/api/materials/department/:deptId',async(req,res)=>{ if(!configured(res))return; const values=[req.params.deptId]; let sql='select material_id,department_code,stage_code,subject_name,title,doctor_name,created_at from study_materials where department_code=$1'; if(req.query.stage){values.push(req.query.stage);sql+=' and stage_code=$2';} sql+=' order by created_at desc'; const r=await pool.query(sql,values); res.json(r.rows); });
app.get('/api/admin/materials',auth,admin,async(req,res)=>{
  if(!configured(res))return;
  const r=await pool.query(`
    select m.material_id,m.title,m.doctor_name,m.department_code,m.stage_code,m.created_at,
           coalesce(d.name,m.department_code) department_name,
           coalesce(s.name,m.stage_code) stage_name
    from study_materials m
    left join departments d on d.code=m.department_code
    left join stages s on s.code=m.stage_code
    order by m.created_at desc
  `);
  res.json({success:true,materials:r.rows});
});
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
app.get('/api/student-files',auth,async(_req,res)=>{ const r=await pool.query("select file_id as id,original_name as \"originalName\",file_path as url,second_file_path as \"secondUrl\",print_type as \"printType\",copies,color_mode,status,student_name,phone,notes,created_at as time from student_print_files where status<>'CANCELLED' order by created_at desc limit 200"); res.json(r.rows); });
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

app.get('/api/tasks',auth,async(_req,res)=>{ const r=await pool.query("select t.*,coalesce(u.full_name,'كادر المكتبة') assigned_to_name,cu.full_name completed_by_name from tasks t left join users u on u.user_id=t.assigned_to left join users cu on cu.user_id=t.completed_by order by t.created_at desc"); res.json(r.rows); });
app.post('/api/tasks/create',auth,admin,async(req,res)=>{ const {taskType,title,description,assignedTo,expectedCompletionAt}=req.body; let userId=null; if(assignedTo){const u=await pool.query('select user_id from users where username=$1 or full_name=$1 limit 1',[assignedTo]);userId=u.rows[0]?.user_id||null;} const r=await pool.query('insert into tasks(task_type,title,description,assigned_to,expected_completion_at) values($1,$2,$3,$4,$5) returning *',[taskType||'عام',title,description||'',userId,expectedCompletionAt||null]); res.json({success:true,task:r.rows[0]}); });
app.post('/api/tasks/complete',auth,async(req,res)=>{ await pool.query("update tasks set status='COMPLETED',completed_by=$1,completed_at=now() where task_id=$2",[req.user.userId,req.body.taskId]); res.json({success:true}); });

// نظام المهام التشغيلي: الإنشاء للجميع، الاستلام لموظف واحد، والإنجاز لمن استلم فقط.
app.get('/api/work-tasks',auth,async(req,res)=>{
  const r=await pool.query(`select t.*,creator.full_name created_by_name,assignee.full_name assigned_to_name,
    extract(epoch from(now()-t.created_at))/3600 age_hours,
    greatest(0,coalesce(t.amount_total,0)-coalesce(t.amount_paid,0)) balance,
    (t.assigned_to=$1) is_mine
    from tasks t left join users creator on creator.user_id=t.created_by left join users assignee on assignee.user_id=t.assigned_to
    where t.status in ('PENDING','IN_PROGRESS')
    order by case when t.status='IN_PROGRESS' and t.assigned_to=$1 then 0 when t.status='PENDING' then 1 else 2 end,
             t.created_at asc`,[req.user.userId]);
  res.json({success:true,tasks:r.rows,userId:req.user.userId});
});
app.post('/api/work-tasks/batch',auth,async(req,res)=>{
  const customerName=String(req.body.customerName||'').trim(),customerPhone=String(req.body.customerPhone||'').trim();
  const types=Array.isArray(req.body.types)?req.body.types.map(x=>String(x).trim()).filter(Boolean).slice(0,12):[];
  const allowed=['طباعة','تنضيد','استنساخ','تجليد','توزيع','تصميم','أخرى'];
  if(!customerName||!customerPhone||!types.length)return res.status(400).json({success:false,error:'اسم الطالب ورقم الهاتف ونوع مهمة واحد على الأقل مطلوبة'});
  if(types.some(x=>!allowed.includes(x)))return res.status(400).json({success:false,error:'نوع مهمة غير صحيح'});
  const total=Math.max(0,Number(req.body.amountTotal||0)),paid=Math.max(0,Number(req.body.amountPaid||0));
  if(paid>total)return res.status(400).json({success:false,error:'المبلغ المدفوع لا يمكن أن يتجاوز المبلغ الكلي'});
  const perTotal=total/types.length,perPaid=paid/types.length,created=[];
  const client=await pool.connect();
  try{await client.query('begin');for(const type of types){const r=await client.query(`insert into tasks(task_type,title,description,created_by,customer_name,customer_phone,notes,amount_total,amount_paid,expected_completion_at)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning task_id`,[type,`${type} - ${customerName}`,String(req.body.description||'').trim(),req.user.userId,customerName,customerPhone,String(req.body.notes||'').trim(),perTotal,perPaid,req.body.dueAt||null]);created.push(r.rows[0].task_id);}await client.query('commit');res.json({success:true,taskIds:created,message:`تمت إضافة ${created.length} مهام منفصلة`});}
  catch(e){await client.query('rollback');throw e;}finally{client.release();}
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
app.get('/api/admin/work-tasks',auth,admin,async(req,res)=>{
  const limit=Math.min(1000,Math.max(1,Number(req.query.limit||500)));
  const r=await pool.query(`select t.*,creator.full_name created_by_name,assignee.full_name assigned_to_name,finisher.full_name completed_by_name,
    greatest(0,coalesce(t.amount_total,0)-coalesce(t.amount_paid,0)) balance
    from tasks t left join users creator on creator.user_id=t.created_by left join users assignee on assignee.user_id=t.assigned_to left join users finisher on finisher.user_id=t.completed_by
    order by case when t.status='PENDING' then 0 when t.status='IN_PROGRESS' then 1 else 2 end,t.created_at desc limit $1`,[limit]);res.json({success:true,tasks:r.rows});
});
app.get('/api/admin/debts',auth,admin,async(_req,res)=>{
  const r=await pool.query(`select coalesce(customer_name,'غير محدد') customer_name,coalesce(customer_phone,'-') customer_phone,
    sum(greatest(0,coalesce(amount_total,0)-coalesce(amount_paid,0))) balance,count(*) task_count,max(created_at) last_task
    from tasks where coalesce(amount_total,0)>coalesce(amount_paid,0) and status<>'CANCELLED'
    group by customer_name,customer_phone order by balance desc,last_task desc`);res.json({success:true,debts:r.rows});
});

app.post('/api/discussions/create',auth,async(req,res)=>{
  const {studentName,gender,degreeType,thesisTitle,discussionDate,locationHall,committee=[]}=req.body;
  const required=degreeType==='MASTER'?4:6;
  if(committee.length!==required)return res.status(400).json({success:false,error:`عدد أعضاء اللجنة المطلوب ${required}`});
  const client=await pool.connect();
  try{await client.query('begin'); const d=await client.query('insert into discussions(student_name,gender,degree_type,thesis_title,discussion_date,location_hall,created_by) values($1,$2,$3,$4,$5,$6,$7) returning discussion_id',[studentName,gender==='FEMALE'?'FEMALE':'MALE',degreeType==='MASTER'?'MASTER':'DOCTORATE',thesisTitle,discussionDate,locationHall,req.user.userId]); for(let i=0;i<committee.length;i++){const m=committee[i];await client.query('insert into discussion_committee(discussion_id,member_name,academic_title,workplace,role_in_committee,member_order) values($1,$2,$3,$4,$5,$6)',[d.rows[0].discussion_id,m.memberName,m.academicTitle||'',m.workplace||'',m.role||'MEMBER',i+1]);} await client.query('commit');res.json({success:true,discussionId:d.rows[0].discussion_id});}catch(e){await client.query('rollback');throw e;}finally{client.release();}
});

app.post('/api/attendance/check-in',auth,async(req,res)=>{ const r=await pool.query('insert into attendance(user_id) values($1) returning *',[req.user.userId]);res.json({success:true,data:r.rows[0]}); });
app.post('/api/attendance/check-out',auth,async(req,res)=>{ const r=await pool.query("update attendance set check_out=now(),regular_hours=least(8,extract(epoch from(now()-check_in))/3600),overtime_hours=greatest(0,extract(epoch from(now()-check_in))/3600-8) where attendance_id=$1 and user_id=$2 and check_out is null returning *",[req.body.attendanceId,req.user.userId]);res.json({success:Boolean(r.rowCount),data:r.rows[0]}); });
app.post('/api/attendance/check',auth,async(req,res)=>{ if(req.body.type==='خروج'){const r=await pool.query("update attendance set check_out=now(),regular_hours=least(8,extract(epoch from(now()-check_in))/3600),overtime_hours=greatest(0,extract(epoch from(now()-check_in))/3600-8) where attendance_id=(select attendance_id from attendance where user_id=$1 and check_out is null order by check_in desc limit 1) returning *",[req.user.userId]);return res.json({success:Boolean(r.rowCount),hours:r.rows[0]?.regular_hours});} const r=await pool.query('insert into attendance(user_id) values($1) returning *',[req.user.userId]);res.json({success:true,data:r.rows[0]}); });
app.get('/api/admin/attendance-reports',auth,admin,async(_req,res)=>{const r=await pool.query('select a.*,u.full_name employee_name from attendance a join users u using(user_id) order by check_in desc limit 500');res.json({success:true,logs:r.rows});});

app.use((err,_req,res,_next)=>{ console.error(err); if(err instanceof multer.MulterError)return res.status(400).json({success:false,error:`حجم الملف يتجاوز ${MAX_UPLOAD_MB}MB`}); if(String(err.message||'').startsWith('نوع الملف غير مدعوم'))return res.status(400).json({success:false,error:err.message}); if(String(err.message||'').startsWith('فشل تخزين الملف'))return res.status(502).json({success:false,error:'تعذر تخزين الملف. تحقق من مساحة Supabase ونوع الملف المسموح'}); res.status(500).json({success:false,error:'حدث خطأ في الخادم',detail:process.env.NODE_ENV==='development'?err.message:undefined}); });
app.listen(PORT,'0.0.0.0',()=>{
  console.log(`Engineering Library: http://localhost:${PORT}`);
  if (IS_PRODUCTION) console.log('Online production mode enabled');
});
