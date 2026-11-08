# اجتماع الجامعيين والخريجين - تطبيق الأسئلة اليومية (PostgreSQL)

## الخطوة 1: الداتا بيز المجانية (Neon)
1. ادخل https://neon.tech واعمل حساب مجاني (ممكن بجوجل).
2. اعمل Project جديد (أي اسم).
3. من لوحة التحكم انسخ **Connection string** (شكلها `postgresql://user:pass@host/db?sslmode=require`). هتحتاجه في الخطوة 3.

## الخطوة 2: ارفع الكود على GitHub
1. اعمل Repository جديد (يفضل Private) على github.com.
2. ارفع كل محتويات الفولدر ده (من غير node_modules).

## الخطوة 3: انشره على Render (مجاني)
1. ادخل https://render.com وسجل بحساب GitHub.
2. New + ← Web Service ← اختار الـ Repository.
3. الإعدادات: Runtime = Node، Build Command = `npm install`، Start Command = `npm start`، Plan = Free.
4. في Environment Variables ضيف:
   - `DATABASE_URL` = الرابط اللي نسخته من Neon
   - `ADMIN_USER` = اليوزر بتاعك (مثلا kero)
   - `ADMIN_PASS` = باسورد قوي
   - `SESSION_SECRET` = أي كلام عشوائي طويل
5. اضغط Create Web Service. بعد دقايق هتاخد لينك زي `https://church-quiz.onrender.com` ابعته للجامعيين.

> الخطة المجانية في Render بتنام بعد فترة من عدم الاستخدام، فأول فتحة ممكن تاخد حوالي دقيقة. بيانات الأعضاء والدرجات محفوظة في Neon ومش بتضيع.

## تشغيل على جهازك للتجربة
```
npm install
DATABASE_URL="رابط-نيون" ADMIN_USER=kero ADMIN_PASS=باسورد npm start
```
وافتح http://localhost:3000

## الاستخدام
سجّل دخول بحساب الأدمن ← "إدارة المحتوى" لإضافة الإصحاحات والأسئلة ← "التقرير" لمتابعة الدرجات وتحميلها CSV لـ Excel.
