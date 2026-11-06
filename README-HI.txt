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


Logo Print Size Fix:
- Customer Ledger aur Loan Statement mein logo ko compact 72px preview aur 18mm print size par lock kiya hai.
- Image width/height attributes aur max/min dimensions force kiye hain taaki original large logo print page ko cover na kare.
- GitHub mein style.css aur src/app.js replace karein; config.js ko na chheden.


Weekly Repayment Schedule Feature:
- Sidebar mein Repayment Schedule tab add hua.
- Customer ko name/ID/mobile se search karke select karein, phir uska loan select karein.
- Customer ke saved collection_day aur loan disbursement_date se weekly due dates calculate hoti hain.
- Same weekday par disbursement hone par first installment agle hafte same weekday hogi.
- Installment count loans.total_emis_required se aata hai (24 ho to 24 weeks).
- Actual payments ke amount se Paid/Partial/Pending/Overdue status derive hota hai. Imported W1-W24 markers ko dated payment nahi maana gaya.
- Schedule Print / Save PDF included.
- Sunday customer collection day option bhi included.
- src/config.js ko replace na karein.


Repayment Schedule Print Layout Update:
- Schedule print page A4 Landscape orientation mein hoga.
- Page ko do vertical sections mein divide kiya: left side Repayment Schedule, right side Customer + Loan Details.
- Left side mein weekly installments table aur summary; right side mein customer ID, name, mobile, center, area, address, loan reference, type, disbursement date, loan amount, EMI, collection day, term and OSP.
- Print button opens A4 landscape print preview.
- src/config.js safe rakhein.


Foldable A4 Landscape Print Layout:
- A4 landscape page with two equal-width bordered panels (50:50).
- Left panel: all weekly repayment schedule rows.
- Right panel: customer and loan details.
- Center dashed vertical line marked FOLD HERE for folding.
- Outer border around the full sheet; separate panel edges.
- Print margin 6mm and table text slightly enlarged to reduce clipping.
- On mobile preview panels stack vertically; print remains side-by-side.
- Keep src/config.js unchanged.


One-Page Compact Print Fix:
- Fixed A4 Landscape print height and compacted schedule rows so all 24 installments fit on one sheet.
- Reduced logo/header/summary vertical space and table cell padding.
- Kept staff signature line at end of each installment row.
- Kept equal two-panel foldable layout with center dashed fold line.
- Please print A4 Landscape, scale 100% or Fit to printable area, margins default/none as browser shows; disable headers/footers.
- src/config.js unchanged.
