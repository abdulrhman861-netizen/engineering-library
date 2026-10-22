-- V6.5: حضور الفروع بالموقع والرمز المتغير + جرد الطباعة المؤكد من الوكيل.
create table if not exists library_branches (
  branch_id bigserial primary key,
  branch_name text not null unique,
  latitude numeric(10,7),
  longitude numeric(10,7),
  radius_meters integer not null default 70 check(radius_meters between 20 and 1000),
  max_accuracy_meters integer not null default 100 check(max_accuracy_meters between 10 and 1000),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into library_branches(branch_name,radius_meters,max_accuracy_meters)
values('مكتبة كلية الهندسة',70,100)
on conflict(branch_name) do nothing;

alter table if exists attendance add column if not exists branch_id bigint references library_branches(branch_id);
alter table if exists attendance add column if not exists check_in_distance_meters numeric(10,2);
alter table if exists attendance add column if not exists check_out_distance_meters numeric(10,2);
alter table if exists attendance add column if not exists verification_method text;
create index if not exists attendance_branch_time_idx on attendance(branch_id,check_in desc);

alter table if exists print_history add column if not exists expected_pages integer not null default 0;
alter table if exists print_history add column if not exists actual_pages integer not null default 0;
alter table if exists print_history add column if not exists estimated_sheets integer not null default 0;
alter table if exists print_history add column if not exists cover_pages integer not null default 0;
alter table if exists print_history add column if not exists audit_method text not null default 'LEGACY_ESTIMATE';

update print_history set expected_pages=total_pages,actual_pages=total_pages,
estimated_sheets=total_pages where expected_pages=0 and total_pages>0;
