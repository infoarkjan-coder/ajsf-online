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
let supabase, currentUser, profile, customers = [], loans = [], payments = [], weeklyStatuses = [], advanceLedger = [], lastReceipt = null;
let settlementCollectors = [], dailySettlements = [], receiptCancellationRequests = [];
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
    try { await processAdvanceForPayment(data); } catch (advanceError) { console.warn("Advance ledger update pending",advanceError); }
    await removeQueuedPayment(item.client_tx_id);
    payments = payments.filter(p => p.client_tx_id !== item.client_tx_id);
    payments.unshift(data);
  }
  renderData();
  try { await cacheSnapshot(`user:${currentUser.id}`, {customers, loans, payments, weeklyStatuses, advanceLedger}); } catch {}
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
  const loanAdminTools = $("loanAdminTools");
  if (loanAdminTools) loanAdminTools.classList.toggle("hidden", !canAdmin());
  const dashboard = $("dashboardCard");
  dashboard.classList.toggle("collector-mode", !canAdmin());
  dashboard.classList.remove("collector-payment-mode");
  // Hide the Admin KPI strip directly for Collectors (not just via stylesheet).
  const summaryGrid = dashboard.querySelector(":scope > .grid");
  if (summaryGrid) summaryGrid.style.setProperty("display", canAdmin() ? "" : "none", "important");
  // Keep Collector on the demand screen; Admin navigation remains unchanged.
  activateTab(canAdmin() ? "customers" : "collector-demand");
  const staffAdminSetupBtn = $("staffAdminSetupBtn");
  if (staffAdminSetupBtn) staffAdminSetupBtn.classList.toggle("hidden", !canAdmin());
  const staffPasswordResetBtn = $("staffPasswordResetBtn");
  if (staffPasswordResetBtn) staffPasswordResetBtn.classList.toggle("hidden", !canAdmin());
  const settlementAdminOnly = $("settlementAdminOnly");
  if (settlementAdminOnly) settlementAdminOnly.classList.toggle("hidden", !canAdmin());
}

function activateTab(tab) {
  document.querySelectorAll("[data-tab]").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  document.querySelectorAll("[data-panel]").forEach(p => p.classList.toggle("hidden", p.dataset.panel !== tab));
}
document.addEventListener("click", e => {
  const tab = e.target.closest("[data-tab]");
  if (tab) activateTab(tab.dataset.tab);
});

async function openStaffPasswordPanel() {
  if (!canAdmin()) return;
  activateTab("staff-password");
  const select = $("staffPasswordTarget");
  if (!select) return showMessage("Password Management पैनल नहीं मिला।", "error");
  if (select.dataset.loaded === "1") return;
  const button = $("staffPasswordResetBtn");
  setBusy(button, true, "Staff सूची लोड हो रही है…");
  try {
    const { data, error } = await supabase.from("profiles")
      .select("id, full_name, staff_code, role")
      .eq("is_active", true).in("role", ["admin", "collector"]).order("full_name");
    if (error) throw error;
    select.innerHTML = '<option value="">अकाउंट चुनें</option>' + (data || []).map(p =>
      '<option value="' + esc(p.id) + '">' + esc(p.full_name) + ' · ' + esc(p.staff_code || "—") + ' · ' + (p.role === "admin" ? "Admin" : "Collector") + '</option>'
    ).join("");
    select.dataset.loaded = "1";
    if (!data?.length) showMessage("कोई सक्रिय Staff / Collector अकाउंट नहीं मिला।", "warn");
  } catch (err) {
    showMessage("Staff सूची लोड नहीं हुई: " + (err?.message || String(err)), "error");
  } finally {
    setBusy(button, false);
  }
}

document.addEventListener("click", event => {
  const button = event.target.closest("#staffPasswordResetBtn");
  if (!button) return;
  event.preventDefault();
  openStaffPasswordPanel();
});

async function loadAll() {
  showMessage("डेटा लोड हो रहा है…");
  let customerQuery = supabase.from("customers")
    .select("id, customer_code, full_name, center_name, contact_number, area, address, collection_day, assigned_collector, customer_status, recovery_status, status_reason, status_changed_at, status_notes, is_active")
    .order("full_name");
  if (!canAdmin()) customerQuery = customerQuery.eq("assigned_collector", currentUser.id);
  let c, l, w;
  const weeklyQuery = supabase.from("loan_weekly_status").select("loan_id, week_no, is_paid, source_marker");
  let adv;
  try { [c, l, w, adv] = await Promise.all([
    customerQuery,
    supabase.from("loans").select("id, loan_reference, customer_id, loan_type, disbursement_date, loan_amount, emi_amount, total_emis_required, status, source_total_collected, source_osp, source_emis_paid, source_emis_pending, previous_loan_id, is_archived").eq("is_archived", false).order("created_at", {ascending:false}),
    weeklyQuery,
    supabase.from("advance_ledger").select("*")
  ]); } catch (networkError) { c = {error:networkError}; l = {error:networkError}; w = {error:networkError}; adv = {error:networkError}; }
  if (c.error || l.error) {
    const cached = await readSnapshot(`user:${currentUser.id}`);
    if (!cached?.value) throw new Error("डेटा ऑनलाइन लोड नहीं हुआ और इस डिवाइस पर Offline Backup भी नहीं मिला।");
    customers = cached.value.customers || [];
    loans = cached.value.loans || [];
    payments = cached.value.payments || [];
    weeklyStatuses = cached.value.weeklyStatuses || [];
    advanceLedger = cached.value.advanceLedger || [];
    const pendingOffline = (await readPaymentQueue()).filter(item => item.collector_id === currentUser.id);
    payments.push(...pendingOffline.map(item => ({...item.payload, id:null, offline_pending:true})));
    renderData();
    await syncQueuedPayments();
    await refreshConnectionStatus();
    showMessage("Offline डेटा खुल गया। इंटरनेट आने पर Pending Payments अपने आप Sync होंगे।", "warn");
    return;
  }
  customers = c.data || []; loans = l.data || [];
  weeklyStatuses = w && !w.error ? (w.data || []) : [];
  advanceLedger = adv && !adv.error ? (adv.data || []) : [];
  payments = [];
  for (let start = 0; ; start += 1000) {
    const { data, error } = await supabase.from("payments").select("*").order("created_at", {ascending:false}).range(start, start + 999);
    if (error) { payments = []; break; }
    payments.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  try { await cacheSnapshot(`user:${currentUser.id}`, {customers, loans, payments, weeklyStatuses, advanceLedger}); } catch (cacheError) { console.warn("Offline cache unavailable", cacheError); }
  const requestResult = await supabase.from("receipt_cancellation_requests").select("*").order("created_at",{ascending:false});
  receiptCancellationRequests = requestResult.error ? [] : (requestResult.data || []);
  renderData();
  await applyMaturedAdvances();
  await syncQueuedPayments();
  await refreshConnectionStatus();
  showMessage("डेटा सफलतापूर्वक लोड हुआ। जमा राशि में आयातित पुरानी वसूली और नए भुगतान शामिल हैं; बकाया में नए भुगतान घटाए गए हैं।", "success");
}


function renderCollectorDemand() {
  const select = $("collectorDemandDay");
  const body = $("collectorDemandRows");
  if (!select || !body || canAdmin()) return;
  const today = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][new Date().getDay()];
  if (!select.value) select.value = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","MONTHLY"].includes(today) ? today : "Monday";
  const day = select.value;
  const isMonthly = day === "MONTHLY";
  const now = new Date();
  const periodStart = new Date(now.getFullYear(), now.getMonth(), isMonthly ? 1 : now.getDate() - ((now.getDay() + 6) % 7));
  periodStart.setHours(0,0,0,0);
  const periodEnd = isMonthly
    ? new Date(now.getFullYear(), now.getMonth() + 1, 1)
    : new Date(periodStart.getFullYear(), periodStart.getMonth(), periodStart.getDate() + 7);
  const paidByLoan = {};
  payments.filter(p => !p.is_reversal).forEach(p => {
    const paidDate = new Date(p.paid_at || p.created_at || "");
    if (!Number.isNaN(paidDate.getTime()) && paidDate >= periodStart && paidDate < periodEnd) {
      paidByLoan[p.loan_id] = (paidByLoan[p.loan_id] || 0) + Number(p.amount || 0);
    }
  });
  const weeklyByLoan = {};
  weeklyStatuses.forEach(row => {
    if (!weeklyByLoan[row.loan_id]) weeklyByLoan[row.loan_id] = {rows:0, pending:0};
    weeklyByLoan[row.loan_id].rows++;
    if (!row.is_paid) weeklyByLoan[row.loan_id].pending++;
  });
  const customerById = new Map(customers.map(c => [c.id,c]));
  const totalsByLoan = paymentsByLoan();
  const rows = [];
  loans.forEach(loan => {
    const customer = customerById.get(loan.customer_id);
    if (!customer || customer.is_active === false || (customer.customer_status || "ACTIVE") !== "ACTIVE") return;
    if (customer.collection_day !== day || loan.status !== "active") return;
    const figures = loanFigures(loan, totalsByLoan);
    if (figures.outstanding <= 0) return;
    const schedule = weeklyByLoan[loan.id];
    const pendingCount = schedule?.rows
      ? schedule.pending
      : (loan.source_emis_pending != null
        ? Number(loan.source_emis_pending)
        : (loanFigures(loan, totalsByLoan).outstanding > 0 ? 1 : 0));
    if (pendingCount <= 0) return;
    const emi = Number(loan.emi_amount || 0);
    const collectedThisPeriod = Number(paidByLoan[loan.id] || 0);
    const advanceAdjustedThisPeriod = advanceLedger.filter(x=>x.loan_id===loan.id && x.entry_type==="advance_adjusted" && x.due_date && new Date(x.due_date+"T00:00:00")>=periodStart && new Date(x.due_date+"T00:00:00")<periodEnd).reduce((sum,x)=>sum+Number(x.amount||0),0);
    const receivable = Math.max(0, Math.round((emi - collectedThisPeriod - advanceAdjustedThisPeriod) * 100) / 100);
    if (receivable <= 0) return;
    rows.push({customer, loan, emi, collectedThisPeriod, receivable});
  });
  rows.sort((a,b) =>
    String(a.customer.center_name || "").localeCompare(String(b.customer.center_name || "")) ||
    String(a.customer.full_name || "").localeCompare(String(b.customer.full_name || ""))
  );
  const customerCount = new Set(rows.map(row => row.customer.id)).size;
  const totalReceivable = rows.reduce((sum,row) => sum + row.receivable, 0);
  $("collectorDemandCustomerCount").textContent = customerCount.toLocaleString("en-IN");
  $("collectorDemandTotal").textContent = money(totalReceivable);
  $("collectorDemandLoanCount").textContent = rows.length.toLocaleString("en-IN");
  $("collectorDemandPeriod").textContent = isMonthly ? "इस महीने की शेष मांग" : "इस सप्ताह की शेष मांग";
  body.innerHTML = rows.map(row => `<tr>
    <td>${esc(formatCustomerId(row.customer.customer_code))}</td>
    <td><strong>${esc(row.customer.full_name || "—")}</strong><small class="demand-subline">${esc(row.customer.contact_number || "")}</small></td>
    <td>${esc(row.customer.center_name || "—")}</td>
    <td>${esc(row.loan.loan_reference || "—")}</td>
    <td>${money(row.emi)}</td>
    <td>${money(row.collectedThisPeriod)}</td>
    <td><strong>${money(row.receivable)}</strong></td>
    <td><button type="button" class="demand-collect-btn" data-customer-id="${esc(row.customer.id)}" data-loan-id="${esc(row.loan.id)}" data-demand="${row.receivable}">राशि जमा करें</button></td>
  </tr>`).join("") || `<tr><td colspan="8" class="empty">इस दिन के लिए कोई बकाया EMI मांग नहीं है।</td></tr>`;
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
  const operationalCustomers = customers.filter(c => c.is_active !== false && (c.customer_status || "ACTIVE") === "ACTIVE");
  const customerRegisterRows = [...operationalCustomers].sort((a,b) =>
    String(a.center_name || "").localeCompare(String(b.center_name || "")) ||
    String(a.full_name || "").localeCompare(String(b.full_name || ""))
  );
  $("customerRows").innerHTML = customerRegisterRows.map((c,i) => "<tr data-center=\"" + esc(c.center_name || "") + "\" data-day=\"" + esc(c.collection_day || "") + "\"><td>" + (i+1) + "</td><td>" + esc(c.center_name || "—") + "</td><td>" + esc(c.full_name || "—") + "</td><td>" + esc(phone(c.contact_number) || "—") + "</td><td>" + esc(formatCustomerId(c.customer_code)) + "</td><td>" + esc(c.area || "—") + "</td><td>" + esc(c.address || "—") + "</td><td>" + esc(c.collection_day || "—") + "</td><td>" + esc(c.customer_status || "—") + "</td><td>" + "<button type=\"button\" class=\"customer-verify secondary\" data-customer-id=\"" + esc(c.id) + "\">Field Verify</button> " + (canAdmin() ? "<button type=\"button\" class=\"customer-remove secondary\" data-customer-id=\"" + esc(c.id) + "\">हटाएँ</button>" : "") + "</td></tr>").join("") || "<tr><td colspan=\"10\" class=\"empty\">कोई ग्राहक नहीं मिला।</td></tr>";
  // Bind actions directly on each freshly-rendered button; avoid delegated capture handlers.
  $("customerRows").querySelectorAll(".customer-account-create").forEach(button => {
    button.onclick = event => {
      event.preventDefault();
      event.stopPropagation();
      createCustomerPortalAccount(button.dataset.customerId, button);
    };
  });
  $("customerRows").querySelectorAll(".customer-verify").forEach(button => {
    button.onclick = event => {
      event.preventDefault(); event.stopPropagation();
      openCustomerVerification(button.dataset.customerId);
    };
  });
  $("customerRows").querySelectorAll(".customer-remove").forEach(button => {
    button.onclick = event => {
      event.preventDefault();
      event.stopPropagation();
      removeCustomerRecord(button.dataset.customerId, button);
    };
  });
  const centerFilter = $("customerCenterFilter");
  if (centerFilter) {
    const selectedCenter = centerFilter.value;
    const centers = [...new Set(operationalCustomers.map(c => String(c.center_name || "").trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
    centerFilter.innerHTML = "<option value=\"\">सभी Center / House</option>" + centers.map(name => "<option value=\"" + esc(name) + "\">" + esc(name) + "</option>").join("");
    if (centers.includes(selectedCenter)) centerFilter.value = selectedCenter;
  }
  const loanFilter = $("loanCustomerFilter");
  if (loanFilter) {
    const selectedLoanCustomer = loanFilter.value;
    loanFilter.innerHTML = '<option value="">सभी ग्राहक</option>' + operationalCustomers.map(c => `<option value="${esc(c.id)}">${esc(formatCustomerId(c.customer_code))} · ${esc(c.full_name || "")}</option>`).join("");
    if (customers.some(c => c.id === selectedLoanCustomer)) loanFilter.value = selectedLoanCustomer;
  }
  const loanCustomerId = loanFilter?.value || "";
  $("loanRows").innerHTML = loans.filter(l => !loanCustomerId || l.customer_id === loanCustomerId).map(l => {
    const c = customers.find(x => x.id === l.customer_id);
    const f = loanFigures(l, totalsByLoan);
    return `<tr><td>${esc(l.loan_reference)}</td><td>${esc(c?.full_name || l.customer_id)}</td><td>${esc(l.loan_type)}</td><td>${money(l.loan_amount)}</td><td>${money(l.emi_amount)}</td><td>${esc(l.total_emis_required)}</td><td>${money(f.collected)}</td><td>${money(f.outstanding)}</td><td>${esc(l.status)}</td></tr>`;
  }).join("") || `<tr><td colspan="9" class="empty">कोई लोन रिकॉर्ड नहीं मिला।</td></tr>`;
  const customerOptions = `<option value="">ग्राहक चुनें</option>` + operationalCustomers.map(c => `<option value="${esc(c.id)}">${esc(formatCustomerId(c.customer_code))} · ${esc(c.full_name)}</option>`).join("");
  if ($("verificationCustomer")) {
    const selectedVerificationCustomer = $("verificationCustomer").value;
    $("verificationCustomer").innerHTML = customerOptions;
    if (customers.some(c => c.id === selectedVerificationCustomer)) $("verificationCustomer").value = selectedVerificationCustomer;
  }
  if ($("newLoanCustomer")) $("newLoanCustomer").innerHTML = customerOptions;
  if ($("closeLoanSelect")) $("closeLoanSelect").innerHTML = '<option value="">Active Loan चुनें</option>' + loans.filter(l=>l.status==="active").map(l=>{const c=customers.find(x=>x.id===l.customer_id);return '<option value="'+esc(l.id)+'">'+esc(l.loan_reference)+' · '+esc(c?.full_name||"")+'</option>';}).join("");
  if ($("newLoanPrevious")) updateRepeatLoanOptions();
  if ($("closeLoanSelect") && !$("closeLoanSelect").value) updateClosurePaymentOptions();

  $("reminderCustomer").innerHTML = customerOptions;
  updateReminderLoanOptions();
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
    return `<tr class="${p.is_reversal ? "muted" : ""}"><td>${esc((p.id || "").slice(0,8).toUpperCase())}</td><td>${esc(formatDate(p.paid_at))}</td><td>${esc(c?.full_name || p.customer_id)}</td><td>${esc(l?.loan_reference || "—")}</td><td>${money(p.amount)}</td><td>${esc(p.payment_mode || "—")}</td><td>${p.is_reversal ? (p.reverses_payment_id ? "Reversal Entry" : "रद्द") : `<button type="button" class="secondary receipt-cancel-request-btn" data-payment-id="${esc(p.id)}" ${p.offline_pending ? "disabled" : ""}>गलत रसीद की Request</button>`}</td></tr>`;
  }).join("") || `<tr><td colspan="7" class="empty">अभी भुगतान उपलब्ध नहीं हैं।</td></tr>`;
  renderCustomerMIS();
  renderCollectorDemand();
  renderAdvanceBalanceInfo();
  renderReceiptCancellationRequests();
}



function updateReminderLoanOptions() {
  const customerId = $("reminderCustomer")?.value || "";
  const eligible = loans.filter(l => l.customer_id === customerId && l.status === "active");
  $("reminderLoan").innerHTML = '<option value="">लोन चुनें</option>' + eligible.map(l => `<option value="${esc(l.id)}">${esc(l.loan_reference)} · ${money(l.loan_amount)}</option>`).join("");
  if (eligible.length === 1) $("reminderLoan").value = eligible[0].id;
  buildReminderMessage();
}
function buildReminderMessage() {
  const customer = customers.find(c => c.id === $("reminderCustomer")?.value);
  const loan = loans.find(l => l.id === $("reminderLoan")?.value);
  const info = $("reminderInfo");
  if (!customer) {
    $("reminderMessage").value = "";
    if (info) info.textContent = "पहले ग्राहक चुनें।";
    return;
  }
  const totals = paymentsByLoan();
  const f = loan ? loanFigures(loan, totals) : null;
  const emi = loan ? money(loan.emi_amount) : "";
  const osp = loan ? money(f.outstanding) : "";
  const message = `नमस्ते ${customer.full_name} जी,\n\nARK JAN SAMRIDDHI FOUNDATION (AJSF) की ओर से आपकी निर्धारित लोन किस्त के संबंध में विनम्र स्मरण।${loan ? `\nLoan Ref: ${loan.loan_reference}\nकिस्त राशि: ${emi}\nशेष बकाया: ${osp}` : ""}\n\nकृपया अपनी निर्धारित किस्त समय पर जमा करें। भुगतान के बाद रसीद अवश्य प्राप्त करें। किसी जानकारी के लिए अपने कलेक्टर से संपर्क करें।\n\nधन्यवाद,\nAJSF Team`;
  $("reminderMessage").value = message;
  if (info) info.textContent = `ग्राहक: ${customer.full_name} · मोबाइल: ${phone(customer.contact_number) || "नंबर उपलब्ध नहीं"}`;
}
function reminderPhone() {
  const customer = customers.find(c => c.id === $("reminderCustomer")?.value);
  let digits = String(phone(customer?.contact_number) || "").replace(/\D/g, "");
  if (digits.length === 10) digits = "91" + digits;
  return digits;
}
function openReminder(channel) {
  const customer = customers.find(c => c.id === $("reminderCustomer")?.value);
  if (!customer) return showMessage("पहले ग्राहक चुनें।", "warn");
  const digits = reminderPhone();
  if (!digits || digits.length < 10) return showMessage("इस ग्राहक का सही मोबाइल नंबर उपलब्ध नहीं है।", "warn");
  const message = $("reminderMessage").value.trim();
  if (!message) return showMessage("Reminder message खाली है।", "warn");
  const url = channel === "whatsapp"
    ? `https://wa.me/${digits}?text=${encodeURIComponent(message)}`
    : `sms:+${digits}?body=${encodeURIComponent(message)}`;
  window.open(url, "_blank", "noopener,noreferrer");
}
function renderCustomerMIS() {
  const body = $("customerMisRows");
  if (!body) return;
  const statusFilter = $("misStatusFilter")?.value || "";
  const term = ($("misSearch")?.value || "").trim().toLowerCase();
  const rows = customers.filter(c => (!statusFilter || (c.customer_status || "ACTIVE") === statusFilter) &&
    (!term || [c.customer_code,c.full_name,c.center_name,c.contact_number].some(v => String(v || "").toLowerCase().includes(term))));
  body.innerHTML = rows.map(c => `<tr data-mis-customer="${esc(c.id)}"><td>${esc(formatCustomerId(c.customer_code))}</td><td>${esc(c.full_name || "—")}</td><td>${esc(c.center_name || "—")}</td><td>${esc(phone(c.contact_number) || "—")}</td><td><select class="mis-status" ${canAdmin() ? "" : "disabled"}><option value="ACTIVE" ${(c.customer_status || "ACTIVE")==="ACTIVE"?"selected":""}>ACTIVE</option><option value="ABSCONDED" ${c.customer_status==="ABSCONDED"?"selected":""}>ABSCONDED</option><option value="DECEASED" ${c.customer_status==="DECEASED"?"selected":""}>DECEASED</option></select>${c.is_active === false ? '<small class="inactive-flag">INACTIVE</small>' : ""}</td><td><input class="mis-date" type="date" value="${esc(c.status_changed_at || "")}" ${canAdmin()?"":"disabled"}></td><td><input class="mis-reason" value="${esc(c.status_reason || "")}" placeholder="जैसे: संपर्क नहीं / मृत्यु" ${canAdmin()?"":"disabled"}></td><td><input class="mis-notes" value="${esc(c.status_notes || "")}" placeholder="विवरण" ${canAdmin()?"":"disabled"}></td><td><div class="mis-actions"><button type="button" class="mis-save" ${canAdmin()?"":"disabled"}>सेव</button>${canAdmin() ? `<button type="button" class="customer-remove secondary" data-customer-id="${esc(c.id)}">हटाएँ</button>` : ""}</div></td></tr>`).join("") || `<tr><td colspan="9" class="empty">कोई रिकॉर्ड नहीं मिला।</td></tr>`;
}
async function createCustomerPortalAccount(customerId, button) {
  if (!canAdmin()) return showMessage("Customer Login बनाने का अधिकार केवल Admin को है।", "warn");
  if (!navigator.onLine) return showMessage("Customer Login बनाने के लिए इंटरनेट आवश्यक है।", "warn");
  const customer = customers.find(c => c.id === customerId);
  if (!customer) return showMessage("ग्राहक रिकॉर्ड नहीं मिला। Refresh करें।", "error");
  if (!/^[0-9]{10}$/.test(String(customer.contact_number || "").replace(/[^0-9]/g, ""))) {
    return showMessage("पहले ग्राहक का सही 10 अंकों का मोबाइल नंबर Customer Register में अपडेट करें।", "warn");
  }
  if (!window.confirm(`${customer.full_name} (${formatCustomerId(customer.customer_code)}) के लिए Customer Portal Login बनाना है? Login ID उनका registered mobile number होगा।`)) return;
  setBusy(button, true, "Login बन रहा है…");
  try {
    const { data, error } = await supabase.functions.invoke("admin-create-customer-account", { body: { customer_id: customerId } });
    if (error) throw error;
    if (!data?.success) throw new Error(data?.error || "Customer Login नहीं बना।");
    showMessage(`Customer Login बन गया। Login ID: ${data.phone}. शुरुआती Password Admin द्वारा सुरक्षित तरीके से ग्राहक को दें।`, "success");
    button.textContent = "Login बन गया";
    button.disabled = true;
  } catch (error) {
    showMessage("Customer Login नहीं बन पाया: " + (error?.message || "Edge Function / Default Password configuration जाँचें।"), "error");
  } finally {
    setBusy(button, false);
  }
}

async function removeCustomerRecord(customerId, button) {
  if (!canAdmin()) return showMessage("ग्राहक हटाने का अधिकार केवल Admin को है।", "warn");
  if (!navigator.onLine) return showMessage("ग्राहक हटाने के लिए इंटरनेट कनेक्शन आवश्यक है।", "warn");
  const customer = customers.find(c => c.id === customerId);
  if (!customer) return showMessage("ग्राहक रिकॉर्ड नहीं मिला। Refresh करके दोबारा प्रयास करें।", "error");
  const confirmed = window.confirm(`क्या आप ग्राहक ${customer.full_name} (${formatCustomerId(customer.customer_code)}) को हटाना चाहते हैं?\n\nयदि Loan या Payment रिकॉर्ड मौजूद है, तो ग्राहक केवल INACTIVE होगा और पुराना हिसाब सुरक्षित रहेगा। बिना Loan/Payment रिकॉर्ड के ही Permanent Delete होगा।\n\nक्या आगे बढ़ें?`);
  if (!confirmed) return;
  setBusy(button, true, "प्रक्रिया जारी…");
  const { data, error } = await supabase.rpc("admin_remove_customer", { p_customer_id: customerId });
  setBusy(button, false);
  if (error) return showMessage("ग्राहक हटाने की प्रक्रिया पूरी नहीं हुई: " + error.message, "error");
  const outcome = Array.isArray(data) ? data[0] : data;
  await loadAll();
  if (outcome?.result === "deleted") showMessage(`ग्राहक ${outcome.customer_code || customer.customer_code} Permanent Delete हो गया। Audit Log सुरक्षित है।`, "success");
  else if (outcome?.result === "deactivated") showMessage("इस ग्राहक का Loan/Payment इतिहास मौजूद है। इसलिए इसे INACTIVE किया गया है; पुराना Loan और Payment रिकॉर्ड सुरक्षित है। Audit Log सुरक्षित है।", "success");
  else showMessage("प्रक्रिया पूरी हुई, लेकिन परिणाम स्पष्ट नहीं मिला। कृपया रिकॉर्ड Refresh करके जाँचें।", "warn");
}

async function saveCustomerMISRow(row) {
  if (!canAdmin()) return showMessage("यह बदलाव केवल Admin कर सकता है।", "warn");
  const id = row?.dataset.misCustomer;
  const customer = customers.find(c => c.id === id);
  if (!customer) return;
  const status = row.querySelector(".mis-status").value;
  const date = row.querySelector(".mis-date").value || null;
  const reason = row.querySelector(".mis-reason").value.trim() || null;
  const notes = row.querySelector(".mis-notes").value.trim() || null;
  if (status !== "ACTIVE" && !date) return showMessage("Absconded / Deceased status के लिए तारीख भरें।", "warn");
  if (status !== "ACTIVE" && !reason) return showMessage("Status का कारण / विवरण भरें।", "warn");
  const payload = {customer_status:status, status_changed_at:status==="ACTIVE"?null:date, status_reason:status==="ACTIVE"?null:reason, status_notes:status==="ACTIVE"?null:notes};
  const btn = row.querySelector(".mis-save");
  setBusy(btn, true, "सेव…");
  const {error} = await supabase.from("customers").update(payload).eq("id", id);
  setBusy(btn, false);
  if (error) return showMessage("Status सेव नहीं हुआ: " + error.message, "error");
  Object.assign(customer, payload);
  renderData();
  showMessage("Customer MIS status सफलतापूर्वक अपडेट हुआ।", "success");
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
  const importedCollected = customerLoans.reduce((s,l) => s + Number(l.source_total_collected || 0), 0);
  const totalCollected = importedCollected + paid;
  const paymentTotalsByLoan = paymentRows.reduce((totals,p) => {
    if (p.loan_id) totals[p.loan_id] = (totals[p.loan_id] || 0) + Number(p.amount || 0);
    return totals;
  }, {});
  const totalLoanAmount = customerLoans.reduce((sum,l) => sum + Number(l.loan_amount || 0), 0);
  const totalOutstanding = customerLoans.reduce((sum,l) => sum + loanFigures(l,paymentTotalsByLoan).outstanding, 0);
  const loanBalanceRows = customerLoans.map(l => {
    const figures = loanFigures(l,paymentTotalsByLoan);
    return `<tr><td>${esc(l.loan_reference || "—")}</td><td>${money(l.loan_amount)}</td><td>${money(figures.collected)}</td><td><strong>${money(figures.outstanding)}</strong></td></tr>`;
  }).join("") || `<tr><td colspan="4">इस ग्राहक का कोई Loan record उपलब्ध नहीं है।</td></tr>`;
  const transactionRows = paymentRows.map(p => {
    const loan = customerLoans.find(l => l.id === p.loan_id);
    return `<tr><td>${esc(formatDate(p.paid_at))}</td><td>${esc((p.id || p.client_tx_id || "").slice(0,8).toUpperCase())}</td><td>${esc(loan?.loan_reference || "—")}</td><td>${esc((p.payment_mode || "—").toUpperCase().replace("_"," "))}</td><td>${money(p.amount)}</td></tr>`;
  }).join("") || `<tr><td colspan="5" class="empty">इस ग्राहक का कोई नया payment transaction उपलब्ध नहीं है।</td></tr>`;
  summary.innerHTML = `<div id="ledgerPrintArea">
    <div class="ledger-print-brand"><img src="./assets/ajsf-logo.png" alt="AJSF Logo" width="72" height="72" style="width:72px;height:72px;max-width:72px;max-height:72px;object-fit:contain;flex:0 0 72px"><div><h2>ARK JAN SAMRIDDHI FOUNDATION</h2><p>SAPNE AAPKE SATH HAMARA</p><strong>CUSTOMER PAYMENT LEDGER / भुगतान खाता</strong></div></div>
    <div class="ledger-print-customer"><span><small>Customer ID</small><b>${esc(formatCustomerId(customer?.customer_code))}</b></span><span><small>Customer Name</small><b>${esc(customer?.full_name || "—")}</b></span><span><small>Center</small><b>${esc(customer?.center_name || "—")}</b></span><span><small>Mobile</small><b>${esc(phone(customer?.contact_number) || "—")}</b></span></div>
    <div class="ledger-print-totals"><span><small>Total Loan Amount</small><b>${money(totalLoanAmount)}</b></span><span><small>All-time Collection</small><b>${money(totalCollected)}</b></span><span><small>Outstanding Balance / कुल बकाया</small><b>${money(totalOutstanding)}</b></span><span><small>Recorded Transactions</small><b>${paymentRows.length.toLocaleString("en-IN")}</b></span></div>
    <h3>Loan-wise Outstanding Balance / लोन अनुसार बाकी राशि</h3>
    <table id="ledgerLoanBalanceTable"><thead><tr><th>Loan Ref</th><th>Loan Amount</th><th>Total Collected</th><th>Remaining Balance</th></tr></thead><tbody>${loanBalanceRows}</tbody></table>
    <h3>Payment Transaction Register</h3>
    <p class="small muted">Outstanding Balance में सभी चालू और पुराने Loan का शेष बकाया शामिल है। नीचे सिस्टम में दर्ज वास्तविक भुगतान की तारीख, रसीद, Loan Ref, Mode और राशि दी गई है।</p>
    <table id="ledgerPaymentTable"><thead><tr><th>Date</th><th>Receipt / Transaction</th><th>Loan Ref</th><th>Mode</th><th>Amount</th></tr></thead><tbody>${transactionRows}</tbody></table>
    <p class="ledger-generated">Statement Generated: ${new Date().toLocaleString("en-IN")}</p>
  </div>`;
  rows.innerHTML = transactionRows;
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
    .map(c => `<option value="${esc(c.id)}">${esc(formatCustomerId(c.customer_code))} · ${esc(c.full_name || "")} · ${esc(phone(c.contact_number))}</option>`).join("");
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
    rows.push(`<tr><td>${i+1}</td><td>${displayDueDate(due)}</td><td>${money(emi)}</td><td><span class="schedule-status ${status.toLowerCase()}">${status}</span></td><td class="passbook-paid-date"></td><td class="passbook-sign"></td></tr>`);
  }
  output.innerHTML = `<div id="repaymentSchedulePrint" class="repayment-fold-sheet">
    <section class="repayment-left">
      <h2>WEEKLY REPAYMENT SCHEDULE</h2>
      <table class="repayment-table">
        <colgroup><col style="width:9%"><col style="width:17%"><col style="width:25%"><col style="width:49%"></colgroup>
        <thead><tr><th>Week</th><th>Day</th><th>Due Date</th><th>Collector Signature</th></tr></thead>
        <tbody>${rows.map((row,i)=>{const due=new Date(first);due.setDate(first.getDate()+i*7);return `<tr><td>${i+1}</td><td>${esc(weekday)}</td><td>${displayDueDate(due)}</td><td class="repayment-sign-cell"></td></tr>`;}).join("")}</tbody>
      </table>
    </section>
    <aside class="repayment-right">
      <header class="repayment-brand"><img src="./assets/ajsf-logo.png" alt="AJSF Logo"><div><h1>ARK JAN SAMRIDDHI FOUNDATION</h1><p>SAPNE AAPKE SATH HAMARA</p></div></header>
      <h2 class="repayment-customer-title">CUSTOMER DETAILS / ग्राहक विवरण</h2>
      <div class="repayment-customer">
        <div><small>Customer Name / ग्राहक का नाम</small><b>${esc(customer?.full_name || "—")}</b></div>
        <div><small>Customer ID / ग्राहक आईडी</small><b>${esc(formatCustomerId(customer?.customer_code))}</b></div>
        <div><small>Mobile Number / मोबाइल</small><b>${esc(phone(customer?.contact_number) || "—")}</b></div>
        <div><small>Center Name / केंद्र</small><b>${esc(customer?.center_name || "—")}</b></div>
        <div><small>Loan Reference / लोन नंबर</small><b>${esc(loan.loan_reference || "—")}</b></div>
        <div><small>Disbursement Date / लोन वितरण तारीख</small><b>${formatDate(loan.disbursement_date)}</b></div>
        <div><small>Loan Amount / ऋण राशि</small><b>${money(loan.loan_amount)}</b></div>
        <div><small>Weekly EMI / साप्ताहिक किस्त</small><b>${money(emi)}</b></div>
        <div><small>Collection Day / वसूली दिन</small><b>${esc(weekday)}</b></div>
        <div><small>Total Installments / कुल किस्तें</small><b>${count} Weeks</b></div>
      </div>
      <div class="repayment-right-footer"><small>Customer Signature / ग्राहक हस्ताक्षर</small><span></span><small>Authorized Collector / अधिकृत कलेक्टर</small><span></span></div>
    </aside>
    <div class="repayment-fold-mark">FOLD</div>
  </div>`;

}
function printRepaymentSchedule() {
  if (!$("scheduleLoan").value) return showMessage("पहले ग्राहक और लोन चुनें।","warn");
  const area = $("repaymentSchedulePrint");
  if (!area) return showMessage("पहले Schedule लोड होने दें।","warn");
  openAjsfPrint("AJSF Repayment Schedule", area.outerHTML, `
    @page{size:A4 landscape;margin:5mm}
    body{padding:0;font-family:Arial,sans-serif;color:#20352d}
    .repayment-fold-sheet{position:relative;display:grid;grid-template-columns:1fr 1fr;width:100%;height:200mm;box-sizing:border-box;border:1px solid #244b3c;background:#fff}
    .repayment-left{grid-column:1;grid-row:1;padding:3mm 5mm 3mm 3mm;box-sizing:border-box;min-width:0}
    .repayment-right{grid-column:2;grid-row:1;padding:7mm 5mm 4mm 8mm;box-sizing:border-box;min-width:0;border-left:1px dashed #71877b}
    .repayment-left h2{font-size:11pt;color:#174b3c;text-align:center;margin:0 0 3mm;padding-bottom:2mm;border-bottom:1px solid #174b3c}
    .repayment-table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:8pt}
    .repayment-table th{background:#e8f1ec;color:#174b3c;font-weight:bold}
    .repayment-table th,.repayment-table td{border:.25mm solid #b9c9bf;padding:1.45mm 1.2mm;height:6.5mm;text-align:center;vertical-align:middle}
    .repayment-table td.repayment-sign-cell{height:6.5mm}
    .repayment-brand{display:flex;align-items:center;gap:4mm;padding-bottom:4mm;border-bottom:2px solid #174b3c}
    .repayment-brand img{width:25mm;height:25mm;object-fit:contain;flex:0 0 25mm}
    .repayment-brand h1{font-size:15pt;line-height:1.15;color:#174b3c;margin:0}
    .repayment-brand p{font-size:8pt;font-weight:bold;letter-spacing:.6px;color:#60756b;margin:2mm 0 0}
    .repayment-customer-title{font-size:10pt;color:#174b3c;margin:7mm 0 3mm}
    .repayment-customer{display:grid;grid-template-columns:1fr 1fr;gap:4mm 5mm}
    .repayment-customer div{min-height:12mm;padding:1mm 0;border-bottom:.25mm solid #d4dfd8}
    .repayment-customer small{display:block;font-size:7pt;color:#65776e;margin-bottom:1.5mm}
    .repayment-customer b{font-size:9pt;overflow-wrap:anywhere}
    .repayment-right-footer{margin-top:12mm;display:grid;grid-template-columns:1fr 1fr;gap:2mm 6mm;font-size:7pt;color:#52665c}
    .repayment-right-footer span{height:12mm;border-bottom:.25mm solid #52665c}
    .repayment-fold-mark{position:absolute;left:50%;top:0;bottom:0;border-left:.25mm dashed #82958b;font-size:0}
  `);;
}

function filterLedgerCustomers() {
  const q = ($("ledgerSearch")?.value || "").trim().toLocaleLowerCase();
  const select = $("ledgerCustomer");
  if (!select) return;
  const current = select.value;
  select.innerHTML = `<option value="">ग्राहक चुनें</option>` + customers
    .filter(c => !q || [c.customer_code,c.full_name,c.contact_number,c.center_name].some(v => String(v || "").toLocaleLowerCase().includes(q)))
    .map(c => `<option value="${esc(c.id)}">${esc(formatCustomerId(c.customer_code))} · ${esc(c.full_name || "")} · ${esc(phone(c.contact_number))}</option>`).join("");
  if (Array.from(select.options).some(o => o.value === current)) select.value = current;
}
function printCustomerLedger() {
  if (!$("ledgerCustomer").value) return showMessage("पहले ग्राहक खोजकर चुनें।", "warn");
  const area = $("ledgerPrintArea");
  if (!area) return showMessage("पहले Ledger लोड होने दें।", "warn");
  openAjsfPrint("AJSF Customer Payment Ledger", area.innerHTML, `
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
    .map(c => `<option value="${esc(c.id)}">${esc(formatCustomerId(c.customer_code))} · ${esc(c.full_name)} · ${esc(phone(c.contact_number))}</option>`).join("");
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
    <div class="statement-customer"><div><small>Customer ID</small><b>${esc(formatCustomerId(customer?.customer_code))}</b></div><div><small>Customer Name</small><b>${esc(customer?.full_name)}</b></div><div><small>Center</small><b>${esc(customer?.center_name || "—")}</b></div><div><small>Mobile</small><b>${esc(phone(customer?.contact_number) || "—")}</b></div><div><small>Collection Day</small><b>${esc(customer?.collection_day || "—")}</b></div></div>
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

async function submitNewLoan(event) {
  event.preventDefault();
  if (!canAdmin()) return showMessage("नया Loan बनाने का अधिकार केवल Admin को है।","warn");
  const form=event.currentTarget, btn=form.querySelector('[type="submit"]'), d=Object.fromEntries(new FormData(form));
  const customer=customers.find(c=>c.id===d.customer_id && c.is_active!==false && (c.customer_status||"ACTIVE")==="ACTIVE");
  const previous=d.previous_loan_id ? loans.find(l=>l.id===d.previous_loan_id) : null;
  const amount=Number(d.loan_amount), emi=Number(d.emi_amount), terms=Number(d.total_emis_required);
  const ref=d.loan_reference.trim();
  if(!customer) return showMessage("सक्रिय ग्राहक चुनें।","warn");
  if(previous && (previous.customer_id!==customer.id || previous.status!=="closed")) return showMessage("Repeat Loan के लिए उसी ग्राहक का CLOSED पुराना Loan चुनें।","warn");
  if(!ref || !d.loan_type.trim() || !d.disbursement_date || !(amount>0) || !(emi>0) || !Number.isInteger(terms) || terms<1) return showMessage("सभी Loan विवरण सही भरें।","warn");
  if(loans.some(l=>String(l.loan_reference||"").trim().toLowerCase()===ref.toLowerCase())) return showMessage("यह Loan Ref पहले से मौजूद है। नया Ref डालें।","warn");
  setBusy(btn,true,"Loan सेव हो रहा है…");
  try {
    const {error}=await supabase.from("loans").insert({
      loan_reference:ref, customer_id:customer.id, loan_type:d.loan_type.trim(),
      disbursement_date:d.disbursement_date, loan_amount:amount, emi_amount:emi,
      total_emis_required:terms, status:"active", created_by:currentUser.id,
      is_archived:false, previous_loan_id:previous?.id||null
    });
    if(error) throw error;
    form.reset(); await loadAll();
    showMessage("नया Loan सफलतापूर्वक सेव हुआ। पुराना Loan अलग history में सुरक्षित है।","success");
  } catch(err) { showMessage("नया Loan सेव नहीं हुआ: "+(err?.message||String(err)),"error"); }
  finally { setBusy(btn,false); }
}
function updateRepeatLoanOptions() {
  const customerId=$("newLoanCustomer")?.value;
  const closed=loans.filter(l=>l.customer_id===customerId && l.status==="closed");
  if($("newLoanPrevious")) $("newLoanPrevious").innerHTML='<option value="">नया Loan / कोई पिछला Loan नहीं</option>'+closed.map(l=>'<option value="'+esc(l.id)+'">'+esc(l.loan_reference)+' · बंद</option>').join("");
}
function updateClosurePaymentOptions() {
  const loanId=$("closeLoanSelect")?.value;
  const rows=payments.filter(p=>p.loan_id===loanId && p.id && !p.is_reversal && !p.offline_pending);
  if($("closeFinalPayment")) $("closeFinalPayment").innerHTML='<option value="">अंतिम रसीद चुनें</option>'+rows.map(p=>'<option value="'+esc(p.id)+'">'+esc((p.id||"").slice(0,8).toUpperCase())+' · '+money(p.amount)+' · '+esc(formatDate(p.paid_at))+'</option>').join("");
}
async function submitLoanClosure(event) {
  event.preventDefault();
  if(!canAdmin()) return showMessage("Loan बंद करने का अधिकार केवल Admin को है।","warn");
  const form=event.currentTarget, btn=form.querySelector('[type="submit"]'), d=Object.fromEntries(new FormData(form));
  const loan=loans.find(l=>l.id===d.loan_id && l.status==="active");
  const payment=payments.find(p=>p.id===d.final_payment_id && p.loan_id===d.loan_id && !p.is_reversal && !p.offline_pending);
  if(!loan || !payment) return showMessage("सही Active Loan और उसी की सेव हुई अंतिम रसीद चुनें।","warn");
  const figures=loanFigures(loan,paymentsByLoan());
  const beforeFinal=Math.max(0,figures.outstanding+Number(payment.amount||0));
  if(figures.outstanding>0.01) return showMessage("Loan अभी बंद नहीं हो सकता। वर्तमान बकाया "+money(figures.outstanding)+" है। पहले पूरा भुगतान दर्ज करें।","warn");
  if(Number(payment.amount||0)<=0 || beforeFinal<=0.01) return showMessage("अंतिम रसीद की राशि जाँचें।","warn");
  setBusy(btn,true,"Loan बंद हो रहा है…");
  try {
    const {data,error}=await supabase.rpc("close_loan_after_final_payment",{
      p_loan_id:loan.id,p_final_payment_id:payment.id,
      p_closure_date:d.closure_date||localDateValue(),p_reason:d.reason||null
    });
    if(error) throw error;
    await loadAll();
    showMessage("Loan बंद हो गया। Final payment से पहले बकाया "+money(data?.outstanding_before_final)+" था। अब इसी ग्राहक का Repeat Loan अलग से बनाया जा सकता है।","success");
  } catch(err) { showMessage("Loan बंद नहीं हुआ: "+(err?.message||String(err)),"error"); }
  finally { setBusy(btn,false); }
}

let verificationPhotoFile = null;
let verificationSignatureFile = null;
const maskedIdentityDocs = {aadhaarFront:null,aadhaarBack:null,panFront:null};
const identityDocEditors = {};
let verificationHomePhoto1 = null, verificationHomePhoto2 = null;
let verificationCameraStream = null, verificationCameraTarget = null;
let verificationLocation = null;
let lastVerificationId = null;
let existingCustomerVerification = null;

function stopVerificationCamera() {
  if (verificationCameraStream) verificationCameraStream.getTracks().forEach(track=>track.stop());
  verificationCameraStream=null;
  const video=$("verificationCameraVideo"); if(video) video.srcObject=null;
  $("verificationCameraModal")?.classList.add("hidden");
}
async function openVerificationCamera(target) {
  verificationCameraTarget=target;
  const modal=$("verificationCameraModal"),video=$("verificationCameraVideo"),error=$("verificationCameraError");
  modal?.classList.remove("hidden"); if(error) error.textContent="कैमरा अनुमति की प्रतीक्षा…";
  try {
    if(!navigator.mediaDevices?.getUserMedia) throw new Error("इस browser में live camera उपलब्ध नहीं है। Gallery विकल्प इस्तेमाल करें।");
    verificationCameraStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:"environment"}},audio:false});
    video.srcObject=verificationCameraStream; await video.play(); if(error) error.textContent="";
  } catch(err) { if(error) error.textContent=(err?.message||"कैमरा नहीं खुला।") + " कृपया Camera permission दें या Gallery चुनें।"; }
}
function setVerificationPhotoFor(target,file) {
  if(!file) return;
  if(!file.type.startsWith("image/")) return showMessage("कृपया फोटो फ़ाइल चुनें।","warn");
  if(file.size>5*1024*1024) return showMessage("हर फोटो 5 MB से छोटी होनी चाहिए।","warn");
  const map={customer:["verificationPhotoPreview","verificationPhotoStatus"],home1:["verificationHome1Preview","verificationHome1Status"],home2:["verificationHome2Preview","verificationHome2Status"]};
  if(target==="customer") verificationPhotoFile=file;
  if(target==="home1") verificationHomePhoto1=file;
  if(target==="home2") verificationHomePhoto2=file;
  const [previewId,statusId]=map[target],preview=$(previewId);
  if(preview.dataset.objectUrl) URL.revokeObjectURL(preview.dataset.objectUrl);
  preview.dataset.objectUrl=URL.createObjectURL(file); preview.src=preview.dataset.objectUrl; preview.classList.remove("hidden");
  $(statusId).textContent="फोटो तैयार: "+file.name;
}
function captureVerificationCameraPhoto() {
  const video=$("verificationCameraVideo");
  if(!video?.videoWidth) return $("verificationCameraError").textContent="कैमरा तैयार नहीं है।";
  const canvas=document.createElement("canvas"); canvas.width=video.videoWidth; canvas.height=video.videoHeight;
  canvas.getContext("2d").drawImage(video,0,0,canvas.width,canvas.height);
  canvas.toBlob(blob=>{
    if(!blob) return showMessage("कैमरा फोटो तैयार नहीं हुई।","error");
    const file=new File([blob],"AJSF-"+verificationCameraTarget+"-"+Date.now()+".jpg",{type:"image/jpeg"});
    setVerificationPhotoFor(verificationCameraTarget,file); stopVerificationCamera();
  },"image/jpeg",0.88);
}

function setupIdentityDocEditor(key) {
  const input=$("doc-"+key), canvas=$("canvas-"+key), status=$("status-"+key), confirm=$("confirm-"+key);
  const rotateBtn=document.querySelector('[data-rotate-doc="'+key+'"]');
  if(!input||!canvas||!status||!confirm) return;
  const ctx=canvas.getContext("2d");
  let image=null, start=null, rect=null, masked=false, rotation=0;
  const redraw=()=>{
    if(!image)return;
    const swap=rotation%180!==0;
    canvas.width=swap?image.naturalHeight:image.naturalWidth;
    canvas.height=swap?image.naturalWidth:image.naturalHeight;
    ctx.save();
    if(rotation===90){ctx.translate(canvas.width,0);ctx.rotate(Math.PI/2);}
    else if(rotation===180){ctx.translate(canvas.width,canvas.height);ctx.rotate(Math.PI);}
    else if(rotation===270){ctx.translate(0,canvas.height);ctx.rotate(-Math.PI/2);}
    ctx.drawImage(image,0,0);
    ctx.restore();
    if(rect){ctx.fillStyle="#000";ctx.fillRect(rect.x,rect.y,rect.w,rect.h);}
  };
  const resetMask=()=>{
    rect=null;masked=false;maskedIdentityDocs[key]=null;
    confirm.checked=false;confirm.disabled=true;
  };
  input.addEventListener("change",()=>{
    const file=input.files?.[0];if(!file)return;
    if(!file.type.startsWith("image/")||file.size>8*1024*1024){status.textContent="कृपया 8 MB से छोटी image चुनें।";input.value="";return;}
    const url=URL.createObjectURL(file);image=new Image();
    image.onload=()=>{rotation=0;resetMask();redraw();status.textContent="फोटो सही दिशा में करें। फिर नंबर वाले हिस्से पर ड्रैग करके काला बॉक्स बनाएं।";URL.revokeObjectURL(url);};
    image.onerror=()=>{status.textContent="यह image पढ़ी नहीं जा सकी।";URL.revokeObjectURL(url);};image.src=url;
  });
  rotateBtn?.addEventListener("click",()=>{
    if(!image){status.textContent="पहले पहचान-पत्र की फोटो चुनें।";return;}
    rotation=(rotation+90)%360;resetMask();redraw();
    status.textContent="फोटो 90° घुमा दी गई। अब नंबर वाले हिस्से पर नया मास्क लगाएं।";
  });
  const point=e=>{const r=canvas.getBoundingClientRect();return{x:Math.max(0,Math.min(canvas.width,(e.clientX-r.left)*canvas.width/r.width)),y:Math.max(0,Math.min(canvas.height,(e.clientY-r.top)*canvas.height/r.height))};};
  canvas.addEventListener("pointerdown",e=>{
    if(!image)return;
    e.preventDefault();canvas.setPointerCapture(e.pointerId);start=point(e);rect={x:start.x,y:start.y,w:0,h:0};redraw();
  });
  canvas.addEventListener("pointermove",e=>{
    if(!start)return;const p=point(e);rect={x:Math.min(start.x,p.x),y:Math.min(start.y,p.y),w:Math.abs(p.x-start.x),h:Math.abs(p.y-start.y)};redraw();
  });
  const finish=()=>{
    if(!start)return;start=null;
    if(!rect||rect.w<canvas.width*.015||rect.h<canvas.height*.008){rect=null;redraw();status.textContent="मास्क थोड़ा बड़ा बनाएं और पूरा नंबर ढकें।";return;}
    redraw();masked=true;confirm.disabled=false;confirm.checked=false;
    status.textContent="काला मास्क दिख रहा है। अब नीचे पुष्टि वाले बॉक्स पर टिक करें।";
  };
  canvas.addEventListener("pointerup",finish);
  canvas.addEventListener("pointercancel",finish);
  confirm.addEventListener("change",()=>{
    if(!confirm.checked||!masked)return;
    canvas.toBlob(blob=>{
      if(!blob){confirm.checked=false;status.textContent="Masked image तैयार नहीं हुई।";return;}
      maskedIdentityDocs[key]=new File([blob],"AJSF-"+key+"-masked.png",{type:"image/png"});
      status.textContent="Masked copy तैयार और पुष्टि की गई। केवल यही सेव होगी।";
    },"image/png");
  });
}

function resetCustomerVerificationForm() {
  verificationPhotoFile=null; verificationSignatureFile=null; verificationHomePhoto1=null; verificationHomePhoto2=null;
  Object.keys(maskedIdentityDocs).forEach(k=>{maskedIdentityDocs[k]=null;if($("doc-"+k))$("doc-"+k).value="";if($("confirm-"+k))$("confirm-"+k).checked=false;if($("canvas-"+k)){const c=$("canvas-"+k);c.getContext("2d").clearRect(0,0,c.width,c.height);c.width=0;c.height=0;}if($("status-"+k))$("status-"+k).textContent="फोटो चुनें और नंबर पर काला मास्क लगाएं।";});
  verificationLocation=null; lastVerificationId=null; existingCustomerVerification=null;
  if($("verificationHistory")){$("verificationHistory").innerHTML="";$("verificationHistory").classList.add("hidden");}
  ["verificationGallery","verificationHome1Gallery","verificationHome2Gallery"].forEach(id=>{if($(id)) $(id).value="";});
  [["verificationPhotoPreview","verificationPhotoStatus","ग्राहक की स्पष्ट फोटो अनिवार्य है।"],["verificationHome1Preview","verificationHome1Status","घर का सामने वाला हिस्सा"],["verificationHome2Preview","verificationHome2Status","घर का दूसरा स्पष्ट एंगल"]].forEach(([p,s,msg])=>{if($(p)){$(p).src="";$(p).classList.add("hidden");}if($(s))$(s).textContent=msg;});
  if($("verificationLocationStatus")) $("verificationLocationStatus").textContent="अभी GPS Location नहीं ली गई है।";
  if($("verificationMessage")) $("verificationMessage").textContent="";
  if($("openVerificationPdf")) $("openVerificationPdf").disabled=true;
  if($("saveCustomerVerification")) $("saveCustomerVerification").textContent="Verification सेव करें और PDF बनाएं";
  if($("verificationNotes")) $("verificationNotes").value="";
  ["familyMotherName","familyMaritalStatus","familySpouseName","familyMaidenVillage","familyMaidenPost","familyMaidenTehsil","familyMaidenDistrict","familyMaidenState","familyBrothers","familySisters","familyFatherInLaw","familyMotherInLaw","familyBrothersInLaw","familySistersInLaw","familySons","familyDaughters","familyChildrenNames","familyOtherMembers","familyOtherNotes"].forEach(id=>{if($(id))$(id).value="";});
  if($("verificationSignaturePreview")){$("verificationSignaturePreview").src="";$("verificationSignaturePreview").classList.add("hidden");}
  if($("verificationSignatureStatus"))$("verificationSignatureStatus").textContent="ग्राहक के हस्ताक्षर की फोटो अपलोड करें (वैकल्पिक)।";
  if($("verificationSignatureGallery"))$("verificationSignatureGallery").value="";
}
async function loadCustomerVerification(customerId) {
  resetCustomerVerificationForm();
  if(!customerId) return;
  const msg=$("verificationMessage");
  if(msg) msg.textContent="पुराना Verification रिकॉर्ड खोजा जा रहा है…";
  try {
    const {data:history,error}=await supabase.from("customer_verifications").select("*").eq("customer_id",customerId).order("verified_at",{ascending:false});
    if(error) throw error;
    const records=history||[];
    const historyBox=$("verificationHistory");
    if(historyBox) {
      historyBox.innerHTML=records.length?'<div class="small muted">पुराने Verification / PDF रिकॉर्ड:</div>'+records.map((r,i)=>'<button type="button" class="secondary verification-history-item" data-verification-id="'+esc(r.id)+'">PDF '+(i+1)+' · '+esc(formatDate(r.verified_at||r.created_at))+'</button>').join(" "):"";
      historyBox.classList.toggle("hidden",!records.length);
    }
    const data=records[0];
    if(!data) { if(msg) msg.textContent="इस ग्राहक का Verification अभी नहीं हुआ है। नया Verification किया जा सकता है।"; return; }
    existingCustomerVerification=data; lastVerificationId=data.id;
    const signatureUrl=data.customer_signature_path?await (async()=>{const r=await supabase.storage.from("customer-verification").createSignedUrl(data.customer_signature_path,300);if(r.error)throw r.error;return r.data.signedUrl;})():"";
    if(signatureUrl&&$("verificationSignaturePreview")){$("verificationSignaturePreview").src=signatureUrl;$("verificationSignaturePreview").classList.remove("hidden");if($("verificationSignatureStatus"))$("verificationSignatureStatus").textContent="ग्राहक के हस्ताक्षर पहले से सेव हैं। नया अपलोड करने पर बदलेंगे।";}
    const signed=async path=>{if(!path)return "";const r=await supabase.storage.from("customer-verification").createSignedUrl(path,300);if(r.error)throw r.error;return r.data.signedUrl;};
    const [photo,home1,home2,af,ab,pan]=await Promise.all([signed(data.photo_path),signed(data.home_photo1_path),signed(data.home_photo2_path),signed(data.aadhaar_front_masked_path),signed(data.aadhaar_back_masked_path),signed(data.pan_front_masked_path)]);
    [["verificationPhotoPreview","verificationPhotoStatus",photo,"ग्राहक की पुरानी फोटो सेव है।"],["verificationHome1Preview","verificationHome1Status",home1,"घर की फोटो 1 सेव है।"],["verificationHome2Preview","verificationHome2Status",home2,"घर की फोटो 2 सेव है।"]].forEach(([p,st,url,label])=>{if(url){$(p).src=url;$(p).classList.remove("hidden");$(st).textContent=label;}});
    [["aadhaarFront",af],["aadhaarBack",ab],["panFront",pan]].forEach(([k,url])=>{if(url&&$("status-"+k))$("status-"+k).textContent="पहले से masked document सेव है — नया दस्तावेज़ चुनने पर ही बदलेगा।";});
    verificationLocation=data.latitude!=null&&data.longitude!=null?{latitude:data.latitude,longitude:data.longitude,accuracy_meters:data.accuracy_meters,captured_at:data.location_captured_at}:null;
    if($("verificationLocationStatus")) $("verificationLocationStatus").textContent=verificationLocation?"पुरानी GPS लोकेशन रिकॉर्ड में उपलब्ध है · "+Number(data.latitude).toFixed(6)+", "+Number(data.longitude).toFixed(6):"पुराने रिकॉर्ड में GPS उपलब्ध नहीं है।";
    if($("verificationNotes")) $("verificationNotes").value=data.notes||"";
    const fd=data.family_details||{};
    const familyMap={familyMotherName:"mother_name",familyMaritalStatus:"marital_status",familySpouseName:"spouse_name",familyMaidenVillage:"maiden_village",familyMaidenPost:"maiden_post",familyMaidenTehsil:"maiden_tehsil",familyMaidenDistrict:"maiden_district",familyMaidenState:"maiden_state",familyBrothers:"brothers_count",familySisters:"sisters_count",familyFatherInLaw:"father_in_law",familyMotherInLaw:"mother_in_law",familyBrothersInLaw:"brothers_in_law",familySistersInLaw:"sisters_in_law",familySons:"sons_count",familyDaughters:"daughters_count",familyChildrenNames:"children_names",familyOtherMembers:"other_members",familyOtherNotes:"other_notes"};
    Object.entries(familyMap).forEach(([id,key])=>{if($(id)&&fd[key]!=null)$(id).value=fd[key];});
    if($("verificationConsent")) $("verificationConsent").checked=!!data.consent_given;
    if($("openVerificationPdf")) $("openVerificationPdf").disabled=false;
    if($("saveCustomerVerification")) $("saveCustomerVerification").textContent="पुराना Verification Edit / Update करें";
    if(msg) {msg.textContent="पुराना Verification मिल गया। PDF देखें या आवश्यक बदलाव करके Update करें।";msg.className="message success";}
  } catch(error) { if(msg){msg.textContent="पुराना Verification लोड नहीं हुआ: "+(error?.message||String(error));msg.className="message error";} }
}
function openCustomerVerification(customerId) {
  if (!currentUser) return;
  stopVerificationCamera(); activateTab("customer-verification");
  const select=$("verificationCustomer"); if(select) select.value=customerId||"";
  loadCustomerVerification(customerId||"");
}
function captureVerificationGps() {
  const status = $("verificationLocationStatus");
  if (!navigator.geolocation) { status.textContent = "इस डिवाइस / Browser में GPS उपलब्ध नहीं है।"; return; }
  status.textContent = "GPS Location ली जा रही है…";
  navigator.geolocation.getCurrentPosition(position => {
    verificationLocation = {
      latitude: position.coords.latitude, longitude: position.coords.longitude,
      accuracy_meters: position.coords.accuracy, captured_at: new Date(position.timestamp || Date.now()).toISOString()
    };
    const accuracy = verificationLocation.accuracy_meters;
    const quality = accuracy <= 100 ? "अच्छी लोकेशन" : accuracy <= 500 ? "कमज़ोर लोकेशन" : "बहुत कमज़ोर GPS";
    status.textContent = quality + " · Accuracy " + Math.round(accuracy) + " मीटर · " +
      verificationLocation.latitude.toFixed(6) + ", " + verificationLocation.longitude.toFixed(6) +
      (accuracy > 100 ? " · बेहतर GPS के लिए खुले स्थान पर दोबारा Fetch करें।" : " · लोकेशन स्वीकार्य है।");
    status.style.color = accuracy <= 100 ? "#176b4b" : "#b45309";
  }, error => {
    verificationLocation = null;
    status.textContent = error.code === 1 ? "Location Permission नहीं मिली। Browser Settings में अनुमति दें।" : "GPS Location नहीं मिल सकी। खुले स्थान पर दोबारा प्रयास करें।";
  }, { enableHighAccuracy:true, timeout:20000, maximumAge:0 });
}
function verificationPdfHtml(customer, verification, photoUrl, homePhoto1Url, homePhoto2Url, aadhaarFrontUrl, aadhaarBackUrl, panFrontUrl, signatureUrl) {
  const maps = verification.latitude != null && verification.longitude != null
    ? "https://www.google.com/maps?q=" + encodeURIComponent(verification.latitude + "," + verification.longitude) : "";
  const accuracy = verification.accuracy_meters == null ? null : Number(verification.accuracy_meters);
  const accuracyLabel = accuracy == null ? "GPS उपलब्ध नहीं" : accuracy <= 100 ? "GOOD · अच्छी सटीकता" : accuracy <= 500 ? "FAIR · सीमित सटीकता" : "LOW · कमजोर GPS";
  const accuracyNote = accuracy == null
    ? "इस सत्यापन में GPS लोकेशन रिकॉर्ड नहीं हुई।"
    : accuracy <= 100
      ? "GPS सटीकता 100 मीटर के भीतर है।"
      : "चेतावनी: GPS सटीकता 100 मीटर से अधिक है। यह लोकेशन अनुमानित हो सकती है। खुले स्थान पर दोबारा GPS लेकर सत्यापन अपडेट करें।";
  const img = photoUrl
    ? '<img class="customer-photo" src="' + photoUrl + '" alt="Customer verification photo">'
    : '<div class="customer-photo photo-placeholder">CUSTOMER PHOTO NOT AVAILABLE</div>';
  const homePhotos = `<section class="section"><div class="section-head">CUSTOMER HOUSE PHOTOGRAPHS</div><div class="home-photo-grid"><div><img src="${homePhoto1Url}" alt="House front view"><b>घर की फोटो 1 — सामने से</b></div><div><img src="${homePhoto2Url}" alt="House second angle"><b>घर की फोटो 2 — दूसरा एंगल</b></div></div></section>`;
  const fd=verification.family_details||{};
  const familyLabels={mother_name:"माता का नाम",marital_status:"वैवाहिक स्थिति",spouse_name:"पति / पत्नी",maiden_village:"मूल परिवार का गाँव / शहर",maiden_post:"मूल परिवार का पोस्ट",maiden_tehsil:"मूल परिवार की तहसील",maiden_district:"मूल परिवार का जिला",maiden_state:"मूल परिवार का राज्य",brothers_count:"भाई",sisters_count:"बहनें",father_in_law:"ससुर",mother_in_law:"सास",brothers_in_law:"देवर",sisters_in_law:"ननद",sons_count:"पुत्र",daughters_count:"पुत्रियाँ",children_names:"बच्चों के नाम",other_members:"अन्य परिवार सदस्य",other_notes:"अन्य जानकारी"};
  const familyRows=Object.entries(familyLabels).filter(([key])=>fd[key]!==undefined&&fd[key]!==null&&String(fd[key]).trim()!=="").map(([key,label])=>'<div class="line"><span class="label">'+label+'</span><span class="value">'+esc(fd[key])+'</span></div>').join("");
  const familySection=familyRows?'<section class="section family-section"><div class="section-head">मूल परिवार का विवरण · पारिवारिक जानकारी</div><div class="family-intro">ग्राहक द्वारा उपलब्ध कराई गई पारिवारिक जानकारी</div><div class="rows family-rows">'+familyRows+'</div></section>':"";
  const identityDocs = `<section class="section identity-section"><div class="section-head">IDENTITY DOCUMENTS · MASKED COPIES</div><div class="identity-grid"><div><img src="${aadhaarFrontUrl}" alt="Masked Aadhaar Front"><b>Aadhaar Front — Masked</b></div><div><img src="${aadhaarBackUrl}" alt="Masked Aadhaar Back"><b>Aadhaar Back — Masked</b></div>${panFrontUrl?`<div><img src="${panFrontUrl}" alt="PAN Front"><b>PAN Card — Front</b></div>`:""}</div><p class="privacy-note">Aadhaar numbers are masked in the saved copies. PAN card is shown as uploaded. Original unmasked Aadhaar files are not stored.</p></section>`;
  const verificationId = verification.id || verification.verification_id || "—";
  const signatureBlock = signatureUrl ? '<img src="' + signatureUrl + '" alt="Customer Signature" style="display:block;max-width:100%;height:22mm;object-fit:contain;margin:0 auto 4px">' : '<div style="height:22mm;display:flex;align-items:center;justify-content:center;color:#87958d;font-size:8px">हस्ताक्षर अपलोड नहीं किए गए</div>';
  const verifiedAt = formatDate(verification.verified_at || new Date().toISOString());
  const gpsTone = accuracy == null || accuracy > 100 ? "warning" : "good";
  return `<!doctype html><html lang="hi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><base href="${esc(document.baseURI)}"><title>AJSF Customer Verification Report</title><style>
  @page{size:A4 portrait;margin:7mm}
  *{box-sizing:border-box}
  html,body{margin:0;padding:0;background:#fff}
  body{font-family:Arial,"Noto Sans Devanagari",sans-serif;color:#1d3028;font-size:8.5px;line-height:1.22}
  .sheet{width:100%;max-width:196mm;margin:0 auto}
  .pdf-page{width:100%;min-height:282mm;position:relative}
  .pdf-page+.pdf-page{break-before:page;page-break-before:always;padding-top:2mm}
  .page-kicker{font-size:9px;font-weight:800;letter-spacing:.7px;color:#174c3c;background:#edf5f0;border-left:3px solid #23805e;padding:7px 10px;margin:0 0 8px;border-radius:4px}
  .masthead{display:flex;align-items:center;gap:13px;padding:0 0 10px;border-bottom:3px solid #174c3c}
  .logo{width:46px;height:46px;object-fit:contain;flex:0 0 46px}
  .brand-name{font-size:17px;font-weight:800;letter-spacing:.2px;color:#123f35;line-height:1.2}
  .brand-tag{font-size:9px;letter-spacing:1px;color:#527367;font-weight:700;margin-top:5px}
  .doc-meta{margin-left:auto;text-align:right;font-size:9px;color:#65766e}
  .doc-meta strong{display:block;color:#174c3c;font-size:10px;margin-bottom:3px}
  .title-wrap{text-align:center;padding:6px 0 5px}
  .eyebrow{font-size:8px;letter-spacing:1.5px;color:#6b8579;font-weight:700}
  h1{font-size:13px;letter-spacing:.5px;color:#123f35;margin:3px 0 0}
  .subtitle{font-size:9px;color:#6a7d73;margin-top:3px}
  .customer-card{display:grid;grid-template-columns:48mm 1fr;gap:10px;padding:9px;border:1px solid #d8e4dc;border-radius:8px;background:#fbfdfb;align-items:stretch}
  .photo-frame{border:1px solid #cbd9d0;border-radius:5px;background:#eef4f0;padding:3px;display:flex;align-items:center;justify-content:center;min-height:66mm}
  .customer-photo{display:block;width:100%;height:64mm;object-fit:contain;object-position:center;border-radius:3px;background:#edf3ef}
  .home-photo-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px}.home-photo-grid img{width:100%;height:66mm;object-fit:contain;border:1px solid #cbd9d0;border-radius:5px}.home-photo-grid b{display:block;text-align:center;font-size:8px;margin-top:4px;color:#52685d}.photo-placeholder{display:flex;align-items:center;justify-content:center;text-align:center;color:#74857c;font-size:10px;font-weight:700;letter-spacing:.5px;padding:10px}
  .photo-caption{text-align:center;font-size:8px;color:#62766b;margin-top:5px;font-weight:700}
  .details{min-width:0}
  .section-title{display:flex;align-items:center;gap:7px;color:#174c3c;font-size:10px;font-weight:800;letter-spacing:.5px;margin:0 0 6px}
  .section-title:before{content:"";width:3px;height:13px;background:#23805e;border-radius:2px}
  .detail-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px}
  .detail{padding:4px 6px;border:1px solid #e2eae5;border-radius:5px;background:#fff;min-width:0}
  .detail.wide{grid-column:1/-1}
  .detail small{display:block;color:#718278;font-size:8px;margin-bottom:2px}
  .detail strong{display:block;color:#253a30;font-size:10px;overflow-wrap:anywhere}
  .section{margin-top:12px}
  .section-head{font-size:8.5px;font-weight:800;color:#174c3c;padding:8px 10px;background:#edf5f0;border:1px solid #d9e7dd;border-left:3px solid #23805e;border-radius:4px;margin-bottom:5px;letter-spacing:.35px}
  .rows{display:grid;grid-template-columns:1fr 1fr;gap:0 14px}
  .line{display:grid;grid-template-columns:90px 1fr;gap:7px;padding:6px 4px;border-bottom:1px solid #e7ede9;min-width:0}
  .label{color:#64766c;font-weight:700}
  .value{color:#263a30;overflow-wrap:anywhere}
  .gps-panel{padding:9px 11px;border:1px solid ${gpsTone==="warning"?"#e8c58b":"#b9d9c7"};background:${gpsTone==="warning"?"#fff8eb":"#f0f8f3"};border-radius:5px;margin-top:7px}
  .gps-panel strong{display:block;color:${gpsTone==="warning"?"#89520c":"#176b4b"};font-size:10px}
  .gps-panel p{margin:3px 0 0;color:#665b49;font-size:8.5px}
  .map-link{display:inline-block;color:#176b4b;font-weight:700;text-decoration:underline}
  .verification-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
  .verification-grid .detail{padding:10px 12px}
  .signatures{display:grid;grid-template-columns:1fr 1fr;gap:25px;margin:22px 4px 0}
  .signature{border-top:1px solid #65766d;text-align:center;padding-top:6px;color:#4c6257;font-size:9px;min-height:25px}
  .footer{margin-top:7px;padding-top:5px;border-top:1px solid #dce6df;display:flex;justify-content:space-between;gap:12px;color:#738279;font-size:8px}
  .footer strong{color:#174c3c}
  .actions{display:flex;justify-content:center;gap:8px;margin:8px 0}
  .actions button{border:0;border-radius:5px;background:#174c3c;color:#fff;padding:9px 18px;font-weight:700;cursor:pointer}
  .identity-grid{display:grid!important;grid-template-columns:repeat(3,minmax(0,1fr))!important;gap:9px!important;align-items:start}\n  .family-section{padding:10px 12px 12px;border:1px solid #d8e7de;border-radius:8px;background:linear-gradient(135deg,#f4faf6 0%,#fff 72%);box-shadow:0 2px 7px #174c3c0c}\n  .family-section .section-head{font-size:11px;padding:10px 12px;margin-bottom:7px}\n  .family-intro{font-size:9px;color:#718278;margin:0 2px 7px}\n  .family-rows{gap:2px 18px}\n  .family-rows .line{grid-template-columns:minmax(100px,42%) 1fr;gap:8px;padding:7px 6px;border:1px solid #e5eee8;border-radius:4px;background:#fff;margin-bottom:3px}\n  .family-rows .label{font-size:10px;color:#466557}\n  .family-rows .value{font-size:11px;font-weight:700;color:#1f3d30}\n  .identity-grid img{height:48mm!important;max-height:48mm!important}
  .identity-grid>div{min-width:0;break-inside:avoid;page-break-inside:avoid}
  .identity-grid img{display:block!important;width:100%!important;height:66mm!important;max-height:66mm!important;object-fit:contain!important;object-position:center!important;border:1px solid #cbd9d0;border-radius:4px;background:#fff}
  .identity-grid b{display:block;text-align:center;font-size:7px;margin-top:2px;color:#52685d}
  .privacy-note{font-size:7px;color:#52685d;margin:3px 0 0}
  .identity-section{break-inside:avoid;page-break-inside:avoid}
  .page-two-title{font-size:12px;color:#123f35;margin:0 0 8px;font-weight:800}
  .page-two-subtitle{font-size:8.5px;color:#6a7d73;margin:-4px 0 14px}\n  .page-two-title{font-size:14px;margin-bottom:10px}\n  .page-two-title~.page-two-subtitle{line-height:1.5}\n  .verification-grid{gap:11px}\n  .verification-grid .detail{padding:10px 12px}\n  .signature img{max-width:68mm!important;max-height:38mm!important;object-fit:contain!important}\n  .privacy-note{font-size:7.5px;margin:5px 0 0}
  .pdf-page-two{display:flex;flex-direction:column}\n  .pdf-page-two .signatures{margin-top:auto;padding-top:14mm}\n  .pdf-page-two .footer{margin-top:10mm;padding-top:8px}\n  @media print{.actions{display:none}.pdf-page{min-height:282mm!important;break-inside:avoid!important;page-break-inside:avoid!important}.pdf-page+.pdf-page{break-before:page!important;page-break-before:always!important}body{padding:0!important;print-color-adjust:exact;-webkit-print-color-adjust:exact}.sheet{max-width:none!important;padding:0!important;box-shadow:none!important;border-radius:0!important}.identity-section,.identity-grid,.customer-card,.masthead,.title-wrap{break-inside:avoid!important;page-break-inside:avoid!important}}
  @media screen{body{padding:8px;background:#eef3f0}.sheet{background:#fff;padding:6mm;box-shadow:0 4px 24px #102b1d18;border-radius:8px}}
  </style></head><body><main class="sheet">
  <section class="pdf-page pdf-page-one"><header class="masthead"><img class="logo" src="./assets/ajsf-logo.png" alt="AJSF Logo"><div><div class="brand-name">ARK JAN SAMRIDDHI FOUNDATION</div><div class="brand-tag">SAPNE AAPKE SATH HAMARA HAI</div></div><div class="doc-meta"><strong>OFFICIAL FIELD RECORD</strong>Customer Verification<br>Confidential Document</div></header>
  <div class="title-wrap"><div class="eyebrow">CUSTOMER DUE DILIGENCE & FIELD CHECK</div><h1>CUSTOMER VERIFICATION REPORT</h1><div class="subtitle">ग्राहक पहचान एवं फील्ड सत्यापन रिपोर्ट</div></div>
  <section class="customer-card"><div><div class="photo-frame">${img}</div><div class="photo-caption">CUSTOMER PHOTOGRAPH</div></div><div class="details"><div class="section-title">CUSTOMER PROFILE</div><div class="detail-grid">
    <div class="detail"><small>Customer ID</small><strong>${esc(formatCustomerId(customer.customer_code))}</strong></div>
    <div class="detail"><small>Customer Name</small><strong>${esc(customer.full_name)}</strong></div>
    <div class="detail"><small>Mobile Number</small><strong>${esc(customer.contact_number || "—")}</strong></div>
    <div class="detail"><small>Center / Group</small><strong>${esc(customer.center_name || "—")}</strong></div>
    <div class="detail"><small>Collection Day</small><strong>${esc(customer.collection_day || "—")}</strong></div>
    <div class="detail"><small>Area</small><strong>${esc(customer.area || "—")}</strong></div>
    <div class="detail wide"><small>Residential Address</small><strong>${esc(customer.address || "—")}</strong></div>
  </div></div></section>
  ${homePhotos}
  ${familySection}
  </section><section class="pdf-page pdf-page-two"><div class="page-kicker">AJSF CUSTOMER VERIFICATION · FIELD RECORD</div><div class="page-two-title">FIELD DOCUMENTS & VERIFICATION</div><div class="page-two-subtitle">पहचान दस्तावेज़, GPS लोकेशन और सत्यापन रिकॉर्ड</div>
  ${identityDocs}
  <section class="section"><div class="section-head">FIELD GPS & LOCATION VERIFICATION</div><div class="rows">
    <div class="line"><span class="label">Latitude</span><span class="value">${verification.latitude ?? "Not captured"}</span></div>
    <div class="line"><span class="label">Longitude</span><span class="value">${verification.longitude ?? "Not captured"}</span></div>
    <div class="line"><span class="label">GPS Accuracy</span><span class="value">${accuracy == null ? "Not available" : Math.round(accuracy) + " metres"}</span></div>
    <div class="line"><span class="label">Map Location</span><span class="value">${maps ? '<a class="map-link" href="' + maps + '">Open in Google Maps</a>' : "Not captured"}</span></div>
  </div><div class="gps-panel"><strong>${accuracyLabel}</strong><p>${esc(accuracyNote)} GPS Accuracy डिवाइस और नेटवर्क के अनुसार बदल सकती है; यह वास्तविक रूप से रिकॉर्ड की गई रीडिंग है।</p></div></section>
  <section class="section"><div class="section-head">VERIFICATION RECORD & CONSENT</div><div class="verification-grid">
    <div class="detail"><small>Verification Date & Time</small><strong>${esc(verifiedAt)}</strong></div>
    <div class="detail"><small>Verified By</small><strong>${esc(verification.verified_by_name || "AJSF Staff")}</strong></div>
    <div class="detail"><small>Verification Reference</small><strong>${esc(String(verificationId).slice(0,18))}</strong></div>
    <div class="detail"><small>Customer Consent</small><strong>Recorded</strong></div>
    <div class="detail wide"><small>Field Officer Remarks</small><strong>${esc(verification.notes || "No additional remarks")}</strong></div>
  </div></section>
  <div class="signatures"><div class="signature">${signatureBlock}Customer Signature</div><div class="signature">Verified By / AJSF Representative</div></div>
  <footer class="footer"><span><strong>AJSF CUSTOMER VERIFICATION</strong><br>यह दस्तावेज़ ग्राहक की सहमति से रिकॉर्ड किए गए विवरण पर आधारित है।</span><span>Generated by AJSF Online<br>Keep this record confidential</span></footer>
  <div class="actions"><button onclick="window.print()">Print / Save as PDF</button></div>
  </section></main></body></html>`;
}
async function openVerificationPdf(verificationId, existingWindow) {
  const id = verificationId || lastVerificationId;
  if (!id) return showMessage("पहले Customer Verification सेव करें।","warn");
  const win = existingWindow || window.open("", "_blank");
  if (!win) return showMessage("Popup blocked है। इस पेज के Popups Allow करके PDF बटन दोबारा दबाएँ।","warn");
  try {
    const {data,error}=await supabase.from("customer_verifications").select("*").eq("id",id).single();
    if(error) throw error;
    const customer=customers.find(c=>c.id===data.customer_id);
    if(!customer) throw new Error("ग्राहक रिकॉर्ड नहीं मिला।");
    const signPhoto=async path=>{if(!path) return "";const signed=await supabase.storage.from("customer-verification").createSignedUrl(path,300);if(signed.error) throw signed.error;return signed.data.signedUrl;};
    const [photoUrl,homePhoto1Url,homePhoto2Url,aadhaarFrontUrl,aadhaarBackUrl,panFrontUrl,signatureUrl]=await Promise.all([signPhoto(data.photo_path),signPhoto(data.home_photo1_path),signPhoto(data.home_photo2_path),signPhoto(data.aadhaar_front_masked_path),signPhoto(data.aadhaar_back_masked_path),signPhoto(data.pan_front_masked_path),signPhoto(data.customer_signature_path)]);
    win.document.open(); win.document.write(verificationPdfHtml(customer,data,photoUrl,homePhoto1Url,homePhoto2Url,aadhaarFrontUrl,aadhaarBackUrl,panFrontUrl,signatureUrl)); win.document.close();
  } catch(err) { win.close(); showMessage("PDF नहीं खुली: "+(err?.message||String(err)),"error"); }
}
async function submitCustomerVerification(event) {
  event.preventDefault();
  const btn=$("saveCustomerVerification");
  const customerId=$("verificationCustomer").value;
  const customer=customers.find(c=>c.id===customerId);
  if(!customer) return showMessage("ग्राहक चुनें।","warn");
  const old=existingCustomerVerification && existingCustomerVerification.customer_id===customerId ? existingCustomerVerification : null;
  if(!verificationPhotoFile && !old?.photo_path) return showMessage("ग्राहक की फोटो Camera या Gallery से चुनें।","warn");
  if((!verificationHomePhoto1&&!old?.home_photo1_path)||(!verificationHomePhoto2&&!old?.home_photo2_path)) return showMessage("घर की दोनों फोटो अनिवार्य हैं — सामने से और दूसरे एंगल से।","warn");
  if((!maskedIdentityDocs.aadhaarFront&&!old?.aadhaar_front_masked_path)||(!maskedIdentityDocs.aadhaarBack&&!old?.aadhaar_back_masked_path)||(!maskedIdentityDocs.panFront&&!old?.pan_front_masked_path)) return showMessage("Aadhaar Front, Aadhaar Back और PAN Front — तीनों की masked copy आवश्यक है।", "warn");
  if(!$("verificationConsent").checked) return showMessage("ग्राहक की सहमति आवश्यक है।","warn");
  const autoPdfWindow=window.open("about:blank","_blank");
  setBusy(btn,true,old?"Verification अपडेट हो रहा है…":"Verification सेव हो रहा है…");
  const uploadedPaths=[];
  try {
    const uploadPhoto=async(file)=>{if(!file)return null;const ext=file.type==="image/png"?"png":file.type==="image/webp"?"webp":"jpg";const p=customerId+"/"+crypto.randomUUID()+"."+ext;const up=await supabase.storage.from("customer-verification").upload(p,file,{contentType:file.type,cacheControl:"3600",upsert:false});if(up.error)throw up.error;uploadedPaths.push(p);return p;};
    const [path,home1Path,home2Path,aadhaarFrontPath,aadhaarBackPath,panFrontPath,signaturePath]=await Promise.all([
      uploadPhoto(verificationPhotoFile),uploadPhoto(verificationHomePhoto1),uploadPhoto(verificationHomePhoto2),
      uploadPhoto(maskedIdentityDocs.aadhaarFront),uploadPhoto(maskedIdentityDocs.aadhaarBack),uploadPhoto(maskedIdentityDocs.panFront),uploadPhoto(verificationSignatureFile)
    ]);
    const record={
      customer_id:customerId,photo_path:path||old?.photo_path||null,home_photo1_path:home1Path||old?.home_photo1_path||null,home_photo2_path:home2Path||old?.home_photo2_path||null,
      aadhaar_front_masked_path:aadhaarFrontPath||old?.aadhaar_front_masked_path||null,aadhaar_back_masked_path:aadhaarBackPath||old?.aadhaar_back_masked_path||null,pan_front_masked_path:panFrontPath||old?.pan_front_masked_path||null,
      customer_signature_path:signaturePath||old?.customer_signature_path||null,
      latitude:verificationLocation?.latitude ?? old?.latitude ?? null,longitude:verificationLocation?.longitude ?? old?.longitude ?? null,
      accuracy_meters:verificationLocation?.accuracy_meters ?? old?.accuracy_meters ?? null,location_captured_at:verificationLocation?.captured_at ?? old?.location_captured_at ?? null,
      consent_given:true,consent_text:"Customer was informed about photo and field GPS collection and consented.",
      family_details:(()=>{const map={familyMotherName:"mother_name",familyMaritalStatus:"marital_status",familySpouseName:"spouse_name",familyMaidenVillage:"maiden_village",familyMaidenPost:"maiden_post",familyMaidenTehsil:"maiden_tehsil",familyMaidenDistrict:"maiden_district",familyMaidenState:"maiden_state",familyBrothers:"brothers_count",familySisters:"sisters_count",familyFatherInLaw:"father_in_law",familyMotherInLaw:"mother_in_law",familyBrothersInLaw:"brothers_in_law",familySistersInLaw:"sisters_in_law",familySons:"sons_count",familyDaughters:"daughters_count",familyChildrenNames:"children_names",familyOtherMembers:"other_members",familyOtherNotes:"other_notes"};const out={};Object.entries(map).forEach(([id,key])=>{const v=$(id)?.value?.trim();if(v)out[key]=v;});return out;})(),
      verified_by:currentUser.id,verified_by_name:profile?.full_name||null,notes:$("verificationNotes").value.trim()||null
    };
    let saved;
    if(old) {
      saved=await supabase.from("customer_verifications").update(record).eq("id",old.id).eq("customer_id",customerId).select("id").maybeSingle();
    } else {
      saved=await supabase.from("customer_verifications").insert(record).select("id").maybeSingle();
    }
    if(saved.error) throw saved.error;
    if(!saved.data?.id) throw new Error(old
      ? "अपडेट के लिए रिकॉर्ड वापस नहीं मिला। संभव है आपके लॉगिन को इस रिकॉर्ड पर UPDATE अनुमति न हो (RLS policy जाँचें)।"
      : "रिकॉर्ड सेव हुआ या नहीं, इसकी पुष्टि नहीं मिली। कृपया ग्राहक का Verification History जाँचें; दोबारा सेव करने से पहले रिकॉर्ड मौजूद है या नहीं देखें।");
    const replaced=[["photo_path",path],["home_photo1_path",home1Path],["home_photo2_path",home2Path],["aadhaar_front_masked_path",aadhaarFrontPath],["aadhaar_back_masked_path",aadhaarBackPath],["pan_front_masked_path",panFrontPath],["customer_signature_path",signaturePath]].filter(([key,next])=>next&&old?.[key]).map(([key])=>old[key]);
    if(replaced.length) await supabase.storage.from("customer-verification").remove(replaced);
    lastVerificationId=saved.data.id;
    $("openVerificationPdf").disabled=false;
    $("verificationMessage").textContent=old?"पुराना Customer Verification सफलतापूर्वक अपडेट हो गया।":"Customer Verification सेव हो गया। PDF तैयार है।";
    $("verificationMessage").className="message success";
    try {
      await openVerificationPdf(lastVerificationId,autoPdfWindow);
    } catch(pdfError) {
      console.warn("Verification saved, but PDF could not be opened:",pdfError);
      $("verificationMessage").textContent += " रिकॉर्ड सेव है, लेकिन PDF नहीं खुली। PDF बटन से दोबारा खोलें।";
      if(autoPdfWindow&&!autoPdfWindow.closed) autoPdfWindow.close();
    }
    try { await loadCustomerVerification(customerId); }
    catch(refreshError) { console.warn("Verification saved; form refresh failed:",refreshError); }
  } catch(err) {
    if(uploadedPaths.length) await supabase.storage.from("customer-verification").remove(uploadedPaths);
    if(autoPdfWindow&&!autoPdfWindow.closed) autoPdfWindow.close();
    $("verificationMessage").textContent="Verification सेव / अपडेट नहीं हुआ: "+(err?.message||String(err));
    $("verificationMessage").className="message error";
  } finally { setBusy(btn,false); }
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

function formatCustomerId(value) { const raw=String(value ?? "").trim(); if(!raw) return "—"; return /^AJSF/i.test(raw) ? raw : "AJSF" + raw; }

function formatDate(value) {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}


function advanceMarkerAmount(loan, weekNo) {
  const row=weeklyStatuses.find(x=>x.loan_id===loan.id && Number(x.week_no)===weekNo);
  if(row?.source_marker!==null && row?.source_marker!==undefined && String(row.source_marker).trim()!==""){
    const n=Number(String(row.source_marker).replace(/[,₹\s]/g,""));
    if(Number.isFinite(n)&&n>=0) return n;
  }
  return row?.is_paid ? Number(loan.emi_amount||0) : 0;
}

function addAdvanceMonths(date, months) {
  const base = new Date(date.getFullYear(), date.getMonth(), 1);
  base.setMonth(base.getMonth() + months);
  const lastDay = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
  return new Date(base.getFullYear(), base.getMonth(), Math.min(date.getDate(), lastDay));
}
function advanceDueDate(loan, customer, installmentNo) {
  if (!loan?.disbursement_date || !Number.isFinite(Number(installmentNo)) || Number(installmentNo) < 1) return null;
  const parts = String(loan.disbursement_date).slice(0,10).split("-").map(Number);
  const disbursement = new Date(parts[0], parts[1]-1, parts[2]);
  disbursement.setHours(0,0,0,0);
  if (customer?.collection_day === "MONTHLY") return addAdvanceMonths(disbursement, Number(installmentNo));
  const days={Sunday:0,Monday:1,Tuesday:2,Wednesday:3,Thursday:4,Friday:5,Saturday:6};
  if (days[customer?.collection_day] === undefined) return null;
  let delta=(days[customer.collection_day]-disbursement.getDay()+7)%7;
  if(delta===0) delta=7;
  const first=new Date(disbursement);
  first.setDate(first.getDate()+delta+((Number(installmentNo)-1)*7));
  return first;
}
function advanceWeekInfo(loan, customer, paidAt) {
  if (!loan?.disbursement_date) return null;
  const monthly = customer?.collection_day === "MONTHLY";
  const days={Sunday:0,Monday:1,Tuesday:2,Wednesday:3,Thursday:4,Friday:5,Saturday:6};
  if (!monthly && days[customer?.collection_day] === undefined) return null;
  const date=new Date(paidAt);
  if(Number.isNaN(date.getTime())) return null;
  date.setHours(0,0,0,0);
  const parts=String(loan.disbursement_date).slice(0,10).split("-").map(Number);
  const disbursement=new Date(parts[0],parts[1]-1,parts[2]);
  disbursement.setHours(0,0,0,0);
  let installmentNo=1;
  if (monthly) {
    const monthDiff=(date.getFullYear()-disbursement.getFullYear())*12+(date.getMonth()-disbursement.getMonth());
    installmentNo=Math.max(1, monthDiff-(date.getDate()<disbursement.getDate()?1:0));
  } else {
    const first=advanceDueDate(loan,customer,1);
    installmentNo=Math.max(1,Math.floor((date-first)/604800000)+1);
  }
  installmentNo=Math.min(Number(loan.total_emis_required||24),installmentNo);
  const start=advanceDueDate(loan,customer,installmentNo);
  const end=advanceDueDate(loan,customer,installmentNo+1);
  if(!start||!end) return null;
  return {week:installmentNo,start,end,due:new Date(start),monthly};
}
async function processAdvanceForPayment(payment) {
  if(!payment?.id || !payment.loan_id || payment.is_reversal) return;
  const loan=loans.find(x=>x.id===payment.loan_id);
  const customer=customers.find(x=>x.id===payment.customer_id);
  const info=advanceWeekInfo(loan,customer,payment.paid_at);
  if(!info) return;
  const {data:rows,error}=await supabase.from("advance_ledger").select("*").eq("loan_id",loan.id).order("event_date");
  if(error) throw error;
  const entries=rows||[];
  advanceLedger=advanceLedger.filter(x=>x.loan_id!==loan.id).concat(entries);
  if(entries.some(x=>x.payment_id===payment.id && ["cash_applied","advance_received"].includes(x.entry_type))) { renderAdvanceBalanceInfo(); return; }

  const deposits=entries.filter(x=>x.entry_type==="advance_received").sort((a,b)=>new Date(a.event_date)-new Date(b.event_date));
  let cashLeft=Number(payment.amount||0);
  const newRows=[];

  for(let week=1;week<=info.week;week++){
    const due=advanceDueDate(loan,customer,week);
    const weekEnd=advanceDueDate(loan,customer,week+1);
    const marker=advanceMarkerAmount(loan,week);
    const weekEntries=entries.filter(x=>Number(x.applied_week_no)===week && ["cash_applied","advance_adjusted"].includes(x.entry_type));
    const weekEmi=Number(weekEntries.find(x=>Number(x.emi_amount_at_allocation)>0)?.emi_amount_at_allocation||loan.emi_amount||0);
    const priorPaymentRows=payments.filter(p=>p.loan_id===loan.id && !p.is_reversal && p.id!==payment.id && p.client_tx_id!==payment.client_tx_id).filter(p=>{
      const dt=new Date(p.paid_at);
      if(Number.isNaN(dt.getTime()) || dt<due || dt>=weekEnd) return false;
      const currentTime=new Date(payment.paid_at).getTime();
      const priorTime=dt.getTime();
      return priorTime<currentTime || (priorTime===currentTime && new Date(p.created_at||0)<new Date(payment.created_at||0));
    });
    const priorPayments=priorPaymentRows.reduce((n,p)=>n+Number(p.amount||0),0);
    const priorPaymentIds=new Set(priorPaymentRows.map(p=>p.id).filter(Boolean));
    const cashAppliedForWeek=entries.filter(x=>x.entry_type==="cash_applied" && Number(x.applied_week_no)===week).reduce((n,x)=>n+Number(x.amount||0),0);
    const cashAlreadyAllocatedFromWeek=entries.filter(x=>x.entry_type==="cash_applied" && priorPaymentIds.has(x.payment_id)).reduce((n,x)=>n+Number(x.amount||0),0);
    const receivedThisWeek=entries.filter(x=>x.entry_type==="advance_received" && Number(x.source_week_no)===week).reduce((n,x)=>n+Number(x.amount||0),0);
    const adjustedThisWeek=entries.filter(x=>x.entry_type==="advance_adjusted" && Number(x.applied_week_no)===week).reduce((n,x)=>n+Number(x.amount||0),0);
    const unallocatedPriorCash=Math.max(0,priorPayments-cashAlreadyAllocatedFromWeek-receivedThisWeek);
    let dueLeft=Math.max(0,weekEmi-marker-cashAppliedForWeek-unallocatedPriorCash-adjustedThisWeek);

    for(const deposit of deposits){
      if(dueLeft<=0) break;
      const used=entries.filter(x=>x.entry_type==="advance_adjusted" && x.source_entry_id===deposit.id).reduce((n,x)=>n+Number(x.amount||0),0)+newRows.filter(x=>x.entry_type==="advance_adjusted" && x.source_entry_id===deposit.id).reduce((n,x)=>n+Number(x.amount||0),0);
      const available=Math.max(0,Number(deposit.amount||0)-used);
      if(!available) continue;
      const amount=Math.min(available,dueLeft);
      const key="advance-adjusted:"+deposit.id+":"+week;
      if(!entries.some(x=>x.idempotency_key===key) && !newRows.some(x=>x.idempotency_key===key)){
        newRows.push({loan_id:loan.id,customer_id:customer.id,payment_id:payment.id,entry_type:"advance_adjusted",amount,event_date:payment.paid_at,source_week_no:deposit.source_week_no,applied_week_no:week,source_entry_id:deposit.id,collector_id:payment.collector_id||currentUser.id,idempotency_key:key,emi_amount_at_allocation:weekEmi,due_date:due.toISOString().slice(0,10),remarks:"Auto-adjusted against next due EMI"});
      }
      dueLeft-=amount;
    }

    if(cashLeft>0 && dueLeft>0){
      const amount=Math.min(cashLeft,dueLeft);
      const key="cash-applied:"+payment.client_tx_id+":"+week;
      newRows.push({loan_id:loan.id,customer_id:customer.id,payment_id:payment.id,entry_type:"cash_applied",amount,event_date:payment.paid_at,applied_week_no:week,collector_id:payment.collector_id||currentUser.id,idempotency_key:key,emi_amount_at_allocation:weekEmi,due_date:due.toISOString().slice(0,10),remarks:"Cash allocated to installment"});
      cashLeft-=amount;
    }
  }

  if(cashLeft>0){
    newRows.push({loan_id:loan.id,customer_id:customer.id,payment_id:payment.id,entry_type:"advance_received",amount:cashLeft,event_date:payment.paid_at,source_week_no:info.week,collector_id:payment.collector_id||currentUser.id,idempotency_key:"advance-received:"+payment.client_tx_id,emi_amount_at_allocation:Number(loan.emi_amount||0),remarks:"Excess collection stored as advance"});
  }
  if(newRows.length){
    const {data:inserted,error:insertError}=await supabase.from("advance_ledger").insert(newRows).select("*");
    if(insertError) throw insertError;
    advanceLedger=advanceLedger.filter(x=>x.loan_id!==loan.id).concat(entries,inserted||[]);
    renderAdvanceBalanceInfo();
  }
}

async function applyMaturedAdvances() {
  if(!navigator.onLine || !currentUser) return;
  const today=new Date(); today.setHours(0,0,0,0);
  for(const loan of loans){
    const customer=customers.find(c=>c.id===loan.customer_id);
    const current=advanceWeekInfo(loan,customer,today);
    if(!current) continue;
    const {data:entries,error}=await supabase.from("advance_ledger").select("*").eq("loan_id",loan.id).order("event_date");
    if(error || !entries?.length) continue;
    const deposits=entries.filter(x=>x.entry_type==="advance_received").sort((a,b)=>new Date(a.event_date)-new Date(b.event_date));
    const pending=[];
    for(let week=1;week<=current.week;week++){
      const due=advanceDueDate(loan,customer,week);
      if(!due || due>today) continue;
      const weekEntries=entries.filter(x=>Number(x.applied_week_no)===week && ["cash_applied","advance_adjusted"].includes(x.entry_type));
      const weekEmi=Number(weekEntries.find(x=>Number(x.emi_amount_at_allocation)>0)?.emi_amount_at_allocation||loan.emi_amount||0);
      const marker=advanceMarkerAmount(loan,week);
      const start=due, end=advanceDueDate(loan,customer,week+1);
      const weekPaymentRows=payments.filter(p=>p.loan_id===loan.id && !p.is_reversal).filter(p=>{const dt=new Date(p.paid_at);return !Number.isNaN(dt.getTime())&&dt>=start&&dt<end;});
      const cash=weekPaymentRows.reduce((n,p)=>n+Number(p.amount||0),0);
      const weekPaymentIds=new Set(weekPaymentRows.map(p=>p.id).filter(Boolean));
      const cashAppliedForWeek=entries.filter(x=>x.entry_type==="cash_applied"&&Number(x.applied_week_no)===week).reduce((n,x)=>n+Number(x.amount||0),0);
      const cashAllocatedFromWeek=entries.filter(x=>x.entry_type==="cash_applied"&&weekPaymentIds.has(x.payment_id)).reduce((n,x)=>n+Number(x.amount||0),0);
      const receivedThisWeek=entries.filter(x=>x.entry_type==="advance_received"&&Number(x.source_week_no)===week).reduce((n,x)=>n+Number(x.amount||0),0);
      const adjusted=entries.filter(x=>x.entry_type==="advance_adjusted"&&Number(x.applied_week_no)===week).reduce((n,x)=>n+Number(x.amount||0),0);
      const unallocatedCash=Math.max(0,cash-cashAllocatedFromWeek-receivedThisWeek);
      let dueLeft=Math.max(0,weekEmi-marker-cashAppliedForWeek-unallocatedCash-adjusted);
      for(const deposit of deposits){
        if(dueLeft<=0) break;
        const used=entries.filter(x=>x.entry_type==="advance_adjusted"&&x.source_entry_id===deposit.id).reduce((n,x)=>n+Number(x.amount||0),0)+pending.filter(x=>x.source_entry_id===deposit.id).reduce((n,x)=>n+Number(x.amount||0),0);
        const available=Math.max(0,Number(deposit.amount||0)-used);
        if(!available) continue;
        const amount=Math.min(available,dueLeft);
        const key="advance-adjusted:"+deposit.id+":"+week;
        if(!entries.some(x=>x.idempotency_key===key)&&!pending.some(x=>x.idempotency_key===key)){
          pending.push({loan_id:loan.id,customer_id:customer.id,payment_id:null,entry_type:"advance_adjusted",amount,event_date:due.toISOString(),source_week_no:deposit.source_week_no,applied_week_no:week,source_entry_id:deposit.id,collector_id:currentUser.id,idempotency_key:key,emi_amount_at_allocation:weekEmi,due_date:due.toISOString().slice(0,10),remarks:"Automatic scheduled advance adjustment"});
        }
        dueLeft-=amount;
      }
    }
    if(pending.length){
      const {data:inserted,error:insertError}=await supabase.from("advance_ledger").insert(pending).select("*");
      if(!insertError) advanceLedger=advanceLedger.filter(x=>x.loan_id!==loan.id).concat(inserted||[]);
    }
  }
  renderAdvanceBalanceInfo();
}

function renderAdvanceBalanceInfo() {
  const el=$("advanceBalanceInfo");
  if(!el) return;
  const loanId=$("payLoan")?.value;
  if(!loanId){el.textContent="Advance Balance: लोन चुनें";return;}
  const rows=advanceLedger.filter(x=>x.loan_id===loanId);
  const received=rows.filter(x=>x.entry_type==="advance_received").reduce((n,x)=>n+Number(x.amount||0),0);
  const adjusted=rows.filter(x=>x.entry_type==="advance_adjusted").reduce((n,x)=>n+Number(x.amount||0),0);
  el.textContent="Advance Received: "+money(received)+" · Adjusted: "+money(adjusted)+" · Available Balance: "+money(Math.max(0,received-adjusted));
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
      <div><small>Customer ID</small><b>${esc(formatCustomerId(customer.customer_code))}</b></div>
      <div><small>Customer Name</small><b>${esc(customer.full_name)}</b></div>
      <div><small>Center</small><b>${esc(customer.center_name || "—")}</b></div>
      <div><small>Mobile</small><b>${esc(phone(customer.contact_number) || "—")}</b></div>
      <div><small>Loan Reference</small><b>${esc(loan.loan_reference)}</b></div>
      <div><small>Payment Mode</small><b>${esc(payment.payment_mode.toUpperCase().replace("_", " "))}</b></div>
    </div>
    <div class="receipt-amount"><div class="receipt-amount-label">AMOUNT RECEIVED <span>प्राप्त राशि</span></div><strong>${money(payment.amount)}</strong><div class="receipt-amount-words"><div><b>In Words:</b> ${esc(amountInWords(payment.amount))}</div><div><b>शब्दों में:</b> ${esc(amountInWords(payment.amount,true))}</div></div></div>
    <p class="receipt-remarks">Advance Added: ${money(advanceLedger.filter(x=>x.payment_id===payment.id && x.entry_type==="advance_received").reduce((sum,x)=>sum+Number(x.amount||0),0))} · Advance Adjusted: ${money(advanceLedger.filter(x=>x.payment_id===payment.id && x.entry_type==="advance_adjusted").reduce((sum,x)=>sum+Number(x.amount||0),0))}</p>
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
  try { await processAdvanceForPayment(data); } catch (advanceError) { console.error("Advance ledger update failed",advanceError); }
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
async function renderReceiptCancellationRequests() {
  const body = $("receiptCancellationRows");
  if (!body) return;
  const rows = receiptCancellationRequests.map(r => {
    const payment = payments.find(p => p.id === r.payment_id);
    const customer = customers.find(c => c.id === r.customer_id);
    const collector = r.collector_id === currentUser?.id ? (profile?.full_name || "आप") : "Collector";
    const status = r.status === "pending" ? "Pending" : r.status === "approved" ? "Approved / रद्द" : "Rejected";
    const actions = canAdmin() && r.status === "pending"
      ? `<button type="button" data-receipt-review="approve" data-request-id="${esc(r.id)}">Approve & Cancel</button> <button type="button" class="secondary" data-receipt-review="reject" data-request-id="${esc(r.id)}">Reject</button>`
      : "";
    return `<tr><td>${esc((r.payment_id || "").slice(0,8).toUpperCase())}</td><td>${esc(formatCustomerId(customer?.customer_code))} · ${esc(customer?.full_name || "—")}</td><td>${money(payment?.amount)}</td><td>${esc(formatDate(r.created_at))}</td><td>${esc(r.reason)}</td><td>${esc(collector)}</td><td>${esc(status)}</td><td>${esc(r.admin_note || "—")}</td><td>${actions}</td></tr>`;
  }).join("");
  body.innerHTML = rows || `<tr><td colspan="9" class="empty">अभी कोई Receipt Cancellation Request नहीं है।</td></tr>`;
}
async function requestReceiptCancellation(paymentId) {
  const payment = payments.find(p => p.id === paymentId);
  if (!payment || payment.is_reversal || payment.offline_pending) return showMessage("यह रसीद Request के लिए उपलब्ध नहीं है।", "warn");
  if (payment.collector_id !== currentUser.id) return showMessage("आप केवल अपनी दर्ज की गई रसीद की Request कर सकते हैं।", "warn");
  const reason = window.prompt("रसीद गलत कटने का कारण लिखें (कम से कम 5 अक्षर):");
  if (reason === null) return;
  if (reason.trim().length < 5) return showMessage("कृपया गलती का पूरा कारण लिखें।", "warn");
  const {error} = await supabase.from("receipt_cancellation_requests").insert({
    payment_id:payment.id, customer_id:payment.customer_id, collector_id:currentUser.id, reason:reason.trim()
  });
  if (error) return showMessage("Request सेव नहीं हुई: " + error.message, "error");
  const refreshed = await supabase.from("receipt_cancellation_requests").select("*").order("created_at",{ascending:false});
  if (!refreshed.error) receiptCancellationRequests = refreshed.data || [];
  renderReceiptCancellationRequests();
  showMessage("Request Admin को भेज दी गई है। Admin की मंजूरी तक रसीद वैध रहेगी।", "success");
}
async function reviewReceiptCancellation(button) {
  if (!canAdmin()) return showMessage("केवल Admin इस Request पर निर्णय ले सकता है।", "warn");
  const decision = button.dataset.receiptReview;
  const note = window.prompt(decision === "approve" ? "Approve करके रसीद रद्द करें? वैकल्पिक Admin Note लिखें:" : "Reject करने का कारण लिखें:");
  if (note === null) return;
  if (decision === "reject" && note.trim().length < 3) return showMessage("Reject करने का कारण लिखें।", "warn");
  if (decision === "approve" && !window.confirm("पुष्टि करें: इस रसीद को Cancel किया जाएगा और हिसाब से हटाया जाएगा। मूल रिकॉर्ड सुरक्षित रहेगा।")) return;
  setBusy(button,true,"प्रक्रिया…");
  const {data,error}=await supabase.rpc("review_receipt_cancellation",{
    p_request_id:button.dataset.requestId,p_decision:decision,p_admin_note:note.trim() || null
  });
  setBusy(button,false);
  if (error) return showMessage("Request पर कार्रवाई नहीं हुई: "+error.message,"error");
  await loadAll();
  showMessage(decision === "approve" ? "रसीद Admin द्वारा Cancel कर दी गई। रिकॉर्ड सुरक्षित है।" : "Request Reject कर दी गई। रसीद वैध रहेगी।","success");
}
document.addEventListener("click", event => {
  const requestBtn = event.target.closest(".receipt-cancel-request-btn");
  if (requestBtn) { event.preventDefault(); requestReceiptCancellation(requestBtn.dataset.paymentId); return; }
  const reviewBtn = event.target.closest("[data-receipt-review]");
  if (reviewBtn) { event.preventDefault(); reviewReceiptCancellation(reviewBtn); }
});
function localDateValue() {
  const d = new Date();
  const offset = d.getTimezoneOffset();
  return new Date(d.getTime() - offset * 60000).toISOString().slice(0, 10);
}
async function loadReceiptLibrary(src, test) {
  if (test()) return;
  const mirrors = [src];
  if (src.includes("/html2canvas/1.4.1/")) {
    mirrors.push("https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js");
    mirrors.push("https://unpkg.com/html2canvas@1.4.1/dist/html2canvas.min.js");
  } else if (src.includes("/jspdf/2.5.1/")) {
    mirrors.push("https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js");
    mirrors.push("https://unpkg.com/jspdf@2.5.1/dist/jspdf.umd.min.js");
  }
  let lastError;
  for (const url of [...new Set(mirrors)]) {
    if (test()) return;
    try {
      await new Promise((resolve, reject) => {
        const script = document.createElement("script");
        const timer = setTimeout(() => { script.remove(); reject(new Error("PDF library load timed out")); },12000);
        script.src = url;
        script.async = true;
        script.onload = () => { clearTimeout(timer); resolve(); };
        script.onerror = () => { clearTimeout(timer); script.remove(); reject(new Error("PDF library could not load")); };
        document.head.appendChild(script);
      });
      if (test()) return;
      throw new Error("PDF library loaded but is not available");
    } catch (error) { lastError = error; }
  }
  throw new Error("PDF बनाने की लाइब्रेरी इंटरनेट से लोड नहीं हुई। इंटरनेट जाँचें और दोबारा प्रयास करें। " + (lastError?.message || ""));
}
function triggerBrowserDownload(blob, fileName, revokeAfterMs = 120000) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.setAttribute("download", fileName);
  link.style.position = "fixed";
  link.style.left = "-10000px";
  link.style.top = "0";
  document.body.appendChild(link);
  link.click();
  setTimeout(() => {
    link.remove();
    URL.revokeObjectURL(url);
  }, revokeAfterMs);
}
async function downloadElementPdf(element, fileName, options = {}) {
  if (!element || !element.innerHTML.trim()) throw new Error("पहले संबंधित विवरण तैयार करें।");
  await loadReceiptLibrary("https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js", () => typeof window.html2canvas === "function");
  await loadReceiptLibrary("https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js", () => !!window.jspdf?.jsPDF);
  // Let the selected panel finish layout and wait for its logo before capturing it.
  if (document.fonts?.ready) await document.fonts.ready;
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  await Promise.all(Array.from(element.querySelectorAll("img")).map(img =>
    img.complete ? Promise.resolve() : new Promise(resolve => {
      img.addEventListener("load",resolve,{once:true});
      img.addEventListener("error",resolve,{once:true});
      setTimeout(resolve,5000);
    })
  ));
  // html2canvas measures the source element before applying clone styles.
  // Expand the two statement roots on the live DOM first so the exported canvas
  // uses the full landscape layout instead of the narrow on-screen preview width.
  const expandLandscapeRoot = ["ledgerPrintArea","statementPrintArea"].includes(element.id);
  const previousInlineStyle = expandLandscapeRoot ? element.getAttribute("style") : null;
  if (expandLandscapeRoot) {
    element.style.setProperty("width","1100px","important");
    element.style.setProperty("min-width","1100px","important");
    element.style.setProperty("max-width","1100px","important");
    element.style.setProperty("box-sizing","border-box","important");
  }
  let canvas;
  try {
    canvas = await window.html2canvas(element, {
    scale:2, backgroundColor:"#ffffff", useCORS:true, logging:false,
    windowWidth:1180,
    onclone: clonedDoc => {
      const root = clonedDoc.getElementById(element.id);
      if (!root) return;
      root.style.cssText += ";display:block!important;width:1100px!important;max-width:none!important;min-width:1100px!important;height:auto!important;min-height:0!important;max-height:none!important;padding:30px!important;margin:0!important;box-sizing:border-box!important;background:#fff!important;color:#20352d!important;font-family:Arial,sans-serif!important;font-size:14px!important;line-height:1.35!important;overflow:visible!important;border:0!important;border-radius:0!important";
      if (element.id === "repaymentSchedulePrint") {
        // Inline !important wins over clone stylesheet rules; explicitly restore the folded two-panel grid.
        root.style.setProperty("display","grid","important");
        root.style.setProperty("grid-template-columns","minmax(0,1fr) minmax(0,1fr)","important");
        root.style.setProperty("grid-template-rows","740px","important");
        root.style.setProperty("align-items","stretch","important");
        root.style.setProperty("width","1100px","important");
        root.style.setProperty("min-width","1100px","important");
        root.style.setProperty("max-width","1100px","important");
        root.style.setProperty("height","740px","important");
        root.style.setProperty("min-height","740px","important");
        root.style.setProperty("max-height","740px","important");
        root.style.setProperty("padding","18px","important");
        root.style.setProperty("overflow","hidden","important");
        root.style.setProperty("border","2px solid #244b3c","important");
      }
      const style = clonedDoc.createElement("style");
      style.textContent = `
        #ledgerPrintArea,#statementPrintArea{width:1100px!important;min-width:1100px!important;max-width:1100px!important;min-height:770px!important;height:auto!important;box-sizing:border-box!important;padding:18px!important;margin:0!important;display:flex!important;flex-direction:column!important;background:#fff!important}
        #ledgerPrintArea .ledger-print-brand,#statementPrintArea .statement-brand{display:flex!important;align-items:center!important;justify-content:flex-start!important;gap:22px!important;padding:0 0 14px!important;margin:0 0 14px!important;border-bottom:4px solid #174b3c!important}
        #ledgerPrintArea .ledger-print-brand img,#statementPrintArea .statement-brand img{width:88px!important;height:88px!important;min-width:88px!important;max-width:88px!important;object-fit:contain!important;flex:0 0 88px!important}
        #ledgerPrintArea .ledger-print-brand h2,#statementPrintArea .statement-brand h1{font-size:27px!important;line-height:1.2!important;margin:0 0 5px!important;color:#174b3c!important}
        #ledgerPrintArea .ledger-print-brand p,#statementPrintArea .statement-brand p{font-size:13px!important;margin:3px 0!important;letter-spacing:1px!important}
        #ledgerPrintArea .ledger-print-brand strong{font-size:18px!important}
        #ledgerPrintArea .ledger-print-customer,#ledgerPrintArea .ledger-print-totals{display:grid!important;grid-template-columns:repeat(4,minmax(0,1fr))!important;gap:14px!important;padding:14px!important;margin:12px 0!important;background:#f1f6f3!important}
        #ledgerPrintArea .ledger-print-customer span,#ledgerPrintArea .ledger-print-totals span{display:flex!important;flex-direction:column!important;gap:5px!important;min-width:0!important;padding:7px!important}
        #ledgerPrintArea small,#statementPrintArea small{display:block!important;font-size:12px!important;color:#65776e!important;margin-bottom:4px!important}
        #ledgerPrintArea b,#statementPrintArea b{font-size:15px!important;overflow-wrap:anywhere!important}
        #statementPrintArea .statement-title{text-align:center!important;font-size:22px!important;margin:16px 0!important;color:#174b3c!important}
        #statementPrintArea .statement-customer{display:grid!important;grid-template-columns:repeat(5,minmax(0,1fr))!important;gap:12px!important;padding:14px!important;margin:12px 0!important;background:#f7f9f7!important}
        #statementPrintArea .statement-totals{display:grid!important;grid-template-columns:repeat(3,minmax(0,1fr))!important;gap:14px!important;padding:18px!important;margin:12px 0!important;background:#eaf3ee!important}
        #ledgerPrintArea h3,#statementPrintArea h3{font-size:18px!important;margin:18px 0 8px!important;color:#174b3c!important}
        #ledgerPrintArea table,#statementPrintArea table{width:100%!important;table-layout:fixed!important;border-collapse:collapse!important;font-size:12px!important;margin:10px 0 16px!important}
        #ledgerPrintArea th,#ledgerPrintArea td,#statementPrintArea th,#statementPrintArea td{border:1px solid #cbd8d0!important;padding:9px 8px!important;text-align:left!important;vertical-align:middle!important;white-space:normal!important;overflow-wrap:anywhere!important}
        #ledgerPrintArea th,#statementPrintArea th{background:#eaf3ee!important;color:#174b3c!important;font-weight:700!important}
        #ledgerPrintArea .ledger-generated,#statementPrintArea .statement-generated{margin-top:auto!important;padding-top:14px!important;text-align:right!important;font-size:11px!important}
        #statementPrintArea .statement-note{font-size:10px!important;line-height:1.35!important;margin:8px 0 0!important;color:#65776e!important}
        /* Download-only statement styling mirrors the proven browser Print layout. */
        #statementPrintArea .statement-brand{justify-content:center!important;gap:38px!important;padding:0 0 12px!important;margin:0 0 10px!important;border-bottom:3px solid #174b3c!important}
        #statementPrintArea .statement-brand img{width:64px!important;height:64px!important;min-width:64px!important;max-width:64px!important;flex:0 0 64px!important}
        #statementPrintArea .statement-brand h1{font-size:19px!important;line-height:1.15!important;margin:0!important}
        #statementPrintArea .statement-brand p{font-size:11px!important;margin:3px 0!important;letter-spacing:1px!important}
        #statementPrintArea .statement-title{font-size:16px!important;margin:10px 0!important}
        #statementPrintArea .statement-customer{grid-template-columns:repeat(5,minmax(0,1fr))!important;gap:8px!important;padding:9px 0!important;margin:0 0 8px!important}
        #statementPrintArea .statement-totals{grid-template-columns:repeat(3,minmax(0,1fr))!important;gap:8px!important;padding:10px!important;margin:0 0 8px!important}
        #statementPrintArea small{font-size:10px!important;margin-bottom:2px!important}
        #statementPrintArea b{font-size:11px!important}
        #statementPrintArea h3{font-size:13px!important;margin:10px 0 5px!important}
        #statementPrintArea table{font-size:10px!important;margin:4px 0 7px!important}
        #statementPrintArea th,#statementPrintArea td{padding:5px!important;line-height:1.2!important}
        #statementPrintArea .statement-generated{font-size:9px!important;margin-top:8px!important;padding-top:4px!important}
        #statementPrintArea .statement-note{font-size:8px!important;line-height:1.25!important;margin-top:6px!important}
        #ledgerPrintArea .ledger-print-brand{justify-content:center!important;gap:30px!important;padding:0 0 10px!important;margin:0 0 10px!important;border-bottom:3px solid #174b3c!important}
        #ledgerPrintArea .ledger-print-brand img{width:64px!important;height:64px!important;min-width:64px!important;max-width:64px!important;flex:0 0 64px!important}
        #ledgerPrintArea .ledger-print-brand h2{font-size:19px!important;line-height:1.15!important;margin:0!important}
        #ledgerPrintArea .ledger-print-brand p{font-size:11px!important;margin:3px 0!important}
        #ledgerPrintArea .ledger-print-customer,#ledgerPrintArea .ledger-print-totals{gap:8px!important;padding:9px!important;margin:7px 0!important}
        #ledgerPrintArea small{font-size:10px!important;margin-bottom:2px!important}
        #ledgerPrintArea b{font-size:11px!important}
        #ledgerPrintArea h3{font-size:13px!important;margin:10px 0 5px!important}
        #ledgerPrintArea table{font-size:10px!important;margin:4px 0 7px!important}
        #ledgerPrintArea th,#ledgerPrintArea td{padding:5px!important;line-height:1.2!important}
        #ledgerPrintArea .ledger-generated{font-size:9px!important;margin-top:8px!important}
        #ledgerPrintArea h3,#statementPrintArea h3{margin:12px 0 6px!important}
        #ledgerPrintArea table,#statementPrintArea table{margin:6px 0 10px!important}
        #ledgerPrintArea th,#ledgerPrintArea td,#statementPrintArea th,#statementPrintArea td{padding:10px 9px!important;line-height:1.25!important}
        /* Download-only: reproduce the proven Print layouts for both customer PDFs. */
        #statementPrintArea{width:1065px!important;min-width:1065px!important;max-width:1065px!important;min-height:0!important;padding:0!important;margin:0!important;display:block!important}
        #statementPrintArea .statement-brand{display:flex!important;align-items:center!important;justify-content:center!important;gap:10px!important;border-bottom:2px solid #123f35!important;padding-bottom:7px!important;margin:0!important}
        #statementPrintArea .statement-brand img{width:17mm!important;height:17mm!important;max-width:17mm!important;max-height:17mm!important;min-width:17mm!important;min-height:17mm!important;flex:0 0 17mm!important}
        #statementPrintArea .statement-brand h1{font-size:14pt!important;margin:0!important}
        #statementPrintArea .statement-brand p{font-size:8pt!important;margin:2px 0!important}
        #statementPrintArea .statement-title{text-align:center!important;font-size:12pt!important;margin:8px 0!important}
        #statementPrintArea .statement-customer{display:grid!important;grid-template-columns:repeat(5,minmax(0,1fr))!important;gap:7px!important;padding:7px 0!important;margin:0!important;background:transparent!important}
        #statementPrintArea .statement-totals{display:grid!important;grid-template-columns:repeat(3,minmax(0,1fr))!important;gap:8px!important;padding:8px!important;margin:0!important;background:#edf5f0!important}
        #statementPrintArea .statement-customer small,#statementPrintArea .statement-totals small{display:block!important;font-size:7pt!important;margin-bottom:2px!important}
        #statementPrintArea .statement-customer b,#statementPrintArea .statement-totals b{font-size:8pt!important}
        #statementPrintArea h3{font-size:9pt!important;margin:9px 0 4px!important}
        #statementPrintArea table{width:100%!important;border-collapse:collapse!important;font-size:7.5pt!important;margin:4px 0 8px!important;table-layout:auto!important}
        #statementPrintArea th,#statementPrintArea td{border:1px solid #cbd8d0!important;padding:4px!important;text-align:left!important;white-space:normal!important;overflow-wrap:normal!important}
        #statementPrintArea .statement-generated{text-align:right!important;font-size:7pt!important;margin-top:8px!important;padding:0!important}
        #statementPrintArea .statement-note{font-size:6.5pt!important;margin-top:6px!important;line-height:normal!important}
        #ledgerPrintArea{width:1065px!important;min-width:1065px!important;max-width:1065px!important;min-height:0!important;padding:0!important;margin:0!important;display:block!important}
        #ledgerPrintArea .ledger-print-brand{display:flex!important;align-items:center!important;justify-content:center!important;gap:12px!important;border-bottom:2px solid #123f35!important;padding-bottom:8px!important;margin:0!important;text-align:left!important}
        #ledgerPrintArea .ledger-print-brand img{display:block!important;width:18mm!important;height:18mm!important;max-width:18mm!important;max-height:18mm!important;min-width:18mm!important;min-height:18mm!important;flex:0 0 18mm!important;object-fit:contain!important}
        #ledgerPrintArea .ledger-print-brand h2{font-size:15pt!important;margin:0!important;color:#123f35!important}
        #ledgerPrintArea .ledger-print-brand p{font-size:8pt!important;margin:2px 0 5px!important}
        #ledgerPrintArea .ledger-print-brand strong{font-size:10pt!important}
        #ledgerPrintArea .ledger-print-customer{display:grid!important;grid-template-columns:repeat(4,1fr)!important;gap:8px!important;padding:9px 0!important;margin:0!important;background:transparent!important}
        #ledgerPrintArea .ledger-print-totals{display:grid!important;grid-template-columns:repeat(4,1fr)!important;gap:8px!important;padding:9px!important;margin:0!important;background:#edf5f0!important}
        #ledgerPrintArea .ledger-print-customer small,#ledgerPrintArea .ledger-print-totals small{display:block!important;font-size:8pt!important;margin-bottom:2px!important}
        #ledgerPrintArea .ledger-print-customer b,#ledgerPrintArea .ledger-print-totals b{font-size:9pt!important}
        #ledgerPrintArea h3{font-size:10pt!important;margin:10px 0 4px!important;color:#123f35!important}
        #ledgerPrintArea table{width:100%!important;border-collapse:collapse!important;font-size:8pt!important;margin:5px 0 9px!important;table-layout:auto!important}
        #ledgerPrintArea th,#ledgerPrintArea td{border:1px solid #cbd8d0!important;padding:5px!important;text-align:left!important;white-space:normal!important;overflow-wrap:normal!important}
        #ledgerPrintArea th{background:#edf5f0!important}
        #ledgerPrintArea .ledger-generated{text-align:right!important;font-size:8pt!important;margin-top:8px!important;padding:0!important}
        #repaymentSchedulePrint{display:block!important;width:1100px!important;height:auto!important;min-height:0!important;max-height:none!important;overflow:visible!important;border:2px solid #244b3c!important}
        #repaymentSchedulePrint .schedule-brand-center{display:flex!important;align-items:center!important;justify-content:center!important;padding:12px!important}
        #repaymentSchedulePrint .schedule-brand img{width:76px!important;height:76px!important;max-width:76px!important;max-height:76px!important}
        #repaymentSchedulePrint .schedule-left,#repaymentSchedulePrint .schedule-right{display:block!important;width:100%!important;min-width:0!important;padding:14px!important;border:0!important}
        #repaymentSchedulePrint .schedule-left table{width:100%!important;table-layout:fixed!important;font-size:11px!important}#repaymentSchedulePrint .schedule-right{border-top:3px solid #174b3c!important;margin-top:18px!important}#repaymentSchedulePrint .schedule-left th,#repaymentSchedulePrint .schedule-left td{padding:7px!important;line-height:1.25!important}
        #repaymentSchedulePrint .schedule-left th,#repaymentSchedulePrint .schedule-left td{padding:7px!important;line-height:1.25!important}
        #repaymentSchedulePrint .schedule-summary{display:grid!important;grid-template-columns:repeat(2,minmax(0,1fr))!important;gap:7px!important}
        #repaymentSchedulePrint .customer-detail{padding:5px!important}
        #repaymentSchedulePrint .customer-detail b{font-size:11px!important}
#repaymentSchedulePrint{display:block!important;width:1100px!important;height:auto!important;min-height:0!important;max-height:none!important;padding:24px!important;overflow:visible!important;border:2px solid #244b3c!important}
        #repaymentSchedulePrint .passbook-top{display:grid!important;grid-template-columns:42% 58%!important;gap:12px!important;align-items:center!important;border-bottom:2px solid #174b3c!important;padding-bottom:10px!important}
        #repaymentSchedulePrint .passbook-brand{display:flex!important;align-items:center!important;gap:12px!important;min-width:0!important}
        #repaymentSchedulePrint .passbook-brand img{width:72px!important;height:72px!important;object-fit:contain!important;flex:0 0 72px!important}
        #repaymentSchedulePrint .passbook-brand h1{font-size:22px!important;line-height:1.1!important;margin:0!important;color:#174b3c!important}
        #repaymentSchedulePrint .passbook-brand p{font-size:11px!important;font-weight:700!important;letter-spacing:.5px!important;margin:4px 0!important}
        #repaymentSchedulePrint .passbook-brand strong{font-size:12px!important}
        #repaymentSchedulePrint .passbook-customer{display:grid!important;grid-template-columns:repeat(4,minmax(0,1fr))!important;gap:6px 10px!important}
        #repaymentSchedulePrint .passbook-customer div{border-bottom:1px solid #d4dfd8!important;padding:4px!important;min-width:0!important}
        #repaymentSchedulePrint .passbook-customer small,#repaymentSchedulePrint .passbook-summary small{display:block!important;font-size:10px!important;color:#64776d!important;margin-bottom:2px!important}
        #repaymentSchedulePrint .passbook-customer b,#repaymentSchedulePrint .passbook-summary b{font-size:12px!important;overflow-wrap:anywhere!important}
        #repaymentSchedulePrint .passbook-summary{display:grid!important;grid-template-columns:repeat(5,minmax(0,1fr))!important;gap:6px!important;margin:12px 0!important;padding:9px!important;background:#edf5f0!important}
        #repaymentSchedulePrint .passbook-summary span{padding:0 5px!important;border-right:1px solid #cfddd4!important}
        #repaymentSchedulePrint .passbook-table-title{font-size:15px!important;color:#174b3c!important;margin:8px 0!important}
        #repaymentSchedulePrint .passbook-table{width:100%!important;border-collapse:collapse!important;table-layout:fixed!important;font-size:11px!important}
        #repaymentSchedulePrint .passbook-table th{background:#e8f1ec!important;color:#174b3c!important;font-weight:700!important}
        #repaymentSchedulePrint .passbook-table th,#repaymentSchedulePrint .passbook-table td{border:1px solid #b9c9bf!important;padding:5px 6px!important;height:22px!important;text-align:left!important;vertical-align:middle!important;white-space:normal!important}
        #repaymentSchedulePrint .passbook-table .schedule-status{font-size:10px!important;font-weight:700!important}
        #repaymentSchedulePrint .passbook-footer{display:grid!important;grid-template-columns:1fr 1fr 1.3fr!important;gap:25px!important;align-items:end!important;margin-top:16px!important}
        #repaymentSchedulePrint .passbook-footer div:not(.passbook-generated) span{display:block!important;height:30px!important;border-bottom:1px solid #52665c!important}
        #repaymentSchedulePrint .passbook-footer small{font-size:10px!important;color:#52665c!important}
        #repaymentSchedulePrint .passbook-generated{text-align:right!important;font-size:9px!important;color:#65776e!important}
#repaymentSchedulePrint.repayment-fold-sheet{position:relative!important;display:grid!important;grid-template-columns:1fr 1fr!important;grid-template-rows:1fr!important;width:1100px!important;height:740px!important;min-height:740px!important;max-height:740px!important;box-sizing:border-box!important;border:2px solid #244b3c!important;background:#fff!important}
        #repaymentSchedulePrint .repayment-left{grid-column:1!important;grid-row:1!important;padding:18px 24px 18px 14px!important;box-sizing:border-box!important;min-width:0!important}
        #repaymentSchedulePrint .repayment-right{grid-column:2!important;grid-row:1!important;padding:38px 25px 20px 42px!important;box-sizing:border-box!important;min-width:0!important;border-left:2px dashed #71877b!important}
        #repaymentSchedulePrint .repayment-left h2{font-size:19px!important;color:#174b3c!important;text-align:center!important;margin:0 0 14px!important;padding-bottom:9px!important;border-bottom:2px solid #174b3c!important}
        #repaymentSchedulePrint .repayment-table{width:100%!important;border-collapse:collapse!important;table-layout:fixed!important;font-size:13px!important}
        #repaymentSchedulePrint .repayment-table th{background:#e8f1ec!important;color:#174b3c!important;font-weight:700!important}
        #repaymentSchedulePrint .repayment-table th,#repaymentSchedulePrint .repayment-table td{border:1px solid #b9c9bf!important;padding:5px 6px!important;height:27px!important;text-align:center!important;vertical-align:middle!important}
        #repaymentSchedulePrint .repayment-table td.repayment-sign-cell{height:27px!important}
        #repaymentSchedulePrint .repayment-brand{display:flex!important;align-items:center!important;gap:18px!important;padding-bottom:18px!important;border-bottom:3px solid #174b3c!important}
        #repaymentSchedulePrint .repayment-brand img{width:92px!important;height:92px!important;object-fit:contain!important;flex:0 0 92px!important}
        #repaymentSchedulePrint .repayment-brand h1{font-size:24px!important;line-height:1.15!important;color:#174b3c!important;margin:0!important}
        #repaymentSchedulePrint .repayment-brand p{font-size:13px!important;font-weight:700!important;letter-spacing:.6px!important;color:#60756b!important;margin:8px 0 0!important}
        #repaymentSchedulePrint .repayment-customer-title{font-size:18px!important;color:#174b3c!important;margin:28px 0 12px!important}
        #repaymentSchedulePrint .repayment-customer{display:grid!important;grid-template-columns:1fr 1fr!important;gap:16px 20px!important}
        #repaymentSchedulePrint .repayment-customer div{min-height:42px!important;padding:4px 0!important;border-bottom:1px solid #d4dfd8!important}
        #repaymentSchedulePrint .repayment-customer small{display:block!important;font-size:12px!important;color:#65776e!important;margin-bottom:5px!important}
        #repaymentSchedulePrint .repayment-customer b{font-size:15px!important;overflow-wrap:anywhere!important}
        #repaymentSchedulePrint .repayment-right-footer{margin-top:36px!important;display:grid!important;grid-template-columns:1fr 1fr!important;gap:8px 22px!important;font-size:12px!important;color:#52665c!important}
        #repaymentSchedulePrint .repayment-right-footer span{height:45px!important;border-bottom:1px solid #52665c!important}
        #repaymentSchedulePrint .repayment-fold-mark{position:absolute!important;left:50%!important;top:0!important;bottom:0!important;border-left:2px dashed #82958b!important;font-size:0!important}
#repaymentSchedulePrint.repayment-fold-sheet{display:grid!important;grid-template-columns:1fr 1fr!important;grid-template-rows:1fr!important;align-items:stretch!important;width:1100px!important;height:740px!important;min-height:740px!important;max-height:740px!important;padding:18px!important;box-sizing:border-box!important;position:relative!important;overflow:hidden!important;border:2px solid #244b3c!important;background:#fff!important}
        #repaymentSchedulePrint .repayment-left{display:block!important;grid-column:1!important;grid-row:1!important;width:auto!important;height:100%!important;padding:10px 18px 10px 6px!important;box-sizing:border-box!important;min-width:0!important}
        #repaymentSchedulePrint .repayment-right{display:block!important;grid-column:2!important;grid-row:1!important;width:auto!important;height:100%!important;padding:30px 12px 12px 30px!important;box-sizing:border-box!important;min-width:0!important;border-left:2px dashed #71877b!important}
        #repaymentSchedulePrint .repayment-left h2{font-size:17px!important;color:#174b3c!important;text-align:center!important;margin:0 0 10px!important;padding-bottom:7px!important;border-bottom:2px solid #174b3c!important}
        #repaymentSchedulePrint .repayment-table{display:table!important;width:100%!important;border-collapse:collapse!important;table-layout:fixed!important;font-size:11px!important}
        #repaymentSchedulePrint .repayment-table thead{display:table-header-group!important}
        #repaymentSchedulePrint .repayment-table tbody{display:table-row-group!important}
        #repaymentSchedulePrint .repayment-table tr{display:table-row!important;height:24px!important}
        #repaymentSchedulePrint .repayment-table th,#repaymentSchedulePrint .repayment-table td{display:table-cell!important;border:1px solid #b9c9bf!important;padding:3px 4px!important;height:24px!important;line-height:1.1!important;text-align:center!important;vertical-align:middle!important;white-space:normal!important}
        #repaymentSchedulePrint .repayment-table th{background:#e8f1ec!important;color:#174b3c!important;font-weight:700!important}
        #repaymentSchedulePrint .repayment-table td.repayment-sign-cell{height:24px!important}
        #repaymentSchedulePrint .repayment-brand{display:flex!important;align-items:center!important;gap:14px!important;padding:0 0 14px!important;border-bottom:3px solid #174b3c!important}
        #repaymentSchedulePrint .repayment-brand img{display:block!important;width:76px!important;height:76px!important;max-width:76px!important;object-fit:contain!important;flex:0 0 76px!important}
        #repaymentSchedulePrint .repayment-brand h1{font-size:20px!important;line-height:1.15!important;color:#174b3c!important;margin:0!important}
        #repaymentSchedulePrint .repayment-brand p{font-size:11px!important;font-weight:700!important;letter-spacing:.5px!important;color:#60756b!important;margin:6px 0 0!important}
        #repaymentSchedulePrint .repayment-customer-title{font-size:16px!important;color:#174b3c!important;margin:22px 0 10px!important}
        #repaymentSchedulePrint .repayment-customer{display:grid!important;grid-template-columns:1fr 1fr!important;gap:12px 14px!important}
        #repaymentSchedulePrint .repayment-customer div{display:block!important;min-height:38px!important;padding:3px 0!important;border-bottom:1px solid #d4dfd8!important;min-width:0!important}
        #repaymentSchedulePrint .repayment-customer small{display:block!important;font-size:10px!important;color:#65776e!important;margin-bottom:4px!important}
        #repaymentSchedulePrint .repayment-customer b{display:block!important;font-size:12px!important;overflow-wrap:anywhere!important}
        #repaymentSchedulePrint .repayment-right-footer{margin-top:28px!important;display:grid!important;grid-template-columns:1fr 1fr!important;gap:7px 14px!important;font-size:10px!important;color:#52665c!important}
        #repaymentSchedulePrint .repayment-right-footer span{display:block!important;height:34px!important;border-bottom:1px solid #52665c!important}
        #repaymentSchedulePrint .repayment-fold-mark{display:block!important;position:absolute!important;left:50%!important;top:0!important;bottom:0!important;border-left:2px dashed #82958b!important;font-size:0!important;z-index:2!important}
        .tablewrap{overflow:visible!important}
      `;
      clonedDoc.head.appendChild(style);
    }
    });
  } finally {
    if (expandLandscapeRoot) {
      if (previousInlineStyle === null) element.removeAttribute("style");
      else element.setAttribute("style",previousInlineStyle);
    }
  }
  if (!canvas || !canvas.width || !canvas.height) throw new Error("PDF पेज तैयार नहीं हुआ। Schedule को दोबारा खोलकर प्रयास करें।");
  const {jsPDF} = window.jspdf;
  const pdf = new jsPDF({orientation:options.orientation || "landscape",unit:"mm",format:"a4",compress:true});
  const pageW = options.orientation === "portrait" ? 210 : 297, pageH = options.orientation === "portrait" ? 297 : 210, margin = Number.isFinite(options.pageMarginMm) ? options.pageMarginMm : 7, usableW = pageW - margin*2, usableH = pageH - margin*2;
  if (options.fitOnePage) {
    const ratio = Math.min(usableW/canvas.width,usableH/canvas.height);
    const w = canvas.width*ratio, h = canvas.height*ratio;
    pdf.addImage(canvas.toDataURL("image/jpeg",0.94),"JPEG",(pageW-w)/2,(pageH-h)/2,w,h,undefined,"FAST");
  } else {
    const sliceHeight = options.targetPages ? Math.ceil(canvas.height / options.targetPages) : Math.floor(canvas.width * usableH / usableW);
    let y = 0, page = 0;
    while (y < canvas.height) {
      const h = Math.min(sliceHeight,canvas.height-y);
      const slice = document.createElement("canvas");
      slice.width = canvas.width; slice.height = h;
      slice.getContext("2d").drawImage(canvas,0,y,canvas.width,h,0,0,canvas.width,h);
      if (page > 0) pdf.addPage("a4","landscape");
      const renderedH = h * usableW / canvas.width;
      if (renderedH > usableH) { const scale = usableH / renderedH; pdf.addImage(slice.toDataURL("image/jpeg",0.94),"JPEG",margin,margin,usableW*scale,usableH,undefined,"FAST"); }
      else pdf.addImage(slice.toDataURL("image/jpeg",0.94),"JPEG",margin,margin,usableW,renderedH,undefined,"FAST");
      y += h; page++;
    }
  }
  const blob = pdf.output("blob");
  if (!blob || blob.size < 100) throw new Error("PDF खाली बनी है। कृपया दोबारा प्रयास करें।");
  const file = new File([blob],fileName,{type:"application/pdf"});
  if (window.AJSFNativeDownload?.saveBase64) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (let i=0;i<bytes.length;i+=0x8000) binary += String.fromCharCode(...bytes.subarray(i,i+0x8000));
    const result = await Promise.resolve(window.AJSFNativeDownload.saveBase64(btoa(binary),file.name,file.type));
    if (result && result !== "OK") throw new Error(String(result));
    if (result === "OK" || result === undefined || result === null) return;
  }
  triggerBrowserDownload(blob,fileName,120000);
}
async function handleDocumentPdf(buttonId, elementId, fileName, successMessage, options = {}) {
  const button = $(buttonId);
  setBusy(button,true,"PDF तैयार हो रही है…");
  try {
    await downloadElementPdf($(elementId),fileName,options);
    showMessage(successMessage,"success");
  } catch(error) {
    showMessage("PDF डाउनलोड नहीं हो पाई: "+(error?.message || String(error)),"warn");
  } finally { setBusy(button,false); }
}

async function createReceiptPdf() {
  const area = $("receiptContent");
  if (!lastReceipt || !area || !area.innerHTML.trim()) throw new Error("पहले भुगतान सेव करें।");
  await loadReceiptLibrary("https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js", () => typeof window.html2canvas === "function");
  const canvas = await window.html2canvas(area, {scale:2,backgroundColor:"#ffffff",useCORS:true,logging:false});
  await loadReceiptLibrary("https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js", () => !!window.jspdf?.jsPDF);
  const {jsPDF} = window.jspdf;
  const pdf = new jsPDF({orientation:"portrait",unit:"mm",format:"a5"});
  const width = 138, height = canvas.height * width / canvas.width;
  pdf.addImage(canvas.toDataURL("image/png"),"PNG",6,6,width,Math.min(height,198));
  const receiptNo = (lastReceipt.payment.id || lastReceipt.payment.client_tx_id || "receipt").slice(0,8).toUpperCase();
  return new File([pdf.output("blob")],"AJSF-Receipt-"+receiptNo+".pdf",{type:"application/pdf"});
}
async function downloadReceiptPdf() {
  const button = $("downloadReceiptPdfBtn");
  setBusy(button,true,"PDF तैयार हो रही है…");
  try {
    const file = await createReceiptPdf();
    if (window.AJSFNativeDownload?.saveBase64) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const result = window.AJSFNativeDownload.saveBase64(btoa(binary), file.name, file.type);
      if (result !== "OK") throw new Error(result || "Android में PDF सेव नहीं हो पाई।");
    } else {
      triggerBrowserDownload(file,file.name,120000);
    }
    showMessage("रसीद PDF Downloads में सेव हो गई है। अब इसे किसी भी ऐप से भेज सकते हैं।","success");
  } catch(error) {
    showMessage("PDF डाउनलोड नहीं हो पाई: " + (error?.message || String(error)),"warn");
  } finally {
    setBusy(button,false);
  }
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


let dayDemandReport=null;
function dateOnlyLocal(value){if(!value)return "";const d=new Date(value);if(Number.isNaN(d.getTime()))return "";return [d.getFullYear(),String(d.getMonth()+1).padStart(2,"0"),String(d.getDate()).padStart(2,"0")].join("-");}
function loadDayDemandReport(){
 if(!canAdmin())return;
 const dateInput=$("demandReportDate"),daySelect=$("demandReportDay"),collectorSelect=$("demandReportCollector");
 if(!dateInput.value)dateInput.value=localDateValue();
 const date=dateInput.value,[yy,mm,dd]=date.split("-").map(Number),selectedDate=new Date(yy,mm-1,dd);
 selectedDate.setHours(0,0,0,0);
 const weekday=["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][selectedDate.getDay()];
 if(!daySelect.value)daySelect.value=weekday;
 const selectedDay=daySelect.value,collectorId=collectorSelect.value,customerById=new Map(customers.map(c=>[c.id,c]));
 const eligibleLoans=loans.filter(l=>{const c=customerById.get(l.customer_id);return c&&c.is_active!==false&&c.customer_status!=="INACTIVE"&&l.status==="active"&&!l.is_archived&&(!selectedDay||c.collection_day===selectedDay)&&(!collectorId||c.assigned_collector===collectorId);});
 const collectedRows=[],pendingRows=[],rupee=n=>Math.round(Number(n||0)*100)/100;
 for(const loan of eligibleLoans){
  const customer=customerById.get(loan.customer_id),count=Math.max(0,Math.min(600,Number(loan.total_emis_required||0)));
  for(let emi=1;emi<=count;emi++){
   const due=advanceDueDate(loan,customer,emi);if(!due)continue;due.setHours(0,0,0,0);
   const dueKey=localISODate(due);if(dueKey>date)break;
   // This report is strictly for the selected collection date. Earlier dues are not carried into today's OD.
   if(dueKey!==date)continue;
   const nextDue=advanceDueDate(loan,customer,emi+1);
   const ledgerRows=advanceLedger.filter(x=>x.loan_id===loan.id&&Number(x.applied_week_no)===emi&&["cash_applied","advance_adjusted"].includes(x.entry_type));
   const ledgerPaid=ledgerRows.reduce((sum,x)=>sum+Number(x.amount||0),0),marker=advanceMarkerAmount(loan,emi);
   let paid=marker+ledgerPaid;
   if(!ledgerRows.length&&!marker){
    const startTime=due.getTime(),endTime=nextDue?nextDue.getTime():Infinity;
    paid+=payments.filter(p=>p.loan_id===loan.id&&!p.is_reversal&&!p.offline_pending).filter(p=>{
     const t=new Date(p.paid_at||p.created_at||"").getTime();return Number.isFinite(t)&&t>=startTime&&t<endTime;
    }).reduce((sum,p)=>sum+Number(p.amount||0),0);
   }
   const emiAmount=Number(ledgerRows.find(x=>Number(x.emi_amount_at_allocation)>0)?.emi_amount_at_allocation||loan.emi_amount||0);
   const received=rupee(Math.min(emiAmount,Math.max(0,paid))),remaining=rupee(Math.max(0,emiAmount-received));
   const row={customer,loan,emi,dueDate:dueKey,demand:emiAmount,received,remaining};
   if(remaining<=0)collectedRows.push(row);else pendingRows.push(row);
  }
 }
 const receiptRows=payments.filter(p=>!p.is_reversal&&!p.offline_pending&&dateOnlyLocal(p.paid_at||p.created_at)===date&&(!collectorId||p.collector_id===collectorId)).sort((a,b)=>new Date(a.paid_at||a.created_at)-new Date(b.paid_at||b.created_at));
 const allDayRows=[...collectedRows,...pendingRows];
 const customerCount=new Set(allDayRows.map(x=>x.customer.id)).size;
 const totalDemand=rupee(allDayRows.reduce((s,x)=>s+x.demand,0));
 const collectedAmount=rupee(collectedRows.reduce((s,x)=>s+x.demand,0));
 const pendingAmount=rupee(pendingRows.reduce((s,x)=>s+x.remaining,0));
 const receivedAmount=rupee(allDayRows.reduce((s,x)=>s+x.received,0));
 $("dayDemandCustomers").textContent=String(customerCount);
 $("dayDemandTotal").textContent=money(totalDemand);
 $("dayDemandCollected").textContent=collectedRows.length+" EMI · "+money(collectedAmount);
 $("dayDemandPending").textContent=pendingRows.length+" EMI · "+money(pendingAmount);
 const modeTotals={cash:0,upi:0,bank_transfer:0}; receiptRows.forEach(p=>{const m=p.payment_mode||"cash";if(Object.prototype.hasOwnProperty.call(modeTotals,m))modeTotals[m]+=Number(p.amount||0);}); Object.keys(modeTotals).forEach(k=>modeTotals[k]=rupee(modeTotals[k]));
 $("dayDemandReceipts").innerHTML=receiptRows.map(p=>{const c=customerById.get(p.customer_id),l=loans.find(x=>x.id===p.loan_id),stamp=new Date(p.paid_at||p.created_at||"");return '<tr><td>'+esc((p.id||p.client_tx_id||"").slice(0,8).toUpperCase())+'</td><td>'+esc(formatCustomerId(c?.customer_code))+' · '+esc(c?.full_name||"—")+'</td><td>'+esc(l?.loan_reference||"—")+'</td><td>'+(Number.isNaN(stamp.getTime())?"—":esc(stamp.toLocaleTimeString("en-IN",{hour:"2-digit",minute:"2-digit"})))+'</td><td>'+esc(p.payment_mode||"cash")+'</td><td>'+money(p.amount)+'</td></tr>';}).join("")||'<tr><td colspan="6" class="empty">इस तारीख की कोई Receipt नहीं मिली।</td></tr>';
 const emiHtml=r=>'<tr><td>'+esc(formatCustomerId(r.customer.customer_code))+'</td><td>'+esc(r.customer.full_name||"—")+'</td><td>'+esc(r.customer.center_name||"—")+'</td><td>'+esc(r.loan.loan_reference||"—")+'</td><td>'+r.emi+'</td><td>'+esc(r.dueDate)+'</td><td>'+money(r.demand)+'</td><td>'+money(r.received)+'</td><td><strong>'+money(r.remaining)+'</strong></td></tr>';
 $("dayDemandCollectedRows").innerHTML=collectedRows.map(emiHtml).join("")||'<tr><td colspan="9" class="empty">इस दिन की कोई पूरी EMI collect नहीं हुई।</td></tr>';
 $("dayDemandPendingRows").innerHTML=pendingRows.map(emiHtml).join("")||'<tr><td colspan="9" class="empty">इस दिन कोई EMI Pending / OD नहीं है।</td></tr>';
 dayDemandReport={date,selectedDay,customerCount,totalDemand,collectedAmount,pendingAmount,receivedAmount,collectedRows,pendingRows,receiptRows};
}
function printDayDemandReport(){
 if(!dayDemandReport)loadDayDemandReport();if(!dayDemandReport)return;const r=dayDemandReport;
 const rowsHtml=items=>items.map(x=>'<tr><td>'+esc(formatCustomerId(x.customer.customer_code))+'</td><td>'+esc(x.customer.full_name||"—")+'</td><td>'+esc(x.loan.loan_reference||"—")+'</td><td>'+x.emi+'</td><td>'+esc(x.dueDate)+'</td><td>'+money(x.demand)+'</td><td>'+money(x.received)+'</td><td>'+money(x.remaining)+'</td></tr>').join("");
 const receipts=r.receiptRows.map(p=>{const c=customerById.get(p.customer_id),l=loans.find(x=>x.id===p.loan_id),stamp=new Date(p.paid_at||p.created_at||"");return '<tr><td>'+esc((p.id||p.client_tx_id||"").slice(0,8).toUpperCase())+'</td><td>'+esc(formatCustomerId(c?.customer_code))+' · '+esc(c?.full_name||"—")+'</td><td>'+esc(l?.loan_reference||"—")+'</td><td>'+esc(p.payment_mode||"cash")+'</td><td>'+money(p.amount)+'</td><td>'+(Number.isNaN(stamp.getTime())?"—":esc(stamp.toLocaleTimeString("en-IN",{hour:"2-digit",minute:"2-digit"})))+'</td></tr>';}).join("");
 const modes={cash:0,upi:0,bank_transfer:0};r.receiptRows.forEach(p=>{const m=p.payment_mode||"cash";if(Object.prototype.hasOwnProperty.call(modes,m))modes[m]+=Number(p.amount||0);});const totalReceived=Object.values(modes).reduce((s,x)=>s+x,0);
 const body='<div class="settlement-print"><header><h2>ARK JAN SAMRIDDHI FOUNDATION</h2><h3>DAILY COLLECTION & COLLECTOR SETTLEMENT</h3><p>Collection Date: '+esc(r.date)+' | Collection Day: '+esc(r.selectedDay)+'</p></header><section class="totals"><div><small>Total Demand</small><b>'+money(r.totalDemand)+'</b></div><div><small>Received against today EMI</small><b>'+money(r.receivedAmount)+'</b></div><div><small>Today EMI Pending</small><b>'+money(r.pendingAmount)+'</b></div><div><small>Cash Received</small><b>'+money(modes.cash)+'</b></div><div><small>UPI Received</small><b>'+money(modes.upi)+'</b></div><div><small>Bank Received</small><b>'+money(modes.bank_transfer)+'</b></div></section><p><b>Customers:</b> '+r.customerCount+' &nbsp; <b>Receipts:</b> '+r.receiptRows.length+' &nbsp; <b>Total Collection:</b> '+money(totalReceived)+'</p><h3>Customer-wise Demand Reconciliation</h3><table><thead><tr><th>Customer ID</th><th>Name</th><th>Loan Ref</th><th>EMI</th><th>Due Date</th><th>Demand</th><th>Received</th><th>Remaining</th></tr></thead><tbody>'+rowsHtml([...r.collectedRows,...r.pendingRows])+'</tbody></table><h3>Today Receipts — Cash / UPI / Bank</h3><table><thead><tr><th>Receipt ID</th><th>Customer</th><th>Loan Ref</th><th>Mode</th><th>Amount</th><th>Time</th></tr></thead><tbody>'+(receipts||'<tr><td colspan="6">आज कोई सफल Receipt नहीं मिली।</td></tr>')+'</tbody></table><h3>Pending / Partial EMI — Today Only</h3><table><thead><tr><th>Customer ID</th><th>Name</th><th>Loan Ref</th><th>EMI</th><th>Due Date</th><th>Demand</th><th>Received</th><th>Remaining</th></tr></thead><tbody>'+rowsHtml(r.pendingRows)+'</tbody></table><footer>System generated report • Reversed / Offline Pending payments are excluded.</footer></div>';
 openAjsfPrint("AJSF Daily Collection Settlement",body,'@page{size:A4 landscape;margin:7mm}body{font-size:8pt}.settlement-print h2{text-align:center;color:#123f35;margin:0}.settlement-print h3{margin:12px 0 5px;color:#123f35}.settlement-print header p{text-align:center}.settlement-print .totals{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin:8px 0}.settlement-print .totals div{border:1px solid #cbd8d0;background:#edf5f0;padding:7px}.settlement-print .totals small,.settlement-print .totals b{display:block}.settlement-print .totals b{font-size:12pt;margin-top:3px}table{width:100%;border-collapse:collapse;margin:5px 0 10px}th,td{border:1px solid #999;padding:4px;text-align:left}th{background:#eaf1ed}footer{text-align:center;margin-top:10px;font-size:8pt}');
}

function settlementDateKey(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return [d.getFullYear(),String(d.getMonth()+1).padStart(2,"0"),String(d.getDate()).padStart(2,"0")].join("-");
}
function settlementTotalsFor(collectorId, date) {
  const totals = {cash:0,upi:0,bank_transfer:0};
  payments.filter(p => p.collector_id === collectorId && !p.is_reversal && settlementDateKey(p.paid_at || p.created_at) === date)
    .forEach(p => { const mode = p.payment_mode || "cash"; if (Object.prototype.hasOwnProperty.call(totals,mode)) totals[mode] += Number(p.amount || 0); });
  Object.keys(totals).forEach(k => totals[k] = Math.round(totals[k]*100)/100);
  return totals;
}
async function loadDailySettlement() {
  if (!canAdmin()) return;
  const dateInput = $("settlementDate");
  if (!dateInput.value) dateInput.value = localDateValue();
  const date = dateInput.value;
  const body = $("settlementRows");
  body.innerHTML = '<tr><td colspan="9" class="empty">Settlement डेटा लोड हो रहा है…</td></tr>';
  try {
    const [staffResult, recordsResult] = await Promise.all([
      supabase.from("profiles").select("id,full_name,staff_code").eq("role","collector").eq("is_active",true).order("full_name"),
      supabase.from("daily_collection_settlements").select("*").eq("settlement_date",date)
    ]);
    if (staffResult.error) throw staffResult.error;
    if (recordsResult.error) throw recordsResult.error;
    settlementCollectors = staffResult.data || [];
    const dayCollector = $("demandReportCollector");
    if (dayCollector) {
      const selectedDayCollector = dayCollector.value;
      dayCollector.innerHTML = '<option value="">सभी Collector</option>' + settlementCollectors.map(x=>'<option value="'+esc(x.id)+'">'+esc(x.full_name)+'</option>').join("");
      if (selectedDayCollector) dayCollector.value = selectedDayCollector;
    }
    const reportCollector = $("settlementReportCollector");
    if (reportCollector) {
      const selected = reportCollector.value;
      reportCollector.innerHTML = '<option value="">सभी Collector</option>' + settlementCollectors.map(x=>'<option value="'+esc(x.id)+'">'+esc(x.full_name)+'</option>').join("");
      if (selected) reportCollector.value = selected;
    }
    dailySettlements = recordsResult.data || [];
    if (!settlementCollectors.length) {
      body.innerHTML = '<tr><td colspan="9" class="empty">कोई Active Collector नहीं मिला।</td></tr>';
      return;
    }
    body.innerHTML = settlementCollectors.map(staff => {
      const system = settlementTotalsFor(staff.id,date);
      const saved = dailySettlements.find(x => x.collector_id === staff.id);
      const approved = saved?.status === "approved";
      const deposited = {cash:Number(saved?.deposited_cash ?? 0),upi:Number(saved?.deposited_upi ?? 0),bank_transfer:Number(saved?.deposited_bank ?? 0)};
      const difference = (system.cash+system.upi+system.bank_transfer) - (deposited.cash+deposited.upi+deposited.bank_transfer);
      const lock = approved ? "disabled" : "";
      const status = approved ? "Approved" : saved ? "Draft Saved" : "Not Settled";
      const input = (kind,val) => '<input type="number" min="0" step="0.01" inputmode="decimal" data-settlement-kind="'+kind+'" data-collector-id="'+esc(staff.id)+'" value="'+Number(val||0).toFixed(2)+'" '+lock+' style="width:92px">';
      return '<tr data-settlement-row="'+esc(staff.id)+'"><td><strong>'+esc(staff.full_name)+'</strong><br><small>'+esc(staff.staff_code||"")+'</small></td><td>'+money(system.cash)+'</td><td>'+money(system.upi)+'</td><td>'+money(system.bank_transfer)+'</td><td>'+input("cash",deposited.cash)+'</td><td>'+input("upi",deposited.upi)+'</td><td>'+input("bank_transfer",deposited.bank_transfer)+'</td><td><strong>'+money(difference)+'</strong></td><td><span>'+status+'</span><br>'+(approved ? '<small>By '+esc(saved.approved_by||"Admin")+'</small>' : '<button type="button" class="secondary" data-settlement-action="save" data-collector-id="'+esc(staff.id)+'">Draft सेव करें</button> <button type="button" data-settlement-action="approve" data-collector-id="'+esc(staff.id)+'" '+(saved ? "" : "disabled")+(Math.abs(difference)>0.009 ? ' title="अंतर होने पर भी Approval संभव है; पहले जाँच लें।"' : '')+'>Approve</button>')+'</td></tr>';
    }).join("");
    loadDayDemandReport();
  } catch (error) {
    body.innerHTML = '<tr><td colspan="9" class="empty">Settlement लोड नहीं हुआ: '+esc(error?.message||String(error))+'</td></tr>';
  }
}

let settlementReportData = [];
function settlementReportTotals(row) {
  const expected = Number(row.expected_cash||0)+Number(row.expected_upi||0)+Number(row.expected_bank||0);
  const deposited = Number(row.deposited_cash||0)+Number(row.deposited_upi||0)+Number(row.deposited_bank||0);
  return {expected,deposited,difference:expected-deposited};
}
async function loadSettlementReport() {
  if (!canAdmin()) return;
  const from = $("settlementReportFrom")?.value || localDateValue();
  const to = $("settlementReportTo")?.value || from;
  const collector = $("settlementReportCollector")?.value || "";
  const status = $("settlementReportStatus")?.value || "";
  const body = $("settlementReportRows");
  if (from > to) { showMessage("From Date, To Date से पहले होनी चाहिए।","warn"); return; }
  body.innerHTML = '<tr><td colspan="9" class="empty">रिपोर्ट लोड हो रही है…</td></tr>';
  try {
    // Date boundaries are India-local because collection dates are recorded in IST.
    const nextDay = new Date(to + "T00:00:00");
    nextDay.setDate(nextDay.getDate() + 1);
    const toExclusive = [nextDay.getFullYear(),String(nextDay.getMonth()+1).padStart(2,"0"),String(nextDay.getDate()).padStart(2,"0")].join("-");

    const staffQuery = supabase.from("profiles").select("id,full_name,staff_code").eq("role","collector");
    const [staffResult, settlementResult] = await Promise.all([
      collector ? staffQuery.eq("id",collector) : staffQuery.order("full_name"),
      supabase.from("daily_collection_settlements").select("*").gte("settlement_date",from).lte("settlement_date",to)
        .order("settlement_date",{ascending:false})
    ]);
    if (staffResult.error) throw staffResult.error;
    if (settlementResult.error) throw settlementResult.error;
    const staffById = {};
    (staffResult.data || []).forEach(x => { staffById[x.id] = x.full_name + (x.staff_code ? " ("+x.staff_code+")" : ""); });

    // Read actual payments for the selected period, including older rows beyond the first 1,000.
    let paymentRows = [];
    for (let offset = 0; ; offset += 1000) {
      let paymentQuery = supabase.from("payments").select("id,collector_id,amount,paid_at,created_at,payment_mode,is_reversal")
        .gte("paid_at",from+"T00:00:00+05:30").lt("paid_at",toExclusive+"T00:00:00+05:30")
        .order("paid_at",{ascending:true}).range(offset,offset+999);
      if (collector) paymentQuery = paymentQuery.eq("collector_id",collector);
      const result = await paymentQuery;
      if (result.error) throw result.error;
      paymentRows.push(...(result.data || []));
      if (!result.data || result.data.length < 1000) break;
    }

    const rowsByKey = new Map();
    const ensureRow = (date, collectorId) => {
      const key = date+"|"+collectorId;
      if (!rowsByKey.has(key)) rowsByKey.set(key,{
        settlement_date:date,collector_id:collectorId,
        collector_name:staffById[collectorId] || "Collector",
        expected_cash:0,expected_upi:0,expected_bank:0,
        deposited_cash:0,deposited_upi:0,deposited_bank:0,
        status:"not_settled"
      });
      return rowsByKey.get(key);
    };

    // Actual collection comes from payments, not from saved settlement drafts.
    paymentRows.forEach(p => {
      if (p.is_reversal || !p.collector_id) return;
      const date = settlementDateKey(p.paid_at || p.created_at);
      if (!date || date < from || date > to) return;
      const row = ensureRow(date,p.collector_id);
      const mode = p.payment_mode || "cash";
      const amount = Number(p.amount || 0);
      if (mode === "cash") row.expected_cash += amount;
      else if (mode === "upi") row.expected_upi += amount;
      else if (mode === "bank_transfer") row.expected_bank += amount;
    });

    // Merge saved deposits and approval state without replacing payment-derived totals.
    (settlementResult.data || []).forEach(saved => {
      const row = ensureRow(saved.settlement_date,saved.collector_id);
      row.deposited_cash = Number(saved.deposited_cash || 0);
      row.deposited_upi = Number(saved.deposited_upi || 0);
      row.deposited_bank = Number(saved.deposited_bank || 0);
      row.status = saved.status === "approved" ? "approved" : "pending";
      row.settlement_id = saved.id;
      row.approved_at = saved.approved_at;
    });

    settlementReportData = [...rowsByKey.values()]
      .filter(x => !collector || x.collector_id === collector)
      .filter(x => !status || (status === "approved" ? x.status === "approved" : x.status !== "approved"))
      .map(x => {
        x.expected_cash = Math.round(x.expected_cash*100)/100;
        x.expected_upi = Math.round(x.expected_upi*100)/100;
        x.expected_bank = Math.round(x.expected_bank*100)/100;
        x.status_label = x.status === "approved" ? "Approved" : x.status === "pending" ? "Pending / Draft" : "Not Settled";
        return x;
      })
      .sort((a,b) => b.settlement_date.localeCompare(a.settlement_date) || a.collector_name.localeCompare(b.collector_name));

    const sum = settlementReportData.reduce((a,x) => {
      const t = settlementReportTotals(x);
      a.expected += t.expected; a.deposited += t.deposited; a.difference += t.difference;
      if (x.status === "approved") a.approved++; else a.pending++;
      return a;
    },{expected:0,deposited:0,difference:0,approved:0,pending:0});
    $("settlementReportExpected").textContent = money(sum.expected);
    $("settlementReportDeposited").textContent = money(sum.deposited);
    $("settlementReportDifference").textContent = money(sum.difference);
    $("settlementReportStatusCount").textContent = sum.approved+" / "+sum.pending;
    body.innerHTML = settlementReportData.length ? settlementReportData.map(x => {
      const t = settlementReportTotals(x);
      return '<tr><td>'+esc(x.settlement_date)+'</td><td>'+esc(x.collector_name)+'</td><td>'+money(t.expected)+'</td><td>'+money(t.deposited)+'</td><td>'+money(t.difference)+'</td><td>'+money(x.expected_cash)+' / '+money(x.deposited_cash)+'</td><td>'+money(x.expected_upi)+' / '+money(x.deposited_upi)+'</td><td>'+money(x.expected_bank)+' / '+money(x.deposited_bank)+'</td><td>'+esc(x.status_label)+'</td></tr>';
    }).join("") : '<tr><td colspan="9" class="empty">इस अवधि में कोई Collection या Settlement रिकॉर्ड नहीं मिला।</td></tr>';
  } catch(error) {
    settlementReportData = [];
    body.innerHTML = '<tr><td colspan="9" class="empty">रिपोर्ट नहीं खुली: '+esc(error?.message||String(error))+'</td></tr>';
    showMessage("Settlement Report लोड नहीं हुई।","error");
  }
}
function downloadSettlementReportCsv() {
  if (!settlementReportData.length) return showMessage("पहले रिपोर्ट देखें; डाउनलोड के लिए कोई रिकॉर्ड नहीं है।","warn");
  const columns = [["Date","settlement_date"],["Collector","collector_name"],["System Cash","expected_cash"],["Deposited Cash","deposited_cash"],["System UPI","expected_upi"],["Deposited UPI","deposited_upi"],["System Bank","expected_bank"],["Deposited Bank","deposited_bank"],["System Total","expected_total"],["Deposited Total","deposited_total"],["Difference","difference"],["Status","status"]];
  const quote = v => '"'+String(v??"").replace(/"/g,'""')+'"';
  const rows = [columns.map(x=>quote(x[0])).join(",")];
  settlementReportData.forEach(x=>{
    const t=settlementReportTotals(x);
    const values={...x,expected_total:t.expected,deposited_total:t.deposited,difference:t.difference};
    rows.push(columns.map(c=>quote(values[c[1]])).join(","));
  });
  const blob=new Blob(["\ufeff"+rows.join("\r\n")],{type:"text/csv;charset=utf-8"});
  triggerBrowserDownload(blob,"AJSF-Settlement-Report.csv",120000);
}
function settlementReportPrintHtml() {
  const from = $("settlementReportFrom")?.value || "";
  const to = $("settlementReportTo")?.value || from;
  const collector = $("settlementReportCollector")?.selectedOptions?.[0]?.textContent || "सभी Collector";
  const status = $("settlementReportStatus")?.selectedOptions?.[0]?.textContent || "सभी Status";
  const totals = settlementReportData.reduce((sum,row) => {
    const t=settlementReportTotals(row);
    sum.expected+=t.expected; sum.deposited+=t.deposited; sum.difference+=t.difference;
    return sum;
  },{expected:0,deposited:0,difference:0});
  const rows = settlementReportData.map(row => {
    const t=settlementReportTotals(row);
    return '<tr><td>'+esc(row.settlement_date)+'</td><td>'+esc(row.collector_name)+'</td><td>'+money(t.expected)+'</td><td>'+money(t.deposited)+'</td><td>'+money(t.difference)+'</td><td>'+money(row.expected_cash)+' / '+money(row.deposited_cash)+'</td><td>'+money(row.expected_upi)+' / '+money(row.deposited_upi)+'</td><td>'+money(row.expected_bank)+' / '+money(row.deposited_bank)+'</td><td>'+esc(row.status_label)+'</td></tr>';
  }).join("");
  return '<div class="settlement-print"><header><h2>ARK JAN SAMRIDDHI FOUNDATION</h2><h3>Daily Collection Settlement Report</h3><p>अवधि: '+esc(from)+' से '+esc(to)+' | Collector: '+esc(collector)+' | Status: '+esc(status)+'</p></header><section class="totals"><div><small>System Collection</small><b>'+money(totals.expected)+'</b></div><div><small>जमा राशि</small><b>'+money(totals.deposited)+'</b></div><div><small>अंतर</small><b>'+money(totals.difference)+'</b></div></section><table><thead><tr><th>तारीख</th><th>Collector</th><th>System Total</th><th>जमा Total</th><th>अंतर</th><th>Cash (System / जमा)</th><th>UPI (System / जमा)</th><th>Bank (System / जमा)</th><th>Status</th></tr></thead><tbody>'+rows+'</tbody></table><footer>Generated from AJSF Online</footer></div>';
}
async function downloadSettlementReportPdf() {
  const button=$("downloadSettlementReportPdfBtn");
  if (!settlementReportData.length) return showMessage("पहले रिपोर्ट देखें; डाउनलोड के लिए कोई रिकॉर्ड नहीं है।","warn");
  setBusy(button,true,"PDF तैयार हो रही है…");
  let area;
  try {
    area=document.createElement("div");
    area.id="settlementReportPdfArea";
    area.style.cssText="position:fixed;left:-12000px;top:0;width:1100px;padding:28px;background:#fff;color:#172923;font:14px Arial,sans-serif";
    area.innerHTML=settlementReportPrintHtml()+'<style>.settlement-print h2{margin:0;color:#123f35;text-align:center;font-size:22px}.settlement-print h3{text-align:center;margin:5px 0 10px}.settlement-print header p{text-align:center;margin:6px 0 14px}.settlement-print .totals{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:12px 0}.settlement-print .totals div{padding:10px;border:1px solid #cbd8d0;background:#edf5f0}.settlement-print .totals small,.settlement-print .totals b{display:block}.settlement-print .totals b{font-size:18px;margin-top:4px}.settlement-print table{width:100%;border-collapse:collapse;font-size:11px}.settlement-print th,.settlement-print td{border:1px solid #9aa99f;padding:7px;text-align:left}.settlement-print th{background:#eaf2ed}.settlement-print footer{text-align:center;margin-top:12px;font-size:10px;color:#60756b}</style>';
    document.body.appendChild(area);
    await downloadElementPdf(area,"AJSF-Daily-Collection-Settlement.pdf",{fitOnePage:true,pageMarginMm:5});
    showMessage("Daily Collection Settlement PDF डाउनलोड हो गई है।","success");
  } catch(error) {
    showMessage("Settlement PDF डाउनलोड नहीं हुई: "+(error?.message||String(error)),"error");
  } finally { area?.remove(); setBusy(button,false); }
}
function printSettlementReport() {
  if (!settlementReportData.length) return showMessage("पहले रिपोर्ट देखें; Print के लिए कोई रिकॉर्ड नहीं है।","warn");
  openAjsfPrint("AJSF Daily Collection Settlement",settlementReportPrintHtml(),`
    @page{size:A4 landscape;margin:8mm}
    body{font-size:9pt}
    .settlement-print h2{text-align:center;font-size:17pt;margin:0;color:#123f35}
    .settlement-print h3{text-align:center;margin:4px 0 8px}
    .settlement-print header p{text-align:center;margin:5px 0 10px}
    .settlement-print .totals{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:8px 0}
    .settlement-print .totals div{padding:7px;border:1px solid #cbd8d0;background:#edf5f0}
    .settlement-print .totals small,.settlement-print .totals b{display:block}
    .settlement-print .totals b{font-size:12pt;margin-top:3px}
    .settlement-print table{font-size:8pt}
    .settlement-print th,.settlement-print td{padding:5px}
    .settlement-print footer{text-align:center;margin-top:8px;font-size:8pt}
  `);
}

async function handleDailySettlementAction(button) {
  if (!canAdmin()) return;
  const collectorId = button.dataset.collectorId;
  const date = $("settlementDate")?.value || localDateValue();
  const saved = dailySettlements.find(x => x.collector_id === collectorId);
  if (saved?.status === "approved") return showMessage("यह Settlement पहले ही Approve हो चुका है।","warn");
  const row = $("settlementRows").querySelector('[data-settlement-row="'+collectorId+'"]');
  if (!row) return;
  const getAmount = kind => Math.max(0,Number(row.querySelector('[data-settlement-kind="'+kind+'"]')?.value || 0));
  if (button.dataset.settlementAction === "save") {
    const system = settlementTotalsFor(collectorId,date);
    const payload = {
      settlement_date:date, collector_id:collectorId,
      expected_cash:system.cash, expected_upi:system.upi, expected_bank:system.bank_transfer,
      deposited_cash:getAmount("cash"), deposited_upi:getAmount("upi"), deposited_bank:getAmount("bank_transfer"),
      notes:null, status:"pending", created_by:currentUser.id, approved_by:null, approved_at:null
    };
    setBusy(button,true,"सेव हो रहा है…");
    try {
      const {error} = await supabase.from("daily_collection_settlements").upsert(payload,{onConflict:"settlement_date,collector_id"});
      if (error) throw error;
      showMessage("Collector का Settlement Draft सेव हो गया। अब जाँचकर Approve करें।","success");
      await loadDailySettlement();
    } catch(error) { showMessage("Settlement सेव नहीं हुआ: "+(error?.message||String(error)),"error"); }
    finally { setBusy(button,false); }
  } else if (button.dataset.settlementAction === "approve") {
    if (!saved) return showMessage("पहले Settlement Draft सेव करें।","warn");
    if (!window.confirm("इस Collector का "+date+" का Settlement Approve करना है? Approval के बाद यह रिकॉर्ड लॉक हो जाएगा।")) return;
    setBusy(button,true,"Approve हो रहा है…");
    try {
      const system = settlementTotalsFor(collectorId,date);
      const {error} = await supabase.from("daily_collection_settlements").update({
        expected_cash:system.cash, expected_upi:system.upi, expected_bank:system.bank_transfer,
        deposited_cash:getAmount("cash"), deposited_upi:getAmount("upi"), deposited_bank:getAmount("bank_transfer"),
        status:"approved",approved_by:currentUser.id,approved_at:new Date().toISOString()
      }).eq("id",saved.id).eq("status","pending");
      if (error) throw error;
      showMessage("Daily Collection Settlement सफलतापूर्वक Approve हो गया।","success");
      await loadDailySettlement();
    } catch(error) { showMessage("Approval नहीं हुआ: "+(error?.message||String(error)),"error"); }
    finally { setBusy(button,false); }
  }
}

async function logout() {
  const btn = $("loginBtn");
  let signOutError = null;
  try {
    const { error } = await supabase.auth.signOut({ scope:"local" });
    signOutError = error || null;
  } catch (error) {
    signOutError = error;
  } finally {
    currentUser = null; profile = null;
    $("dashboardCard").classList.add("hidden");
    $("loginCard").classList.remove("hidden");
    $("appShell").classList.remove("logged-in");
    $("loginForm").reset();
    setBusy(btn,false);
    btn.disabled = false;
    showMessage(signOutError
      ? "इस डिवाइस से लॉगआउट कर दिया गया। सर्वर से session revoke नहीं हो पाया; इंटरनेट जाँचें।"
      : "आप लॉगआउट हो गए हैं।", signOutError ? "warn" : "info");
  }
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
    event.preventDefault();
    const btn = $("loginBtn");
    if (btn.disabled) return;
    showMessage("");
    setBusy(btn,true,"लॉगिन हो रहा है…");
    try {
      const loginId = $("loginId").value.trim();
      const password = $("password").value;
      let loginData;
      if (/^[0-9]{10}$/.test(loginId)) {
        const { data: mobileData, error: mobileError } =
          await supabase.functions.invoke("staff-mobile-login", {
            body: { phone: loginId, password }
          });
        if (mobileError) throw mobileError;
        if (!mobileData?.success || !mobileData?.session?.access_token || !mobileData?.session?.refresh_token) {
          throw new Error(mobileData?.error || "मोबाइल लॉगिन सत्यापित नहीं हुआ।");
        }
        const { data: sessionData, error: sessionError } =
          await supabase.auth.setSession({
            access_token: mobileData.session.access_token,
            refresh_token: mobileData.session.refresh_token
          });
        if (sessionError) throw sessionError;
        loginData = sessionData;
      } else {
        const { data, error } = await supabase.auth.signInWithPassword({
          email: loginId,
          password
        });
        if (error) throw error;
        loginData = data;
      }
      if (!loginData?.user) throw new Error("Login session नहीं मिला। दोबारा प्रयास करें।");
      currentUser = loginData.user;
      await loadProfile(currentUser);
      renderShell();
      $("customerForm").addEventListener("submit",submitCustomer);
      $("verificationGallery")?.addEventListener("change",e=>setVerificationPhotoFor("customer",e.target.files?.[0]));
      $("verificationHome1Gallery")?.addEventListener("change",e=>setVerificationPhotoFor("home1",e.target.files?.[0]));
      $("verificationHome2Gallery")?.addEventListener("change",e=>setVerificationPhotoFor("home2",e.target.files?.[0]));
      ["aadhaarFront","aadhaarBack","panFront"].forEach(setupIdentityDocEditor);
      document.querySelectorAll("[data-open-camera]").forEach(btn=>btn.addEventListener("click",()=>openVerificationCamera(btn.dataset.openCamera)));
      $("takeVerificationPhoto")?.addEventListener("click",captureVerificationCameraPhoto);
      $("closeVerificationCamera")?.addEventListener("click",stopVerificationCamera);
      $("captureVerificationLocation")?.addEventListener("click",captureVerificationGps);
      $("customerVerificationForm")?.addEventListener("submit",submitCustomerVerification);
      $("verificationCustomer")?.addEventListener("change",event=>loadCustomerVerification(event.target.value));
      $("verificationSignatureGallery")?.addEventListener("change",event=>{const file=event.target.files?.[0];if(!file)return;if(!file.type.startsWith("image/"))return showMessage("हस्ताक्षर की image चुनें।","warn");if(file.size>5*1024*1024)return showMessage("हस्ताक्षर की फोटो 5 MB से छोटी होनी चाहिए।","warn");verificationSignatureFile=file;const preview=$("verificationSignaturePreview");preview.src=URL.createObjectURL(file);preview.classList.remove("hidden");$("verificationSignatureStatus").textContent="हस्ताक्षर की फोटो अपलोड के लिए तैयार है।";});
      $("verificationHistory")?.addEventListener("click",event=>{const button=event.target.closest("[data-verification-id]");if(button)openVerificationPdf(button.dataset.verificationId);});
      $("openVerificationPdf")?.addEventListener("click",()=>openVerificationPdf());
      $("newLoanForm")?.addEventListener("submit",submitNewLoan);
      $("closeLoanForm")?.addEventListener("submit",submitLoanClosure);
      $("newLoanCustomer")?.addEventListener("change",updateRepeatLoanOptions);
      $("closeLoanSelect")?.addEventListener("change",updateClosurePaymentOptions);
      $("closureDate") && ($("closureDate").value=localDateValue());

      $("paymentForm").addEventListener("submit",submitPayment);
      try {
        await loadAll();
      } catch (dataError) {
        console.error("AJSF dashboard data load failed:",dataError);
        showMessage("डेटा लोड नहीं हुआ: "+(dataError?.message || String(dataError))+" | स्क्रीनशॉट भेजें।","error");
      }
    } catch (err) {
      console.error("AJSF login failed:",err);
      currentUser = null; profile = null;
      try { await supabase.auth.signOut({scope:"local"}); } catch (signOutError) { console.warn("Local session cleanup failed",signOutError); }
      showMessage("लॉगिन नहीं हुआ: "+(err?.message || "नेटवर्क या Auth समस्या")+"। इंटरनेट जाँचकर फिर प्रयास करें।","error");
      $("loginCard").classList.remove("hidden");
      $("dashboardCard").classList.add("hidden");
    } finally {
      setBusy(btn,false);
      btn.disabled = false;
    }
  });
  $("logoutBtn").addEventListener("click", logout);
  $("runDayDemandBtn")?.addEventListener("click",loadDayDemandReport);
  $("demandReportDate")?.addEventListener("change",()=>{const d=new Date($("demandReportDate").value+"T00:00:00");$("demandReportDay").value=["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][d.getDay()];loadDayDemandReport();});
  $("demandReportDay")?.addEventListener("change",loadDayDemandReport);
  $("demandReportCollector")?.addEventListener("change",loadDayDemandReport);
  $("printDayDemandBtn")?.addEventListener("click",printDayDemandReport);
  const staffAdminSetupBtn = $("staffAdminSetupBtn");
  if (staffAdminSetupBtn) {
    staffAdminSetupBtn.addEventListener("click", async () => {
      if (!canAdmin()) return;
      const confirmed = window.confirm(
        "तीन Full Admin अकाउंट बनाए जाएँ?\\n\\nRavindra — 8449109044\\nAnuraj Rana — 9219148507\\nKapil — 8273916006\\n\\nतीनों के लिए एक ही अस्थायी पासवर्ड बनेगा।"
      );
      if (!confirmed) return;
      setBusy(staffAdminSetupBtn,true,"Admin अकाउंट बनाए जा रहे हैं…");
      try {
        const { data, error } = await supabase.functions.invoke("quick-handler");
        if (error) throw error;
        if (!data?.success || !data?.initial_password) throw new Error(data?.error || "Account creation result incomplete.");
        showMessage("तीनों Admin अकाउंट बन गए।\\nअस्थायी साझा पासवर्ड (इसे सुरक्षित रखें): " + data.initial_password + "\\nतीनों को यह पासवर्ड निजी रूप से दें; बाद में हर व्यक्ति इसे बदल सकता है।","success");
        staffAdminSetupBtn.disabled = true;
        staffAdminSetupBtn.textContent = "Admin अकाउंट बन गए";
      } catch (err) {
        showMessage("Admin अकाउंट नहीं बने: " + (err?.message || String(err)),"error");
      } finally {
        if (!staffAdminSetupBtn.disabled) setBusy(staffAdminSetupBtn,false);
      }
    });
  }
  $("staffPasswordForm")?.addEventListener("submit", async event => {
    event.preventDefault();
    if (!canAdmin()) return;
    const btn = $("staffPasswordSaveBtn");
    const targetId = $("staffPasswordTarget").value;
    const password = $("staffNewPassword").value;
    const confirmPassword = $("staffConfirmPassword").value;
    if (!targetId) return showMessage("पहले Staff / Collector अकाउंट चुनें।","warn");
    if (password.length < 10) return showMessage("पासवर्ड कम से कम 10 अक्षर का रखें।","warn");
    if (password !== confirmPassword) return showMessage("दोनों पासवर्ड एक जैसे नहीं हैं।","warn");
    if (!window.confirm("चुने गए Staff / Collector का पासवर्ड बदलना है?")) return;
    setBusy(btn,true,"पासवर्ड अपडेट हो रहा है…");
    try {
      const { data, error } = await supabase.functions.invoke("admin-reset-staff-password", {
        body: { target_user_id: targetId, new_password: password }
      });
      if (error) throw error;
      if (!data?.success) throw new Error(data?.error || "पासवर्ड अपडेट नहीं हुआ।");
      $("staffPasswordForm").reset();
      showMessage("पासवर्ड सफलतापूर्वक अपडेट हो गया: " + (data.staff_name || "Staff") + " (" + (data.staff_code || "—") + ")","success");
    } catch (err) {
      console.error("Staff password update failed:",err);
      showMessage("पासवर्ड अपडेट नहीं हुआ: " + (err?.message || String(err)),"error");
    } finally { setBusy(btn,false); }
  });
  $("settlementDate")?.addEventListener("change", loadDailySettlement);
  $("runSettlementReportBtn")?.addEventListener("click", loadSettlementReport);
  $("downloadSettlementReportBtn")?.addEventListener("click", downloadSettlementReportCsv);
  $("downloadSettlementReportPdfBtn")?.addEventListener("click", downloadSettlementReportPdf);
  $("printSettlementReportBtn")?.addEventListener("click", printSettlementReport);
  const reportToday = localDateValue();
  const reportFrom = $("settlementReportFrom"), reportTo = $("settlementReportTo");
  if (reportFrom && !reportFrom.value) { const d=new Date(reportToday+"T00:00:00"); d.setDate(d.getDate()-29); reportFrom.value=settlementDateKey(d); }
  if (reportTo && !reportTo.value) reportTo.value=reportToday;
  document.addEventListener("click", event => {
    if (event.target.closest("#settlementAdminOnly")) loadDailySettlement();
    const action = event.target.closest("[data-settlement-action]");
    if (action) handleDailySettlementAction(action);
  });
  // Delegated listener survives panel redraws and reliably handles day changes.
  document.addEventListener("change", event => {
    if (event.target && event.target.id === "collectorDemandDay") renderCollectorDemand();
  });
  $("collectorDemandRows")?.addEventListener("click", event => {
    const button = event.target.closest(".demand-collect-btn");
    if (!button) return;
    const customer = customers.find(c => c.id === button.dataset.customerId);
    const loan = loans.find(l => l.id === button.dataset.loanId && l.customer_id === customer?.id && l.status === "active");
    if (!customer || !loan) return showMessage("ग्राहक या Active Loan नहीं मिला। डेटा Refresh करें।", "warn");
    $("payCustomer").value = customer.id;
    refreshLoanOptions();
    $("payLoan").value = loan.id;
    $("paymentForm").elements.amount.value = button.dataset.demand;
    $("paymentDate").value = localDateValue();
    $("dashboardCard").classList.add("collector-payment-mode");
    activateTab("payment");
    $("paymentForm").scrollIntoView({behavior:"smooth", block:"start"});
  });
  $("backToDemandBtn")?.addEventListener("click", () => {
    $("dashboardCard").classList.remove("collector-payment-mode");
    activateTab("collector-demand");
  });
  $("payCustomer").addEventListener("change", refreshLoanOptions);
  $("payLoan").addEventListener("change", renderAdvanceBalanceInfo);
  $("reminderCustomer").addEventListener("change", updateReminderLoanOptions);
  $("reminderLoan").addEventListener("change", buildReminderMessage);
  $("sendWhatsAppReminder").addEventListener("click", () => openReminder("whatsapp"));
  $("sendSmsReminder").addEventListener("click", () => openReminder("sms"));
  $("loanCustomerFilter").addEventListener("change", renderData);
  $("misStatusFilter")?.addEventListener("change", renderCustomerMIS);
  $("misSearch")?.addEventListener("input", renderCustomerMIS);
  $("customerMisRows")?.addEventListener("click", event => { const removeBtn = event.target.closest(".customer-remove"); if (removeBtn) return removeCustomerRecord(removeBtn.dataset.customerId, removeBtn); const btn = event.target.closest(".mis-save"); if (btn) saveCustomerMISRow(btn.closest("tr")); });
  // Customer Register actions are bound directly after each table render above.
  $("ledgerCustomer").addEventListener("change", loadCustomerLedger);
  $("ledgerSearch").addEventListener("input", filterLedgerCustomers);
  $("downloadLedgerPdfBtn").addEventListener("click", () => handleDocumentPdf("downloadLedgerPdfBtn","ledgerPrintArea","AJSF-Customer-Ledger.pdf","Customer Ledger PDF Downloads में सेव हो गई है।",{fitOnePage:true,pageMarginMm:3}));
  $("printLedgerBtn").addEventListener("click", printCustomerLedger);
  $("scheduleSearch").addEventListener("input", filterScheduleCustomers);
  $("scheduleCustomer").addEventListener("change", populateScheduleLoans);
  $("scheduleLoan").addEventListener("change", renderRepaymentSchedule);
  $("downloadSchedulePdfBtn").addEventListener("click", () => {
    if (!$("scheduleLoan").value) return showMessage("पहले ग्राहक और लोन चुनें।","warn");
    handleDocumentPdf("downloadSchedulePdfBtn","repaymentSchedulePrint","AJSF-Repayment-Schedule.pdf","Repayment Schedule PDF Downloads में सेव हो गई है।",{fitOnePage:true});
  });
  $("printScheduleBtn").addEventListener("click", printRepaymentSchedule);
  $("customerFilter").addEventListener("input", filterCustomerRows);
  $("customerCenterFilter").addEventListener("change", filterCustomerRows);
  $("customerDayFilter").addEventListener("change", filterCustomerRows);
  $("statementSearch").addEventListener("input", filterStatementCustomers);
  $("statementCustomer").addEventListener("change", renderCustomerStatement);
  $("downloadStatementPdfBtn").addEventListener("click", () => {
    if (!$("statementCustomer").value) return showMessage("पहले ग्राहक चुनें।","warn");
    renderCustomerStatement();
    handleDocumentPdf("downloadStatementPdfBtn","statementPrintArea","AJSF-Customer-Loan-Statement.pdf","Loan Statement PDF Downloads में सेव हो गई है।",{fitOnePage:true,pageMarginMm:3});
  });
  $("printStatementBtn").addEventListener("click", printCustomerStatement);
  $("printReceiptBtn").addEventListener("click", printReceipt);
  $("downloadReceiptPdfBtn").addEventListener("click", downloadReceiptPdf);
  $("closeReceiptBtn").addEventListener("click", () => $("receiptPanel").classList.add("hidden"));
}
if ($("paymentDate")) $("paymentDate").value = localDateValue();
boot();
