AJSF ONLINE - Dashboard integration starter
1. Extract ZIP. Replace repository files: index.html, style.css, and src/app.js.
2. Keep your existing src/config.js. Add only the Supabase Publishable Key from Project Settings > API Keys.
3. Never put service_role/secret key in browser code.
4. Deploy through your existing Vercel GitHub connection.
5. This version reads profiles/customers/loans and attempts payment insert using:
   payments(loan_id, customer_id, amount, payment_date, payment_mode, collected_by, remarks)
6. Your current database must have RLS policies allowing:
   - signed-in users to read their own profiles;
   - admin to read/write all customers, loans, payments;
   - collectors to read assigned customers and their loans, and insert payments for assigned customers.
7. Payment column names and RLS are not verified against live Supabase in this environment. If payment save returns a column/policy error, share the exact error (never share keys).
8. Existing imported W1-W24 history remains separate from payments; no old payments are fabricated.
9. This build does not yet implement offline sync, receipt printing, Excel import/export, or payment edit/void.
