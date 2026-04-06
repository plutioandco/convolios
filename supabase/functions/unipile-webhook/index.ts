import { createClient } from "https://esm.sh/@supabase/supabase-js@2.101.1";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WEBHOOK_SECRET = Deno.env.get("UNIPILE_WEBHOOK_SECRET") ?? "";
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const CHANNEL_MAP: Record<string, string> = {
  LINKEDIN: "linkedin",
  WHATSAPP: "whatsapp",
  INSTAGRAM: "instagram",
  TELEGRAM: "telegram",
  MAIL: "email",
  GMAIL: "email",
  OUTLOOK: "email",
  IMAP: "email",
};

interface UnipileWebhook {
  account_id: string;
  account_type: string;
  account_info?: { user_id?: string };
  event: string;
  chat_id: string;
  timestamp: string;
  message_id: string;
  message?: string;
  sender?: {
    attendee_id: string;
    attendee_name: string;
    attendee_provider_id: string;
    attendee_profile_url?: string;
  };
  attendees?: Array<{
    attendee_id: string;
    attendee_name: string;
    attendee_provider_id: string;
    attendee_profile_url?: string;
  }>;
  attachments?: Array<{
    id: string;
    type: string;
    mimetype?: string;
    url?: string;
    size?: { height?: string; width?: string };
  }>;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders() });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  if (WEBHOOK_SECRET) {
    const authHeader = req.headers.get("Unipile-Auth") ?? "";
    if (authHeader !== WEBHOOK_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }
  }

  try {
    const payload: UnipileWebhook = await req.json();

    if (payload.event !== "message_received") {
      return jsonResponse({ ok: true, skipped: payload.event });
    }

    const channel = CHANNEL_MAP[payload.account_type] ?? payload.account_type.toLowerCase();

    const { data: account } = await supabase
      .from("connected_accounts")
      .select("user_id")
      .eq("account_id", payload.account_id)
      .eq("provider", "unipile")
      .eq("status", "active")
      .limit(1)
      .single();

    if (!account) {
      console.error("No connected account found for", payload.account_id);
      return jsonResponse({ ok: false, error: "unknown_account" }, 200);
    }

    const userId = account.user_id;
    const isSender =
      payload.account_info?.user_id === payload.sender?.attendee_provider_id;
    const direction = isSender ? "outbound" : "inbound";

    const senderHandle =
      payload.sender?.attendee_provider_id ??
      payload.sender?.attendee_id ??
      "unknown";
    const senderName = payload.sender?.attendee_name ?? senderHandle;

    const { personId, identityId } = await findOrCreatePerson(
      userId,
      channel,
      senderHandle,
      senderName,
      payload.account_id
    );

    const attachments = (payload.attachments ?? []).map((a) => ({
      id: a.id,
      type: a.type,
      mimetype: a.mimetype ?? null,
      url: a.url ?? null,
    }));

    const { error: msgError } = await supabase.from("messages").upsert(
      {
        user_id: userId,
        person_id: personId,
        identity_id: identityId,
        external_id: payload.message_id,
        channel,
        direction,
        message_type: "dm",
        body_text: payload.message ?? null,
        attachments: JSON.stringify(attachments),
        thread_id: payload.chat_id,
        sent_at: payload.timestamp,
        triage: "unclassified",
      },
      { onConflict: "external_id", ignoreDuplicates: true }
    );

    if (msgError) {
      console.error("Insert message error:", msgError);
      return jsonResponse({ ok: false, error: msgError.message }, 200);
    }

    if (GEMINI_API_KEY && direction === "inbound" && payload.message) {
      await triageMessage(payload.message_id, payload.message);
    }

    return jsonResponse({ ok: true, direction, channel, person_id: personId });
  } catch (err) {
    console.error("Webhook handler error:", err);
    return jsonResponse({ ok: false, error: String(err) }, 200);
  }
});

async function findOrCreatePerson(
  userId: string,
  channel: string,
  handle: string,
  displayName: string,
  unipileAccountId: string
): Promise<{ personId: string; identityId: string }> {
  const { data: existingIdentity } = await supabase
    .from("identities")
    .select("id, person_id")
    .eq("channel", channel)
    .eq("handle", handle)
    .limit(1)
    .single();

  if (existingIdentity) {
    return {
      personId: existingIdentity.person_id,
      identityId: existingIdentity.id,
    };
  }

  const { data: person, error: personError } = await supabase
    .from("persons")
    .insert({
      user_id: userId,
      display_name: displayName,
    })
    .select("id")
    .single();

  if (personError || !person) {
    throw new Error(`Failed to create person: ${personError?.message}`);
  }

  const { data: identity, error: identityError } = await supabase
    .from("identities")
    .insert({
      person_id: person.id,
      channel,
      handle,
      display_name: displayName,
      unipile_account_id: unipileAccountId,
    })
    .select("id")
    .single();

  if (identityError || !identity) {
    throw new Error(`Failed to create identity: ${identityError?.message}`);
  }

  return { personId: person.id, identityId: identity.id };
}

async function triageMessage(messageId: string, text: string) {
  try {
    const prompt = `Classify this message into exactly ONE category. Reply with ONLY the category word, nothing else.

Categories:
- urgent: needs immediate reply (money, deadlines, direct questions needing fast answers)
- human: real person, real conversation, but not time-sensitive
- newsletter: mass email, marketing, promotional content
- notification: automated system message (receipts, alerts, shipping updates)
- noise: spam, irrelevant, or junk

Message: "${text.slice(0, 500)}"

Category:`;

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 10, temperature: 0 },
        }),
      }
    );

    if (!res.ok) {
      console.error("Gemini triage error:", res.status, await res.text());
      return;
    }

    const data = await res.json();
    const raw =
      data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim().toLowerCase() ??
      "";

    const valid = ["urgent", "human", "newsletter", "notification", "noise"];
    const triage = valid.includes(raw) ? raw : "unclassified";

    await supabase
      .from("messages")
      .update({ triage })
      .eq("external_id", messageId);
  } catch (err) {
    console.error("Triage failed (non-blocking):", err);
  }
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, unipile-auth",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}
