import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./config.js";

const $ = (id) => document.getElementById(id);
const money = (n) => "₹" + Number(n || 0).toLocaleString("en-IN");
const EN_ONES = ["Zero","One","Two","Three","Four","Five","Six","Seven","Eight","Nine","Ten","Eleven","Twelve","Thirteen","Fourteen","Fifteen","Sixteen","Seventeen","Eighteen","Nineteen"];
const EN_TENS = ["","","Twenty","Thirty","Forty","Fifty","Sixty","Seventy","Eighty","Ninety"];
const HI_ONES = ["शून्य","एक","दो","तीन","चार","पाँच","छह","सात","आठ","नौ","दस","ग्यारह","बारह","तेरह","चौदह","पंद्रह","सोलह","सत्रह","अठारह","उन्नीस"];
const HI_TENS = ["","","बीस","तीस","चालीस","पचास","साठ","सत्तर","अस्सी","नब्बे"];
function underHundred(n, hindi=false) {
  const ones = hindi ? HI_ONES : EN_ONES, tens = hindi ? HI_TENS : EN_TENS;
  if (n < 20) return ones[n];
  return tens[Math.floor(n/10)] + (n%10 ? (hindi ? " " : " ") + ones[n%10] : "");
}
function underThousand(n, hindi=false) {
  if (n < 100) return underHundred(n,hindi);
  const hundreds = hindi ? "सौ" : "Hundred";
  return (hindi ? HI_ONES[numericHundreds(n)] : EN_ONES[Math.floor(n/100)]) + " " + hundreds + (n%100 ? " " + underHundred(n%100,hindi) : "");
}
function numericHundreds(n) { return Math.floor(n/100); }
function indianNumberWords(value, hindi=false) {
  let n = Math.floor(Math.abs(Number(value)||0));
  if (!n) return hindi ? "शून्य" : "Zero";
  const units = hindi ? ["","हजार","लाख","करोड़","अरब","खरब"] : ["","Thousand","Lakh","Crore","Arab","Kharab"];
  const parts = [];
  const first = n % 1000; n = Math.floor(n/1000);
  if (first) parts.unshift(underThousand(first,hindi));
  let index = 1;
  while (n > 0 && index < units.length) {
    const group = n % 100; n = Math.floor(n/100);
    if (group) parts.unshift(underHundred(group,hindi) + " " + units[index]);
    index++;
  }
  if (n > 0) return hindi ? "राशि बहुत बड़ी है" : "Amount too large";
  return parts.join(" ").trim();
}
function amountInWords(value, hindi=false) {
  const amount = Math.round((Number(value)||0) * 100) / 100;
  const rupees = Math.floor(amount);
  const paise = Math.round((amount - rupees) * 100);
  const prefix = hindi ? "रुपये" : "Rupees";
  let result = prefix + " " + indianNumberWords(rupees,hindi);
  if (paise) result += hindi ? " और " + indianNumberWords(paise,true) + " पैसे" : " and " + indianNumberWords(paise,false) + " Paise";
  return result + (hindi ? " मात्र" : " Only");
}

const phone = (v) => { const s = String(v ?? "").trim(); return /^\d+\.0+$/.test(s) ? s.replace(/\.0+$/, "") : s; };
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
let supabase, currentUser, profile, customers = [], loans = [], payments = [], lastReceipt = null;
let offlineDbPromise;
function offlineDb() {
  if (!("indexedDB" in window)) return Promise.reject(new Error("इस browser में offline storage उपलब्ध नहीं है।"));
  if (!offlineDbPromise) offlineDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open("ajsf-offline-v1", 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("snapshots")) db.createObjectStore("snapshots", {keyPath:"key"});
      if (!db.objectStoreNames.contains("paymentQueue")) db.createObjectStore("paymentQueue", {keyPath:"client_tx_id"});
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return offlineDbPromise;
}
async function offlineStore(store, mode, action) {
  const db = await offlineDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = action(tx.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
const cacheSnapshot = (key, value) => offlineStore("snapshots", "readwrite", store => store.put({key, value, saved_at:new Date().toISOString()}));
const readSnapshot = key => offlineStore("snapshots", "readonly", store => store.get(key));
const queuePayment = row => offlineStore("paymentQueue", "readwrite", store => store.put(row));
const readPaymentQueue = () => offlineStore("paymentQueue", "readonly", store => store.getAll());
const removeQueuedPayment = id => offlineStore("paymentQueue", "readwrite", store => store.delete(id));
function updateConnectionStatus(message) {
  const el = $("connectionStatus");
  if (!el) return;
  const queued = Number(el.dataset.queued || 0);
  el.textContent = message || (navigator.onLine ? `इंटरनेट उपलब्ध · Pending Offline Payments: ${queued}` : `Offline Mode · Pending Payments: ${queued}`);
  el.classList.toggle("offline", !navigator.onLine);
  el.classList.toggle("online", navigator.onLine);
}
async function refreshConnectionStatus() {
  try {
    const queue = await readPaymentQueue();
    const mine = queue.filter(item => item.collector_id === currentUser?.id);
    const el = $("connectionStatus");
    if (el) el.dataset.queued = String(mine.length);
    updateConnectionStatus();
  } catch { updateConnectionStatus(navigator.onLine ? "इंटरनेट उपलब्ध" : "Offline Mode"); }
}
async function syncQueuedPayments() {
  if (!navigator.onLine || !currentUser) return;
  let queue;
  try { queue = await readPaymentQueue(); } catch { return; }
  for (const item of queue.filter(p => p.collector_id === currentUser.id)) {
    let { data, error } = await supabase.from("payments").insert(item.payload)
      .select("id, client_tx_id, customer_id, loan_id, collector_id, amount, paid_at, payment_mode, remarks").single();
    if (error) {
      const existing = await supabase.from("payments")
        .select("id, client_tx_id, customer_id, loan_id, collector_id, amount, paid_at, payment_mode, remarks")
        .eq("client_tx_id", item.client_tx_id).maybeSingle();
      if (!existing.error && existing.data) { data = existing.data; error = null; }
    }
    if (error) continue;
    await removeQueuedPayment(item.client_tx_id);
    payments = payments.filter(p => p.client_tx_id !== item.client_tx_id);
    payments.unshift(data);
  }
  renderData();
  try { await cacheSnapshot(`user:${currentUser.id}`, {customers, loans, payments}); } catch {}
  await refreshConnectionStatus();
}

const paymentsByLoan = () => payments.filter(p => !p.is_reversal).reduce((m, p) => { const k = p.loan_id; if (k) m[k] = (m[k] || 0) + Number(p.amount || 0); return m; }, {});
function loanFigures(loan, paymentTotals) {
  const newPaid = paymentTotals[loan.id] || 0;
  const importedPaid = Number(loan.source_total_collected || 0);
  const collected = importedPaid + newPaid;
  const baselineOsp = loan.source_osp == null ? Math.max(0, Number(loan.loan_amount || 0) - importedPaid) : Number(loan.source_osp);
  return { collected, outstanding: Math.max(0, baselineOsp - newPaid) };
}

function openAjsfPrint(title, content, pageCss) {
  const w = window.open("", "_blank");
  if (!w) { showMessage("Print popup block है। Browser में pop-ups allow करें।", "warn"); return null; }
  w.document.open();
  w.document.write(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><base href="${esc(document.baseURI)}"><title>${esc(title)}</title><style>
    *{box-sizing:border-box}html,body{margin:0;padding:0;background:#fff;color:#172923;font-family:Arial,system-ui,sans-serif}
    body{padding:7mm;font-size:10pt;line-height:1.35}
    img{max-width:100%;object-fit:contain}table{width:100%;border-collapse:collapse}thead{display:table-header-group}tr{break-inside:avoid}
    th,td{border:1px solid #cbd8d0;padding:6px;text-align:left;vertical-align:top}th{background:#edf5f0;color:#23483c}
    h1,h2,h3{color:#123f35}small{color:#60756b}
    ${pageCss}
    @media print{body{padding:0}*{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
  </style></head><body>${content}</body></html>`);
  w.document.close();
  const printWhenReady = () => {
    const images = Array.from(w.document.images);
    Promise.all(images.map(img => img.complete ? Promise.resolve() : new Promise(resolve => { img.onload=resolve; img.onerror=resolve; })))
      .then(() => { w.focus(); w.print(); });
  };
  if (w.document.readyState === "complete") printWhenReady();
  else w.addEventListener("load", printWhenReady, { once:true });
  return w;
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
  let c, l;
  try { [c, l] = await Promise.all([
    customerQuery,
    supabase.from("loans").select("id, loan_reference, customer_id, loan_type, disbursement_date, loan_amount, emi_amount, total_emis_required, status, source_total_collected, source_osp, source_emis_paid, source_emis_pending").order("created_at", {ascending:false})
  ]); } catch (networkError) { c = {error:networkError}; l = {error:networkError}; }
  if (c.error || l.error) {
    const cached = await readSnapshot(`user:${currentUser.id}`);
    if (!cached?.value) throw new Error("डेटा ऑनलाइन लोड नहीं हुआ और इस डिवाइस पर Offline Backup भी नहीं मिला।");
    customers = cached.value.customers || [];
    loans = cached.value.loans || [];
    payments = cached.value.payments || [];
    const pendingOffline = (await readPaymentQueue()).filter(item => item.collector_id === currentUser.id);
    payments.push(...pendingOffline.map(item => ({...item.payload, id:null, offline_pending:true})));
    renderData();
    await syncQueuedPayments();
    await refreshConnectionStatus();
    showMessage("Offline डेटा खुल गया। इंटरनेट आने पर Pending Payments अपने आप Sync होंगे।", "warn");
    return;
  }
  customers = c.data || []; loans = l.data || [];
  payments = [];
  for (let start = 0; ; start += 1000) {
    const { data, error } = await supabase.from("payments").select("*").order("created_at", {ascending:false}).range(start, start + 999);
    if (error) { payments = []; break; }
    payments.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  try { await cacheSnapshot(`user:${currentUser.id}`, {customers, loans, payments}); } catch (cacheError) { console.warn("Offline cache unavailable", cacheError); }
  renderData();
  await syncQueuedPayments();
  await refreshConnectionStatus();
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
  const customerRegisterRows = [...customers].sort((a,b) =>
    String(a.center_name || "").localeCompare(String(b.center_name || "")) ||
    String(a.full_name || "").localeCompare(String(b.full_name || ""))
  );
  $("customerRows").innerHTML = customerRegisterRows.map((c,i) => "<tr data-center=\"" + esc(c.center_name || "") + "\" data-day=\"" + esc(c.collection_day || "") + "\"><td>" + (i+1) + "</td><td>" + esc(c.center_name || "—") + "</td><td>" + esc(c.full_name || "—") + "</td><td>" + esc(phone(c.contact_number) || "—") + "</td><td>" + esc(c.customer_code || "—") + "</td><td>" + esc(c.area || "—") + "</td><td>" + esc(c.address || "—") + "</td><td>" + esc(c.collection_day || "—") + "</td><td>" + esc(c.customer_status || "—") + "</td></tr>").join("") || "<tr><td colspan=\"9\" class=\"empty\">कोई ग्राहक नहीं मिला।</td></tr>";
  const centerFilter = $("customerCenterFilter");
  if (centerFilter) {
    const selectedCenter = centerFilter.value;
    const centers = [...new Set(customers.map(c => String(c.center_name || "").trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
    centerFilter.innerHTML = "<option value=\"\">सभी Center / House</option>" + centers.map(name => "<option value=\"" + esc(name) + "\">" + esc(name) + "</option>").join("");
    if (centers.includes(selectedCenter)) centerFilter.value = selectedCenter;
  }
  const loanFilter = $("loanCustomerFilter");
  if (loanFilter) {
    const selectedLoanCustomer = loanFilter.value;
    loanFilter.innerHTML = '<option value="">सभी ग्राहक</option>' + customers.map(c => `<option value="${esc(c.id)}">${esc(c.customer_code || "")} · ${esc(c.full_name || "")}</option>`).join("");
    if (customers.some(c => c.id === selectedLoanCustomer)) loanFilter.value = selectedLoanCustomer;
  }
  const loanCustomerId = loanFilter?.value || "";
  $("loanRows").innerHTML = loans.filter(l => !loanCustomerId || l.customer_id === loanCustomerId).map(l => {
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
  const importedCollected = customerLoans.reduce((s,l) => s + Number(l.source_total_collected || 0), 0);
  const paymentTotals = paymentsByLoan();
  const currentOsp = customerLoans.reduce((s,l) => s + loanFigures(l, paymentTotals).outstanding, 0);
  const totalCollected = importedCollected + paid;
  const loanDetails = customerLoans.map(l => {
    const figures = loanFigures(l, paymentTotals);
    return `<tr><td>${esc(l.loan_reference || "—")}</td><td>${money(l.loan_amount)}</td><td>${money(l.emi_amount)}</td><td>${esc(l.total_emis_required || "—")}</td><td>${money(Number(l.source_total_collected || 0))}</td><td>${money(figures.outstanding)}</td></tr>`;
  }).join("") || `<tr><td colspan="6">कोई Loan record उपलब्ध नहीं है।</td></tr>`;
  summary.innerHTML = `<div id="ledgerPrintArea">
    <div class="ledger-print-brand"><img src="./assets/ajsf-logo.png" alt="AJSF Logo" width="72" height="72" style="width:72px;height:72px;max-width:72px;max-height:72px;object-fit:contain;flex:0 0 72px"><div><h2>ARK JAN SAMRIDDHI FOUNDATION</h2><p>SAPNE AAPKE SATH HAMARA</p><strong>CUSTOMER LEDGER / LOAN STATEMENT</strong></div></div>
    <div class="ledger-print-customer"><span><small>Customer ID</small><b>${esc(customer?.customer_code || "—")}</b></span><span><small>Customer Name</small><b>${esc(customer?.full_name || "—")}</b></span><span><small>Center</small><b>${esc(customer?.center_name || "—")}</b></span><span><small>Mobile</small><b>${esc(phone(customer?.contact_number) || "—")}</b></span></div>
    <div class="ledger-print-totals"><span><small>Total Loan Amount</small><b>${money(loanAmount)}</b></span><span><small>Total Collected (Imported + Recorded)</small><b>${money(totalCollected)}</b></span><span><small>Recorded Payments</small><b>${money(paid)}</b></span><span><small>Current OSP</small><b>${money(currentOsp)}</b></span></div>
    <h3>Loan Details</h3><div class="tablewrap"><table><thead><tr><th>Loan Reference</th><th>Loan Amount</th><th>Weekly EMI</th><th>Terms</th><th>Imported Collection</th><th>Current OSP</th></tr></thead><tbody>${loanDetails}</tbody></table></div>
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
    .map(c => `<option value="${esc(c.id)}">${esc(c.customer_code || "")} · ${esc(c.full_name || "")} · ${esc(phone(c.contact_number))}</option>`).join("");
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
  const datedPayments = actualPayments.map(p => ({date:new Date(p.paid_at),amount:Number(p.amount||0)}))
    .filter(p => !Number.isNaN(p.date.getTime())).sort((a,b)=>a.date-b.date);
  const today = new Date(); today.setHours(23,59,59,999);
  const rows = [];
  for(let i=0;i<count;i++){
    const due = new Date(first); due.setDate(first.getDate()+i*7); due.setHours(23,59,59,999);
    const cumulativePaid = datedPayments.filter(p=>p.date<=due).reduce((s,p)=>s+p.amount,0);
    const installmentTarget = emi*(i+1);
    const previousTarget = emi*i;
    let status = "Pending";
    if (cumulativePaid >= installmentTarget && emi > 0) status = "Paid";
    else if (cumulativePaid > previousTarget) status = "Partial";
    else if (due < today) status = "Overdue";
    rows.push(`<tr><td>${i+1}</td><td>${weekday}</td><td>${displayDueDate(due)}</td><td>${money(emi)}</td><td><span class="schedule-status ${status.toLowerCase()}">${status}</span></td><td class="staff-sign-cell"><span class="staff-sign-line"></span></td></tr>`);
  }
  output.innerHTML = `<div id="repaymentSchedulePrint" class="schedule-print-sheet">
    <header class="schedule-brand schedule-brand-center"><img src="./assets/ajsf-logo.png" alt="AJSF Logo"><div><h2>ARK JAN SAMRIDDHI FOUNDATION</h2><p>SAPNE AAPKE SATH HAMARA</p><strong>WEEKLY REPAYMENT SCHEDULE</strong></div></header>
    <section class="schedule-left">
      <div class="schedule-summary"><span><small>Total Installments</small><b>${count}</b></span><span><small>Total Scheduled Amount</small><b>${money(count*emi)}</b></span><span><small>First Due Date</small><b>${displayDueDate(first)}</b></span><span><small>Last Due Date</small><b>${displayDueDate(new Date(first.getFullYear(),first.getMonth(),first.getDate()+(count-1)*7))}</b></span></div>
      <h3>INSTALLMENT DETAILS</h3><div class="tablewrap"><table><colgroup><col style="width:7%"><col style="width:14%"><col style="width:20%"><col style="width:11%"><col style="width:14%"><col style="width:34%"></colgroup><thead><tr><th>Week</th><th>Day</th><th>Due Date</th><th>EMI</th><th>Status</th><th>Staff Signature</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>
      <p class="schedule-note">Status is calculated from actual dated payment transactions, applied to installments in due-date order. Imported W1–W24 markers are not treated as dated receipts.</p>
    </section>
    <aside class="schedule-right">
      <h2>CUSTOMER & LOAN DETAILS</h2>
      <div class="customer-detail"><small>Customer Name</small><b>${esc(customer?.full_name || "—")}</b></div>
      <div class="customer-detail"><small>Customer ID</small><b>${esc(customer?.customer_code || "—")}</b></div>
      <div class="customer-detail"><small>Mobile Number</small><b>${esc(phone(customer?.contact_number) || "—")}</b></div>
      <div class="customer-detail"><small>Center Name</small><b>${esc(customer?.center_name || "—")}</b></div>
      <div class="customer-detail"><small>Area</small><b>${esc(customer?.area || "—")}</b></div>
      <div class="customer-detail"><small>Address</small><b>${esc(customer?.address || "—")}</b></div>
      <div class="customer-detail"><small>Loan Reference / Type</small><b>${esc(loan.loan_reference || "—")} · ${esc(loan.loan_type || "—")}</b></div>
      <div class="customer-detail"><small>Disbursement Date</small><b>${displayDueDate(disb)}</b></div>
      <div class="customer-detail"><small>Loan Amount / Weekly EMI</small><b>${money(loan.loan_amount)} / ${money(emi)}</b></div>
      <div class="customer-detail"><small>Collection Day / Total Installments</small><b>${weekday} / ${count} Weeks</b></div>
      <div class="customer-detail"><small>Current Outstanding (OSP)</small><b>${money(loanFigures(loan, paymentsByLoan()).outstanding)}</b></div>
      <div class="customer-signatures"><div><small>Borrower Signature / Thumb Impression</small><span></span></div><div><small>Collector Name & Staff Code</small><b>${esc(profile?.full_name || "—")} · ${esc(profile?.staff_code || "—")}</b></div><div><small>Collector Signature</small><span></span></div></div>
      <p class="schedule-generated">Generated: ${new Date().toLocaleDateString("en-IN")}</p>
    </aside>
  </div>`;
}
function printRepaymentSchedule() {
  if (!$("scheduleLoan").value) return showMessage("पहले ग्राहक और लोन चुनें।","warn");
  const area = $("repaymentSchedulePrint");
  if (!area) return showMessage("पहले Schedule लोड होने दें।","warn");
  openAjsfPrint("AJSF Repayment Schedule", area.outerHTML, `
    @page{size:A4 landscape;margin:5mm}
    body{padding:0;font-size:8pt}
    .schedule-print-sheet{display:grid;grid-template-columns:55% 45%;grid-template-rows:17mm 1fr;width:100%;min-height:198mm;border:1px solid #243c33;position:relative;overflow:hidden}
    .schedule-brand-center{grid-column:1/3;grid-row:1;display:flex;justify-content:center;align-items:center;text-align:center;gap:3mm;border-bottom:1px solid #123f35;padding:1mm}
    .schedule-brand img{width:14mm;height:14mm;max-width:14mm;max-height:14mm;object-fit:contain}
    .schedule-brand h2{font-size:13px;margin:0;color:#123f35}.schedule-brand p{font-size:7px;margin:1px 0 2px;font-weight:bold;letter-spacing:1px}.schedule-brand strong{font-size:8px}
    .schedule-left{grid-column:1;grid-row:2;padding:2mm 4mm 2mm 2.5mm;border-right:1px dashed #536b60;min-width:0}
    .schedule-right{grid-column:2;grid-row:2;padding:3mm 3mm 2mm 5mm;min-width:0}
    .schedule-summary{display:grid;grid-template-columns:repeat(2,1fr);gap:2px;padding:2px 0 3px}
    .schedule-summary span{border:1px solid #d5e0d9;padding:2px 3px}
    .schedule-summary small,.customer-detail small,.customer-signatures small{display:block;font-size:7px;margin-bottom:1px}
    .schedule-summary b,.customer-detail b{font-size:8px}
    .schedule-left table{width:100%;table-layout:fixed;font-size:8px}
    .schedule-left th,.schedule-left td{padding:1px 2px;line-height:1;height:4.8mm}
    .schedule-left th{font-size:7px}
    .schedule-status{font-size:6.5px;font-weight:bold}
    .staff-sign-cell{height:4.8mm}.staff-sign-line{display:block;width:100%;height:2.8mm;border-bottom:1px solid #52665c}
    .schedule-note{font-size:5.5px;margin-top:1px}
    .schedule-print-sheet{min-height:0;height:198mm;max-height:198mm;break-inside:avoid;page-break-inside:avoid}
    .schedule-summary{padding:1px 0 2px}
    .schedule-left h3{margin:1px 0;font-size:7.5px}
    .schedule-right{padding-top:2mm}
    .customer-detail{padding:1.5mm 1mm;min-height:6.5mm}
    .customer-signatures{margin-top:2mm;padding-top:1mm}
    .customer-signatures div{margin:1.5mm 0 2mm}
    .customer-signatures span{height:5mm}
    .schedule-right h2{font-size:10px;border-bottom:1px solid #123f35;padding-bottom:2mm;margin:0 0 2mm}
    .customer-detail{padding:2.1mm 1mm;border-bottom:1px solid #e1e8e3;min-height:8mm}
    .customer-detail b{overflow-wrap:anywhere}
    .customer-signatures{margin-top:3mm;border-top:1px solid #aabbb1;padding-top:2mm}
    .customer-signatures div{margin:2.5mm 0 3mm}
    .customer-signatures span{display:block;height:8mm;border-bottom:1px solid #52665c;width:85%}
    .customer-signatures b{font-size:8px}
    .schedule-generated{font-size:7px;text-align:right;margin-top:2mm}
  `);
}

function filterLedgerCustomers() {
  const q = ($("ledgerSearch")?.value || "").trim().toLocaleLowerCase();
  const select = $("ledgerCustomer");
  if (!select) return;
  const current = select.value;
  select.innerHTML = `<option value="">ग्राहक चुनें</option>` + customers
    .filter(c => !q || [c.customer_code,c.full_name,c.contact_number,c.center_name].some(v => String(v || "").toLocaleLowerCase().includes(q)))
    .map(c => `<option value="${esc(c.id)}">${esc(c.customer_code || "")} · ${esc(c.full_name || "")} · ${esc(phone(c.contact_number))}</option>`).join("");
  if (Array.from(select.options).some(o => o.value === current)) select.value = current;
}
function printCustomerLedger() {
  if (!$("ledgerCustomer").value) return showMessage("पहले ग्राहक खोजकर चुनें।", "warn");
  const area = $("ledgerPrintArea");
  if (!area) return showMessage("पहले Ledger लोड होने दें।", "warn");
  openAjsfPrint("AJSF Customer Ledger", area.innerHTML, `
    @page{size:A4 landscape;margin:9mm}
    body{font-size:9pt}
    .ledger-print-brand{display:flex;align-items:center;justify-content:center;gap:12px;border-bottom:2px solid #123f35;padding-bottom:8px;text-align:left}
    .ledger-print-brand img{display:block!important;width:18mm!important;height:18mm!important;max-width:18mm!important;max-height:18mm!important;min-width:18mm!important;min-height:18mm!important;flex:0 0 18mm!important;object-fit:contain!important}
    .ledger-print-brand h2{font-size:15pt;margin:0;color:#123f35}.ledger-print-brand p{font-size:8pt;margin:2px 0 5px}.ledger-print-brand strong{font-size:10pt}
    .ledger-print-customer{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;padding:9px 0}
    .ledger-print-totals{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;padding:9px;background:#edf5f0}
    .ledger-print-customer small,.ledger-print-totals small{display:block;font-size:8pt;margin-bottom:2px}
    .ledger-print-customer b,.ledger-print-totals b{font-size:9pt}
    h3{font-size:10pt;margin:10px 0 4px;color:#123f35}
    table{width:100%;border-collapse:collapse;font-size:8pt;margin:5px 0 9px}
    th,td{border:1px solid #cbd8d0;padding:5px;text-align:left}th{background:#edf5f0}
    .ledger-generated{text-align:right;font-size:8pt;margin-top:8px}
  `);
}

function filterCustomerRows() {
  const q = ($("customerFilter")?.value || "").trim().toLocaleLowerCase();
  const center = ($("customerCenterFilter")?.value || "").trim().toLocaleLowerCase();
  const day = ($("customerDayFilter")?.value || "").trim().toLocaleLowerCase();
  document.querySelectorAll("#customerRows tr").forEach(row => {
    const matchesText = !q || row.textContent.toLocaleLowerCase().includes(q);
    const matchesCenter = !center || (row.dataset.center || "").toLocaleLowerCase() === center;
    const matchesDay = !day || (row.dataset.day || "").toLocaleLowerCase() === day;
    row.hidden = !(matchesText && matchesCenter && matchesDay);
  });
}
function filterStatementCustomers() {
  const q = ($("statementSearch")?.value || "").trim().toLocaleLowerCase();
  const select = $("statementCustomer");
  if (!select) return;
  const current = select.value;
  select.innerHTML = `<option value="">ग्राहक चुनें</option>` + customers
    .filter(c => !q || [c.customer_code,c.full_name,c.contact_number,c.center_name].some(v => String(v || "").toLocaleLowerCase().includes(q)))
    .map(c => `<option value="${esc(c.id)}">${esc(c.customer_code)} · ${esc(c.full_name)} · ${esc(phone(c.contact_number))}</option>`).join("");
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
    <div class="statement-customer"><div><small>Customer ID</small><b>${esc(customer?.customer_code)}</b></div><div><small>Customer Name</small><b>${esc(customer?.full_name)}</b></div><div><small>Center</small><b>${esc(customer?.center_name || "—")}</b></div><div><small>Mobile</small><b>${esc(phone(customer?.contact_number) || "—")}</b></div><div><small>Collection Day</small><b>${esc(customer?.collection_day || "—")}</b></div></div>
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
  const area = $("statementPrintArea");
  if (!area) return showMessage("Statement तैयार नहीं हुआ।","warn");
  openAjsfPrint("AJSF Customer Loan Statement", area.outerHTML, `
    @page{size:A4 landscape;margin:8mm}
    body{font-size:8pt}
    .statement-brand{display:flex;align-items:center;justify-content:center;gap:10px;border-bottom:2px solid #123f35;padding-bottom:7px}
    .statement-brand img{width:17mm!important;height:17mm!important;max-width:17mm!important;max-height:17mm!important;flex:0 0 17mm!important}
    .statement-brand h1{font-size:14pt;margin:0}.statement-brand p{font-size:8pt;margin:2px 0}
    .statement-title{text-align:center;font-size:12pt;margin:8px 0}
    .statement-customer{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:7px;padding:7px 0}
    .statement-totals{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;padding:8px;background:#edf5f0}
    .statement-customer small,.statement-totals small{display:block;font-size:7pt;margin-bottom:2px}
    .statement-customer b,.statement-totals b{font-size:8pt}
    h3{font-size:9pt;margin:9px 0 4px}
    table{width:100%;border-collapse:collapse;font-size:7.5pt;margin:4px 0 8px}
    th,td{border:1px solid #cbd8d0;padding:4px;text-align:left;white-space:normal}
    .statement-generated{text-align:right;font-size:7pt;margin-top:8px}
    .statement-note{font-size:6.5pt;margin-top:6px}
  `);
}

async function submitCustomer(event) {
  event.preventDefault();
  if (!canAdmin()) return showMessage("नया ग्राहक जोड़ने का अधिकार केवल Admin को है।", "warn");
  const form = event.currentTarget, btn = form.querySelector('[type="submit"]');
  const d = Object.fromEntries(new FormData(form));
  const row = {
    customer_code: d.customer_code.trim(), full_name: d.full_name.trim(),
    center_name: d.center_name || null, contact_number: phone(d.contact_number) || null,
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
    <div class="receipt-amount"><small>Amount Received / प्राप्त राशि</small><strong>${money(payment.amount)}</strong><div class="receipt-amount-words"><b>In Words:</b> ${esc(amountInWords(payment.amount))}<br><b>शब्दों में:</b> ${esc(amountInWords(payment.amount,true))}</div></div>
    <p class="receipt-remarks">Remarks: ${esc(payment.remarks || "—")}</p>
    <div class="receipt-footer"><span>Customer Signature</span><span>Authorized Collector</span></div>
    <p class="receipt-note">${payment.offline_pending ? "यह Offline Entry है। इंटरनेट आने पर भुगतान AJSF ONLINE में Sync होगा।" : "यह कंप्यूटर जनरेटेड रसीद है। भुगतान रिकॉर्ड AJSF ONLINE में सेव है।"}</p>`;
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
    loan_id: loan.id,
    customer_id: customer.id,
    amount,
    paid_at: paidAt,
    payment_mode: d.payment_mode,
    collector_id: currentUser.id,
    remarks: d.remarks?.trim() || null
  };
  row.client_tx_id = crypto.randomUUID();
  setBusy(btn, true, "भुगतान सेव हो रहा है…");
  if (!navigator.onLine) {
    try {
      await queuePayment({client_tx_id:row.client_tx_id, collector_id:currentUser.id, payload:row, queued_at:new Date().toISOString()});
      const queued = {...row, id:null, offline_pending:true};
      payments.unshift(queued);
      renderData();
      form.reset(); $("paymentDate").value = localDateValue(); refreshLoanOptions();
      showReceipt(queued, customer, loan);
      await refreshConnectionStatus();
      setBusy(btn, false);
      return showMessage("भुगतान इस डिवाइस में सुरक्षित है। इंटरनेट आते ही अपने आप Sync होगा।", "warn");
    } catch (queueError) {
      setBusy(btn, false);
      return showMessage("Offline भुगतान सुरक्षित नहीं हो पाया: " + queueError.message, "error");
    }
  }
  let { data, error } = await supabase.from("payments").insert(row)
    .select("id, client_tx_id, customer_id, loan_id, collector_id, amount, paid_at, payment_mode, remarks").single();
  if (error) {
    // A previous request may have reached the database even if the browser lost its response.
    const existing = await supabase.from("payments")
      .select("id, client_tx_id, customer_id, loan_id, collector_id, amount, paid_at, payment_mode, remarks")
      .eq("client_tx_id", row.client_tx_id).maybeSingle();
    if (!existing.error && existing.data) { data = existing.data; error = null; }
  }
  setBusy(btn, false);
  if (error && (!navigator.onLine || /failed to fetch|network|load failed|fetch failed/i.test(error.message || ""))) {
    try {
      await queuePayment({client_tx_id:row.client_tx_id, collector_id:currentUser.id, payload:row, queued_at:new Date().toISOString()});
      const queued = {...row, id:null, offline_pending:true};
      payments.unshift(queued); renderData(); form.reset(); $("paymentDate").value = localDateValue(); refreshLoanOptions();
      showReceipt(queued, customer, loan); await refreshConnectionStatus(); setBusy(btn, false);
      return showMessage("Network नहीं मिला। भुगतान इस डिवाइस में सुरक्षित है और इंटरनेट आते ही Sync होगा।", "warn");
    } catch (queueError) {
      setBusy(btn, false);
      return showMessage("भुगतान सेव नहीं हुआ और Offline Backup भी नहीं बन पाया: " + queueError.message, "error");
    }
  }
  if (error) {
    setBusy(btn, false);
    return showMessage("भुगतान सेव नहीं हुआ: " + error.message, "error");
  }
  payments = payments.filter(p => p.client_tx_id !== data.client_tx_id);
  payments.unshift(data);
  renderData();
  form.reset();
  $("paymentDate").value = localDateValue();
  refreshLoanOptions();
  showReceipt(data, customer, loan);
  await refreshConnectionStatus();
  showMessage("भुगतान सफलतापूर्वक सेव हुआ। रसीद नीचे उपलब्ध है।", "success");
}
function localDateValue() {
  const d = new Date();
  const offset = d.getTimezoneOffset();
  return new Date(d.getTime() - offset * 60000).toISOString().slice(0, 10);
}
function printReceipt() {
  if (!lastReceipt) return showMessage("पहले भुगतान सेव करें।", "warn");
  const area = $("receiptContent");
  if (!area || !area.innerHTML.trim()) return showMessage("पहले Payment Receipt तैयार होने दें।","warn");
  openAjsfPrint("AJSF Payment Receipt", area.innerHTML, `
    @page{size:A5 portrait;margin:6mm}
    body{padding:0;font-size:8pt;line-height:1.2}
    .receipt{width:100%;max-width:none;margin:0;padding:3mm;border:1px solid #9aa9a0;border-radius:0}
    .receipt-brand{display:flex;align-items:center;gap:2mm;border-bottom:1px solid #123f35;padding-bottom:1.5mm}
    .receipt-brand img.receipt-logo{display:block!important;width:12mm!important;height:12mm!important;min-width:12mm!important;min-height:12mm!important;max-width:12mm!important;max-height:12mm!important;flex:0 0 12mm!important;object-fit:contain!important}
    .receipt-brand h2{font-size:10pt;margin:0}.receipt-brand p{font-size:6pt;letter-spacing:.3px;margin:1px 0}
    .receipt-title{text-align:center;font-size:9pt;font-weight:800;margin:2mm 0;color:#123f35}
    .receipt-meta{display:flex;justify-content:space-between;gap:2mm;font-size:7pt;margin-bottom:2mm;padding-bottom:1.5mm;border-bottom:1px solid #dce5df}
    .receipt-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1.5mm 3mm;border-top:0;border-bottom:1px solid #dce5df;padding:1.5mm 0}
    .receipt-grid div{display:grid;gap:.3mm}.receipt-grid small{font-size:6pt;color:#60756b}.receipt-grid b{font-size:7pt;overflow-wrap:anywhere}
    .receipt-amount{display:grid;grid-template-columns:1fr auto;align-items:center;gap:1mm 3mm;margin:2mm 0;padding:1.5mm 2mm;background:#edf5f0}
    .receipt-amount small{font-size:7pt}.receipt-amount strong{font-size:13pt;color:#123f35}.receipt-amount-words{grid-column:1/-1;font-size:6.5pt;line-height:1.35;overflow-wrap:anywhere}.receipt-amount-words b{color:#23483c}
    .receipt-remarks{font-size:7pt;margin:1mm 0}
    .receipt-footer{display:flex;justify-content:space-between;gap:8mm;margin:6mm 0 2mm;font-size:6pt}
    .receipt-footer span{border-top:1px solid #687a72;padding-top:1mm;min-width:30mm;text-align:center}
    .receipt-note{text-align:center;font-size:5.5pt;color:#68756b;margin-top:1mm}
  `);
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
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./service-worker.js").catch(err => console.warn("AJSF offline app setup failed", err));
  window.addEventListener("online", () => { updateConnectionStatus(); syncQueuedPayments(); });
  window.addEventListener("offline", () => updateConnectionStatus());
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
  $("loanCustomerFilter").addEventListener("change", renderData);
  $("ledgerCustomer").addEventListener("change", loadCustomerLedger);
  $("ledgerSearch").addEventListener("input", filterLedgerCustomers);
  $("printLedgerBtn").addEventListener("click", printCustomerLedger);
  $("scheduleSearch").addEventListener("input", filterScheduleCustomers);
  $("scheduleCustomer").addEventListener("change", populateScheduleLoans);
  $("scheduleLoan").addEventListener("change", renderRepaymentSchedule);
  $("printScheduleBtn").addEventListener("click", printRepaymentSchedule);
  $("customerFilter").addEventListener("input", filterCustomerRows);
  $("customerCenterFilter").addEventListener("change", filterCustomerRows);
  $("customerDayFilter").addEventListener("change", filterCustomerRows);
  $("statementSearch").addEventListener("input", filterStatementCustomers);
  $("statementCustomer").addEventListener("change", renderCustomerStatement);
  $("printStatementBtn").addEventListener("click", printCustomerStatement);
  $("printReceiptBtn").addEventListener("click", printReceipt);
  $("closeReceiptBtn").addEventListener("click", () => $("receiptPanel").classList.add("hidden"));
}
if ($("paymentDate")) $("paymentDate").value = localDateValue();
boot();
