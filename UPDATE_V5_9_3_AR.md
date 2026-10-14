# تحديث 5.9.3 — تحويل Word المستقر

- استبدال التحكم البرمجي التالف في Microsoft Word بمحرك LibreOffice الصامت.
- يعمل التحويل داخل وكيل الطباعة حتى عند تشغيله تلقائياً من Scheduled Task.
- تحويل DOC وDOCX إلى PDF مؤقت ثم طباعته عبر SumatraPDF.
- حساب صفحات PDF الناتج وتحديث الملزمة وورقة التعريف.
- يبقى ملف Word الأصلي محفوظاً دون تعديل.

## المتطلب

تثبيت LibreOffice مرة واحدة على حاسبة المكتبة:

```powershell
winget install --id TheDocumentFoundation.LibreOffice -e
```
