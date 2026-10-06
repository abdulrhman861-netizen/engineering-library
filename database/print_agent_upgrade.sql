-- نفذ هذا الملف مرة واحدة في Supabase SQL Editor قبل تشغيل وكيل الطباعة v5.4
alter table if exists student_print_files add column if not exists direct_print_status text not null default 'MANUAL';
alter table if exists student_print_files drop constraint if exists student_print_files_direct_print_status_check;
alter table if exists student_print_files add constraint student_print_files_direct_print_status_check check(direct_print_status in ('MANUAL','QUEUED','CLAIMED','COMPLETED','FAILED','CANCELLED'));
alter table if exists student_print_files add column if not exists printer_number integer;
alter table if exists student_print_files add column if not exists print_error text;
alter table if exists student_print_files add column if not exists agent_id text;
alter table if exists student_print_files add column if not exists queued_at timestamptz;
alter table if exists student_print_files add column if not exists claimed_at timestamptz;
create index if not exists student_print_files_direct_queue_idx on student_print_files(direct_print_status,queued_at,created_at);
