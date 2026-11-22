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
  if (password.length < 10 || password.length > 72)
    return json({ error: "पासवर्ड 10 से 72 अक्षर का होना चाहिए।" }, 400);

  const { data: target, error: targetError } = await admin.from("profiles")
    .select("id, full_name, staff_code, role, is_active").eq("id", targetId).maybeSingle();
  if (targetError || !target || !target.is_active || !["admin", "collector"].includes(target.role))
    return json({ error: "केवल सक्रिय Staff/Collector का पासवर्ड बदला जा सकता है।" }, 404);

  const { error: updateError } = await admin.auth.admin.updateUserById(targetId, { password });
  if (updateError) return json({ error: "पासवर्ड अपडेट नहीं हुआ।" }, 400);
  return json({ success: true, staff_name: target.full_name, staff_code: target.staff_code });
});
