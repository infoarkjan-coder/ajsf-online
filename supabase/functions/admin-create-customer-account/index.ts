import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  const url = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const defaultPassword = Deno.env.get("AJSF_CUSTOMER_DEFAULT_PASSWORD");
  if (!defaultPassword || defaultPassword.length < 8) {
    return new Response(JSON.stringify({ error: "Customer default password is not configured securely." }), { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  try {
    const callerClient = createClient(url, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: { user }, error: userError } = await callerClient.auth.getUser();
    if (userError || !user) throw new Error("Unauthorized");

    const adminClient = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
    const { data: profile, error: profileError } = await adminClient.from("profiles")
      .select("role,is_active").eq("id", user.id).single();
    if (profileError || !profile || profile.role !== "admin" || profile.is_active !== true) {
      return new Response(JSON.stringify({ error: "Only an active AJSF Admin can create customer accounts." }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const body = await req.json();
    const customerId = String(body.customer_id || "");
    if (!/^[0-9a-f-]{36}$/i.test(customerId)) throw new Error("Valid customer_id is required.");

    const { data: customer, error: customerError } = await adminClient.from("customers")
      .select("id,contact_number,customer_status,is_active").eq("id", customerId).single();
    if (customerError || !customer) throw new Error("Customer record not found.");
    if (customer.is_active === false || (customer.customer_status && customer.customer_status !== "ACTIVE")) throw new Error("Only active customers can receive portal accounts.");

    const digits = String(customer.contact_number || "").replace(/[^0-9]/g, "");
    if (!/^[0-9]{10}$/.test(digits)) throw new Error("Customer must have a valid 10-digit registered mobile number.");
    const phone = "+91" + digits;

    const { data: existing } = await adminClient.from("customer_accounts").select("id,is_active").eq("customer_id", customerId).maybeSingle();
    if (existing) throw new Error("This customer already has a portal account.");

    const { data: created, error: createError } = await adminClient.auth.admin.createUser({
      phone, password: defaultPassword, phone_confirm: true,
      app_metadata: { account_type: "customer" },
    });
    if (createError || !created.user) throw new Error(createError?.message || "Could not create customer login.");

    const { error: linkError } = await adminClient.from("customer_accounts").insert({
      customer_id: customerId, auth_user_id: created.user.id, is_active: true,
      must_change_password: false, created_by: user.id,
    });
    if (linkError) {
      await adminClient.auth.admin.deleteUser(created.user.id);
      throw new Error("Account link failed; new login was rolled back. " + linkError.message);
    }

    return new Response(JSON.stringify({ success: true, customer_id: customerId, phone, message: "Customer portal account created. Share the initial password privately with the customer." }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (error) {
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Request failed" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});