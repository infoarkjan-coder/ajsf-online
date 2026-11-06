import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./config.js";

const $ = (id) => document.getElementById(id);
const money = (n) => "₹" + Number(n || 0).toLocaleString("en-IN");
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
let supabase, currentUser, profile, customers = [], loans = [], payments = [], lastReceipt = null;
const paymentsByLoan = () => payments.filter(p => !p.is_reversal).reduce((m, p) => { const k = p.loan_id; if (k) m[k] = (m[k] || 0) + Number(p.amount || 0); return m; }, {});
function loanFigures(loan, paymentTotals) {
  const newPaid = paymentTotals[loan.id] || 0;
  const importedPaid = Number(loan.source_total_collected || 0);
  const collected = importedPaid + newPaid;
  const baselineOsp = loan.source_osp == null ? Math.max(0, Number(loan.loan_amount || 0) - importedPaid) : Number(loan.source_osp);
  return { collected, outstanding: Math.max(0, baselineOsp - newPaid) };
}

function showMessage(message, type = "info") {
  const dashboardCard = $("dashboardCard");
  const dashboardVisible = dashboardCard ? !dashboardCard.classList.contains("hidden") : false;
  const el = $(dashboardVisible ? "dashboardMessage" : "loginMessage") || $("message");
  if (!el) return;
  el.textContent = message;
  el.className = `message ${type}`;
}
function setBusy(button, busy, label = "कृपया प्रतीक्षा करें…") {
  if (!button) return;
  if (busy) { button.dataset.oldText = button.textContent; button.textContent = label; button.disabled = true; }
  else { button.textContent = button.dataset.oldText || button.textContent; button.disabled = false; }
}
function canAdmin() { return profile?.role === "admin"; }

async function loadProfile(user) {
  const { data, error } = await supabase.from("profiles")
    .select("full_name, role, staff_code, is_active")
    .eq("id", user.id).single();
  if (error || !data || !data.is_active) throw new Error("सक्रिय प्रोफाइल नहीं मिली। Admin से संपर्क करें।");
  profile = data;
}

function renderShell() {
  $("loginCard").classList.add("hidden");
  $("dashboardCard").classList.remove("hidden");
  $("staffName").textContent = profile.full_name || "Staff";
  $("staffCode").textContent = profile.staff_code || "—";
  $("staffRole").textContent = canAdmin() ? "Admin" : "Collector";
  $("roleNote").textContent = canAdmin()
    ? "आप सभी ग्राहक, लोन और भुगतान देख सकते हैं।"
    : "आपको केवल आपके assigned ग्राहक दिखेंगे।";
  const adminOnly = $("adminOnly");
  const collectorOnly = $("collectorOnly");
  if (adminOnly) adminOnly.classList.toggle("hidden", !canAdmin());
  if (collectorOnly) collectorOnly.classList.toggle("hidden", canAdmin());
}

function activateTab(tab) {
  document.querySelectorAll("[data-tab]").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  document.querySelectorAll("[data-panel]").forEach(p => p.classList.toggle("hidden", p.dataset.panel !== tab));
}
document.addEventListener("click", e => {
  const tab = e.target.closest("[data-tab]");
  if (tab) activateTab(tab.dataset.tab);
});

async function loadAll() {
  showMessage("डेटा लोड हो रहा है…");
  let customerQuery = supabase.from("customers")
    .select("id, customer_code, full_name, center_name, contact_number, area, address, collection_day, assigned_collector, customer_status, recovery_status, is_active")
    .order("full_name");
  if (!canAdmin()) customerQuery = customerQuery.eq("assigned_collector", currentUser.id);
  const [c, l] = await Promise.all([
    customerQuery,
    supabase.from("loans").select("id, loan_reference, customer_id, loan_type, disbursement_date, loan_amount, emi_amount, total_emis_required, status, source_total_collected, source_osp, source_emis_paid, source_emis_pending").order("created_at", {ascending:false})
  ]);
  if (c.error) throw new Error("Customer API (" + c.error.code + "): " + c.error.message);
  if (l.error) throw new Error("Loan API (" + l.error.code + "): " + l.error.message);
  customers = c.data || []; loans = l.data || [];
  payments = [];
  for (let start = 0; ; start += 1000) {
    const { data, error } = await supabase.from("payments").select("*").order("created_at", {ascending:false}).range(start, start + 999);
    if (error) { payments = []; break; }
    payments.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  renderData();
  showMessage("डेटा सफलतापूर्वक लोड हुआ। जमा राशि में आयातित पुरानी वसूली और नए भुगतान शामिल हैं; बकाया में नए भुगतान घटाए गए हैं।", "success");
}

function renderData() {
  $("customersCount").textContent = customers.length;
  $("loansCount").textContent = loans.length;
  $("paymentsCount").textContent = payments.length;
  const today = new Date().toISOString().slice(0,10);
  const todayPayments = payments.filter(p => !p.is_reversal && String(p.paid_at || p.created_at || "").slice(0,10) === today);
  $("todayTotal").textContent = money(todayPayments.reduce((s,p) => s + Number(p.amount || p.payment_amount || 0), 0));
  const totalsByLoan = paymentsByLoan();
  const figures = loans.map(l => loanFigures(l, totalsByLoan));
  $("collectedTotal").textContent = money(figures.reduce((s, f) => s + f.collected, 0));
  $("outstandingTotal").textContent = money(figures.reduce((s, f) => s + f.outstanding, 0));
  $("customerRows").innerHTML = customers.map(c => `<tr><td>${esc(c.customer_code)}</td><td>${esc(c.full_name)}</td><td>${esc(c.center_name)}</td><td>${esc(c.contact_number)}</td><td>${esc(c.collection_day)}</td><td>${esc(c.customer_status)}</td></tr>`).join("") || `<tr><td colspan="6" class="empty">कोई ग्राहक नहीं मिला।</td></tr>`;
  $("loanRows").innerHTML = loans.map(l => {
    const c = customers.find(x => x.id === l.customer_id);
    const f = loanFigures(l, totalsByLoan);
    return `<tr><td>${esc(l.loan_reference)}</td><td>${esc(c?.full_name || l.customer_id)}</td><td>${esc(l.loan_type)}</td><td>${money(l.loan_amount)}</td><td>${money(l.emi_amount)}</td><td>${esc(l.total_emis_required)}</td><td>${money(f.collected)}</td><td>${money(f.outstanding)}</td><td>${esc(l.status)}</td></tr>`;
  }).join("") || `<tr><td colspan="9" class="empty">कोई लोन रिकॉर्ड नहीं मिला।</td></tr>`;
  const customerOptions = `<option value="">ग्राहक चुनें</option>` + customers.map(c => `<option value="${esc(c.id)}">${esc(c.customer_code)} · ${esc(c.full_name)}</option>`).join("");
  $("payCustomer").innerHTML = customerOptions;
  $("ledgerCustomer").innerHTML = customerOptions;
  filterLedgerCustomers();
  $("statementCustomer").innerHTML = customerOptions;
  filterScheduleCustomers();
  refreshLoanOptions();
  filterCustomerRows();
  filterStatementCustomers();
  $("paymentRows").innerHTML = payments.map(p => {
    const c = customers.find(x => x.id === p.customer_id);
    const l = loans.find(x => x.id === p.loan_id);
    return `<tr><td>${esc(p.id)}</td><td>${esc(formatDate(p.paid_at))}</td><td>${esc(c?.full_name || p.customer_id)}</td><td>${esc(l?.loan_reference || "—")}</td><td>${money(p.amount)}</td><td>${esc(p.payment_mode || "—")}</td></tr>`;
  }).join("") || `<tr><td colspan="6" class="empty">अभी भुगतान उपलब्ध नहीं हैं।</td></tr>`;
}


async function loadCustomerLedger() {
  const customerId = $("ledgerCustomer").value;
  const summary = $("ledgerSummary"), rows = $("ledgerRows");
  if (!customerId) {
    summary.textContent = "ग्राहक खोजकर चुनें।";
    rows.innerHTML = `<tr><td colspan="5" class="empty">कोई ग्राहक चयनित नहीं है।</td></tr>`;
    return;
  }
  const customer = customers.find(c => c.id === customerId);
  const customerLoans = loans.filter(l => l.customer_id === customerId);
  summary.textContent = "Ledger लोड हो रहा है…";
  const { data, error } = await supabase.from("payments")
    .select("id, client_tx_id, loan_id, amount, paid_at, payment_mode, remarks")
    .eq("customer_id", customerId).eq("is_reversal", false)
    .order("paid_at", {ascending:false});
  if (error) {
    summary.textContent = "Ledger लोड नहीं हुआ: " + error.message;
    rows.innerHTML = `<tr><td colspan="5" class="empty">डेटा उपलब्ध नहीं है।</td></tr>`;
    return;
  }
  const paymentRows = data || [];
  const paid = paymentRows.reduce((s,p) => s + Number(p.amount || 0), 0);
  const loanAmount = customerLoans.reduce((s,l) => s + Number(l.loan_amount || 0), 0);
  const sourceOsp = customerLoans.reduce((s,l) => s + Number(l.source_osp || 0), 0);
  const collectedIncludingImported = customerLoans.reduce((s,l) => s + Number(l.total_collected || 0), 0) + paid;
  const loanDetails = customerLoans.map(l => `<tr><td>${esc(l.loan_reference || "—")}</td><td>${money(l.loan_amount)}</td><td>${money(l.emi_amount)}</td><td>${esc(l.total_emis_required || "—")}</td><td>${money(l.source_osp)}</td></tr>`).join("") || `<tr><td colspan="5">कोई Loan record उपलब्ध नहीं है।</td></tr>`;
  summary.innerHTML = `<div id="ledgerPrintArea">
    <div class="ledger-print-brand"><img src="./assets/ajsf-logo.png" alt="AJSF Logo" width="72" height="72" style="width:72px;height:72px;max-width:72px;max-height:72px;object-fit:contain;flex:0 0 72px"><div><h2>ARK JAN SAMRIDDHI FOUNDATION</h2><p>SAPNE AAPKE SATH HAMARA</p><strong>CUSTOMER LEDGER / LOAN STATEMENT</strong></div></div>
    <div class="ledger-print-customer"><span><small>Customer ID</small><b>${esc(customer?.customer_code || "—")}</b></span><span><small>Customer Name</small><b>${esc(customer?.full_name || "—")}</b></span><span><small>Center</small><b>${esc(customer?.center_name || "—")}</b></span><span><small>Mobile</small><b>${esc(customer?.contact_number || "—")}</b></span></div>
    <div class="ledger-print-totals"><span><small>Total Loan Amount</small><b>${money(loanAmount)}</b></span><span><small>Recorded Payments</small><b>${money(paid)}</b></span><span><small>Imported OSP</small><b>${money(sourceOsp)}</b></span></div>
    <h3>Loan Details</h3><div class="tablewrap"><table><thead><tr><th>Loan Reference</th><th>Loan Amount</th><th>Weekly EMI</th><th>Terms</th><th>Imported OSP</th></tr></thead><tbody>${loanDetails}</tbody></table></div>
    <h3>Payment History</h3>
  </div>`;
  rows.innerHTML = paymentRows.map(p => {
    const loan = customerLoans.find(l => l.id === p.loan_id);
    return `<tr><td>${esc(formatDate(p.paid_at))}</td><td>${esc((p.id || p.client_tx_id || "").slice(0,8).toUpperCase())}</td><td>${esc(loan?.loan_reference || "—")}</td><td>${esc((p.payment_mode || "—").toUpperCase().replace("_"," "))}</td><td>${money(p.amount)}</td></tr>`;
  }).join("") || `<tr><td colspan="5" class="empty">इस ग्राहक का कोई नया payment transaction उपलब्ध नहीं है।</td></tr>`;
  const table = document.querySelector('[data-panel="ledger"] #ledgerRows').closest("table");
  table.id = "ledgerPaymentTable";
  const generated = document.createElement("p");
  generated.className = "ledger-generated";
  generated.textContent = "Statement Generated: " + new Date().toLocaleString("en-IN");
  $("ledgerPrintArea").appendChild(table.cloneNode(true));
  $("ledgerPrintArea").appendChild(generated);
}



const WEEKDAY_INDEX = {Sunday:0,Monday:1,Tuesday:2,Wednesday:3,Thursday:4,Friday:5,Saturday:6};
function localISODate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}
function displayDueDate(d) {
  return d.toLocaleDateString("en-IN",{day:"2-digit",month:"short",year:"numeric"});
}
function filterScheduleCustomers() {
  const q = ($("scheduleSearch")?.value || "").trim().toLocaleLowerCase();
  const select = $("scheduleCustomer");
  if (!select) return;
  const current = select.value;
  select.innerHTML = `<option value="">ग्राहक चुनें</option>` + customers
    .filter(c => !q || [c.customer_code,c.full_name,c.contact_number,c.center_name].some(v => String(v || "").toLocaleLowerCase().includes(q)))
    .map(c => `<option value="${esc(c.id)}">${esc(c.customer_code || "")} · ${esc(c.full_name || "")} · ${esc(c.contact_number || "")}</option>`).join("");
  if (Array.from(select.options).some(o => o.value === current)) select.value = current;
}
function populateScheduleLoans() {
  const id = $("scheduleCustomer").value;
  const list = loans.filter(l => l.customer_id === id);
  $("scheduleLoan").innerHTML = `<option value="">लोन चुनें</option>` + list.map(l => `<option value="${esc(l.id)}">${esc(l.loan_reference || "Loan")} · ${money(l.loan_amount)}</option>`).join("");
  $("scheduleOutput").innerHTML = "लोन चुनें।";
}
function renderRepaymentSchedule() {
  const loanId = $("scheduleLoan").value;
  const loan = loans.find(l => l.id === loanId);
  const output = $("scheduleOutput");
  if (!loan) { output.innerHTML = "ग्राहक और लोन चुनने पर Schedule दिखाई देगा।"; return; }
  const customer = customers.find(c => c.id === loan.customer_id);
  const weekday = customer?.collection_day;
  const targetDay = WEEKDAY_INDEX[weekday];
  if (!loan.disbursement_date || targetDay === undefined) {
    output.innerHTML = `<p>इस ग्राहक के लिए सही Collection Day या Disbursement Date उपलब्ध नहीं है। Customer Register में Monday से Sunday में से दिन चुनें और Loan Disbursement Date जाँचें।</p>`;
    return;
  }
  const [yy,mm,dd] = String(loan.disbursement_date).slice(0,10).split("-").map(Number);
  const disb = new Date(yy,mm-1,dd);
  const first = new Date(disb);
  let delta = (targetDay - disb.getDay() + 7) % 7;
  if (delta === 0) delta = 7; // same-day disbursement: first installment is next week's selected day
  first.setDate(first.getDate()+delta);
  const count = Math.max(1,Math.min(60,Number(loan.total_emis_required || 24)));
  const emi = Number(loan.emi_amount || 0);
  const actualPayments = payments.filter(p => p.loan_id === loan.id && !p.is_reversal)
    .slice().sort((a,b) => new Date(a.paid_at)-new Date(b.paid_at));
  let remainingPaid = actualPayments.reduce((s,p)=>s+Number(p.amount||0),0);
  const today = new Date(); today.setHours(0,0,0,0);
  const rows = [];
  for(let i=0;i<count;i++){
    const due = new Date(first); due.setDate(first.getDate()+i*7);
    let status = "Pending";
    if (remainingPaid >= emi && emi > 0) { status = "Paid"; remainingPaid -= emi; }
    else if (remainingPaid > 0) { status = "Partial"; remainingPaid = 0; }
    else if (due < today) status = "Overdue";
    rows.push(`<tr><td>${i+1}</td><td>${weekday}</td><td>${displayDueDate(due)}</td><td>${money(emi)}</td><td><span class="schedule-status ${status.toLowerCase()}">${status}</span></td><td class="staff-sign-cell"><span class="staff-sign-line"></span></td></tr>`);
  }
  output.innerHTML = `<div id="repaymentSchedulePrint" class="schedule-print-sheet">
    <section class="schedule-left">
      <div class="schedule-brand"><img src="./assets/ajsf-logo.png" alt="AJSF Logo"><div><h2>ARK JAN SAMRIDDHI FOUNDATION</h2><p>SAPNE AAPKE SATH HAMARA</p><strong>WEEKLY REPAYMENT SCHEDULE</strong></div></div>
      <div class="schedule-summary"><span><small>Total Installments</small><b>${count}</b></span><span><small>Total Scheduled Amount</small><b>${money(count*emi)}</b></span><span><small>First Due Date</small><b>${displayDueDate(first)}</b></span><span><small>Last Due Date</small><b>${displayDueDate(new Date(first.getFullYear(),first.getMonth(),first.getDate()+(count-1)*7))}</b></span></div>
      <h3>INSTALLMENT DETAILS</h3><div class="tablewrap"><table><colgroup><col style="width:8%"><col style="width:17%"><col style="width:23%"><col style="width:13%"><col style="width:14%"><col style="width:25%"></colgroup><thead><tr><th>Week</th><th>Day</th><th>Due Date</th><th>EMI</th><th>Status</th><th>Staff Signature</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>
      <p class="schedule-note">Status is based on actual payment transactions. Historical W1–W24 markers are not treated as dated receipts.</p>
    </section>
    <aside class="schedule-right">
      <h2>CUSTOMER DETAILS</h2>
      <div class="customer-detail"><small>Customer Name</small><b>${esc(customer?.full_name || "—")}</b></div>
      <div class="customer-detail"><small>Customer ID</small><b>${esc(customer?.customer_code || "—")}</b></div>
      <div class="customer-detail"><small>Mobile Number</small><b>${esc(customer?.contact_number || "—")}</b></div>
      <div class="customer-detail"><small>Center Name</small><b>${esc(customer?.center_name || "—")}</b></div>
      <div class="customer-detail"><small>Area</small><b>${esc(customer?.area || "—")}</b></div>
      <div class="customer-detail"><small>Address</small><b>${esc(customer?.address || "—")}</b></div>
      <hr>
      <div class="customer-detail"><small>Loan Reference</small><b>${esc(loan.loan_reference || "—")}</b></div>
      <div class="customer-detail"><small>Loan Type</small><b>${esc(loan.loan_type || "—")}</b></div>
      <div class="customer-detail"><small>Disbursement Date</small><b>${displayDueDate(disb)}</b></div>
      <div class="customer-detail"><small>Loan Amount</small><b>${money(loan.loan_amount)}</b></div>
      <div class="customer-detail"><small>Weekly EMI</small><b>${money(emi)}</b></div>
      <div class="customer-detail"><small>Collection Day</small><b>${weekday}</b></div>
      <div class="customer-detail"><small>Total Installments</small><b>${count} Weeks</b></div>
      <div class="customer-detail"><small>Imported Outstanding (OSP)</small><b>${money(loan.source_osp)}</b></div>
      <div class="customer-detail"><small>Contact / Collector Signature</small><b>________________________</b></div>
      <p class="schedule-generated">Generated: ${new Date().toLocaleDateString("en-IN")}</p>
    </aside>
  </div>`;
}
function printRepaymentSchedule() {
  if (!$("scheduleLoan").value) return showMessage("पहले ग्राहक और लोन चुनें।","warn");
  const area = $("repaymentSchedulePrint");
  if (!area) return showMessage("पहले Schedule लोड होने दें।","warn");
  const w = window.open("","_blank");
  if (!w) return showMessage("Print popup block है। Browser में pop-ups allow करें।","warn");
  w.document.write(`<!doctype html><html><head><title>AJSF Repayment Schedule</title><style>
  @page{size:A4 landscape;margin:6mm}
  *{box-sizing:border-box}body{font-family:Arial,sans-serif;color:#172923;font-size:8px;margin:0}
  .schedule-print-sheet{display:grid;grid-template-columns:1fr 1fr;gap:0;width:100%;min-height:190mm;border:1.2px solid #243c33;position:relative}
  .schedule-left{padding:5mm 6mm 5mm 4mm;border-right:1.2px dashed #536b60;min-width:0}
  .schedule-right{padding:5mm 4mm 5mm 6mm;min-width:0;border-left:0;position:relative}.schedule-print-sheet:after{content:"FOLD HERE";position:absolute;left:50%;top:50%;transform:translate(-50%,-50%) rotate(-90deg);font-size:6px;letter-spacing:1px;color:#718278;background:#fff;padding:2px 5px}
  .schedule-brand{display:flex;align-items:center;gap:3mm;border-bottom:1.5px solid #123f35;padding-bottom:2mm}
  .schedule-brand img{display:block;width:16mm!important;height:16mm!important;max-width:16mm!important;max-height:16mm!important;object-fit:contain;flex:0 0 16mm}
  .schedule-brand h2{font-size:13px;margin:0;color:#123f35}.schedule-brand p{font-size:7px;margin:2px 0 4px}.schedule-brand strong{font-size:9px}
  .schedule-summary{display:grid;grid-template-columns:repeat(2,1fr);gap:4px;padding:6px 0}
  .schedule-summary span{border:1px solid #d5e0d9;padding:4px}.schedule-summary small,.customer-detail small{display:block;color:#60756b;font-size:7px;margin-bottom:2px}.schedule-summary b,.customer-detail b{font-size:8px}
  h3{font-size:9px;margin:5px 0;color:#123f35}
  table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:7.8px}th,td{border:1px solid #cbd8d0;padding:4px 3px;text-align:left;line-height:1.15}th{background:#edf5f0}
  .schedule-status{font-size:7px;font-weight:bold}.staff-sign-cell{width:24mm;height:7mm}.staff-sign-line{display:block;width:100%;height:5mm;border-bottom:1px solid #52665c}
  .schedule-note{font-size:6.5px;color:#53665d;margin-top:4px}
  .schedule-right h2{font-size:12px;color:#123f35;border-bottom:1.5px solid #123f35;padding-bottom:5px;margin:0 0 7px}
  .customer-detail{padding:5px 3px;border-bottom:1px solid #e1e8e3;min-height:9.5mm}
  .customer-detail b{overflow-wrap:anywhere}
  .schedule-right hr{border:0;border-top:1px solid #aabbb1;margin:6px 0}
  .schedule-generated{font-size:6.5px;text-align:right;margin-top:8px;color:#53665d}
  </style></head><body>${area.outerHTML}</body></html>`);
  w.document.close();w.focus();w.print();
}

function filterLedgerCustomers() {
  const q = ($("ledgerSearch")?.value || "").trim().toLocaleLowerCase();
  const select = $("ledgerCustomer");
  if (!select) return;
  const current = select.value;
  select.innerHTML = `<option value="">ग्राहक चुनें</option>` + customers
    .filter(c => !q || [c.customer_code,c.full_name,c.contact_number,c.center_name].some(v => String(v || "").toLocaleLowerCase().includes(q)))
    .map(c => `<option value="${esc(c.id)}">${esc(c.customer_code || "")} · ${esc(c.full_name || "")} · ${esc(c.contact_number || "")}</option>`).join("");
  if (Array.from(select.options).some(o => o.value === current)) select.value = current;
}
function printCustomerLedger() {
  if (!$("ledgerCustomer").value) return showMessage("पहले ग्राहक खोजकर चुनें।", "warn");
  const area = $("ledgerPrintArea");
  if (!area) return showMessage("पहले Ledger लोड होने दें।", "warn");
  const w = window.open("", "_blank");
  if (!w) return showMessage("Print popup block है। Browser में pop-ups allow करें।", "warn");
  w.document.write(`<!doctype html><html><head><title>AJSF Customer Ledger</title><style>
  @page{size:A4 portrait;margin:12mm}body{font-family:Arial,sans-serif;color:#172923;font-size:11px}
  .ledger-print-brand{display:flex;align-items:center;justify-content:center;gap:14px;border-bottom:2px solid #123f35;padding-bottom:10px;text-align:left}
  .ledger-print-brand img{display:block!important;width:72px!important;height:72px!important;max-width:72px!important;max-height:72px!important;min-width:72px!important;min-height:72px!important;flex:0 0 72px!important;object-fit:contain!important}.ledger-print-brand h2{font-size:17px;margin:0;color:#123f35}.ledger-print-brand p{font-size:9px;margin:3px 0 8px}.ledger-print-brand strong{font-size:12px}
  .ledger-print-customer,.ledger-print-totals{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;padding:12px 0}.ledger-print-customer small,.ledger-print-totals small{display:block;color:#60756b;font-size:9px;margin-bottom:3px}.ledger-print-customer b,.ledger-print-totals b{font-size:11px}
  .ledger-print-totals{background:#edf5f0;padding:10px;border-radius:6px}h3{font-size:12px;margin:14px 0 6px;color:#123f35}
  table{width:100%;border-collapse:collapse;font-size:9px;margin:7px 0 12px}th,td{border:1px solid #cbd8d0;padding:6px;text-align:left}th{background:#edf5f0}
  .ledger-generated{text-align:right;font-size:9px;margin-top:14px}
  </style></head><body>${area.innerHTML}</body></html>`);
  w.document.close();w.focus();w.print();
}

function filterCustomerRows() {
  const q = ($("customerFilter")?.value || "").trim().toLocaleLowerCase();
  document.querySelectorAll("#customerRows tr").forEach(row => {
    row.hidden = !!q && !row.textContent.toLocaleLowerCase().includes(q);
  });
}
function filterStatementCustomers() {
  const q = ($("statementSearch")?.value || "").trim().toLocaleLowerCase();
  const select = $("statementCustomer");
  if (!select) return;
  const current = select.value;
  select.innerHTML = `<option value="">ग्राहक चुनें</option>` + customers
    .filter(c => !q || [c.customer_code,c.full_name,c.contact_number,c.center_name].some(v => String(v || "").toLocaleLowerCase().includes(q)))
    .map(c => `<option value="${esc(c.id)}">${esc(c.customer_code)} · ${esc(c.full_name)} · ${esc(c.contact_number || "")}</option>`).join("");
  if (customers.some(c => c.id === current) && Array.from(select.options).some(o => o.value === current)) select.value = current;
}
function renderCustomerStatement() {
  const id = $("statementCustomer").value;
  const root = $("statementOutput");
  if (!id) { root.innerHTML = `<p class="muted">ग्राहक चुनने पर Loan Statement दिखाई देगा।</p>`; return; }
  const customer = customers.find(c => c.id === id);
  const customerLoans = loans.filter(l => l.customer_id === id);
  const customerPayments = payments.filter(p => p.customer_id === id && !p.is_reversal)
    .slice().sort((x,y) => new Date(x.paid_at) - new Date(y.paid_at));
  const totals = paymentsByLoan();
  const totalLoan = customerLoans.reduce((s,l) => s + Number(l.loan_amount || 0), 0);
  const totalCollected = customerLoans.reduce((s,l) => s + loanFigures(l, totals).collected, 0);
  const totalOutstanding = customerLoans.reduce((s,l) => s + loanFigures(l, totals).outstanding, 0);
  const loanRows = customerLoans.map(l => {
    const f = loanFigures(l, totals);
    return `<tr><td>${esc(l.loan_reference)}</td><td>${formatDate(l.disbursement_date)}</td><td>${money(l.loan_amount)}</td><td>${money(l.emi_amount)}</td><td>${esc(l.total_emis_required)}</td><td>${money(f.collected)}</td><td>${money(f.outstanding)}</td><td>${esc(l.status)}</td></tr>`;
  }).join("") || `<tr><td colspan="8">कोई Loan record उपलब्ध नहीं है।</td></tr>`;
  const paymentRows = customerPayments.map(p => {
    const loan = customerLoans.find(l => l.id === p.loan_id);
    return `<tr><td>${formatDate(p.paid_at)}</td><td>${esc((p.id || p.client_tx_id || "").slice(0,8).toUpperCase())}</td><td>${esc(loan?.loan_reference || "—")}</td><td>${esc((p.payment_mode || "—").toUpperCase().replace("_"," "))}</td><td>${money(p.amount)}</td><td>${esc(p.remarks || "—")}</td></tr>`;
  }).join("") || `<tr><td colspan="6">इस सिस्टम में कोई नया Payment record नहीं है।</td></tr>`;
  root.innerHTML = `<div id="statementPrintArea">
    <div class="statement-brand"><img src="./assets/ajsf-logo.png" alt="AJSF Logo" width="72" height="72" style="width:72px;height:72px;max-width:72px;max-height:72px;object-fit:contain;flex:0 0 72px"><div><h1>ARK JAN SAMRIDDHI FOUNDATION</h1><p>SAPNE AAPKE SATH HAMARA</p></div></div>
    <h2 class="statement-title">CUSTOMER LOAN STATEMENT / ग्राहक ऋण विवरण</h2>
    <div class="statement-customer"><div><small>Customer ID</small><b>${esc(customer?.customer_code)}</b></div><div><small>Customer Name</small><b>${esc(customer?.full_name)}</b></div><div><small>Center</small><b>${esc(customer?.center_name || "—")}</b></div><div><small>Mobile</small><b>${esc(customer?.contact_number || "—")}</b></div><div><small>Collection Day</small><b>${esc(customer?.collection_day || "—")}</b></div></div>
    <div class="statement-totals"><div><small>Total Loan Amount</small><b>${money(totalLoan)}</b></div><div><small>Total Collected</small><b>${money(totalCollected)}</b></div><div><small>Outstanding (OSP)</small><b>${money(totalOutstanding)}</b></div></div>
    <h3>Loan Details</h3><div class="tablewrap"><table><thead><tr><th>Loan Ref</th><th>Disbursement</th><th>Loan Amount</th><th>Weekly EMI</th><th>Terms</th><th>Total Collected</th><th>Outstanding</th><th>Status</th></tr></thead><tbody>${loanRows}</tbody></table></div>
    <h3>Payment History</h3><div class="tablewrap"><table><thead><tr><th>Payment Date</th><th>Receipt No.</th><th>Loan Ref</th><th>Mode</th><th>Amount</th><th>Remarks</th></tr></thead><tbody>${paymentRows}</tbody></table></div>
    <p class="statement-generated">Statement Generated: ${new Date().toLocaleString("en-IN")}</p>
    <p class="statement-note">Note: Total Collected includes imported historical collection total plus actual payment transactions recorded in AJSF ONLINE. Historical W1–W24 markers are not treated as individual dated payment receipts.</p>
  </div>`;
}
function printCustomerStatement() {
  if (!$("statementCustomer").value) return showMessage("पहले ग्राहक चुनें।", "warn");
  renderCustomerStatement();
  window.print();
}

async function submitCustomer(event) {
  event.preventDefault();
  if (!canAdmin()) return showMessage("नया ग्राहक जोड़ने का अधिकार केवल Admin को है।", "warn");
  const form = event.currentTarget, btn = form.querySelector('[type="submit"]');
  const d = Object.fromEntries(new FormData(form));
  const row = {
    customer_code: d.customer_code.trim(), full_name: d.full_name.trim(),
    center_name: d.center_name || null, contact_number: d.contact_number || null,
    area: d.area || null, address: d.address || null, collection_day: d.collection_day,
    assigned_collector: d.assigned_collector || currentUser.id,
    created_by: currentUser.id, customer_status: "ACTIVE", recovery_status: "NOT_REQUIRED", is_active: true
  };
  setBusy(btn, true);
  const { error } = await supabase.from("customers").insert(row);
  setBusy(btn, false);
  if (error) return showMessage("ग्राहक सेव नहीं हुआ: " + error.message, "error");
  form.reset(); await loadAll(); showMessage("ग्राहक सफलतापूर्वक सेव हुआ।", "success");
}

function formatDate(value) {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}
function refreshLoanOptions() {
  const customerId = $("payCustomer")?.value;
  const eligible = loans.filter(l => (!customerId || l.customer_id === customerId) && l.status === "active");
  $("payLoan").innerHTML = `<option value="">लोन चुनें</option>` + eligible.map(l => `<option value="${esc(l.id)}">${esc(l.loan_reference)} · ${money(l.loan_amount)}</option>`).join("");
}
function showReceipt(payment, customer, loan) {
  lastReceipt = { payment, customer, loan };
  const receiptNo = payment.id ? payment.id.slice(0, 8).toUpperCase() : payment.client_tx_id.slice(0, 8).toUpperCase();
  $("receiptContent").innerHTML = `
    <div class="receipt-brand"><img src="./assets/ajsf-logo.png" alt="AJSF Logo" class="receipt-logo"><div><h2>ARK JAN SAMRIDDHI FOUNDATION</h2><p>SAPNE AAPKE SATH HAMARA</p></div></div>
    <div class="receipt-title">PAYMENT RECEIPT <span>रसीद</span></div>
    <div class="receipt-meta"><span>Receipt No.: <b>${esc(receiptNo)}</b></span><span>Date: <b>${esc(formatDate(payment.paid_at))}</b></span></div>
    <div class="receipt-grid">
      <div><small>Customer ID</small><b>${esc(customer.customer_code)}</b></div>
      <div><small>Customer Name</small><b>${esc(customer.full_name)}</b></div>
      <div><small>Center</small><b>${esc(customer.center_name || "—")}</b></div>
      <div><small>Mobile</small><b>${esc(customer.contact_number || "—")}</b></div>
      <div><small>Loan Reference</small><b>${esc(loan.loan_reference)}</b></div>
      <div><small>Payment Mode</small><b>${esc(payment.payment_mode.toUpperCase().replace("_", " "))}</b></div>
    </div>
    <div class="receipt-amount"><small>Amount Received / प्राप्त राशि</small><strong>${money(payment.amount)}</strong></div>
    <p class="receipt-remarks">Remarks: ${esc(payment.remarks || "—")}</p>
    <div class="receipt-footer"><span>Customer Signature</span><span>Authorized Collector</span></div>
    <p class="receipt-note">यह कंप्यूटर जनरेटेड रसीद है। भुगतान रिकॉर्ड AJSF ONLINE में सेव है।</p>`;
  $("receiptPanel").classList.remove("hidden");
  $("receiptPanel").scrollIntoView({ behavior: "smooth", block: "start" });
}
async function submitPayment(event) {
  event.preventDefault();
  const form = event.currentTarget, btn = form.querySelector('[type="submit"]');
  const d = Object.fromEntries(new FormData(form));
  const loan = loans.find(x => x.id === d.loan_id && x.status === "active");
  const customer = customers.find(x => x.id === d.customer_id);
  const amount = Number(d.amount);
  if (!loan || !customer || loan.customer_id !== customer.id) return showMessage("सही ग्राहक और उसी ग्राहक का Active Loan चुनें।", "warn");
  if (!Number.isFinite(amount) || amount <= 0) return showMessage("भुगतान राशि शून्य से अधिक दर्ज करें।", "warn");
  if (!d.payment_date) return showMessage("भुगतान की तारीख चुनें।", "warn");
  const paidAt = new Date(`${d.payment_date}T12:00:00`).toISOString();
  const row = {
    client_tx_id: crypto.randomUUID(),
    loan_id: loan.id,
    customer_id: customer.id,
    amount,
    paid_at: paidAt,
    payment_mode: d.payment_mode,
    collector_id: currentUser.id,
    remarks: d.remarks?.trim() || null
  };
  setBusy(btn, true, "भुगतान सेव हो रहा है…");
  const { data, error } = await supabase.from("payments").insert(row).select("id, client_tx_id, customer_id, loan_id, collector_id, amount, paid_at, payment_mode, remarks").single();
  setBusy(btn, false);
  if (error) return showMessage("भुगतान सेव नहीं हुआ: " + error.message, "error");
  payments.unshift(data);
  renderData();
  form.reset();
  $("paymentDate").value = localDateValue();
  refreshLoanOptions();
  showReceipt(data, customer, loan);
  showMessage("भुगतान सफलतापूर्वक सेव हुआ। रसीद नीचे उपलब्ध है।", "success");
}
function localDateValue() {
  const d = new Date();
  const offset = d.getTimezoneOffset();
  return new Date(d.getTime() - offset * 60000).toISOString().slice(0, 10);
}
function printReceipt() {
  if (!lastReceipt) return showMessage("पहले भुगतान सेव करें।", "warn");
  window.print();
}

async function logout() {
  await supabase.auth.signOut();
  currentUser = null; profile = null;
  $("dashboardCard").classList.add("hidden"); $("loginCard").classList.remove("hidden"); $("appShell").classList.remove("logged-in");
  $("loginForm").reset(); showMessage("आप लॉगआउट हो गए हैं।");
}

async function boot() {
  if (!SUPABASE_PUBLISHABLE_KEY || SUPABASE_PUBLISHABLE_KEY.includes("PASTE_YOUR")) {
    showMessage("src/config.js में Supabase Publishable Key डालें।", "error");
    $("loginBtn").disabled = true; return;
  }
  supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
  $("loginForm").addEventListener("submit", async event => {
    event.preventDefault(); showMessage("");
    const btn = $("loginBtn"); setBusy(btn, true, "लॉगिन हो रहा है…");
    const { data, error } = await supabase.auth.signInWithPassword({
      email: $("email").value.trim(), password: $("password").value
    });
    if (error) { setBusy(btn, false); return showMessage("लॉगिन असफल: ईमेल/पासवर्ड जाँचें।", "error"); }
    try {
      currentUser = data.user;
      await loadProfile(currentUser);
      renderShell();
      $("customerForm").addEventListener("submit", submitCustomer);
      $("paymentForm").addEventListener("submit", submitPayment);
      try {
        await loadAll();
      } catch (dataError) {
        console.error("AJSF dashboard data load failed:", dataError);
        showMessage("डेटा लोड नहीं हुआ: " + (dataError?.message || String(dataError)) + " | स्क्रीनशॉट भेजें।", "error");
      }
    } catch (err) {
      console.error("AJSF login/profile failed:", err);
      await supabase.auth.signOut();
      setBusy(btn, false);
      showMessage(err.message, "error");
    }
  });
  $("logoutBtn").addEventListener("click", logout);
  $("payCustomer").addEventListener("change", refreshLoanOptions);
  $("ledgerCustomer").addEventListener("change", loadCustomerLedger);
  $("ledgerSearch").addEventListener("input", filterLedgerCustomers);
  $("printLedgerBtn").addEventListener("click", printCustomerLedger);
  $("scheduleSearch").addEventListener("input", filterScheduleCustomers);
  $("scheduleCustomer").addEventListener("change", populateScheduleLoans);
  $("scheduleLoan").addEventListener("change", renderRepaymentSchedule);
  $("printScheduleBtn").addEventListener("click", printRepaymentSchedule);
  $("customerFilter").addEventListener("input", filterCustomerRows);
  $("statementSearch").addEventListener("input", filterStatementCustomers);
  $("statementCustomer").addEventListener("change", renderCustomerStatement);
  $("printStatementBtn").addEventListener("click", printCustomerStatement);
  $("printReceiptBtn").addEventListener("click", printReceipt);
  $("closeReceiptBtn").addEventListener("click", () => $("receiptPanel").classList.add("hidden"));
}
if ($("paymentDate")) $("paymentDate").value = localDateValue();
boot();
