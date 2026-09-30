-- ترقية آمنة للنسخة السحابية: لا تحذف أي بيانات موجودة
alter table if exists student_print_files add column if not exists student_name text;
alter table if exists student_print_files add column if not exists phone text;
alter table if exists student_print_files add column if not exists notes text;
alter table if exists student_print_files add column if not exists second_file_path text;
alter table if exists student_print_files add column if not exists second_storage_path text;
alter table if exists student_print_files add column if not exists print_type text not null default 'DOCUMENT';

update storage.buckets
set public = true,
    file_size_limit = 52428800,
    allowed_mime_types = array[
      'application/pdf','image/jpeg','image/png','image/webp','image/heic','image/heif',
      'application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ]
where id = 'library-files';

-- نظام المهام والديون v4.3 (ترقية آمنة دون حذف المهام القديمة)
alter table if exists tasks add column if not exists created_by bigint references users(user_id) on delete set null;
alter table if exists tasks add column if not exists customer_name text;
alter table if exists tasks add column if not exists customer_phone text;
alter table if exists tasks add column if not exists notes text;
alter table if exists tasks add column if not exists amount_total numeric(14,2) not null default 0;
alter table if exists tasks add column if not exists amount_paid numeric(14,2) not null default 0;
alter table if exists tasks add column if not exists updated_at timestamptz not null default now();
alter table if exists tasks add column if not exists claimed_at timestamptz;
create index if not exists tasks_status_created_idx on tasks(status,created_at);
create index if not exists tasks_customer_phone_idx on tasks(customer_phone);
