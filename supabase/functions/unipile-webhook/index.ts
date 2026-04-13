import { createClient } from "https://esm.sh/@supabase/supabase-js@2.101.1";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing required env: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}
const WEBHOOK_SECRET = Deno.env.get("UNIPILE_WEBHOOK_SECRET") ?? "";
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const UNIPILE_API_KEY = Deno.env.get("UNIPILE_API_KEY") ?? "";
const UNIPILE_API_URL = Deno.env.get("UNIPILE_API_URL") ?? "";

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
  MOBILE: "sms",
  SMS: "sms",
  RCS: "sms",
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

function normalizeHandle(raw: string, channel: string): string {
  let h = raw
    .replace(/@s\.whatsapp\.net$/, "")
    .replace(/@lid$/, "")
    .replace(/@c\.us$/, "")
    .trim();
  if (channel === "whatsapp" && /^\d+$/.test(h)) {
    h = `+${h}`;
  }
  if (channel === "linkedin") {
    h = h.replace(/^https?:\/\/(www\.)?linkedin\.com\/in\//i, "").replace(/\/$/, "");
  }
  return h.toLowerCase();
}

function resolveAccount(accountId: string) {
  return supabase
    .from("connected_accounts")
    .select("user_id")
    .eq("account_id", accountId)
    .eq("provider", "unipile")
    .limit(1)
    .single();
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders() });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  if (!WEBHOOK_SECRET) {
    return new Response("Unauthorized — UNIPILE_WEBHOOK_SECRET not configured", { status: 401 });
  }

  const authHeader =
    req.headers.get("x-webhook-secret") ??
    req.headers.get("Unipile-Auth") ??
    "";
  if (authHeader !== WEBHOOK_SECRET) {
    console.error("Webhook auth failed");
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const payload = await req.json();
    const event = payload.event as string;

    switch (event) {
      case "message_received":
        return await handleMessageReceived(payload);
      case "mail_received":
        return await handleEmailEvent(payload);
      case "message_reaction":
        return await handleMessageReaction(payload);
      case "message_read":
        return await handleMessageRead(payload);
      case "message_edited":
        return await handleMessageEdited(payload);
      case "message_deleted":
        return await handleMessageDeleted(payload);
      case "message_delivered":
        return await handleMessageDelivered(payload);
      case "mail_sent":
        return await handleEmailEvent(payload);
      case "mail_moved":
        return await handleMailMoved(payload);
      case "account_connected":
      case "account_disconnected":
      case "account_error":
      case "creation_success":
      case "reconnected":
      case "creation_fail":
      case "error":
      case "credentials":
        return await handleAccountStatus(payload);
      default:
        console.warn("Unhandled webhook event:", event);
        return jsonResponse({ ok: true, skipped: event });
    }
  } catch (err) {
    console.error("Webhook handler error:", err);
    return jsonResponse({ ok: false, error: "internal_error" }, 500);
  }
});

// ─── MESSAGE RECEIVED ──────────────────────────────────────────────────────

function resolveSenderDirection(
  fullMsg: Record<string, unknown> | null,
  payload: UnipileWebhook,
): "inbound" | "outbound" {
  if (fullMsg != null && fullMsg.is_sender != null) {
    return fullMsg.is_sender ? "outbound" : "inbound";
  }
  const accountUserId = payload.account_info?.user_id;
  const senderProviderId = payload.sender?.attendee_provider_id;
  if (accountUserId && senderProviderId && accountUserId === senderProviderId) {
    return "outbound";
  }
  return "inbound";
}

async function handleMessageReceived(payload: UnipileWebhook): Promise<Response> {
  const channel = CHANNEL_MAP[payload.account_type] ?? payload.account_type.toLowerCase();

  const { data: existing } = await supabase
    .from("messages")
    .select("id")
    .eq("external_id", payload.message_id)
    .maybeSingle();

  if (existing) {
    return jsonResponse({ ok: true, skipped: "already_persisted" });
  }

  const [chatInfo, accountResult, fullMsg] = await Promise.all([
    fetchChatInfo(payload.chat_id),
    resolveAccount(payload.account_id),
    fetchFullMessage(payload.message_id),
  ]);

  const account = accountResult.data;
  if (!account) {
    console.error("No connected account found for", payload.account_id);
    return jsonResponse({ ok: false, error: "unknown_account" }, 400);
  }

  const userId = account.user_id;
  const isGroup = chatInfo.isGroup || (payload.attendees?.length ?? 0) >= 3;

  const threadLookup = await resolvePersonFromThread(userId, payload.chat_id);

  let personId: string;
  let identityId: string;
  let direction: "inbound" | "outbound";
  let messageType: string;

  if (threadLookup) {
    if (isGroup) {
      const groupHandle = chatInfo.provider_id ?? payload.chat_id;
      const groupName = chatInfo.name ?? "Group Chat";
      const result = await findOrCreatePerson(
        userId, channel, groupHandle, groupName, payload.account_id
      );
      personId = result.personId;
      identityId = result.identityId;
    } else {
      personId = threadLookup.person_id;
      identityId = threadLookup.identity_id;
    }
    messageType = isGroup ? "group" : threadLookup.message_type;

    direction = resolveSenderDirection(fullMsg, payload);
  } else {
    const isSender = resolveSenderDirection(fullMsg, payload) === "outbound";
    direction = isSender ? "outbound" : "inbound";
    messageType = isGroup ? "group" : "dm";

    let contactHandle: string;
    let contactName: string;

    if (isGroup) {
      contactHandle = chatInfo.provider_id ?? payload.chat_id;
      contactName = chatInfo.name ?? "Group Chat";
    } else if (isSender) {
      const recipient = payload.attendees?.find(
        (a) => a.attendee_provider_id !== payload.sender?.attendee_provider_id
      );
      const recipientHandle = recipient?.attendee_provider_id
        ?? chatInfo.attendee_provider_id
        ?? payload.chat_id;
      contactHandle = normalizeHandle(recipientHandle, channel);
      contactName = recipient?.attendee_name ?? chatInfo.name ?? contactHandle;
    } else {
      contactHandle = normalizeHandle(
        payload.sender?.attendee_provider_id
          ?? payload.sender?.attendee_id
          ?? "unknown",
        channel
      );
      contactName = payload.sender?.attendee_name ?? contactHandle;
    }

    const result = await findOrCreatePerson(
      userId, channel, contactHandle, contactName, payload.account_id
    );
    personId = result.personId;
    identityId = result.identityId;

    // Mark avatar as stale if it hasn't been refreshed in 3+ days
    const { data: personRow } = await supabase
      .from("persons")
      .select("avatar_refreshed_at")
      .eq("id", personId)
      .maybeSingle();

    if (personRow) {
      const refreshedAt = personRow.avatar_refreshed_at
        ? new Date(personRow.avatar_refreshed_at).getTime()
        : 0;
      const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
      if (Date.now() - refreshedAt > threeDaysMs) {
        // Fire-and-forget — marking stale is advisory, don't block webhook response
        supabase
          .from("persons")
          .update({ avatar_stale: true })
          .eq("id", personId)
          .then(() => {});
      }
    }
  }

  // Content-based dedup for outbound messages.
  // Rust persist_outbound and the webhook receive different external_ids AND
  // potentially different chat_ids (thread_id) from Unipile for the same
  // physical message, so match by person + body + direction within a tight window,
  // then adopt the webhook's external_id so future events resolve correctly.
  if (direction === "outbound") {
    const ts = new Date(payload.timestamp).getTime();
    const windowStart = new Date(ts - 10000).toISOString();
    const windowEnd = new Date(ts + 10000).toISOString();

    const { data: contentDup } = await supabase
      .from("messages")
      .select("id")
      .eq("person_id", personId)
      .eq("user_id", userId)
      .eq("direction", "outbound")
      .eq("body_text", payload.message ?? "")
      .gte("sent_at", windowStart)
      .lte("sent_at", windowEnd)
      .order("sent_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (contentDup) {
      await supabase
        .from("messages")
        .update({
          external_id: payload.message_id,
          thread_id: payload.chat_id,
          identity_id: identityId,
          unipile_account_id: payload.account_id,
          seen: fullMsg?.seen ?? false,
          delivered: fullMsg?.delivered ?? false,
          provider_id: fullMsg?.provider_id ?? null,
          chat_provider_id: fullMsg?.chat_provider_id ?? null,
        })
        .eq("id", contentDup.id);
      return jsonResponse({ ok: true, merged: "outbound_content_dedup" });
    }
  }

  const senderName = payload.sender?.attendee_name
    ?? payload.sender?.attendee_provider_id
    ?? "Unknown";

  const attachments = await enrichAttachments(
    payload.attachments ?? [], payload.message_id
  );

  const { error: msgError } = await supabase.from("messages").upsert(
    {
      user_id: userId,
      person_id: personId,
      identity_id: identityId,
      external_id: payload.message_id,
      channel,
      direction,
      message_type: messageType,
      body_text: payload.message ?? null,
      attachments,
      thread_id: payload.chat_id,
      sent_at: payload.timestamp,
      sender_name: isGroup ? senderName : null,
      triage: "unclassified",
      unipile_account_id: payload.account_id,
      hidden: fullMsg?.hidden ?? false,
      is_event: fullMsg?.is_event ?? false,
      event_type: fullMsg?.event_type ?? null,
      quoted_text: fullMsg?.quoted?.text ?? null,
      quoted_sender: fullMsg?.quoted?.sender_name ?? null,
      reactions: Array.isArray(fullMsg?.reactions) ? fullMsg.reactions : [],
      seen: fullMsg?.seen ?? false,
      seen_by: fullMsg?.seen_by ?? null,
      delivered: fullMsg?.delivered ?? false,
      edited: fullMsg?.edited ?? false,
      deleted: fullMsg?.deleted ?? false,
      provider_id: fullMsg?.provider_id ?? null,
      chat_provider_id: fullMsg?.chat_provider_id ?? null,
      folder: chatInfo.folder ?? null,
    },
    { onConflict: "external_id", ignoreDuplicates: false }
  );

  if (msgError) {
    console.error("Insert message error:", msgError);
    return jsonResponse({ ok: false, error: msgError.message }, 500);
  }

  const response = jsonResponse({ ok: true, direction, channel, person_id: personId });

  if (GEMINI_API_KEY && direction === "inbound" && payload.message) {
    triageMessage(payload.message_id, payload.message).catch(() => {});
  }

  return response;
}

// ─── EMAIL RECEIVED / SENT ─────────────────────────────────────────────────

async function handleEmailEvent(payload: Record<string, unknown>): Promise<Response> {
  const accountId = payload.account_id as string;

  const { data: account } = await resolveAccount(accountId);
  if (!account) {
    return jsonResponse({ ok: false, error: "unknown_email_account" }, 400);
  }

  const userId = account.user_id;
  const emailId = (payload.email_id ?? payload.message_id ?? "") as string;
  if (!emailId) {
    return jsonResponse({ ok: false, error: "no_email_id" }, 400);
  }

  if (!UNIPILE_API_KEY) {
    return jsonResponse({ ok: false, error: "no_api_key" }, 500);
  }

  try {
    const res = await fetch(
      `${UNIPILE_API_URL}/api/v1/emails/${emailId}`,
      { headers: { "X-API-KEY": UNIPILE_API_KEY } }
    );
    if (!res.ok) {
      console.error("Email fetch failed:", res.status);
      return jsonResponse({ ok: false, error: `email_fetch_${res.status}` }, 502);
    }

    const em = await res.json();
    const fromAddr = (em.from_attendee?.identifier ?? "").toLowerCase();
    const fromName = em.from_attendee?.display_name ?? fromAddr;

    const isSentEvent = (payload.event as string) === "mail_sent";
    const direction = (isSentEvent || em.origin === "internal") ? "outbound" : "inbound";
    const otherAddr = direction === "inbound"
      ? fromAddr
      : (em.to_attendees?.[0]?.identifier?.toLowerCase() ?? "");
    const otherName = direction === "inbound"
      ? fromName
      : (em.to_attendees?.[0]?.display_name ?? otherAddr);

    if (!otherAddr) {
      return jsonResponse({ ok: true, skipped: "no_other_party" });
    }

    const { personId, identityId } = await findOrCreatePerson(
      userId, "email", otherAddr, otherName, accountId
    );

    const folders = Array.isArray(em.folders) ? em.folders : [];
    const folder = folders[0] ?? null;

    const { error: msgError } = await supabase.from("messages").upsert(
      {
        user_id: userId,
        person_id: personId,
        identity_id: identityId,
        external_id: em.id ?? emailId,
        channel: "email",
        direction,
        message_type: "dm",
        subject: em.subject ?? null,
        body_text: em.body_plain ?? null,
        body_html: em.body ?? null,
        attachments: Array.isArray(em.attachments) ? em.attachments : [],
        thread_id: em.thread_id ?? em.id ?? emailId,
        sent_at: em.date ?? new Date().toISOString(),
        sender_name: fromName,
        triage: "unclassified",
        unipile_account_id: accountId,
        in_reply_to_message_id: em.in_reply_to?.message_id ?? null,
        smtp_message_id: em.message_id ?? null,
        folder,
        seen: em.read_date ? true : false,
        read_at: em.read_date ?? null,
      },
      { onConflict: "external_id", ignoreDuplicates: false }
    );

    if (msgError) {
      console.error("Email insert error:", msgError);
      return jsonResponse({ ok: false, error: msgError.message }, 500);
    }

    if (GEMINI_API_KEY && direction === "inbound" && em.subject) {
      await triageMessage(em.id ?? emailId, `${em.subject}\n${(em.body_plain ?? "").slice(0, 400)}`);
    }

    return jsonResponse({ ok: true, direction, channel: "email", person_id: personId });
  } catch (err) {
    console.error("Email handler error:", err);
    return jsonResponse({ ok: false, error: "internal_error" }, 500);
  }
}

// ─── MUTATION EVENTS ────────────────────────────────────────────────────────

async function handleMessageReaction(payload: Record<string, unknown>): Promise<Response> {
  const messageId = (payload.message_id ?? "") as string;
  if (!messageId) return jsonResponse({ ok: true, skipped: "no_message_id" });

  const reactionEmoji = (payload.reaction ?? "") as string;
  if (!reactionEmoji) return jsonResponse({ ok: true, skipped: "no_reaction_data" });

  const reactionSender = payload.reaction_sender as Record<string, unknown> | undefined;
  const senderId = (reactionSender?.attendee_provider_id ?? reactionSender?.attendee_id ?? "") as string;

  const { data: existing } = await supabase
    .from("messages")
    .select("reactions")
    .eq("external_id", messageId)
    .single();

  if (!existing) return jsonResponse({ ok: true, skipped: "message_not_found" });

  const reactions = Array.isArray(existing.reactions) ? [...existing.reactions] : [];
  reactions.push({
    value: reactionEmoji,
    sender_id: senderId,
  });

  const { error } = await supabase
    .from("messages")
    .update({ reactions })
    .eq("external_id", messageId);

  if (error) {
    console.error("Reaction update error:", error);
    return jsonResponse({ ok: false, error: error.message }, 500);
  }

  return jsonResponse({ ok: true, event: "reaction" });
}

async function handleMessageRead(payload: Record<string, unknown>): Promise<Response> {
  const messageId = (payload.message_id ?? "") as string;
  const chatId = (payload.chat_id ?? "") as string;
  const accountId = (payload.account_id ?? "") as string;

  if (messageId) {
    await supabase
      .from("messages")
      .update({ seen: true })
      .eq("external_id", messageId);
  } else if (chatId) {
    await supabase
      .from("messages")
      .update({ seen: true })
      .eq("thread_id", chatId)
      .eq("direction", "outbound")
      .eq("seen", false);
  }

  if (chatId && accountId) {
    const { data: account } = await resolveAccount(accountId);
    if (account) {
      const threadPerson = await resolvePersonFromThread(account.user_id, chatId);
      const personId = threadPerson?.person_id;

      if (personId) {
        await supabase
          .from("messages")
          .update({ read_at: new Date().toISOString() })
          .eq("person_id", personId)
          .eq("user_id", account.user_id)
          .eq("direction", "inbound")
          .is("read_at", null);
      } else {
        await supabase
          .from("messages")
          .update({ read_at: new Date().toISOString() })
          .eq("thread_id", chatId)
          .eq("user_id", account.user_id)
          .eq("direction", "inbound")
          .is("read_at", null);
      }
    }
  }

  return jsonResponse({ ok: true, event: "read" });
}

async function handleMessageEdited(payload: Record<string, unknown>): Promise<Response> {
  const messageId = (payload.message_id ?? "") as string;
  if (!messageId) return jsonResponse({ ok: true, skipped: "no_message_id" });

  const newText = (payload.message ?? payload.text ?? "") as string;

  const { error } = await supabase
    .from("messages")
    .update({ body_text: newText || undefined, edited: true })
    .eq("external_id", messageId);

  if (error) {
    console.error("Edit update error:", error);
    return jsonResponse({ ok: false, error: error.message }, 500);
  }

  return jsonResponse({ ok: true, event: "edited" });
}

async function handleMessageDeleted(payload: Record<string, unknown>): Promise<Response> {
  const messageId = (payload.message_id ?? "") as string;
  if (!messageId) return jsonResponse({ ok: true, skipped: "no_message_id" });

  const { error } = await supabase
    .from("messages")
    .delete()
    .eq("external_id", messageId);

  if (error) {
    console.error("Message hard-delete error:", error);
    return jsonResponse({ ok: false, error: error.message }, 500);
  }

  return jsonResponse({ ok: true, event: "deleted" });
}

async function handleMessageDelivered(payload: Record<string, unknown>): Promise<Response> {
  const messageId = (payload.message_id ?? "") as string;
  if (!messageId) return jsonResponse({ ok: true, skipped: "no_message_id" });

  await supabase
    .from("messages")
    .update({ delivered: true })
    .eq("external_id", messageId);

  return jsonResponse({ ok: true, event: "delivered" });
}

async function handleMailMoved(payload: Record<string, unknown>): Promise<Response> {
  const emailId = (payload.email_id ?? payload.message_id ?? "") as string;
  if (!emailId) return jsonResponse({ ok: true, skipped: "no_email_id" });

  const folder = (payload.folder ?? payload.destination ?? "") as string;
  if (folder) {
    await supabase
      .from("messages")
      .update({ folder })
      .eq("external_id", emailId);
  }

  return jsonResponse({ ok: true, event: "mail_moved" });
}

async function handleAccountStatus(payload: Record<string, unknown>): Promise<Response> {
  const accountId = (payload.account_id ?? "") as string;
  const event = (payload.event ?? "") as string;

  if (!accountId) return jsonResponse({ ok: true, skipped: "no_account_id" });

  const ACTIVE_EVENTS = ["account_connected", "creation_success", "reconnected"];
  const CREDENTIALS_EVENTS = ["credentials"];
  const ERROR_EVENTS = ["account_error", "error"];
  const status = ACTIVE_EVENTS.includes(event)
    ? "active"
    : CREDENTIALS_EVENTS.includes(event)
      ? "credentials"
      : ERROR_EVENTS.includes(event)
        ? "error"
        : "disconnected";

  const { error } = await supabase
    .from("connected_accounts")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("account_id", accountId)
    .eq("provider", "unipile");

  if (error) {
    console.error("Account status update error:", error);
    return jsonResponse({ ok: false, error: error.message }, 500);
  }

  return jsonResponse({ ok: true, event, status });
}

// ─── HELPERS ────────────────────────────────────────────────────────────────

async function fetchFullMessage(
  messageId: string
): Promise<Record<string, unknown> | null> {
  if (!UNIPILE_API_KEY) return null;
  try {
    const res = await fetch(
      `${UNIPILE_API_URL}/api/v1/messages/${messageId}`,
      { headers: { "X-API-KEY": UNIPILE_API_KEY } }
    );
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function enrichAttachments(
  webhookAtts: Array<{ id?: string; type?: string; mimetype?: string; url?: string }>,
  messageId: string
): Promise<unknown[]> {
  const hasIds = webhookAtts.length > 0 && webhookAtts.every((a) => a.id);
  if (hasIds) {
    return webhookAtts.map((a) => ({
      id: a.id,
      type: a.type ?? "image",
      mimetype: a.mimetype ?? null,
      url: a.url ?? null,
    }));
  }

  if (webhookAtts.length === 0 || !UNIPILE_API_KEY) return [];

  try {
    const res = await fetch(
      `${UNIPILE_API_URL}/api/v1/messages/${messageId}`,
      { headers: { "X-API-KEY": UNIPILE_API_KEY } }
    );
    if (!res.ok) return webhookAtts;
    const msg = await res.json();
    const fullAtts = msg.attachments ?? [];
    if (Array.isArray(fullAtts) && fullAtts.length > 0) {
      return fullAtts;
    }
  } catch (err) {
    console.error("Failed to enrich attachments:", err);
  }

  return webhookAtts;
}

async function fetchChatInfo(
  chatId: string
): Promise<{ provider_id?: string; name?: string; isGroup?: boolean; folder?: string; attendee_provider_id?: string }> {
  if (!UNIPILE_API_KEY) return {};
  try {
    const res = await fetch(
      `${UNIPILE_API_URL}/api/v1/chats/${chatId}`,
      { headers: { "X-API-KEY": UNIPILE_API_KEY } }
    );
    if (!res.ok) return {};
    const data = await res.json();
    return {
      provider_id: data.provider_id ?? undefined,
      name: data.name ?? undefined,
      isGroup: (data.type ?? 0) >= 1,
      folder: data.folder ?? undefined,
      attendee_provider_id: data.attendee_provider_id ?? undefined,
    };
  } catch (err) {
    console.error("Failed to fetch chat info:", err);
    return {};
  }
}

async function resolvePersonFromThread(
  userId: string,
  threadId: string
): Promise<{ person_id: string; identity_id: string; message_type: string } | null> {
  const { data } = await supabase
    .from("messages")
    .select("person_id, identity_id, message_type")
    .eq("user_id", userId)
    .eq("thread_id", threadId)
    .not("person_id", "is", null)
    .order("sent_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

async function findOrCreatePerson(
  userId: string,
  channel: string,
  handle: string,
  displayName: string,
  unipileAccountId: string
): Promise<{ personId: string; identityId: string }> {
  const normalizedHandle = normalizeHandle(handle, channel);

  const { data: existingIdentity } = await supabase
    .from("identities")
    .select("id, person_id")
    .eq("channel", channel)
    .eq("handle", normalizedHandle)
    .eq("user_id", userId)
    .limit(1)
    .single();

  if (existingIdentity) {
    if (displayName && displayName !== "Unknown" && displayName !== "unknown") {
      await supabase
        .from("persons")
        .update({ display_name: displayName })
        .eq("id", existingIdentity.person_id)
        .eq("display_name", "Unknown");
    }
    return {
      personId: existingIdentity.person_id,
      identityId: existingIdentity.id,
    };
  }

  // Fallback: match by raw handle variants (backfill may have stored un-normalized)
  const rawVariants = [handle];
  if (handle !== normalizedHandle) rawVariants.push(normalizedHandle);
  const stripped = handle.replace(/^\+/, "");
  if (!rawVariants.includes(stripped)) rawVariants.push(stripped);
  const withSuffix = stripped + "@s.whatsapp.net";
  if (channel === "whatsapp" && !rawVariants.includes(withSuffix)) rawVariants.push(withSuffix);

  const { data: variantIdentity } = await supabase
    .from("identities")
    .select("id, person_id")
    .eq("channel", channel)
    .in("handle", rawVariants)
    .eq("user_id", userId)
    .limit(1)
    .single();

  if (variantIdentity) {
    if (displayName && displayName !== "Unknown" && displayName !== "unknown") {
      await supabase
        .from("persons")
        .update({ display_name: displayName })
        .eq("id", variantIdentity.person_id)
        .eq("display_name", "Unknown");
    }
    return {
      personId: variantIdentity.person_id,
      identityId: variantIdentity.id,
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
      handle: normalizedHandle,
      display_name: displayName,
      unipile_account_id: unipileAccountId,
      user_id: userId,
    })
    .select("id")
    .single();

  if (identityError) {
    // UNIQUE constraint race — another webhook created this identity first
    const { data: raceIdentity } = await supabase
      .from("identities")
      .select("id, person_id")
      .eq("channel", channel)
      .eq("handle", normalizedHandle)
      .eq("user_id", userId)
      .limit(1)
      .single();

    if (raceIdentity) {
      // Clean up the orphaned person we just created
      await supabase.from("persons").delete().eq("id", person.id);
      return { personId: raceIdentity.person_id, identityId: raceIdentity.id };
    }
    throw new Error(`Failed to create identity: ${identityError?.message}`);
  }

  return { personId: person.id, identityId: identity!.id };
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
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": GEMINI_API_KEY,
        },
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
