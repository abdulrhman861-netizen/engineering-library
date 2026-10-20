-- v6.2: optional student number for print requests.
alter table if exists student_print_files
  add column if not exists student_number text;
