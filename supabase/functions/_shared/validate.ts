function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

export function validateWebhookBase(payload: unknown): ValidationResult {
  if (!isObject(payload)) {
    return { valid: false, error: "payload must be an object" };
  }
  if (!isNonEmptyString(payload.event)) {
    return { valid: false, error: "missing or empty event field" };
  }
  return { valid: true };
}

export function validateMessageEvent(payload: Record<string, unknown>): ValidationResult {
  if (!isNonEmptyString(payload.account_id)) {
    return { valid: false, error: "missing account_id" };
  }
  if (!isNonEmptyString(payload.message_id)) {
    return { valid: false, error: "missing message_id" };
  }
  if (!isNonEmptyString(payload.chat_id)) {
    return { valid: false, error: "missing chat_id" };
  }
  return { valid: true };
}

export function validateEmailEvent(payload: Record<string, unknown>): ValidationResult {
  if (!isNonEmptyString(payload.account_id)) {
    return { valid: false, error: "missing account_id" };
  }
  const emailId = payload.email_id ?? payload.message_id;
  if (!isNonEmptyString(emailId)) {
    return { valid: false, error: "missing email_id or message_id" };
  }
  return { valid: true };
}

// Shape posted by the Convolios desktop app's on-device bridge sidecar (e.g.
// the Meta bridge wrapping mautrix-meta's messagix for Instagram/Messenger).
// The sidecar authenticates via a Supabase user JWT and emits normalized
// events in this flat shape — fields mirror the Unipile webhook where
// possible so downstream persistence logic stays shared.
export function validateOnDeviceMessageEvent(payload: Record<string, unknown>): ValidationResult {
  if (!isNonEmptyString(payload.account_id)) {
    return { valid: false, error: "missing account_id" };
  }
  if (!isNonEmptyString(payload.channel)) {
    return { valid: false, error: "missing channel" };
  }
  if (!isNonEmptyString(payload.external_id)) {
    return { valid: false, error: "missing external_id" };
  }
  if (!isNonEmptyString(payload.thread_id)) {
    return { valid: false, error: "missing thread_id" };
  }
  if (payload.direction !== "inbound" && payload.direction !== "outbound") {
    return { valid: false, error: "direction must be 'inbound' or 'outbound'" };
  }
  if (!isNonEmptyString(payload.sent_at)) {
    return { valid: false, error: "missing sent_at" };
  }
  if (!isObject(payload.other_party)) {
    return { valid: false, error: "missing other_party object" };
  }
  if (!isNonEmptyString((payload.other_party as Record<string, unknown>).handle)) {
    return { valid: false, error: "missing other_party.handle" };
  }
  return { valid: true };
}

export function validateAccountCallbackPayload(payload: unknown): ValidationResult {
  if (!isObject(payload)) {
    return { valid: false, error: "payload must be an object" };
  }
  if (!isNonEmptyString(payload.account_id)) {
    return { valid: false, error: "missing account_id" };
  }
  if (!isNonEmptyString(payload.name)) {
    return { valid: false, error: "missing name (user_id)" };
  }
  return { valid: true };
}
