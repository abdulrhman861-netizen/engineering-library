# نشر مكتبة كلية الهندسة على الإنترنت

هذه النسخة مصممة لتعمل من رابط واحد على عدة حاسبات وموبايلات دون الحاجة إلى الشبكة نفسها.

## قبل النشر

1. بدّل أي كلمة مرور أو مفتاح ظهر في صورة أو رسالة سابقة.
2. في Supabase شغّل الملف `database/online_upgrade.sql` مرة واحدة من SQL Editor.
3. أنشئ Secret API key جديدًا من Settings > API Keys، ولا تستخدم مفتاحًا سبق نشره.

## متغيرات الاستضافة

- `DATABASE_URL`: رابط Session pooler مع كلمة مرور قاعدة البيانات.
- `SUPABASE_URL`: رابط مشروع Supabase.
- `SUPABASE_SERVICE_ROLE_KEY`: Secret key جديد يبدأ بـ `sb_secret_`.
- `SUPABASE_BUCKET`: القيمة `library-files`.
- `JWT_SECRET`: نص عشوائي طويل.
- `ADMIN_SETUP_PIN`: رمز مدير جديد.
- `MAX_UPLOAD_MB`: القيمة `50`.
- `NODE_ENV`: القيمة `production`.

## التشغيل

- Build command: `npm ci`
- Start command: `npm start`
- Health check: `/api/health`

بعد النشر افتح الرابط العام. سيولّد رمز QR رابط بوابة الطلاب العام تلقائيًا.
