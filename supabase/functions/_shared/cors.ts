const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

export function webhookHeaders(): Record<string, string> {
  return { "Content-Type": "application/json" };
}

export function appCorsHeaders(origin?: string | null): Record<string, string> {
  if (!origin || ALLOWED_ORIGINS.length === 0 || !ALLOWED_ORIGINS.includes(origin)) {
    return { "Content-Type": "application/json" };
  }

  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };
}

export function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = webhookHeaders(),
): Response {
  return new Response(JSON.stringify(body), { status, headers });
}
