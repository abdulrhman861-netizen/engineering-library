-- v6.3: separate print queues by the origin of each request.
alter table if exists student_print_files
  add column if not exists source_type text not null default 'STUDENT_UPLOAD';

update student_print_files
set source_type = case
  when notes = 'طباعة مباشرة من إدارة الملازم' then 'MATERIAL_STAFF'
  when notes = 'طلب طباعة ملزمة من المكتبة الرقمية' then 'MATERIAL_STUDENT'
  when telegram_chat_id is not null then 'TELEGRAM'
  when source_task_id is not null then 'TASK'
  else source_type
end;

create index if not exists student_print_files_source_type_idx
  on student_print_files(source_type,created_at desc);

-- Attendance locations captured at check-in and check-out.
alter table if exists attendance add column if not exists check_in_lat numeric(10,7);
alter table if exists attendance add column if not exists check_in_lng numeric(10,7);
alter table if exists attendance add column if not exists check_in_accuracy numeric(10,2);
alter table if exists attendance add column if not exists check_out_lat numeric(10,7);
alter table if exists attendance add column if not exists check_out_lng numeric(10,7);
alter table if exists attendance add column if not exists check_out_accuracy numeric(10,2);
