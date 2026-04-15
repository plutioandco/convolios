const encoder = new TextEncoder();

export async function verifyWebhookSecret(
  header: string,
  secret: string,
): Promise<boolean> {
  if (!secret || !header) return false;

  const a = encoder.encode(header);
  const b = encoder.encode(secret);

  if (a.byteLength !== b.byteLength) return false;

  const keyData = crypto.getRandomValues(new Uint8Array(32));
  const key = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const [sigA, sigB] = await Promise.all([
    crypto.subtle.sign("HMAC", key, a),
    crypto.subtle.sign("HMAC", key, b),
  ]);

  const viewA = new Uint8Array(sigA);
  const viewB = new Uint8Array(sigB);
  let diff = 0;
  for (let i = 0; i < viewA.length; i++) {
    diff |= viewA[i] ^ viewB[i];
  }
  return diff === 0;
}
