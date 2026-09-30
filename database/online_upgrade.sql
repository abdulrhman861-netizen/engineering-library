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
      'application/pdf','image/jpeg','image/png','image/webp',
      'application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ]
where id = 'library-files';
