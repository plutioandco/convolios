import { createClient } from "https://esm.sh/@supabase/supabase-js@2.101.1";
import { jsonResponse } from "../_shared/cors.ts";
import { CHANNEL_MAP } from "../_shared/channel-map.ts";
import { verifyWebhookSecret } from "../_shared/auth.ts";
import { validateAccountCallbackPayload } from "../_shared/validate.ts";
import { initLogger, log } from "../_shared/logging.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing required env: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}
const UNIPILE_API_KEY = Deno.env.get("UNIPILE_API_KEY") ?? "";
const UNIPILE_API_URL = Deno.env.get("UNIPILE_API_URL") ?? "";
const CALLBACK_SECRET = Deno.env.get("UNIPILE_CALLBACK_SECRET") ?? "";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

Deno.serve(async (req: Request) => {
  initLogger("unipile-account-callback");

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    if (!CALLBACK_SECRET) {
      return jsonResponse({ ok: false, error: "unauthorized — UNIPILE_CALLBACK_SECRET not configured" }, 401);
    }

    const authHeader = req.headers.get("x-callback-secret") ?? "";
    if (!await verifyWebhookSecret(authHeader, CALLBACK_SECRET)) {
      return jsonResponse({ ok: false, error: "unauthorized" }, 401);
    }

    let payload: Record<string, unknown>;
    try {
      payload = await req.json();
    } catch {
      return jsonResponse({ ok: false, error: "invalid_json" }, 400);
    }

    const validation = validateAccountCallbackPayload(payload);
    if (!validation.valid) {
      return jsonResponse({ ok: false, error: validation.error }, 400);
    }

    const status = payload.status;
    const accountId = payload.account_id as string;
    const userId = payload.name as string;

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
        log.error("Failed to fetch account type from Unipile", { error: String(err) });
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
        log.error("Insert account error", { error: insertError.message });
        return jsonResponse({ ok: false, error: insertError.message }, 500);
      }
    }

    return jsonResponse({ ok: true, account_id: accountId, channel });
  } catch (err) {
    log.error("Account callback error", { error: String(err) });
    return jsonResponse({ ok: false, error: "internal_error" }, 500);
  }
});

