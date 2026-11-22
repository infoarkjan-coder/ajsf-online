import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anon || !service) return json({ error: "Server configuration missing" }, 500);

  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "Unauthorized" }, 401);
  const caller = createClient(url, anon, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false }
  });
  const { data: authData, error: authError } = await caller.auth.getUser(token);
  if (authError || !authData.user) return json({ error: "Unauthorized" }, 401);

  const admin = createClient(url, service, { auth: { persistSession: false } });
  const { data: actor, error: actorError } = await admin.from("profiles")
    .select("id, role, is_active").eq("id", authData.user.id).maybeSingle();
  if (actorError || !actor || actor.role !== "admin" || actor.is_active !== true)
    return json({ error: "केवल सक्रिय Admin यह कार्य कर सकता है।" }, 403);

  let body: { target_user_id?: string; new_password?: string } = {};
  try { body = await req.json(); } catch { return json({ error: "Invalid request" }, 400); }
  const targetId = String(body.target_user_id || "");
  const password = String(body.new_password || "");
  if (!/^[0-9a-f-]{36}$/i.test(targetId)) return json({ error: "Staff account नहीं मिला।" }, 400);
  if (password.length < 12 || password.length > 72)
    return json({ error: "पासवर्ड 12 से 72 अक्षर का होना चाहिए।" }, 400);
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password) || !/[^A-Za-z0-9]/.test(password))
    return json({ error: "पासवर्ड में छोटे-बड़े अक्षर, नंबर और एक विशेष चिन्ह होना चाहिए।" }, 400);
  const normalizedPassword = password.toLowerCase().replace(/[^a-z0-9]/g, "");
  const commonPasswords = ["password", "password123", "admin", "admin123", "welcome", "welcome123", "qwerty", "qwerty123", "letmein", "iloveyou", "india123", "ajsf123", "123456", "12345678"];
  if (commonPasswords.some((item) => normalizedPassword.includes(item)) || /(.)\1{4,}/.test(normalizedPassword) || "abcdefghijklmnopqrstuvwxyz".includes(normalizedPassword) || "01234567890123456789".includes(normalizedPassword))
    return json({ error: "यह पासवर्ड बहुत आम या अनुमान लगाने में आसान है। कृपया अलग पासवर्ड चुनें।" }, 400);

  const { data: target, error: targetError } = await admin.from("profiles")
    .select("id, full_name, staff_code, role, is_active").eq("id", targetId).maybeSingle();
  if (targetError || !target || !target.is_active || !["admin", "collector"].includes(target.role))
    return json({ error: "केवल सक्रिय Staff/Collector का पासवर्ड बदला जा सकता है।" }, 404);

  const { error: updateError } = await admin.auth.admin.updateUserById(targetId, { password });
  if (updateError) return json({ error: "पासवर्ड अपडेट नहीं हुआ।" }, 400);
  return json({ success: true, staff_name: target.full_name, staff_code: target.staff_code });
});
