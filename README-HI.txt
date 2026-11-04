AJSF ONLINE - अपडेटेड पैकेज

इस अपडेट में:
1. Login header में AJSF logo बड़ा किया गया है। Foundation का नाम और slogan बड़ा तथा bold किया गया है।
2. Dashboard में कुल जमा राशि और कुल बकाया (OSP) के कार्ड जोड़े गए हैं।
3. Loan Register में प्रत्येक loan के सामने कुल जमा और बकाया OSP दिखेगा।
4. Payment list अब 100 रिकॉर्ड तक सीमित नहीं है; pagination से सभी उपलब्ध payment rows लोड करने की कोशिश होती है।

गणना का आधार:
- कुल जमा = imported source_total_collected + इस सिस्टम में दर्ज वास्तविक payments.
- बकाया = imported source_osp - इस सिस्टम में दर्ज नए वास्तविक payments.
- यदि source_osp खाली है, तो बकाया = loan_amount - source_total_collected - नए payments.
- Reversal entries जमा राशि में नहीं जोड़ी जातीं।
- W1-W24 के पुराने markers को वास्तविक payment transaction नहीं माना गया है।

GitHub पर अपडेट:
- index.html -> repository root में replace
- style.css -> repository root में replace
- src/app.js -> src folder में replace
- assets/ajsf-logo.png -> assets folder में रखें/replace
- src/config.js को replace न करें। Supabase settings सुरक्षित रखें।

नोट: बकाया की गणना आपके imported source_osp को शुरुआती बकाया मानती है। यदि imported OSP गलत/पुराना है, तो पहले source OSP data ठीक करना होगा।
