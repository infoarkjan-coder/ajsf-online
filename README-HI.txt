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


नया अपडेट (Customer Filter + Customer Loan Statement):
- Customer Register में नाम/ID/Center/Mobile से खोजें।
- Loan Statement में ग्राहक खोजकर चुनें।
- Loan details, imported collected, live payment history और OSP summary दिखाई देगी।
- Statement Print / Save PDF बटन केवल चुने हुए statement को प्रिंट करता है।
- पुराने W1-W24 marker को अलग payment receipt नहीं माना गया है।
- GitHub में index.html, style.css और src/app.js replace करें। src/config.js सुरक्षित रखें।


Customer Ledger Print Update:
- Customer Ledger mein ab naam, Customer ID, Mobile aur Center se search field hai.
- Search karne par matching customers dropdown mein aayenge; dropdown se customer select karein.
- Ledger mein Loan Details, recorded payments aur imported OSP summary aayegi.
- Ledger Print / Save PDF button selected customer ka ledger print karega.
- src/config.js ko replace na karein. GitHub mein index.html, style.css, src/app.js aur assets folder update karein.


Mobile Dashboard Layout Fix:
- Mobile screen par sidebar aur dashboard ab vertical stack honge.
- Menu 2-column buttons mein aayega; content full width rahega.
- Dashboard cards 2-column; forms single-column; tables horizontal scroll.
- Desktop layout unchanged.
- GitHub mein style.css replace karein; is package mein Customer Ledger print/search changes bhi saath hain.
- src/config.js ko replace na karein.
