import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./config.js";
const $ = id => document.getElementById(id);
const money = n => "₹" + Number(n || 0).toLocaleString("en-IN");
let supabase, currentUser, customer, loans=[], payments=[], weekly=[];
let language = "hi";
const labels = {
 hi:{loginTitle:"ग्राहक लॉगिन",loginHelp:"अपने रजिस्टर्ड मोबाइल नंबर और पासवर्ड से लॉगिन करें।",welcome:"नमस्ते",loanAmount:"कुल Loan Amount",paid:"EMI Paid",pending:"EMI Pending",next:"अगला Collection Day",loans:"मेरे लोन",history:"Payment History",security:"Account Settings",passwordNote:"आप चाहें तो अपना Password बदल सकते हैं। यह अनिवार्य नहीं है।",newPassword:"नया Password",change:"Password बदलें",login:"लॉगिन करें",logout:"लॉगआउट",date:"तारीख",loanRef:"Loan Ref",amount:"राशि",mode:"Mode",receipt:"Receipt",status:"Status",noLoans:"अभी कोई Loan रिकॉर्ड उपलब्ध नहीं है।",noPayments:"अभी कोई Payment रिकॉर्ड उपलब्ध नहीं है。",success:"डेटा सफलतापूर्वक लोड हुआ।",badPhone:"कृपया सही रजिस्टर्ड मोबाइल नंबर डालें।",passwordChanged:"Password सफलतापूर्वक बदल गया।"},
 en:{loginTitle:"Customer Login",loginHelp:"Login with your registered mobile number and password.",welcome:"Welcome",loanAmount:"Total Loan Amount",paid:"EMIs Paid",pending:"EMIs Pending",next:"Next Collection Day",loans:"My Loans",history:"Payment History",security:"Account Settings",passwordNote:"You may change your password if you wish. It is optional.",newPassword:"New Password",change:"Change Password",login:"Login",logout:"Logout",date:"Date",loanRef:"Loan Ref",amount:"Amount",mode:"Mode",receipt:"Receipt",status:"Status",noLoans:"No loan records are available yet.",noPayments:"No payment records are available yet.",success:"Data loaded successfully.",badPhone:"Enter your registered mobile number.",passwordChanged:"Password changed successfully."}
};
function t(k){return labels[language][k]||k}
function message(id, text, type="info"){const el=$(id);el.textContent=text;el.className="message "+type}
function setLanguage(){const map={loginTitle:"loginTitle",loginHelp:"loginHelp",welcomeText:"welcome",loanAmountLabel:"loanAmount",paidLabel:"paid",pendingLabel:"pending",nextDueLabel:"next",loansTitle:"loans",historyTitle:"history",securityTitle:"security",passwordNote:"passwordNote",newPasswordLabel:"newPassword",changePasswordBtn:"change",customerLoginBtn:"login",customerLogout:"logout"};for(const [id,key] of Object.entries(map))$(id).textContent=t(key);$("langToggle").textContent=language==="hi"?"English":"हिंदी";}
function nextCollectionDay(day){const names=["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];if(!day)return "—";const today=new Date();const target=names.indexOf(day);if(target<0)return day;let delta=(target-today.getDay()+7)%7;if(delta===0)delta=7;const d=new Date(today);d.setDate(today.getDate()+delta);return d.toLocaleDateString(language==="hi"?"hi-IN":"en-IN",{day:"2-digit",month:"short",year:"numeric"});}
function render(){
 $("customerName").textContent=customer.full_name||"Customer";$("customerCode").textContent=customer.customer_code||"—";$("customerMobile").textContent=customer.contact_number||currentUser.phone||"—";
 const active=loans.filter(x=>x.status==="active");const total=active.reduce((s,x)=>s+Number(x.loan_amount||0),0);
 const totalEmi=weekly.length;const paidEmi=weekly.filter(x=>x.is_paid).length;
 $("loanAmount").textContent=money(total);$("emiPaid").textContent=String(paidEmi);$("emiPending").textContent=String(Math.max(0,totalEmi-paidEmi));
 $("nextDue").textContent=nextCollectionDay(customer.collection_day);
 $("customerLoans").innerHTML=loans.length?loans.map(l=>`<tr><td>${l.loan_reference||"—"}</td><td>${money(l.loan_amount)}</td><td>${money(l.emi_amount)}</td><td>${Number(l.total_emis_required||0)}</td><td>${l.status||"—"}</td></tr>`).join(""):`<tr><td colspan="5">${t("noLoans")}</td></tr>`;
 $("customerPayments").innerHTML=payments.length?payments.map(p=>`<tr><td>${new Date(p.paid_at||p.created_at).toLocaleDateString()}</td><td>${loans.find(l=>l.id===p.loan_id)?.loan_reference||"—"}</td><td>${money(p.amount)}</td><td>${p.payment_mode||"—"}</td><td><button type="button" data-receipt="${p.id}">${t("receipt")}</button></td></tr>`).join(""):`<tr><td colspan="5">${t("noPayments")}</td></tr>`;
}
function receipt(paymentId){
 const p=payments.find(x=>x.id===paymentId);if(!p)return;
 const loan=loans.find(x=>x.id===p.loan_id);
 const w=window.open("","_blank");if(!w){message("dashboardMessage","Please allow pop-ups to open receipt.","warn");return;}
 w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>AJSF Receipt</title><style>body{font:14px Arial;padding:28px;color:#173d31}.paper{max-width:620px;margin:auto;border:1px solid #cbd8d0;padding:24px}h2{margin:0;color:#14583d}table{width:100%;border-collapse:collapse;margin-top:20px}td{padding:10px;border-bottom:1px solid #ddd}.right{text-align:right}</style></head><body><div class="paper"><h2>ARK JAN SAMRIDDHI FOUNDATION</h2><p>SAPNE AAPKE SATH HAMARA</p><h3>Payment Receipt</h3><table><tr><td>Customer</td><td class="right">${customer.full_name||""}</td></tr><tr><td>Customer ID</td><td class="right">${customer.customer_code||""}</td></tr><tr><td>Loan Ref</td><td class="right">${loan?.loan_reference||""}</td></tr><tr><td>Payment Date</td><td class="right">${new Date(p.paid_at||p.created_at).toLocaleString()}</td></tr><tr><td>Payment Mode</td><td class="right">${p.payment_mode||""}</td></tr><tr><td>Amount</td><td class="right"><b>${money(p.amount)}</b></td></tr><tr><td>Transaction ID</td><td class="right">${p.id}</td></tr></table><p>Thank you.</p></div><script>window.onload=()=>window.print()<\/script></body></html>`);w.document.close();
}
async function loadCustomer(){
 const {data:account,error:accountError}=await supabase.from("customer_accounts").select("customer_id,is_active").eq("auth_user_id",currentUser.id).single();
 if(accountError||!account||!account.is_active)throw new Error("Customer account is not active. Please contact AJSF.");
 const [c,l,p]=await Promise.all([
  supabase.from("customers").select("id,customer_code,full_name,contact_number,collection_day").eq("id",account.customer_id).single(),
  supabase.from("loans").select("id,loan_reference,customer_id,loan_amount,emi_amount,total_emis_required,status,disbursement_date").eq("customer_id",account.customer_id).order("created_at",{ascending:false}),
  supabase.from("payments").select("id,loan_id,amount,paid_at,created_at,payment_mode,is_reversal").eq("customer_id",account.customer_id).eq("is_reversal",false).order("paid_at",{ascending:false})
 ]);
 if(c.error)throw c.error;if(l.error)throw l.error;if(p.error)throw p.error;
 customer=c.data;loans=l.data||[];payments=p.data||[];
 const loanIds=loans.map(x=>x.id);
 if(loanIds.length){const result=await supabase.from("loan_weekly_status").select("loan_id,week_no,is_paid").in("loan_id",loanIds);if(result.error)throw result.error;weekly=result.data||[];}else weekly=[];
 render();$("customerLogin").classList.add("customer-hidden");$("customerDashboard").classList.remove("customer-hidden");message("dashboardMessage",t("success"),"success");
}
$("customerLoginForm").addEventListener("submit",async e=>{
 e.preventDefault();const btn=$("customerLoginBtn");btn.disabled=true;btn.textContent="...";
 try{const mobile=$("mobile").value.replace(/\D/g,"");if(!/^\d{10,15}$/.test(mobile))throw new Error(t("badPhone"));
 const {data,error}=await supabase.auth.signInWithPassword({phone:mobile.length===10?"+91"+mobile:mobile,password:$("password").value});if(error)throw error;currentUser=data.user;await loadCustomer();
 }catch(err){message("customerLoginMessage",err.message||"Login failed","error");try{await supabase.auth.signOut({scope:"local"});}catch{}}
 finally{btn.disabled=false;btn.textContent=t("login");}
});
$("customerLogout").addEventListener("click",async()=>{await supabase.auth.signOut({scope:"local"});currentUser=null;customer=null;$("customerDashboard").classList.add("customer-hidden");$("customerLogin").classList.remove("customer-hidden");$("customerLoginForm").reset();});
$("customerPayments").addEventListener("click",e=>{const b=e.target.closest("[data-receipt]");if(b)receipt(b.dataset.receipt);});
$("changePasswordForm").addEventListener("submit",async e=>{e.preventDefault();const password=$("newPassword").value;if(password.length<8){message("passwordMessage","Password must be at least 8 characters.","error");return;}const {error}=await supabase.auth.updateUser({password});if(error)message("passwordMessage",error.message,"error");else{$("newPassword").value="";message("passwordMessage",t("passwordChanged"),"success");}});
$("langToggle").addEventListener("click",()=>{language=language==="hi"?"en":"hi";setLanguage();if(customer)render();});
if(SUPABASE_PUBLISHABLE_KEY&&!SUPABASE_PUBLISHABLE_KEY.includes("PASTE_YOUR"))supabase=createClient(SUPABASE_URL,SUPABASE_PUBLISHABLE_KEY);else message("customerLoginMessage","Supabase configuration missing.","error");
setLanguage();
