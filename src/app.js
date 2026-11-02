import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./config.js";

const $ = (id) => document.getElementById(id);
const money = (n) => "₹" + Number(n || 0).toLocaleString("en-IN");
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
let supabase, currentUser, profile, customers = [], loans = [], payments = [], lastReceipt = null;

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
  const [c, l, p] = await Promise.all([
    customerQuery,
    supabase.from("loans").select("id, loan_reference, customer_id, loan_type, disbursement_date, loan_amount, emi_amount, total_emis_required, status, source_total_collected, source_osp, source_emis_paid, source_emis_pending").order("created_at", {ascending:false}),
    supabase.from("payments").select("*").order("created_at", {ascending:false}).limit(100)
  ]);
  if (c.error) throw new Error("Customer API (" + c.error.code + "): " + c.error.message);
  if (l.error) throw new Error("Loan API (" + l.error.code + "): " + l.error.message);
  customers = c.data || []; loans = l.data || [];
  payments = p.error ? [] : (p.data || []);
  renderData();
  showMessage(p.error ? "ग्राहक और लोन लोड हुए। Payment History के लिए payments table की read policy जाँचें।" : "डेटा सफलतापूर्वक लोड हुआ।", p.error ? "warn" : "success");
}

function renderData() {
  $("customersCount").textContent = customers.length;
  $("loansCount").textContent = loans.length;
  $("paymentsCount").textContent = payments.length;
  const today = new Date().toISOString().slice(0,10);
  const todayPayments = payments.filter(p => String(p.paid_at || p.created_at || "").slice(0,10) === today);
  $("todayTotal").textContent = money(todayPayments.reduce((s,p) => s + Number(p.amount || p.payment_amount || 0), 0));
  $("customerRows").innerHTML = customers.map(c => `<tr><td>${esc(c.customer_code)}</td><td>${esc(c.full_name)}</td><td>${esc(c.center_name)}</td><td>${esc(c.contact_number)}</td><td>${esc(c.collection_day)}</td><td>${esc(c.customer_status)}</td></tr>`).join("") || `<tr><td colspan="6" class="empty">कोई ग्राहक नहीं मिला।</td></tr>`;
  $("loanRows").innerHTML = loans.map(l => {
    const c = customers.find(x => x.id === l.customer_id);
    return `<tr><td>${esc(l.loan_reference)}</td><td>${esc(c?.full_name || l.customer_id)}</td><td>${esc(l.loan_type)}</td><td>${money(l.loan_amount)}</td><td>${money(l.emi_amount)}</td><td>${esc(l.total_emis_required)}</td><td>${esc(l.status)}</td></tr>`;
  }).join("") || `<tr><td colspan="7" class="empty">कोई लोन रिकॉर्ड नहीं मिला।</td></tr>`;
  $("payCustomer").innerHTML = `<option value="">ग्राहक चुनें</option>` + customers.map(c => `<option value="${esc(c.id)}">${esc(c.customer_code)} · ${esc(c.full_name)}</option>`).join("");
  refreshLoanOptions();
  $("paymentRows").innerHTML = payments.map(p => {
    const c = customers.find(x => x.id === p.customer_id);
    const l = loans.find(x => x.id === p.loan_id);
    return `<tr><td>${esc(p.id)}</td><td>${esc(formatDate(p.paid_at))}</td><td>${esc(c?.full_name || p.customer_id)}</td><td>${esc(l?.loan_reference || "—")}</td><td>${money(p.amount)}</td><td>${esc(p.payment_mode || "—")}</td></tr>`;
  }).join("") || `<tr><td colspan="6" class="empty">अभी भुगतान उपलब्ध नहीं हैं।</td></tr>`;
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
    <div class="receipt-brand"><div class="receipt-mark">AJSF</div><div><h2>ARK JAN SAMRIDDHI FOUNDATION</h2><p>SAPNE AAPKE SATH HAMARA</p></div></div>
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
  $("dashboardCard").classList.add("hidden"); $("loginCard").classList.remove("hidden");
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
  $("printReceiptBtn").addEventListener("click", printReceipt);
  $("closeReceiptBtn").addEventListener("click", () => $("receiptPanel").classList.add("hidden"));
}
if ($("paymentDate")) $("paymentDate").value = localDateValue();
boot();
