-- تحديث 5.7: بوت Telegram وطلبات الطباعة الذاتية الأولية
create table if not exists telegram_sessions(
  chat_id bigint primary key,
  telegram_user_id bigint,
  username text,
  state text not null default 'AWAITING_NAME',
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table if exists student_print_files add column if not exists telegram_chat_id bigint;
alter table if exists student_print_files add column if not exists telegram_user_id bigint;
alter table if exists student_print_files add column if not exists estimated_price_iqd integer not null default 0;
alter table if exists student_print_files add column if not exists payment_status text not null default 'UNPAID';
alter table if exists student_print_files add column if not exists telegram_request_key text;
alter table if exists student_print_files drop constraint if exists student_print_files_payment_status_check;
alter table if exists student_print_files add constraint student_print_files_payment_status_check check(payment_status in ('UNPAID','PENDING','PAID','REFUNDED','WAIVED'));
create index if not exists student_print_files_telegram_idx on student_print_files(telegram_chat_id,created_at desc);
create unique index if not exists student_print_files_telegram_request_key_uidx on student_print_files(telegram_request_key) where telegram_request_key is not null;

alter table telegram_sessions enable row level security;
