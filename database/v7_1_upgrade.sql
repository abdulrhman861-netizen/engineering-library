-- V7.1: إخفاء قسم هندسة العمارة المكرر مع إبقاء القسم الرسمي الهندسة المعمارية
-- نفذ مرة واحدة في Supabase SQL Editor.
update departments
set is_active=false
where trim(name)='هندسة العمارة'
  and code <> 'architecture';

