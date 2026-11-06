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
    <div class="ledger-print-brand"><img src="./assets/ajsf-logo.png" alt="AJSF Logo"><div><h2>ARK JAN SAMRIDDHI FOUNDATION</h2><p>SAPNE AAPKE SATH HAMARA</p><strong>CUSTOMER LEDGER / LOAN STATEMENT</strong></div></div>
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
  .ledger-print-brand img{width:58px;height:58px;object-fit:contain}.ledger-print-brand h2{font-size:17px;margin:0;color:#123f35}.ledger-print-brand p{font-size:9px;margin:3px 0 8px}.ledger-print-brand strong{font-size:12px}
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
    <div class="statement-brand"><img src="./assets/ajsf-logo.png" alt="AJSF Logo"><div><h1>ARK JAN SAMRIDDHI FOUNDATION</h1><p>SAPNE AAPKE SATH HAMARA</p></div></div>
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
  $("customerFilter").addEventListener("input", filterCustomerRows);
  $("statementSearch").addEventListener("input", filterStatementCustomers);
  $("statementCustomer").addEventListener("change", renderCustomerStatement);
  $("printStatementBtn").addEventListener("click", printCustomerStatement);
  $("printReceiptBtn").addEventListener("click", printReceipt);
  $("closeReceiptBtn").addEventListener("click", () => $("receiptPanel").classList.add("hidden"));
}
if ($("paymentDate")) $("paymentDate").value = localDateValue();
boot();
