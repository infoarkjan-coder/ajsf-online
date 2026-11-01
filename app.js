import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./config.js";
const $ = id => document.getElementById(id);
const loginCard = $("loginCard"), dashboardCard = $("dashboardCard"), message = $("message"), loginBtn = $("loginBtn");
if (SUPABASE_PUBLISHABLE_KEY === "PASTE_YOUR_SUPABASE_PUBLISHABLE_KEY_HERE") {
  message.textContent = "पहले src/config.js में Supabase Publishable Key डालें।"; loginBtn.disabled = true;
} else {
  const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
  $("loginForm").addEventListener("submit", async event => {
    event.preventDefault(); message.textContent = ""; loginBtn.disabled = true; loginBtn.textContent = "जाँच हो रही है…";
    const { data, error } = await supabase.auth.signInWithPassword({email: $("email").value.trim(), password: $("password").value});
    if (error) { message.textContent = "लॉगिन नहीं हुआ। ईमेल/पासवर्ड जाँचें या Admin से संपर्क करें।"; loginBtn.disabled = false; loginBtn.textContent = "लॉगिन करें"; return; }
    const { data: profile, error: profileError } = await supabase.from("profiles").select("full_name, role, staff_code, is_active").eq("id", data.user.id).single();
    if (profileError || !profile || !profile.is_active) { await supabase.auth.signOut(); message.textContent = "सक्रिय प्रोफाइल नहीं मिली। Admin से संपर्क करें।"; loginBtn.disabled = false; loginBtn.textContent = "लॉगिन करें"; return; }
    $("staffName").textContent = profile.full_name || "Staff"; $("staffCode").textContent = profile.staff_code || "—"; $("staffRole").textContent = profile.role === "admin" ? "Admin" : "Collector";
    $("nextStep").textContent = profile.role === "admin" ? "Admin लॉगिन सत्यापित है। Dashboard मॉड्यूल अगला चरण है।" : "Collector लॉगिन सत्यापित है। Assigned Customer Collection मॉड्यूल अगला चरण है।";
    loginCard.classList.add("hidden"); dashboardCard.classList.remove("hidden");
  });
  $("logoutBtn").addEventListener("click", async () => { await supabase.auth.signOut(); dashboardCard.classList.add("hidden"); loginCard.classList.remove("hidden"); $("loginForm").reset(); message.textContent = "आप लॉगआउट हो गए हैं।"; loginBtn.disabled = false; loginBtn.textContent = "लॉगिन करें"; });
}
