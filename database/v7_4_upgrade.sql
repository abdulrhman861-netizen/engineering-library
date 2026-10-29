-- تحديث V7.4: تسديدات الشركاء كمصروفات وربطها بفترة التسوية الأسبوعية.
-- نفّذ مرة واحدة في Supabase SQL Editor.

alter table if exists financial_entries drop constraint if exists financial_entries_category_check;
alter table if exists financial_entries add constraint financial_entries_category_check
  check(category in ('SALES','SALARY','RENT','ELECTRICITY','POS_COMMISSION','SUPPLIES','PARTNER_SHARE','OTHER'));

alter table if exists financial_entries add column if not exists partner_payment_id bigint;
alter table if exists partner_payments add column if not exists financial_entry_id bigint references financial_entries(entry_id) on delete set null;
alter table if exists partner_payments add column if not exists settlement_from date;
alter table if exists partner_payments add column if not exists settlement_to date;

create unique index if not exists financial_entries_partner_payment_uidx
  on financial_entries(partner_payment_id) where partner_payment_id is not null;
create index if not exists partner_payments_settlement_idx
  on partner_payments(partner_id,settlement_from,settlement_to);

-- تحويل التسديدات القديمة إلى مصروفات إذا لم تكن مرتبطة سابقاً.
insert into financial_entries(entry_date,entry_type,category,description,amount,payment_method,created_by,spent_by,entry_source,partner_payment_id)
select pp.payment_date,'EXPENSE','PARTNER_SHARE','تسديد حصة الشريك: '||p.partner_name,pp.amount,pp.payment_method,pp.created_by,p.partner_name,'PARTNER_PAYMENT',pp.payment_id
from partner_payments pp
join partners p using(partner_id)
where not exists(select 1 from financial_entries f where f.partner_payment_id=pp.payment_id);

update partner_payments pp
set financial_entry_id=f.entry_id,
    settlement_from=coalesce(pp.settlement_from,pp.payment_date),
    settlement_to=coalesce(pp.settlement_to,pp.payment_date)
from financial_entries f
where f.partner_payment_id=pp.payment_id
  and (pp.financial_entry_id is null or pp.settlement_from is null or pp.settlement_to is null);
