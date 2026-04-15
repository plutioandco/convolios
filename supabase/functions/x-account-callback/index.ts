import { encryptJson } from "../_shared/crypto.ts";

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !state) {
    return errorPage("Authorization was cancelled or failed. Please try again.");
  }

  try {
    const sbUrl = Deno.env.get("SUPABASE_URL");
    const sbKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!sbUrl || !sbKey) {
      return errorPage("Server configuration error. Please contact support.");
    }
    const clientId = Deno.env.get("X_API_CLIENT_ID");
    const clientSecret = Deno.env.get("X_API_CLIENT_SECRET");

    if (!clientId || !clientSecret) {
      return errorPage("X API credentials not configured.");
    }

    const stateResp = await fetch(
      `${sbUrl}/rest/v1/x_oauth_state?state=eq.${encodeURIComponent(state)}&select=code_verifier,user_id`,
      {
        headers: {
          apikey: sbKey,
          Authorization: `Bearer ${sbKey}`,
        },
      },
    );

    if (!stateResp.ok) {
      return errorPage("Failed to verify OAuth state. Please try again.");
    }

    const rows = await stateResp.json();
    if (!Array.isArray(rows) || !rows.length) {
      return errorPage("Invalid or expired OAuth state. Please try again.");
    }

    const { code_verifier, user_id } = rows[0];

    const redirectUri = `${sbUrl}/functions/v1/x-account-callback`;
    const basicAuth = btoa(`${clientId}:${clientSecret}`);

    const tokenResp = await fetch("https://api.twitter.com/2/oauth2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${basicAuth}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        code_verifier,
      }),
    });

    const tokenBody = await tokenResp.json();

    if (!tokenResp.ok) {
      console.error("[x-callback] token exchange failed:", tokenBody);
      return errorPage("Token exchange failed. Please try again.");
    }

    await fetch(`${sbUrl}/rest/v1/x_oauth_state?state=eq.${encodeURIComponent(state)}`, {
      method: "DELETE",
      headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` },
    });

    const accessToken = tokenBody.access_token;
    const refreshToken = tokenBody.refresh_token ?? "";

    const meResp = await fetch(
      "https://api.twitter.com/2/users/me?user.fields=name,username,profile_image_url",
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!meResp.ok) {
      console.error("[x-callback] /2/users/me failed:", meResp.status);
      return errorPage("Failed to fetch your X profile. Please try again.");
    }
    const meBody = await meResp.json();
    const xData = meBody.data ?? {};
    const xUserId = xData.id ?? "";
    const displayName = xData.name ?? null;
    const username = xData.username ?? null;

    const now = new Date().toISOString();
    const plainParams = {
      access_token: accessToken,
      refresh_token: refreshToken,
      x_user_id: xUserId,
    };
    let connectionParams: unknown = plainParams;
    try {
      connectionParams = { encrypted: await encryptJson(plainParams) };
    } catch {
      // TOKEN_ENCRYPTION_KEY not configured — store plaintext (backward compat)
    }

    const accountRow = {
      user_id,
      provider: "x",
      channel: "x",
      account_id: xUserId,
      status: "active",
      display_name: displayName,
      username,
      provider_type: "X",
      connection_params: connectionParams,
      last_synced_at: now,
      updated_at: now,
    };

    const storeResp = await fetch(
      `${sbUrl}/rest/v1/connected_accounts?on_conflict=user_id,provider,account_id`,
      {
        method: "POST",
        headers: {
          apikey: sbKey,
          Authorization: `Bearer ${sbKey}`,
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates",
        },
        body: JSON.stringify(accountRow),
      },
    );

    if (!storeResp.ok && storeResp.status !== 409) {
      const errText = await storeResp.text();
      console.error("[x-callback] store failed:", errText);
      return errorPage("Failed to save account. Please try again.");
    }

    return successPage(username ?? "your account");
  } catch (e) {
    console.error("[x-callback] unexpected error:", e);
    return errorPage("Something went wrong. Please try again.");
  }
});

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function errorPage(message: string) {
  const safe = escapeHtml(message);
  return new Response(
    `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
    <body style="background:#1e1f22;color:#f2f3f5;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
      <div style="text-align:center">
        <h2 style="color:#ed4245">Connection Failed</h2>
        <p>${safe}</p>
        <p style="margin-top:24px;color:#999;font-size:13px">You can close this tab and try again in Convolios.</p>
      </div>
    </body></html>`,
    { status: 400, headers: { "Content-Type": "text/html" } },
  );
}

function successPage(username: string) {
  const safe = escapeHtml(username);
  return new Response(
    `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
    <body style="background:#1e1f22;color:#f2f3f5;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
      <div style="text-align:center">
        <div style="font-size:48px;margin-bottom:16px">&#10003;</div>
        <h2 style="color:#57f287">X Account Connected!</h2>
        <p>@${safe} is now linked to Convolios.</p>
        <p id="hint" style="margin-top:24px;color:#999;font-size:13px">Closing this tab...</p>
      </div>
      <script>
        try { window.close(); } catch(_){}
        setTimeout(function(){
          try { window.close(); } catch(_){}
          document.getElementById("hint").textContent = "You can close this tab and return to the app.";
        }, 500);
      </script>
    </body></html>`,
    { status: 200, headers: { "Content-Type": "text/html" } },
  );
}
