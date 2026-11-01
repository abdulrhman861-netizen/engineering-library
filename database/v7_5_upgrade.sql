-- تحديث V7.5: مجموعات Telegram، رفع iPhone، جرد الطباعة، والأوامر العالقة.
-- آمن للتنفيذ أكثر من مرة في Supabase SQL Editor.

alter table if exists student_print_files add column if not exists batch_id uuid;
alter table if exists student_print_files add column if not exists batch_position integer;
alter table if exists student_print_files add column if not exists batch_size integer;
create index if not exists student_print_files_batch_idx
  on student_print_files(batch_id,batch_position) where batch_id is not null;

alter table if exists print_history add column if not exists expected_pages integer not null default 0;
alter table if exists print_history add column if not exists actual_pages integer not null default 0;
alter table if exists print_history add column if not exists estimated_sheets integer not null default 0;
alter table if exists print_history add column if not exists cover_pages integer not null default 0;
alter table if exists print_history add column if not exists audit_method text not null default 'LEGACY_ESTIMATE';
create index if not exists print_history_printer_day_idx on print_history(printer_number,printed_at);

update print_history
set expected_pages=case when expected_pages=0 then total_pages else expected_pages end,
    actual_pages=case when actual_pages=0 then total_pages else actual_pages end,
    estimated_sheets=case when estimated_sheets=0 then total_pages else estimated_sheets end
where total_pages>0 and (expected_pages=0 or actual_pages=0 or estimated_sheets=0);

-- حرر فقط المطالبات القديمة جداً التي بقيت من توقف وكيل الطباعة.
update student_print_files
set direct_print_status='FAILED',status='QUEUED',claimed_at=null,agent_id=null,
    print_error='تم تحرير أمر طباعة قديم أثناء تحديث V7.5 — يمكن إعادة الإرسال'
where direct_print_status='CLAIMED' and claimed_at<now()-interval '10 minutes';

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('library-files','library-files',true,52428800,array[
  'application/pdf','image/jpeg','image/png','image/webp','image/heic','image/heif',
  'application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/octet-stream','audio/webm','audio/mp4','audio/mpeg','audio/ogg','audio/wav'
])
on conflict(id) do update set file_size_limit=excluded.file_size_limit,
  allowed_mime_types=excluded.allowed_mime_types;
