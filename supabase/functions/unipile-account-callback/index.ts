import { createClient } from "https://esm.sh/@supabase/supabase-js@2.101.1";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing required env: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}
const UNIPILE_API_KEY = Deno.env.get("UNIPILE_API_KEY") ?? "";
const UNIPILE_API_URL = Deno.env.get("UNIPILE_API_URL") ?? "";
const CALLBACK_SECRET = Deno.env.get("UNIPILE_CALLBACK_SECRET") ?? "";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const CHANNEL_MAP: Record<string, string> = {
  LINKEDIN: "linkedin",
  WHATSAPP: "whatsapp",
  INSTAGRAM: "instagram",
  TELEGRAM: "telegram",
  MAIL: "email",
  GMAIL: "email",
  GOOGLE: "email",
  GOOGLE_OAUTH: "email",
  OUTLOOK: "email",
  MICROSOFT: "email",
  IMAP: "email",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders() });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    if (!CALLBACK_SECRET) {
      return jsonResponse({ ok: false, error: "unauthorized — UNIPILE_CALLBACK_SECRET not configured" }, 401);
    }

    const authHeader = req.headers.get("x-callback-secret") ?? "";
    if (authHeader !== CALLBACK_SECRET) {
      return jsonResponse({ ok: false, error: "unauthorized" }, 401);
    }

    const payload = await req.json();

    const status = payload.status;
    const accountId = payload.account_id;
    const userId = payload.name;

    if (!accountId || !userId) {
      return jsonResponse({ ok: false, error: "missing account_id or name" }, 400);
    }

    if (status !== "CREATION_SUCCESS" && status !== "RECONNECTED") {
      return jsonResponse({ ok: true, skipped: status });
    }

    let channel = "unknown";
    let display_name: string | null = null;
    let email: string | null = null;
    let phone: string | null = null;
    let username: string | null = null;
    let provider_type: string | null = null;
    let connection_params: Record<string, unknown> = {};

    if (UNIPILE_API_KEY && UNIPILE_API_URL) {
      try {
        const base = UNIPILE_API_URL.replace(/\/$/, "");
        const res = await fetch(`${base}/api/v1/accounts/${accountId}`, {
          headers: {
            "X-API-KEY": UNIPILE_API_KEY,
            Accept: "application/json",
          },
        });
        if (res.ok) {
          const acc = await res.json();
          const accType = (acc.type ?? "").toUpperCase();
          channel = CHANNEL_MAP[accType] ?? CHANNEL_MAP[accType.replace("_OAUTH", "")] ?? accType.toLowerCase();
          provider_type = acc.type ?? null;
          display_name = acc.name ?? null;
          connection_params = acc.connection_params ?? {};

          const cp = acc.connection_params ?? {};
          email = cp?.mail?.username ?? cp?.mail?.id ?? null;
          phone = cp?.im?.phone_number ?? null;
          if (accType === "LINKEDIN") username = cp?.im?.publicIdentifier ?? null;
          else if (accType === "INSTAGRAM" || accType === "TELEGRAM") username = cp?.im?.username ?? null;
        }
      } catch (err) {
        console.error("Failed to fetch account type from Unipile:", err);
      }
    }

    const row = {
      user_id: userId,
      provider: "unipile",
      channel,
      account_id: accountId,
      status: "active",
      display_name,
      email,
      phone,
      username,
      provider_type,
      connection_params,
      last_synced_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const { error } = await supabase.from("connected_accounts").upsert(
      row,
      { onConflict: "user_id,provider,account_id" }
    );

    if (error) {
      const { error: insertError } = await supabase
        .from("connected_accounts")
        .insert(row);

      if (insertError) {
        console.error("Insert account error:", insertError);
        return jsonResponse({ ok: false, error: insertError.message }, 500);
      }
    }

    return jsonResponse({ ok: true, account_id: accountId, channel });
  } catch (err) {
    console.error("Account callback error:", err);
    return jsonResponse({ ok: false, error: "internal_error" }, 500);
  }
});

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}
