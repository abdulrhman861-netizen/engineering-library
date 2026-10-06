# وكيل الطباعة المباشرة v5.4

1. نفّذ `database/print_agent_upgrade.sql` مرة واحدة في Supabase SQL Editor.
2. أنشئ رمزاً عشوائياً وضعه في `.env` باسم `PRINT_AGENT_TOKEN`، وضع الرمز نفسه في `print-agent/config.json`.
3. انسخ `config.example.json` إلى `config.json` ولا ترفع `config.json` إلى GitHub.
4. ابدأ مع `enabled: false`. بعد فحص الاتصال غيّرها إلى `true`.
5. شغّل الوكيل من PowerShell:
   `powershell -ExecutionPolicy Bypass -File .\print-agent\print-agent.ps1`

الوكيل لا يطبع الطلبات القديمة تلقائياً. يطبع فقط الطلب الذي يضغط الموظف له زر «إرسال للطباعة المباشرة» ويحدد رقم الطابعة.
