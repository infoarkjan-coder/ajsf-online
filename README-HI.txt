AJSF ONLINE LOGIN - STARTER PROJECT

इस ZIP में पहला login starter है: Supabase Email/Password authentication और profiles role check.
यह पूरा collection management software नहीं है। Customer, Loan, Payment, Receipt, SOA, Reports,
Offline Sync, Audit Trail और Backup modules अभी बनने बाकी हैं।

शुरू करने के कदम:
1. src/config.js खोलें।
2. PASTE_YOUR_SUPABASE_PUBLISHABLE_KEY_HERE की जगह अपनी Supabase Publishable Key डालें।
   Supabase Dashboard > Project Settings > API Keys में publishable key मिलेगी।
3. service_role या secret key कभी भी frontend files में न डालें।
4. GitHub पर नया repository बनाएं: ajsf-online
5. ZIP extract करके सभी files repository में upload/commit करें।
6. Vercel में Add New > Project चुनें और GitHub repository import करें।
7. Deploy के बाद Admin और Akshay Kumar Collector दोनों से login test करें।

महत्वपूर्ण:
- profiles table पर authenticated user को अपनी profile SELECT करने की RLS policy जरूरी है।
- दोनों Auth users की email confirmation आपके Supabase Auth settings के अनुसार पूरी होनी चाहिए।
- RLS policies और Admin/Collector access अलग-अलग test करें।
- अभी असली ग्राहक या भुगतान डेटा इस्तेमाल न करें।
- यह starter deployment package है; इसे production-ready collection system न समझें।
