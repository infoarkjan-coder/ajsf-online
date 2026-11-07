import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as XLSX from "https://esm.sh/xlsx@0.18.5";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./config.js";

const $ = (id) => document.getElementById(id);
const db = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
let activeUser = null;
let activeRole = null;
let activeCustomers = [];

const fields = [
  "customer_code","full_name","center_name","contact_number","area","address",
  "collection_day","customer_status","recovery_status","status_changed_at",
  "status_reason","status_notes"
];
const headers = [
  "Customer ID","Customer Name","Center Name","Contact Number","Area","Address",
  "Collection Day","Status","Recovery Status","Status Date","Status Reason","Notes"
];
const dayValues = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday","MONTHLY"];
const statusValues = ["ACTIVE","ABSCONDED","DECEASED"];

function say(message, type="info") {
  const el = $("dataToolsMessage");
  if (!el) return;
  el.textContent = message;
  el.dataset.type = type;
}
function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
function dateStamp() { return new Date().toISOString().replace(/[:.]/g,"-").slice(0,19); }
function normalizeDay(value) {
  const raw = String(value || "").trim().toUpperCase();
  return dayValues.find(d => d.toUpperCase() === raw) || "";
}
function normalizeStatus(value) {
  const raw = String(value || "ACTIVE").trim().toUpperCase();
  return statusValues.includes(raw) ? raw : "";
}
function nextCustomerCode(list=activeCustomers) {
  const nums = list.map(c => String(c.customer_code || "").trim()).filter(v => /^\d{6,}$/.test(v)).map(Number);
  const next = (nums.length ? Math.max(...nums) : 260100000) + 1;
  return String(next);
}
async function refreshCustomers() {
  const { data, error } = await db.from("customers")
    .select("id,customer_code,full_name,center_name,contact_number,area,address,collection_day,assigned_collector,customer_status,recovery_status,status_reason,status_changed_at,status_notes,is_active,created_by,created_at,updated_at")
    .order("customer_code");
  if (error) throw error;
  activeCustomers = data || [];
}
function makeToolbar() {
  const panel = document.querySelector('[data-panel="customers"]');
  if (!panel || $("customerDataTools")) return;
  const toolbar = document.createElement("div");
  toolbar.id = "customerDataTools";
  toolbar.className = "data-tools";
  toolbar.innerHTML = `
    <div class="data-tools-head"><div><b>Customer Data Tools</b><small>Excel Import / Export · Full Backup / Restore</small></div>
      <div class="data-tools-actions">
        <button type="button" class="secondary" id="downloadCustomerTemplate">Excel Template</button>
        <button type="button" class="secondary" id="exportCustomersExcel">Export Customers</button>
        <button type="button" id="importCustomersExcel">Import Excel</button>
        <button type="button" class="secondary" id="downloadFullBackup">Full Backup</button>
        <button type="button" class="secondary" id="restoreFullBackup">Restore Backup</button>
        <input id="customerExcelFile" type="file" accept=".xlsx,.xls,.csv" hidden>
        <input id="backupJsonFile" type="file" accept=".json,application/json" hidden>
      </div>
    </div>
    <p id="dataToolsMessage" class="data-tools-message" role="status">Excel में .xlsx या .csv फ़ाइल इस्तेमाल करें। Full Backup JSON format में डाउनलोड होगा।</p>`;
  const form = $("customerForm");
  if (form) panel.insertBefore(toolbar, form);
  else panel.prepend(toolbar);

  $("downloadCustomerTemplate").addEventListener("click", downloadTemplate);
  $("exportCustomersExcel").addEventListener("click", exportCustomers);
  $("importCustomersExcel").addEventListener("click", () => $("customerExcelFile").click());
  $("customerExcelFile").addEventListener("change", importCustomers);
  $("downloadFullBackup").addEventListener("click", downloadBackup);
  $("restoreFullBackup").addEventListener("click", () => $("backupJsonFile").click());
  $("backupJsonFile").addEventListener("change", restoreBackup);
}
function setupCustomerForm() {
  const form = $("customerForm");
  if (!form || form.dataset.toolsReady === "1") return;
  form.dataset.toolsReady = "1";
  const code = form.elements.namedItem("customer_code");
  if (code) {
    code.readOnly = true;
    code.placeholder = "अपने आप बनेगा";
    code.title = "Customer ID सिस्टम अपने आप बनाएगा";
  }
  const assignment = form.elements.namedItem("assigned_collector");
  if (assignment) {
    const select = document.createElement("select");
    select.name = "assigned_collector";
    select.id = "customerCollectorSelect";
    select.innerHTML = '<option value="">Collector चुनें</option>';
    assignment.replaceWith(select);
    loadCollectors(select);
  }
  refreshCustomers().then(() => {
    if (code && !code.value) code.value = nextCustomerCode();
  }).catch(() => {});
  form.addEventListener("reset", () => setTimeout(async () => {
    try { await refreshCustomers(); if (code) code.value = nextCustomerCode(); } catch {}
  }, 0));
}
async function loadCollectors(select) {
  const { data, error } = await db.from("profiles")
    .select("id,full_name,staff_code,role").eq("is_active",true).order("full_name");
  if (error) { say("Collector सूची नहीं मिली: " + error.message, "error"); return; }
  select.innerHTML = '<option value="">स्वयं / Unassigned</option>' +
    (data || []).filter(p => p.role === "collector").map(p =>
      `<option value="${p.id}">${escapeHtml(p.full_name)} · ${escapeHtml(p.staff_code || "")}</option>`).join("");
  if (activeRole === "collector" && activeUser) select.value = activeUser.id;
}
function escapeHtml(v) {
  return String(v ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function sheetFromRows(rows) {
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Customers");
  return wb;
}
function downloadTemplate() {
  const example = [{
    "Customer ID":"","Customer Name":"Example Customer","Center Name":"CENTER A",
    "Contact Number":"9876543210","Area":"Area name","Address":"Full address",
    "Collection Day":"Monday","Status":"ACTIVE","Recovery Status":"NOT_REQUIRED",
    "Status Date":"","Status Reason":"","Notes":""
  }];
  XLSX.writeFile(sheetFromRows(example), "AJSF_Customer_Import_Template.xlsx");
}
async function exportCustomers() {
  try {
    await refreshCustomers();
    const rows = activeCustomers.map(c => ({
      "Customer ID":c.customer_code || "", "Customer Name":c.full_name || "",
      "Center Name":c.center_name || "", "Contact Number":c.contact_number || "",
      "Area":c.area || "", "Address":c.address || "", "Collection Day":c.collection_day || "",
      "Status":c.customer_status || "ACTIVE", "Recovery Status":c.recovery_status || "",
      "Status Date":c.status_changed_at || "", "Status Reason":c.status_reason || "",
      "Notes":c.status_notes || "", "Assigned Collector":c.assigned_collector || "",
      "Active":c.is_active
    }));
    XLSX.writeFile(sheetFromRows(rows), "AJSF_Customers_" + dateStamp() + ".xlsx");
    say("Customer Excel डाउनलोड हो गया। कुल रिकॉर्ड: " + rows.length, "success");
  } catch (e) { say("Export असफल: " + e.message, "error"); }
}
function cell(row, ...keys) {
  for (const key of keys) if (row[key] !== undefined && row[key] !== null) return String(row[key]).trim();
  return "";
}
async function importCustomers(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  if (activeRole !== "admin") return say("Excel Import केवल Admin कर सकता है।", "error");
  try {
    const bytes = await file.arrayBuffer();
    const wb = XLSX.read(bytes, {type:"array", cellDates:false});
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const raw = XLSX.utils.sheet_to_json(sheet, {defval:"", raw:false});
    if (!raw.length) return say("Excel में कोई डेटा नहीं मिला।", "error");
    await refreshCustomers();
    const known = new Set(activeCustomers.map(c => String(c.customer_code || "").trim()).filter(Boolean));
    let generated = Number(nextCustomerCode());
    const payload = [], problems = [];
    raw.forEach((r, index) => {
      const name = cell(r,"Customer Name","full_name","Full Name","ग्राहक का नाम");
      if (!name) { problems.push("Row " + (index+2) + ": Customer Name खाली"); return; }
      let code = cell(r,"Customer ID","customer_code","Customer Code","CUSTOMER ID");
      if (!code) { while (known.has(String(generated))) generated++; code = String(generated++); }
      if (known.has(code)) { problems.push("Row " + (index+2) + ": Duplicate Customer ID " + code); return; }
      const dayRaw = cell(r,"Collection Day","collection_day");
      const day = normalizeDay(dayRaw);
      if (dayRaw && !day) { problems.push("Row " + (index+2) + ": Collection Day गलत"); return; }
      const statusRaw = cell(r,"Status","customer_status") || "ACTIVE";
      const status = normalizeStatus(statusRaw);
      if (!status) { problems.push("Row " + (index+2) + ": Status गलत"); return; }
      const reason = cell(r,"Status Reason","status_reason") || null;
      const date = cell(r,"Status Date","status_changed_at") || null;
      if (status !== "ACTIVE" && (!reason || !date)) {
        problems.push("Row " + (index+2) + ": " + status + " के लिए Status Date और Status Reason जरूरी");
        return;
      }
      known.add(code);
      payload.push({
        customer_code:code, full_name:name,
        center_name:cell(r,"Center Name","center_name") || null,
        contact_number:cell(r,"Contact Number","contact_number","Mobile") || null,
        area:cell(r,"Area","area") || null, address:cell(r,"Address","address") || null,
        collection_day:day || null, customer_status:status,
        recovery_status:cell(r,"Recovery Status","recovery_status") || (status==="ACTIVE"?"NOT_REQUIRED":"PENDING"),
        status_changed_at:status==="ACTIVE"?null:date,
        status_reason:status==="ACTIVE"?null:reason,
        status_notes:cell(r,"Notes","status_notes") || null,
        is_active:status==="ACTIVE", assigned_collector:activeUser.id, created_by:activeUser.id
      });
    });
    if (!payload.length) return say("कोई नया रिकॉर्ड Import योग्य नहीं। " + problems.slice(0,4).join(" | "), "warn");
    const preview = "Excel में " + raw.length + " rows हैं।\n" + payload.length + " नए ग्राहक Import होंगे।\n" +
      problems.length + " rows Skip होंगी।\n\n" + problems.slice(0,8).join("\n") +
      "\n\nक्या Import जारी रखें?";
    if (!confirm(preview)) return say("Import रद्द किया गया।");
    let inserted = 0;
    for (let i=0;i<payload.length;i+=50) {
      const {error} = await db.from("customers").insert(payload.slice(i,i+50));
      if (error) throw new Error("Batch " + (Math.floor(i/50)+1) + ": " + error.message + ". पहले से सेव batches हटाए नहीं गए।");
      inserted += payload.slice(i,i+50).length;
    }
    await refreshCustomers();
    say(inserted + " ग्राहक Import हो गए। " + problems.length + " rows Skip हुईं।", "success");
    document.dispatchEvent(new CustomEvent("ajsf:data-imported"));
  } catch (e) { say("Import असफल: " + e.message, "error"); }
}
async function downloadBackup() {
  if (activeRole !== "admin") return say("Full Backup केवल Admin डाउनलोड कर सकता है।", "error");
  try {
    say("पूरा Backup तैयार हो रहा है…");
    const tables = ["customers","loans","payments","loan_weekly_status"];
    const backup = {app:"AJSF Online",format_version:1,created_at:new Date().toISOString(),project_ref:"hruklvyvrdnivulqhfsq",tables:{}};
    for (const table of tables) {
      const rows = [];
      for (let start=0;;start+=1000) {
        const {data,error} = await db.from(table).select("*").range(start,start+999);
        if (error) throw new Error(table + ": " + error.message);
        rows.push(...(data || []));
        if (!data || data.length<1000) break;
      }
      backup.tables[table] = rows;
    }
    const blob = new Blob([JSON.stringify(backup,null,2)],{type:"application/json"});
    downloadBlob(blob,"AJSF_Full_Backup_"+dateStamp()+".json");
    say("Full Backup डाउनलोड हो गया: Customers "+backup.tables.customers.length+", Loans "+backup.tables.loans.length+", Payments "+backup.tables.payments.length+". इसे सुरक्षित जगह रखें।","success");
  } catch(e) { say("Backup असफल: "+e.message,"error"); }
}
async function restoreBackup(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  if (activeRole !== "admin") return say("Restore केवल Admin कर सकता है।","error");
  try {
    const backup = JSON.parse(await file.text());
    if (backup.app !== "AJSF Online" || backup.format_version !== 1 || !backup.tables) throw new Error("यह AJSF का मान्य Backup नहीं है।");
    const order = ["customers","loans","payments","loan_weekly_status"];
    for (const table of order) if (!Array.isArray(backup.tables[table])) throw new Error("Backup में "+table+" डेटा नहीं है।");
    const total = order.reduce((n,t)=>n+backup.tables[t].length,0);
    if (!confirm("Restore से पहले वर्तमान डेटा का नया Backup डाउनलोड होगा।\n\nचुनी गई फ़ाइल से "+total+" records ID के आधार पर जोड़ेंगे/अपडेट करेंगे।\nमौजूदा अतिरिक्त रिकॉर्ड delete नहीं होंगे।\n\nक्या आगे बढ़ें?")) return;
    await downloadBackup();
    for (const table of order) {
      const rows = backup.tables[table];
      for (let i=0;i<rows.length;i+=100) {
        const {error} = await db.from(table).upsert(rows.slice(i,i+100),{onConflict:"id"});
        if (error) throw new Error(table+" restore error: "+error.message);
      }
    }
    await refreshCustomers();
    say("Restore पूरा हुआ। रिकॉर्ड delete नहीं किए गए; समान ID वाले रिकॉर्ड अपडेट हुए। कृपया Loans और Payments जाँचें।","success");
    document.dispatchEvent(new CustomEvent("ajsf:data-imported"));
  } catch(e) { say("Restore पूरा नहीं हुआ: "+e.message,"error"); }
}
async function activate(user) {
  activeUser = user;
  const {data,error} = await db.from("profiles").select("role,is_active").eq("id",user.id).single();
  if (error || !data?.is_active) return;
  activeRole = data.role;
  makeToolbar();
  setupCustomerForm();
  const admin = activeRole === "admin";
  ["importCustomersExcel","downloadFullBackup","restoreFullBackup"].forEach(id => { const el=$(id); if(el) el.classList.toggle("hidden",!admin); });
  if (!admin) {
    const exp=$("exportCustomersExcel"); if(exp) exp.classList.remove("hidden");
    const tmpl=$("downloadCustomerTemplate"); if(tmpl) tmpl.classList.add("hidden");
  }
}
db.auth.onAuthStateChange((event,session) => {
  if (event === "SIGNED_IN" && session?.user) setTimeout(()=>activate(session.user),0);
  if (event === "SIGNED_OUT") { activeUser=null; activeRole=null; }
});
document.addEventListener("ajsf:data-imported", () => {
  say("डेटा अपडेट हो गया। Dashboard को Refresh करें ताकि सभी सूची नए रिकॉर्ड दिखाएँ।","success");
});
