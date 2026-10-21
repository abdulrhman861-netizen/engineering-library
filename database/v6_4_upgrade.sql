-- مكتبة كلية الهندسة الرقمية V6.4
-- نفّذ هذا الملف مرة واحدة في Supabase > SQL Editor

-- إضافة دور التدريسي وربط حسابه بقسمه.
alter table users drop constraint if exists users_role_check;
alter table users add constraint users_role_check
  check (role in ('ADMIN','ACCOUNTANT','STAFF','TYPIST','TEACHER'));
alter table users add column if not exists department_code text references departments(code) on update cascade on delete set null;
create index if not exists users_role_department_idx on users(role,department_code) where is_active=true;

-- صورة مستقلة لكل قسم (يمكن للمدير تغييرها لاحقاً).
alter table departments add column if not exists image_url text;

-- تمييز محادثات التدريسيين مع كادر المكتبة مع إبقاء محادثات الطلاب كما هي.
alter table chat_conversations add column if not exists participant_type text not null default 'STUDENT';
alter table chat_conversations add column if not exists participant_user_id bigint references users(user_id) on delete set null;
create index if not exists chat_participant_idx on chat_conversations(participant_type,participant_user_id,created_at desc);

-- تسجيل الطابعة الملونة الجديدة رقم 10 ضمن إعدادات النظام.
insert into settings(setting_key,setting_value) values
('printer_10','{"number":10,"name":"HP PageWide Color Flow E58650","windowsName":"HP PageWide Color Flow E58650 [83371B]","colorMode":"COLOR","technology":"LIQUID_INK","autoPriority":3,"enabled":true}'::jsonb)
on conflict(setting_key) do update set setting_value=excluded.setting_value,updated_at=now();

