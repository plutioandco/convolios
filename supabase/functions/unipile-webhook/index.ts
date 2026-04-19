import { createClient } from "https://esm.sh/@supabase/supabase-js@2.101.1";
import { jsonResponse } from "../_shared/cors.ts";
import { CHANNEL_MAP } from "../_shared/channel-map.ts";
import { verifyWebhookSecret } from "../_shared/auth.ts";
import { validateWebhookBase, validateMessageEvent, validateEmailEvent } from "../_shared/validate.ts";
import { initLogger, log } from "../_shared/logging.ts";

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
  const isLid = raw.includes("@lid");
  let h = raw
    .replace(/@s\.whatsapp\.net$/, "")
    .replace(/@lid$/, "")
    .replace(/@c\.us$/, "")
    .trim();
  if (channel === "whatsapp" && !isLid && /^\d+$/.test(h) && h.length <= 15) {
    h = `+${h}`;
  }
  if (channel === "linkedin") {
    h = h.replace(/^https?:\/\/(www\.)?linkedin\.com\/in\//i, "").replace(/\/$/, "");
  }
  if ((channel === "imessage" || channel === "sms") && h.length > 0) {
    const digits = h.replace(/\D/g, "");
    if (digits.length >= 7 && digits.length <= 15) {
      h = `+${digits}`;
    }
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
    .maybeSingle();
}

Deno.serve(async (req: Request) => {
  initLogger("unipile-webhook");

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
  if (!await verifyWebhookSecret(authHeader, WEBHOOK_SECRET)) {
    log.error("Webhook auth failed");
    return new Response("Unauthorized", { status: 401 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: "invalid_json" }, 400);
  }

  const baseCheck = validateWebhookBase(payload);
  if (!baseCheck.valid) {
    return jsonResponse({ ok: false, error: baseCheck.error }, 400);
  }

  const event = payload.event as string;

  if (event === "message_received") {
    const check = validateMessageEvent(payload);
    if (!check.valid) return jsonResponse({ ok: false, error: check.error }, 400);
  } else if (event === "mail_received" || event === "mail_sent") {
    const check = validateEmailEvent(payload);
    if (!check.valid) return jsonResponse({ ok: false, error: check.error }, 400);
  }

  try {
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
        log.warn("Unhandled webhook event", { event });
        return jsonResponse({ ok: true, skipped: event });
    }
  } catch (err) {
    log.error("Webhook handler error", { error: String(err) });
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
    // Rust `persist_outbound` writes the row with a placeholder attachments
    // blob (`[{ name, mimetype }]`, no id) because the send response doesn't
    // expose attachment IDs. The webhook payload IS authoritative — upgrade
    // the row so the UI can fetch and render the media.
    if ((payload.attachments?.length ?? 0) > 0) {
      const attachments = await enrichAttachments(
        payload.attachments ?? [], payload.message_id,
      );
      await supabase
        .from("messages")
        .update({ attachments })
        .eq("id", existing.id);
    }
    return jsonResponse({ ok: true, skipped: "already_persisted" });
  }

  const [chatInfo, accountResult, fullMsg] = await Promise.all([
    fetchChatInfo(payload.chat_id),
    resolveAccount(payload.account_id),
    fetchFullMessage(payload.message_id),
  ]);

  const account = accountResult.data;
  if (!account) {
    log.error("No connected account found", { account_id: payload.account_id });
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
    direction = resolveSenderDirection(fullMsg, payload);

    if (isGroup) {
      const groupHandle = chatInfo.provider_id ?? payload.chat_id;
      const groupName = chatInfo.name ?? "Group Chat";
      const result = await findOrCreatePerson(
        userId, channel, groupHandle, groupName, payload.account_id, direction
      );
      personId = result.personId;
      identityId = result.identityId;
    } else {
      // Verify the cached person isn't the account owner (misattributed).
      // If the identity handle matches the account owner's user_id or the
      // sender's provider_id on an outbound message, re-resolve via chat_attendees.
      let needsReResolve = false;
      if (threadLookup.identity_id) {
        const { data: cachedIdentity } = await supabase
          .from("identities")
          .select("handle")
          .eq("id", threadLookup.identity_id)
          .maybeSingle();
        if (cachedIdentity) {
          const cachedHandle = cachedIdentity.handle?.toLowerCase() ?? "";
          const ownerUserId = (payload.account_info?.user_id ?? "").toLowerCase();
          const senderPid = (payload.sender?.attendee_provider_id ?? "").toLowerCase();
          // If cached handle matches the account owner or sender on outbound, it's wrong
          if (
            (ownerUserId && cachedHandle === ownerUserId) ||
            (direction === "outbound" && senderPid && cachedHandle === senderPid)
          ) {
            needsReResolve = true;
          }
        }
      }

      if (needsReResolve) {
        const attendees = await fetchChatAttendees(payload.chat_id);
        const otherParty = attendees.find((a) => {
          const self = typeof a.is_self === "boolean" ? a.is_self
            : (typeof a.is_self === "number" ? a.is_self === 1 : false);
          return !self;
        });
        if (otherParty) {
          const otherHandle = otherParty.public_identifier
            ?? otherParty.identifier
            ?? otherParty.provider_id
            ?? "";
          const contactHandle = normalizeHandle(
            otherHandle || chatInfo.attendee_provider_id || payload.chat_id,
            channel
          );
          const contactName = otherParty.display_name ?? otherParty.name ?? chatInfo.name ?? contactHandle;
          const result = await findOrCreatePerson(
            userId, channel, contactHandle, contactName, payload.account_id, direction
          );
          personId = result.personId;
          identityId = result.identityId;
          // Re-assign existing messages in this thread to the correct person.
          // Uses an RPC to bypass trg_prevent_person_id_change trigger.
          await supabase.rpc("reassign_thread_person", {
            p_user_id: userId,
            p_thread_id: payload.chat_id,
            p_from_person_id: threadLookup.person_id,
            p_to_person_id: personId,
            p_to_identity_id: identityId,
          });
        } else {
          personId = threadLookup.person_id;
          identityId = threadLookup.identity_id;
        }
      } else {
        personId = threadLookup.person_id;
        identityId = threadLookup.identity_id;
      }
    }
    messageType = isGroup ? "group" : threadLookup.message_type;
  } else {
    const isSender = resolveSenderDirection(fullMsg, payload) === "outbound";
    direction = isSender ? "outbound" : "inbound";
    messageType = isGroup ? "group" : "dm";

    let contactHandle: string;
    let contactName: string;

    if (isGroup) {
      contactHandle = chatInfo.provider_id ?? payload.chat_id;
      contactName = chatInfo.name ?? "Group Chat";
    } else {
      // For DMs, always use chat_attendees with is_self=false as the
      // authoritative source for the other party. The webhook payload's
      // attendees and chatInfo.attendee_provider_id are unreliable —
      // on Instagram, the sender's attendee_provider_id differs from
      // account_info.user_id, causing the account owner to be treated
      // as a contact.
      const attendees = await fetchChatAttendees(payload.chat_id);
      const otherParty = attendees.find((a) => {
        const self = typeof a.is_self === "boolean" ? a.is_self
          : (typeof a.is_self === "number" ? a.is_self === 1 : false);
        return !self;
      });

      if (otherParty) {
        const otherHandle = otherParty.public_identifier
          ?? otherParty.identifier
          ?? otherParty.provider_id
          ?? "";
        contactHandle = normalizeHandle(
          otherHandle || chatInfo.attendee_provider_id || payload.chat_id,
          channel
        );
        contactName = otherParty.display_name ?? otherParty.name ?? chatInfo.name ?? contactHandle;
      } else if (isSender) {
        // Fallback: no attendees returned, use webhook payload
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
    }

    const result = await findOrCreatePerson(
      userId, channel, contactHandle, contactName, payload.account_id, direction
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

  // Outbound dedup — Rust persist_outbound writes a stub with its own
  // external_id, and the webhook then arrives with a different external_id
  // for the same physical message. The provider_id is the underlying network's
  // native message ID and is stable across both paths; it's the correct dedup
  // key. We fall back to a content+window match only when provider_id is
  // absent on the incoming payload (some channels don't echo it via webhook).
  if (direction === "outbound") {
    let existingDup: { id: string } | null = null;

    const incomingProviderId = fullMsg?.provider_id ?? null;
    if (incomingProviderId) {
      const { data } = await supabase
        .from("messages")
        .select("id")
        .eq("user_id", userId)
        .eq("person_id", personId)
        .eq("direction", "outbound")
        .eq("provider_id", incomingProviderId)
        .limit(1)
        .maybeSingle();
      existingDup = data ?? null;
    }

    if (!existingDup) {
      const ts = new Date(payload.timestamp).getTime();
      const windowStart = new Date(ts - 10000).toISOString();
      const windowEnd = new Date(ts + 10000).toISOString();

      const { data } = await supabase
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
      existingDup = data ?? null;
    }

    if (existingDup) {
      const update: Record<string, unknown> = {
        external_id: payload.message_id,
        thread_id: payload.chat_id,
        identity_id: identityId,
        unipile_account_id: payload.account_id,
        seen: fullMsg?.seen ?? false,
        delivered: fullMsg?.delivered ?? false,
        provider_id: fullMsg?.provider_id ?? null,
        chat_provider_id: fullMsg?.chat_provider_id ?? null,
      };
      // Rust persist_outbound writes placeholder attachments without IDs —
      // overwrite with the webhook's authoritative metadata so media renders.
      if ((payload.attachments?.length ?? 0) > 0) {
        update.attachments = await enrichAttachments(
          payload.attachments ?? [], payload.message_id,
        );
      }
      await supabase
        .from("messages")
        .update(update)
        .eq("id", existingDup.id);
      return jsonResponse({
        ok: true,
        merged: incomingProviderId ? "outbound_provider_id" : "outbound_content_dedup",
      });
    }
  }

  const senderName = payload.sender?.attendee_name
    ?? payload.sender?.attendee_provider_id
    ?? "Unknown";

  const attachments = await enrichAttachments(
    payload.attachments ?? [], payload.message_id
  );

  const { data: upserted, error: msgError } = await supabase.from("messages").upsert(
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
    { onConflict: "user_id,external_id", ignoreDuplicates: false }
  ).select("id, user_id, person_id, direction, sent_at").single();

  if (msgError) {
    log.error("Insert message error", {
      code: msgError.code,
      message: msgError.message,
      details: msgError.details,
      hint: msgError.hint,
      external_id: payload.message_id,
      channel,
      user_id: userId,
    });
    return jsonResponse(
      { ok: false, error: "insert_failed", code: msgError.code ?? null },
      500
    );
  }

  const response = jsonResponse({ ok: true, direction, channel, person_id: personId });

  if (GEMINI_API_KEY && payload.message && upserted) {
    extractMessageContext(upserted, payload.message).catch((err) => {
      log.error("Extract failed", { message_id: payload.message_id, error: String(err) });
    });
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
      log.error("Email fetch failed", { status: res.status });
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
      userId, "email", otherAddr, otherName, accountId, direction as "inbound" | "outbound"
    );

    if (direction === "outbound") {
      const allRecipients = [
        ...(em.to_attendees ?? []).slice(1),
        ...(em.cc_attendees ?? []),
        ...(em.bcc_attendees ?? []),
      ].slice(0, 50);
      await Promise.allSettled(
        allRecipients.map((r) => {
          const addr = r?.identifier?.toLowerCase();
          if (!addr || addr === otherAddr) return Promise.resolve();
          return findOrCreatePerson(userId, "email", addr, r?.display_name ?? addr, accountId, "outbound")
            .catch((err) => { log.warn("Email recipient creation failed", { addr, error: String(err) }); });
        })
      );
    }

    const folders = Array.isArray(em.folders) ? em.folders : [];
    const folder = folders[0] ?? null;
    const isStarred = folders.some((f: string) =>
      f.toUpperCase() === "STARRED" || f.toUpperCase() === "FLAGGED"
    );

    const { data: upserted, error: msgError } = await supabase.from("messages").upsert(
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
        flagged_at: isStarred ? new Date().toISOString() : null,
      },
      { onConflict: "user_id,external_id", ignoreDuplicates: false }
    ).select("id, user_id, person_id, direction, sent_at").single();

    if (msgError) {
      log.error("Email insert error", {
        code: msgError.code,
        message: msgError.message,
        details: msgError.details,
        hint: msgError.hint,
        external_id: emailId,
        user_id: userId,
      });
      return jsonResponse(
        { ok: false, error: "insert_failed", code: msgError.code ?? null },
        500
      );
    }

    if (GEMINI_API_KEY && em.subject && upserted) {
      const combined = `${em.subject}\n${(em.body_plain ?? "").slice(0, 1000)}`;
      await extractMessageContext(upserted, combined);
    }

    return jsonResponse({ ok: true, direction, channel: "email", person_id: personId });
  } catch (err) {
    log.error("Email handler error", { error: String(err) });
    return jsonResponse({ ok: false, error: "internal_error" }, 500);
  }
}

// ─── MUTATION EVENTS ────────────────────────────────────────────────────────

async function handleMessageReaction(payload: Record<string, unknown>): Promise<Response> {
  const messageId = (payload.message_id ?? "") as string;
  if (!messageId) return jsonResponse({ ok: true, skipped: "no_message_id" });

  // GET /messages/{id} is the source of truth — the webhook event may lose
  // reactions that were merged server-side before we processed it.
  const full = await fetchFullMessage(messageId);
  if (!full) return jsonResponse({ ok: true, skipped: "refetch_failed" });
  const reactions = Array.isArray(full.reactions) ? full.reactions : [];

  const { error } = await supabase
    .from("messages")
    .update({ reactions })
    .eq("external_id", messageId);

  if (error) {
    log.error("Reaction update error", {
      code: error.code, message: error.message, details: error.details,
    });
    return jsonResponse({ ok: false, error: "reaction_update_failed" }, 500);
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

  // Refetch the full message — the webhook payload's body may lag server state
  // if multiple edits coalesced.
  const full = await fetchFullMessage(messageId);
  const body = (full?.text ?? payload.message ?? payload.text ?? "") as string;

  const update: Record<string, unknown> = { edited: true };
  if (body) update.body_text = body;

  const { error } = await supabase
    .from("messages")
    .update(update)
    .eq("external_id", messageId);

  if (error) {
    log.error("Edit update error", {
      code: error.code, message: error.message, details: error.details,
    });
    return jsonResponse({ ok: false, error: "edit_update_failed" }, 500);
  }

  return jsonResponse({ ok: true, event: "edited" });
}

async function handleMessageDeleted(payload: Record<string, unknown>): Promise<Response> {
  const messageId = (payload.message_id ?? "") as string;
  if (!messageId) return jsonResponse({ ok: true, skipped: "no_message_id" });

  const { error } = await supabase
    .from("messages")
    .update({ deleted: true, deleted_at: new Date().toISOString() })
    .eq("external_id", messageId);

  if (error) {
    log.error("Message soft-delete error", { error: error.message });
    return jsonResponse({ ok: false, error: "delete_update_failed" }, 500);
  }

  return jsonResponse({ ok: true, event: "deleted" });
}

async function handleMessageDelivered(payload: Record<string, unknown>): Promise<Response> {
  const messageId = (payload.message_id ?? "") as string;
  if (!messageId) return jsonResponse({ ok: true, skipped: "no_message_id" });

  // Refetch for the authoritative delivered/seen snapshot — in some channels
  // the delivered and seen flags land within milliseconds of each other and
  // arrive on separate webhook events.
  const full = await fetchFullMessage(messageId);
  const update: Record<string, unknown> = { delivered: true };
  if (full) {
    if (typeof full.seen === "boolean") update.seen = full.seen;
    if (typeof full.delivered === "boolean") update.delivered = full.delivered;
  }

  const { error } = await supabase
    .from("messages")
    .update(update)
    .eq("external_id", messageId);

  if (error) {
    log.error("Delivered update error", {
      code: error.code, message: error.message, details: error.details,
    });
  }

  return jsonResponse({ ok: true, event: "delivered" });
}

async function handleMailMoved(payload: Record<string, unknown>): Promise<Response> {
  const emailId = (payload.email_id ?? payload.message_id ?? "") as string;
  if (!emailId) return jsonResponse({ ok: true, skipped: "no_email_id" });

  const folder = (payload.folder ?? payload.destination ?? "") as string;
  const update: Record<string, unknown> = {};
  if (folder) update.folder = folder;

  if (UNIPILE_API_KEY && UNIPILE_API_URL) {
    try {
      const res = await fetch(
        `${UNIPILE_API_URL}/api/v1/emails/${emailId}`,
        { headers: { "X-API-KEY": UNIPILE_API_KEY } }
      );
      if (res.ok) {
        const em = await res.json();
        const folders = Array.isArray(em.folders) ? em.folders : [];
        const isStarred = folders.some((f: string) =>
          f.toUpperCase() === "STARRED" || f.toUpperCase() === "FLAGGED"
        );
        update.flagged_at = isStarred ? new Date().toISOString() : null;

        if (!folder && folders.length > 0) {
          update.folder = folders[0];
        }
      }
    } catch (err) {
      log.warn("mail_moved: email fetch failed", { emailId, error: String(err) });
    }
  }

  if (Object.keys(update).length > 0) {
    await supabase
      .from("messages")
      .update(update)
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
    log.error("Account status update error", { error: error.message });
    return jsonResponse({ ok: false, error: "status_update_failed" }, 500);
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
    log.error("Failed to enrich attachments", { error: String(err) });
  }

  return webhookAtts;
}

async function fetchChatAttendees(
  chatId: string
): Promise<Array<{ id?: string; identifier?: string; provider_id?: string; name?: string; display_name?: string; is_self?: boolean; picture_url?: string; public_identifier?: string }>> {
  if (!UNIPILE_API_KEY) return [];
  try {
    const res = await fetch(
      `${UNIPILE_API_URL}/api/v1/chat_attendees?chat_id=${chatId}`,
      { headers: { "X-API-KEY": UNIPILE_API_KEY } }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return data.items ?? [];
  } catch (err) {
    log.error("Failed to fetch chat attendees", { error: String(err) });
    return [];
  }
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
    log.error("Failed to fetch chat info", { error: String(err) });
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
  unipileAccountId: string,
  direction: "inbound" | "outbound" = "inbound"
): Promise<{ personId: string; identityId: string }> {
  const normalizedHandle = normalizeHandle(handle, channel);

  const { data: existingIdentity } = await supabase
    .from("identities")
    .select("id, person_id")
    .eq("channel", channel)
    .eq("handle", normalizedHandle)
    .eq("user_id", userId)
    .limit(1)
    .maybeSingle();

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
    .maybeSingle();

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
      status: direction === "outbound" ? "approved" : "pending",
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
      .maybeSingle();

    if (raceIdentity) {
      // Clean up the orphaned person we just created
      await supabase.from("persons").delete().eq("id", person.id);
      return { personId: raceIdentity.person_id, identityId: raceIdentity.id };
    }
    throw new Error(`Failed to create identity: ${identityError?.message}`);
  }

  return { personId: person.id, identityId: identity!.id };
}

// Structured JSON output via Gemini's responseSchema. Returns triage +
// extracted unanswered questions + commitments (both directions) in a single
// call. Consolidating avoids a second round-trip for AI enrichment.
const GEMINI_SCHEMA = {
  type: "object",
  properties: {
    triage: {
      type: "string",
      enum: ["urgent", "human", "newsletter", "notification", "noise"],
      description: "Category of the message.",
    },
    their_questions: {
      type: "array",
      description:
        "Direct questions asked by them that need an answer. Empty if no explicit questions or if the message is outbound.",
      items: { type: "string" },
    },
    their_commitments: {
      type: "array",
      description:
        "Things they explicitly promised to do (e.g. 'I will send the doc tomorrow'). Empty if outbound.",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          due_hint: { type: "string", description: "Natural-language date/time if mentioned, else empty string." },
        },
        required: ["text", "due_hint"],
      },
    },
    my_commitments: {
      type: "array",
      description:
        "Things I explicitly promised to do. Populate only for outbound messages. Empty if inbound.",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          due_hint: { type: "string", description: "Natural-language date/time if mentioned, else empty string." },
        },
        required: ["text", "due_hint"],
      },
    },
  },
  required: ["triage", "their_questions", "their_commitments", "my_commitments"],
} as const;

type ExtractedContext = {
  triage: string;
  their_questions: string[];
  their_commitments: Array<{ text: string; due_hint: string }>;
  my_commitments: Array<{ text: string; due_hint: string }>;
};

async function extractMessageContext(
  messageRow: { id: string; user_id: string; person_id: string | null; direction: string; sent_at: string },
  text: string,
) {
  if (!messageRow.person_id) return;

  const directionLabel = messageRow.direction === "inbound" ? "INBOUND (from them)" : "OUTBOUND (from me)";

  const prompt = `You analyse a single message in a conversation and return strict JSON per the provided schema.

Direction: ${directionLabel}

Rules:
- triage: one of urgent | human | newsletter | notification | noise.
  urgent = needs a fast reply (money, deadlines, explicit questions needing fast answers).
  human = real person / real conversation, not time-sensitive.
  newsletter = mass email, marketing.
  notification = automated receipt / alert / shipping update.
  noise = spam or irrelevant.
- their_questions: include ONLY if direction is INBOUND. Verbatim or lightly cleaned questions asked of me.
  Drop rhetorical questions. At most 3 items. Empty array if none.
- their_commitments: include ONLY if direction is INBOUND. Things they explicitly promised.
  Empty array if none.
- my_commitments: include ONLY if direction is OUTBOUND. Things I explicitly promised.
  Empty array if none.
- due_hint: empty string if no date/time mentioned.

Message:
"""
${text.slice(0, 1200)}
"""`;

  try {
    const res = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": GEMINI_API_KEY,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            maxOutputTokens: 512,
            temperature: 0,
            responseMimeType: "application/json",
            responseSchema: GEMINI_SCHEMA,
          },
        }),
      },
    );

    if (!res.ok) {
      log.error("Gemini extract error", { status: res.status });
      return;
    }

    const data = await res.json();
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";

    let parsed: ExtractedContext;
    try {
      parsed = JSON.parse(raw) as ExtractedContext;
    } catch (err) {
      log.error("Gemini JSON parse failed", { error: String(err), raw: raw.slice(0, 200) });
      return;
    }

    const triage = ["urgent", "human", "newsletter", "notification", "noise"].includes(parsed.triage)
      ? parsed.triage
      : "unclassified";

    await supabase.from("messages").update({ triage }).eq("id", messageRow.id);

    // Webhook retries re-run extraction on the same message. Dedup via the
    // (message_id, …) unique constraints added in migration 058 so retries
    // are no-ops instead of duplicating rows in the thread banner.
    if (messageRow.direction === "inbound") {
      const questions = (parsed.their_questions ?? [])
        .filter((q): q is string => typeof q === "string" && q.trim().length > 0)
        .slice(0, 3);
      if (questions.length > 0) {
        await supabase.from("unanswered_questions").upsert(
          questions.map((q) => ({
            user_id: messageRow.user_id,
            person_id: messageRow.person_id,
            message_id: messageRow.id,
            question_text: q.trim(),
            asked_at: messageRow.sent_at,
          })),
          { onConflict: "message_id,question_text", ignoreDuplicates: true },
        );
      }

      const commitments = (parsed.their_commitments ?? [])
        .filter((c) => c && typeof c.text === "string" && c.text.trim().length > 0)
        .slice(0, 5);
      if (commitments.length > 0) {
        await supabase.from("commitments").upsert(
          commitments.map((c) => ({
            user_id: messageRow.user_id,
            person_id: messageRow.person_id,
            message_id: messageRow.id,
            direction: "theirs",
            commitment_text: c.text.trim(),
            due_hint: c.due_hint?.trim() || null,
          })),
          { onConflict: "message_id,direction,commitment_text", ignoreDuplicates: true },
        );
      }
    } else {
      const myCommitments = (parsed.my_commitments ?? [])
        .filter((c) => c && typeof c.text === "string" && c.text.trim().length > 0)
        .slice(0, 5);
      if (myCommitments.length > 0) {
        await supabase.from("commitments").upsert(
          myCommitments.map((c) => ({
            user_id: messageRow.user_id,
            person_id: messageRow.person_id,
            message_id: messageRow.id,
            direction: "mine",
            commitment_text: c.text.trim(),
            due_hint: c.due_hint?.trim() || null,
          })),
          { onConflict: "message_id,direction,commitment_text", ignoreDuplicates: true },
        );
      }
    }
  } catch (err) {
    log.error("Context extraction failed", { error: String(err) });
  }
}

