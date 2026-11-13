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
const dayValues = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","MONTHLY"];
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
  a.href = url;
  a.download = name;
  a.setAttribute("download", name);
  a.style.position = "fixed";
  a.style.left = "-10000px";
  a.style.top = "0";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 120000);
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
    <div class="data-tools-head"><div><b>AJSF Weekly EMI Tracker</b><small>एक ही Excel फ़ाइल में Customer + Loan + W1–W24 · Full Backup / Restore</small></div>
      <div class="data-tools-actions">
        <button type="button" class="secondary" id="exportCustomersExcel">Full Excel Export</button>
        <button type="button" id="importCustomersExcel">Import Excel</button>
        <button type="button" class="secondary" id="downloadFullBackup">Full Backup</button>
        <button type="button" class="secondary" id="restoreFullBackup">Restore Backup</button>
        <input id="customerExcelFile" type="file" accept=".xlsx" hidden>
        <input id="backupJsonFile" type="file" accept=".json,application/json" hidden>
      </div>
    </div>
    <p id="dataToolsMessage" class="data-tools-message" role="status">Full Excel Export की .xlsx फ़ाइल को उसी format में Import करें। Full Backup JSON अलग रहेगा।</p>`;
  const form = $("customerForm");
  if (form) panel.insertBefore(toolbar, form);
  else panel.prepend(toolbar);

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
  else if (activeRole === "admin" && data?.length) select.value = data.filter(p=>p.role==="collector")[0]?.id || "";
}
function escapeHtml(v) {
  return String(v ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function trackerHeaders() {
  return [
    "Customer Name","CENTER NAME","CONTACT NUMBER","CUSTOMER ID","AREA","ADDRESES",
    "Collection Day","FRESH/REPEAT","DATE OF DISBURSEMENT","Loan Amount","EMI Amount",
    "Total EMIs Required",
    ...Array.from({length:24},(_,i)=>["WEEK"+(i+1),"ADVANCE"+(i+1),"ADVANCE ADJUSTED"+(i+1)]).flat(),
    "Total Advance Received","Total Advance Adjusted","Available Advance Balance",
    "Total EMIs Paid","Total EMIs Pending","Total Amount Collected","Outstanding Balance (OSP)",
    "_AJSF Customer UUID","_AJSF Loan UUID","_AJSF Loan Ref","_AJSF Loan Status",
    "_AJSF Assigned Collector","_AJSF Customer Created By","_AJSF Loan Created By",
    "_AJSF Customer Status","_AJSF Recovery Status","_AJSF Status Reason","_AJSF Status Date","_AJSF Status Notes","_AJSF Is Active","_AJSF Advance Ledger JSON"
  ];
}
function sheetFromRows(rows) {
  const ws = XLSX.utils.json_to_sheet(rows, {header:trackerHeaders()});
  ws["!cols"] = trackerHeaders().map((h,i)=>({
    wch: i < 12 ? [24,20,16,16,16,28,16,14,18,14,14,16][i] : (i < 84 ? 12 : (i < 91 ? 19 : 4)),
    hidden: i >= 91
  }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "AJSF Weekly EMI Tracker");
  return wb;
}
async function fetchAllRows(table, select="*") {
  const rows = [];
  for (let start=0;;start+=1000) {
    const {data,error} = await db.from(table).select(select).range(start,start+999);
    if (error) throw new Error(table + ": " + error.message);
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return rows;
}
function exportDate(value) {
  if (!value) return "";
  return String(value).slice(0,10);
}
function exportTrackerRow(customer, loan, weeklyByLoan, paidByLoan, advanceByLoan, loanFigures) {
  const weekly = weeklyByLoan.get(loan?.id) || new Map();
  const weeklyAmounts = Array.from({length:24},(_,i)=> {
    const entry = weekly.get(i+1);
    if (entry && entry.amount !== null && Number.isFinite(entry.amount)) return entry.amount;
    return entry?.isPaid ? Number(loan?.emi_amount || 0) : 0;
  });
  const advance = advanceByLoan.get(loan?.id) || {received:new Map(),adjusted:new Map(),cashApplied:new Map(),entries:[]};
  const allocatedAmounts = weeklyAmounts.map((v,i)=>v+Number(advance.cashApplied.get(i+1)||0)+Number(advance.adjusted.get(i+1)||0));
  const paidCount = allocatedAmounts.reduce((n,v)=>n+(v>0?1:0),0);
  const figures = loan ? loanFigures(loan, paidByLoan) : {collected:0,outstanding:0};
  return {
    "Customer Name":customer.full_name || "",
    "CENTER NAME":customer.center_name || "",
    "CONTACT NUMBER":customer.contact_number || "",
    "CUSTOMER ID":customer.customer_code || "",
    "AREA":customer.area || "",
    "ADDRESES":customer.address || "",
    "Collection Day":customer.collection_day || "",
    "FRESH/REPEAT":loan?.loan_type || "",
    "DATE OF DISBURSEMENT":exportDate(loan?.disbursement_date),
    "Loan Amount":loan?.loan_amount ?? "",
    "EMI Amount":loan?.emi_amount ?? "",
    "Total EMIs Required":loan?.total_emis_required ?? "",
    ...Object.fromEntries(allocatedAmounts.flatMap((v,i)=>[["WEEK"+(i+1),v],["ADVANCE"+(i+1),Number(advance.received.get(i+1)||0)],["ADVANCE ADJUSTED"+(i+1),Number(advance.adjusted.get(i+1)||0)]])),
    "Total Advance Received":[...advance.received.values()].reduce((n,v)=>n+Number(v||0),0),
    "Total Advance Adjusted":[...advance.adjusted.values()].reduce((n,v)=>n+Number(v||0),0),
    "Available Advance Balance":Math.max(0,[...advance.received.values()].reduce((n,v)=>n+Number(v||0),0)-[...advance.adjusted.values()].reduce((n,v)=>n+Number(v||0),0)),
    "Total EMIs Paid":loan ? paidCount : "",
    "Total EMIs Pending":loan ? Math.max(0,Number(loan.total_emis_required || 0)-paidCount) : "",
    "Total Amount Collected":loan ? figures.collected : "",
    "Outstanding Balance (OSP)":loan ? figures.outstanding : "",
    "_AJSF Customer UUID":customer.id || "",
    "_AJSF Loan UUID":loan?.id || "",
    "_AJSF Loan Ref":loan?.loan_reference || "",
    "_AJSF Loan Status":loan?.status || "",
    "_AJSF Assigned Collector":customer.assigned_collector || "",
    "_AJSF Customer Created By":customer.created_by || "",
    "_AJSF Loan Created By":loan?.created_by || "",
    "_AJSF Customer Status":customer.customer_status || "ACTIVE",
    "_AJSF Recovery Status":customer.recovery_status || "NOT_REQUIRED",
    "_AJSF Status Reason":customer.status_reason || "",
    "_AJSF Status Date":exportDate(customer.status_changed_at),
    "_AJSF Status Notes":customer.status_notes || "",
    "_AJSF Is Active":customer.is_active !== false,
    "_AJSF Advance Ledger JSON":JSON.stringify(advance.entries)
  };
}
async function exportCustomers() {
  try {
    say("पूरा Excel तैयार हो रहा है…");
    const [allCustomers, fetchedLoans, fetchedWeekly, fetchedPayments, fetchedAdvance] = await Promise.all([
      fetchAllRows("customers"),
      fetchAllRows("loans"),
      fetchAllRows("loan_weekly_status"),
      fetchAllRows("payments","id,loan_id,amount,is_reversal"),
      fetchAllRows("advance_ledger")
    ]);
    const customerIds = new Set(allCustomers.map(c=>c.id));
    const allLoans = fetchedLoans.filter(l=>customerIds.has(l.customer_id));
    const loanIds = new Set(allLoans.map(l=>l.id));
    const allWeekly = fetchedWeekly.filter(w=>loanIds.has(w.loan_id));
    const allPayments = fetchedPayments.filter(p=>loanIds.has(p.loan_id));
    const allAdvance = fetchedAdvance.filter(p=>loanIds.has(p.loan_id));
    const advanceByLoan = new Map();
    allAdvance.forEach(entry=>{
      if(!advanceByLoan.has(entry.loan_id)) advanceByLoan.set(entry.loan_id,{received:new Map(),adjusted:new Map(),cashApplied:new Map(),entries:[]});
      const target=advanceByLoan.get(entry.loan_id); target.entries.push(entry);
      const key=entry.entry_type==="advance_received"?"received":entry.entry_type==="advance_adjusted"?"adjusted":entry.entry_type==="cash_applied"?"cashApplied":null;
      const week=entry.entry_type==="advance_received"?Number(entry.source_week_no):Number(entry.applied_week_no);
      if(key && week){const map=target[key];map.set(week,(map.get(week)||0)+Number(entry.amount||0));}
    });
    const weeklyByLoan = new Map();
    allWeekly.forEach(w => {
      if (!weeklyByLoan.has(w.loan_id)) weeklyByLoan.set(w.loan_id,new Map());
      {
        const rawAmount = w.source_marker === null || w.source_marker === undefined || String(w.source_marker).trim() === "" ? null : Number(String(w.source_marker).replace(/[,₹\s]/g,""));
        weeklyByLoan.get(w.loan_id).set(Number(w.week_no),{
          amount: rawAmount !== null && Number.isFinite(rawAmount) && rawAmount >= 0 ? rawAmount : null,
          isPaid: w.is_paid === true
        });
      }
    });
    const paidByLoan = new Map();
    allPayments.filter(p=>!p.is_reversal && p.loan_id).forEach(p=>{
      paidByLoan.set(p.loan_id,(paidByLoan.get(p.loan_id)||0)+Number(p.amount||0));
    });
    const loanByCustomer = new Map();
    allLoans.forEach(l=>{
      if (!loanByCustomer.has(l.customer_id)) loanByCustomer.set(l.customer_id,[]);
      loanByCustomer.get(l.customer_id).push(l);
    });
    const rows = [];
    allCustomers.forEach(c=>{
      const customerLoans = loanByCustomer.get(c.id) || [];
      if (!customerLoans.length) rows.push(exportTrackerRow(c,null,weeklyByLoan,paidByLoan,advanceByLoan,(l,p)=>({collected:0,outstanding:0})));
      else customerLoans.forEach(l=>rows.push(exportTrackerRow(c,l,weeklyByLoan,paidByLoan,advanceByLoan,(loan,payments)=>{
        const collected = Number(loan.source_total_collected||0) + Number(payments.get(loan.id)||0);
        const baseline = loan.source_osp == null ? Math.max(0,Number(loan.loan_amount||0)-Number(loan.source_total_collected||0)) : Number(loan.source_osp);
        return {collected,outstanding:Math.max(0,baseline-Number(payments.get(loan.id)||0))};
      })));
    });
    rows.sort((a,b)=>String(a["CENTER NAME"]).localeCompare(String(b["CENTER NAME"])) ||
      String(a["Customer Name"]).localeCompare(String(b["Customer Name"])) ||
      String(a["_AJSF Loan Ref"]).localeCompare(String(b["_AJSF Loan Ref"])));
    XLSX.writeFile(sheetFromRows(rows),"AJSF_Weekly_EMI_Tracker_"+dateStamp()+".xlsx");
    say("Full Excel डाउनलोड हो गया। Customers: "+allCustomers.length+" · Loans: "+allLoans.length+" · Weekly Status: "+allWeekly.length+" · Rows: "+rows.length,"success");
  } catch(e) { say("Full Excel Export असफल: "+e.message,"error"); }
}
function cell(row, ...keys) {
  for (const key of keys) if (row[key] !== undefined && row[key] !== null) return String(row[key]).trim();
  return "";
}
function normalizeExcelHeader(value) {
  return String(value ?? "").replace(/^\uFEFF/, "").replace(/\u00A0/g, " ").trim().toLowerCase().replace(/[\s_]+/g," ");
}
function headerMap(row) {
  const map = {};
  Object.keys(row || {}).forEach(k=>{ map[normalizeExcelHeader(k)] = row[k]; });
  return map;
}
function rowValue(row, ...names) {
  for (const name of names) {
    const key = normalizeExcelHeader(name);
    if (row[key] !== undefined && row[key] !== null) return String(row[key]).trim();
  }
  return "";
}
function parseExcelDate(value) {
  if (!value) return null;
  const s=String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m=s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
  if (m) return m[3]+"-"+m[2].padStart(2,"0")+"-"+m[1].padStart(2,"0");
  const d=new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0,10);
}
function numericCell(value, label, rowNo, required=false) {
  const s=String(value ?? "").trim();
  if (!s) {
    if (required) throw new Error("Row "+rowNo+": "+label+" खाली है।");
    return null;
  }
  const n=Number(s.replace(/[,₹\s]/g,""));
  if (!Number.isFinite(n) || n<0) throw new Error("Row "+rowNo+": "+label+" सही संख्या नहीं है।");
  return n;
}
function excelRowsToRecords(raw, existingCustomers, existingLoans, existingWeekly, existingPayments, existingAdvance) {
  const customerByCode = new Map(existingCustomers.map(c=>[String(c.customer_code||"").trim(),c]));
  const customerById = new Map(existingCustomers.map(c=>[c.id,c]));
  const loanById = new Map(existingLoans.map(l=>[l.id,l]));
  const loanByRef = new Map(existingLoans.filter(l=>l.loan_reference).map(l=>[String(l.loan_reference),l]));
  const paymentTotals = new Map();
  existingPayments.filter(p=>!p.is_reversal && p.loan_id).forEach(p=>paymentTotals.set(p.loan_id,(paymentTotals.get(p.loan_id)||0)+Number(p.amount||0)));
  const weeklyExisting = new Map();
  existingWeekly.forEach(w=>weeklyExisting.set(w.loan_id+":"+w.week_no,w));
  const customers = new Map(), loans = [], weekly = [], advanceLedger = [], problems=[];
  const knownAdvanceKeys = new Set((existingAdvance||[]).map(x=>x.idempotency_key));
  let newCustomerCount=0, updateCustomerCount=0, newLoanCount=0, updateLoanCount=0;
  raw.forEach((source,index)=>{
    const rowNo=index+2, row=headerMap(source);
    const name=rowValue(row,"Customer Name","Customer Name","full_name");
    const code=rowValue(row,"CUSTOMER ID","Customer ID","customer_code");
    if (!name || !code) { problems.push("Row "+rowNo+": Customer Name और Customer ID जरूरी"); return; }
    const hiddenCustomerId=rowValue(row,"_AJSF Customer UUID");
    const oldCustomer=customerByCode.get(code) || customerById.get(hiddenCustomerId);
    const customerId=oldCustomer?.id || hiddenCustomerId || crypto.randomUUID();
    const dayRaw=rowValue(row,"Collection Day");
    const day=normalizeDay(dayRaw);
    if (dayRaw && !day) { problems.push("Row "+rowNo+": Collection Day गलत"); return; }
    const statusRaw=rowValue(row,"Status","customer_status","_AJSF Customer Status") || oldCustomer?.customer_status || "ACTIVE";
    const status=normalizeStatus(statusRaw);
    if (!status) { problems.push("Row "+rowNo+": Status गलत"); return; }
    const existingCustomer=oldCustomer || {};
    const customer={
      id:customerId, customer_code:code, full_name:name,
      center_name:rowValue(row,"CENTER NAME","Center Name") || null,
      contact_number:rowValue(row,"CONTACT NUMBER","Contact Number","Mobile") || null,
      area:rowValue(row,"AREA","Area") || null,
      address:rowValue(row,"ADDRESES","ADDRESS","Address") || null,
      collection_day:day || null,
      customer_status:status,
      recovery_status:rowValue(row,"_AJSF Recovery Status") || existingCustomer.recovery_status || (status==="ACTIVE"?"NOT_REQUIRED":"PENDING"),
      status_reason:rowValue(row,"_AJSF Status Reason") || existingCustomer.status_reason || null,
      status_changed_at:parseExcelDate(rowValue(row,"_AJSF Status Date")) || existingCustomer.status_changed_at || null,
      status_notes:rowValue(row,"_AJSF Status Notes") || existingCustomer.status_notes || null,
      is_active:rowValue(row,"_AJSF Is Active") ? ["true","1","yes"].includes(rowValue(row,"_AJSF Is Active").toLowerCase()) : status==="ACTIVE",
      assigned_collector:existingCustomer.assigned_collector || rowValue(row,"_AJSF Assigned Collector") || null,
      created_by:existingCustomer.created_by || rowValue(row,"_AJSF Customer Created By") || activeUser.id
    };
    customers.set(customerId,customer);
    if (oldCustomer) updateCustomerCount++; else newCustomerCount++;

    const loanAmount=numericCell(rowValue(row,"Loan Amount"),"Loan Amount",rowNo,false);
    const emiAmount=numericCell(rowValue(row,"EMI Amount"),"EMI Amount",rowNo,false);
    const terms=numericCell(rowValue(row,"Total EMIs Required"),"Total EMIs Required",rowNo,false);
    const disbursement=parseExcelDate(rowValue(row,"DATE OF DISBURSEMENT","DATE OF DISBERSMENT","Date of Disbursement"));
    const loanTypeRaw=rowValue(row,"FRESH/REPEAT","FRESH/REPEET","FRESH REPEET","Loan Type").toUpperCase();
    const loanType=({REPEET:"REPEAT",REPEATE:"REPEAT",REPEATED:"REPEAT"})[loanTypeRaw] || loanTypeRaw || "";
    const hasLoan=loanAmount!==null || emiAmount!==null || terms!==null || !!loanType || !!disbursement;
    if (!hasLoan) return;
    if (loanAmount===null || emiAmount===null || terms===null || !loanType || !["FRESH","REPEAT"].includes(loanType)) {
      problems.push("Row "+rowNo+": Loan Amount, EMI Amount, Total EMIs Required और FRESH/REPEAT पूरा भरें"); return;
    }
    if (!Number.isInteger(terms) || terms<1 || terms>24) { problems.push("Row "+rowNo+": Total EMIs Required 1 से 24 होना चाहिए"); return; }
    const hiddenLoanId=rowValue(row,"_AJSF Loan UUID");
    const hiddenLoanRef=rowValue(row,"_AJSF Loan Ref");
    let oldLoan=loanById.get(hiddenLoanId) || (hiddenLoanRef ? loanByRef.get(hiddenLoanRef) : null);
    if (!oldLoan && disbursement) oldLoan=existingLoans.find(l=>l.customer_id===customerId && l.disbursement_date===disbursement && l.loan_type===loanType);
    const loanId=oldLoan?.id || hiddenLoanId || crypto.randomUUID();
    const ledgerJson=rowValue(row,"_AJSF Advance Ledger JSON");
    let rowAdvanceEntries=[];
    if(ledgerJson){
      try{
        const imported=JSON.parse(ledgerJson);
        if(!Array.isArray(imported)) throw new Error("Advance Ledger JSON array नहीं है");
        rowAdvanceEntries=imported;
        imported.forEach(entry=>{
          if(entry.loan_id!==loanId || !["advance_received","advance_adjusted","cash_applied"].includes(entry.entry_type) || !(Number(entry.amount)>0) || !entry.idempotency_key) throw new Error("Advance Ledger record गलत है");
          if(!knownAdvanceKeys.has(entry.idempotency_key)){advanceLedger.push(entry);knownAdvanceKeys.add(entry.idempotency_key);}
        });
      }catch(e){problems.push("Row "+rowNo+": Advance Ledger डेटा गलत है ("+e.message+")");return;}
    }
    let loanRef=oldLoan?.loan_reference || hiddenLoanRef;
    if (!loanRef) loanRef="AJSF-XL-"+new Date().getFullYear()+"-"+crypto.randomUUID().slice(0,8).toUpperCase();
    const weeklyAmounts=[];
    const weeklyTotalAmounts=[];
    for (let w=1;w<=24;w++) {
      const rawAmount=rowValue(row,"WEEK"+w,"W"+w);
      const amount=numericCell(rawAmount,"WEEK"+w,rowNo,false);
      const totalWeekAmount=amount===null?0:amount;
      const ledgerApplied=rowAdvanceEntries.filter(entry=>Number(entry.applied_week_no)===w && ["cash_applied","advance_adjusted"].includes(entry.entry_type)).reduce((sum,entry)=>sum+Number(entry.amount||0),0);
      weeklyTotalAmounts.push(totalWeekAmount);
      weeklyAmounts.push(Math.max(0,totalWeekAmount-ledgerApplied));
    }
    const paidCount=weeklyTotalAmounts.filter(amount=>amount>0).length;
    const totalCollected=numericCell(rowValue(row,"Total Amount Collected"),"Total Amount Collected",rowNo,false);
    const osp=numericCell(rowValue(row,"Outstanding Balance (OSP)","Outstanding Balance"),"Outstanding Balance (OSP)",rowNo,false);
    const currentPaymentTotal=paymentTotals.get(loanId)||0;
    const sourceCollected=totalCollected===null ? Number(oldLoan?.source_total_collected||0) : Math.max(0,totalCollected-currentPaymentTotal);
    const sourceOsp=osp===null ? oldLoan?.source_osp ?? null : osp+currentPaymentTotal;
    const hiddenStatus=rowValue(row,"_AJSF Loan Status");
    const loanStatus=hiddenStatus || (osp===0 ? "closed" : (oldLoan?.status || "active"));
    const loan={
      id:loanId, loan_reference:loanRef, customer_id:customerId, loan_type:loanType,
      disbursement_date:disbursement, loan_amount:loanAmount, emi_amount:emiAmount,
      total_emis_required:terms, status:["active","closed","cancelled"].includes(loanStatus)?loanStatus:"active",
      source_total_collected:sourceCollected, source_osp:sourceOsp,
      source_emis_paid:paidCount, source_emis_pending:Math.max(0,terms-paidCount),
      created_by:oldLoan?.created_by || rowValue(row,"_AJSF Loan Created By") || activeUser.id
    };
    loans.push(loan);
    if (oldLoan) updateLoanCount++; else newLoanCount++;
    weeklyAmounts.forEach((amount,i)=>{
      const key=loanId+":"+(i+1), old=weeklyExisting.get(key);
      weekly.push({
        id:old?.id || crypto.randomUUID(),loan_id:loanId,week_no:i+1,
        is_paid:amount>0,source_marker:String(amount)
      });
    });
  });
  return {customers:[...customers.values()],loans,weekly,advanceLedger,problems,newCustomerCount,updateCustomerCount,newLoanCount,updateLoanCount};
}
async function importCustomers(event) {
  const file=event.target.files?.[0];
  event.target.value="";
  if (!file) return;
  if (activeRole!=="admin") return say("Excel Import केवल Admin कर सकता है।","error");
  try {
    say("Excel जाँची जा रही है…");
    const bytes=await file.arrayBuffer();
    const wb=XLSX.read(bytes,{type:"array",cellDates:false});
    const preferredSheetName=wb.SheetNames.find(n=>normalizeExcelHeader(n).includes("weekly emi collection tracker")) || wb.SheetNames[0];
    const sheet=wb.Sheets[preferredSheetName];
    const matrix=XLSX.utils.sheet_to_json(sheet,{header:1,defval:"",raw:false});
    const headerIndex=matrix.findIndex(cells=>{
      const hs=(cells||[]).map(normalizeExcelHeader);
      return hs.some(h=>["customer name","name of customer","name"].includes(h)) &&
        hs.some(h=>["customer id","customer code","customerid","customer code/id"].includes(h));
    });
    if (headerIndex<0) throw new Error("इस Excel में Customer Name और Customer ID वाले column नहीं मिले। सही शीट: WEEKLY EMI COLLECTION TRACKER चुनें।");
    const sourceHeaders=(matrix[headerIndex]||[]).map(v=>String(v??"").trim());
    const raw=matrix.slice(headerIndex+1).filter(cells=>(cells||[]).some(v=>String(v??"").trim()!=="")).map(cells=>{
      const record={};
      sourceHeaders.forEach((h,i)=>{if(h) record[h]=cells?.[i]??"";});
      return record;
    });
    if (!raw.length) return say("Excel में कोई डेटा नहीं मिला।","error");
    const [allCustomers,allLoans,allWeekly,allPayments,allAdvance]=await Promise.all([
      fetchAllRows("customers"),
      fetchAllRows("loans"),
      fetchAllRows("loan_weekly_status"),
      fetchAllRows("payments","id,loan_id,amount,is_reversal"),
      fetchAllRows("advance_ledger")
    ]);
    const parsed=excelRowsToRecords(raw,allCustomers,allLoans,allWeekly,allPayments,allAdvance);
    if (parsed.problems.length) throw new Error("Import रोक दिया गया। "+parsed.problems.slice(0,8).join(" | ")+(parsed.problems.length>8?" | और "+(parsed.problems.length-8)+" त्रुटियाँ":""));
    if (!parsed.customers.length) throw new Error("कोई Import योग्य Customer नहीं मिला।");
    const uniqueCustomerCount=parsed.customers.length;
    const preview="Excel में "+raw.length+" rows हैं।\n"+
      "Customer records: "+uniqueCustomerCount+" (नए/अपडेट मिलाकर)\n"+
      "नए Loan: "+parsed.newLoanCount+" · अपडेट Loan: "+parsed.updateLoanCount+"\n"+
      "Weekly Status: "+parsed.weekly.length+" rows\nAdvance Ledger: "+parsed.advanceLedger.length+" new rows\n\n"+
      "मौजूदा Payment Transactions delete या duplicate नहीं होंगे। Excel के W1–W24 और Loan totals अपडेट होंगे।\n"+
      "Excel में न होने वाले पुराने रिकॉर्ड delete नहीं होंगे।\n\nक्या Import जारी रखें?";
    if (!confirm(preview)) return say("Import रद्द किया गया।");
    for(let i=0;i<parsed.customers.length;i+=50) {
      const {error}=await db.from("customers").upsert(parsed.customers.slice(i,i+50),{onConflict:"id"});
      if(error) throw new Error("Customer batch "+(Math.floor(i/50)+1)+": "+error.message);
    }
    for(let i=0;i<parsed.loans.length;i+=50) {
      const {error}=await db.from("loans").upsert(parsed.loans.slice(i,i+50),{onConflict:"id"});
      if(error) throw new Error("Loan batch "+(Math.floor(i/50)+1)+": "+error.message);
    }
    for(let i=0;i<parsed.weekly.length;i+=100) {
      const {error}=await db.from("loan_weekly_status").upsert(parsed.weekly.slice(i,i+100),{onConflict:"loan_id,week_no"});
      if(error) throw new Error("Weekly Status batch "+(Math.floor(i/100)+1)+": "+error.message);
    }
    const advanceRank={advance_received:0,cash_applied:1,advance_adjusted:2};
    parsed.advanceLedger.sort((a,b)=>(advanceRank[a.entry_type]??9)-(advanceRank[b.entry_type]??9));
    for(let i=0;i<parsed.advanceLedger.length;i+=100) {
      const {error}=await db.from("advance_ledger").insert(parsed.advanceLedger.slice(i,i+100));
      if(error) throw new Error("Advance Ledger batch "+(Math.floor(i/100)+1)+": "+error.message);
    }
    await refreshCustomers();
    say("Import पूरा हुआ। Customer: "+parsed.customers.length+" · Loan: "+parsed.loans.length+" · W1–W24: "+parsed.weekly.length+" · Advance Ledger: "+parsed.advanceLedger.length+". Dashboard Refresh करें।","success");
    document.dispatchEvent(new CustomEvent("ajsf:data-imported"));
  } catch(e) { say("Import असफल: "+e.message,"error"); }
}
async function downloadBackup() {
  if (activeRole !== "admin") return say("Full Backup केवल Admin डाउनलोड कर सकता है।", "error");
  try {
    say("पूरा Backup तैयार हो रहा है…");
    const tables = ["customers","loans","payments","loan_weekly_status","advance_ledger"];
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
    if (!Array.isArray(backup.tables.advance_ledger)) backup.tables.advance_ledger = [];
    const order = ["customers","loans","payments","loan_weekly_status","advance_ledger"];
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
  const exp=$("exportCustomersExcel"); if(exp) exp.classList.remove("hidden");
}
db.auth.onAuthStateChange((event,session) => {
  if ((event === "SIGNED_IN" || event === "INITIAL_SESSION" || event === "TOKEN_REFRESHED") && session?.user) setTimeout(()=>activate(session.user),0);
  if (event === "SIGNED_OUT") { activeUser=null; activeRole=null; }
});
document.addEventListener("ajsf:data-imported", () => {
  say("डेटा अपडेट हो गया। Dashboard को Refresh करें ताकि सभी सूची नए रिकॉर्ड दिखाएँ।","success");
});
