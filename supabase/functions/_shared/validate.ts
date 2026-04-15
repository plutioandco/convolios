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
