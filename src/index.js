// ============================================================
// REPORTLI AI — DODO PAYMENTS WORKER
// ============================================================
// Routes:
//   GET  /health
//   POST /checkout
//   POST /webhook
//   GET  /return
//
// Frontend POST /checkout body:
// {
//   "user_id": "SUPABASE_USER_ID",
//   "plan": "premium"
// }
//
// Required secrets:
//   SUPABASE_SERVICE_ROLE_KEY
//   DODO_PAYMENTS_API_KEY
//   DODO_PAYMENTS_WEBHOOK_KEY
//
// Required variables:
//   SUPABASE_URL
//   DODO_PAYMENTS_PRODUCT_ID
//   DODO_PAYMENTS_ENVIRONMENT
//   FRONTEND_SETTINGS_URL
//
// IMPORTANT:
// - Never expose server secrets to the frontend.
// - Never trust user_id without checking the access token.
// - Never grant credits based on a browser redirect.
// ============================================================

const LIVE_API = "https://live.dodopayments.com";
const TEST_API = "https://test.dodopayments.com";

const ALLOWED_ORIGIN = "https://reportliai.sbs";

// ============================================================
// MAIN ROUTER
// ============================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }

    try {
      if (url.pathname === "/health" && request.method === "GET") {
        return json({
          ok: true,
          worker: "reportli-dodo-payments",
        });
      }

      if (url.pathname === "/checkout" && request.method === "POST") {
        return await createCheckout(request, env);
      }

      if (url.pathname === "/webhook" && request.method === "POST") {
        return await handleWebhook(request, env);
      }

      if (url.pathname === "/return" && request.method === "GET") {
        return handleReturn(env);
      }

      return json({
        ok: false,
        error: "Endpoint not found",
      }, 404);

    } catch (error) {
      // Log details in Cloudflare, but do not expose secrets.
      console.error("Worker error:", error?.stack || error?.message || error);

      return json({
        ok: false,
        error: error?.message || "Unknown internal error",
      }, 500);
    }
  },
};

// ============================================================
// RESPONSE HELPERS
// ============================================================

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders(),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

// ============================================================
// CONFIGURATION
// ============================================================

function validateConfig(env) {
  const required = [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "DODO_PAYMENTS_API_KEY",
    "DODO_PAYMENTS_WEBHOOK_KEY",
    "DODO_PAYMENTS_PRODUCT_ID",
    "DODO_PAYMENTS_ENVIRONMENT",
    "FRONTEND_SETTINGS_URL",
  ];

  for (const name of required) {
    if (!env[name] || !String(env[name]).trim()) {
      throw new Error(`Missing Worker configuration: ${name}`);
    }
  }

  if (
    env.DODO_PAYMENTS_ENVIRONMENT !== "live_mode" &&
    env.DODO_PAYMENTS_ENVIRONMENT !== "test_mode"
  ) {
    throw new Error(
      "DODO_PAYMENTS_ENVIRONMENT must be live_mode or test_mode"
    );
  }

  const settingsUrl = new URL(env.FRONTEND_SETTINGS_URL);

  if (settingsUrl.protocol !== "https:") {
    throw new Error("FRONTEND_SETTINGS_URL must use HTTPS");
  }
}

function dodoBaseUrl(env) {
  return env.DODO_PAYMENTS_ENVIRONMENT === "live_mode"
    ? LIVE_API
    : TEST_API;
}

// ============================================================
// SUPABASE REST HELPER
// ============================================================

async function supabaseRequest(env, path, options = {}) {
  const base = env.SUPABASE_URL.replace(/\/+$/, "");

  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  const text = await response.text();

  let data;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    console.error("Supabase error:", {
      status: response.status,
      response: typeof data === "string"
        ? data.slice(0, 500)
        : JSON.stringify(data).slice(0, 500),
    });

    throw new Error(
      `Supabase request failed (${response.status}). Check the Worker logs for details.`
    );
  }

  return data;
}

// ============================================================
// SUPABASE AUTHENTICATION
// ============================================================

async function authenticate(request, env) {
  const header = request.headers.get("Authorization");

  if (!header || !header.startsWith("Bearer ")) {
    return {
      error: "Missing Supabase access token. Please log in again.",
      status: 401,
    };
  }

  const token = header.slice(7).trim();

  if (!token) {
    return {
      error: "Empty access token. Please log in again.",
      status: 401,
    };
  }

  const base = env.SUPABASE_URL.replace(/\/+$/, "");

  const response = await fetch(`${base}/auth/v1/user`, {
    method: "GET",
    headers: {
      "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    console.error("Supabase authentication rejected:", response.status);

    return {
      error: "Your session is invalid or expired. Please log in again.",
      status: 401,
    };
  }

  const user = await response.json();

  if (!user?.id || !user?.email) {
    return {
      error: "Supabase did not return a valid authenticated user.",
      status: 401,
    };
  }

  return { user };
}

// ============================================================
// CREATE CHECKOUT
// ============================================================

async function createCheckout(request, env) {
  validateConfig(env);

  // Authenticate the real user first.
  const auth = await authenticate(request, env);

  if (auth.error) {
    return json({
      ok: false,
      error: auth.error,
    }, auth.status);
  }

  const user = auth.user;

  let body;

  try {
    body = await request.json();
  } catch {
    return json({
      ok: false,
      error: "Request body must contain valid JSON.",
    }, 400);
  }

  // The frontend request must use this format.
  if (body.plan !== "premium") {
    return json({
      ok: false,
      error: "Unsupported plan. Expected plan: premium.",
    }, 400);
  }

  // Compare the frontend ID with the authenticated Supabase ID.
  if (typeof body.user_id !== "string" || body.user_id !== user.id) {
    return json({
      ok: false,
      error: "The supplied user_id does not match your authenticated account.",
    }, 403);
  }

  // Ensure the app account exists.
  const userRows = await supabaseRequest(
    env,
    `/rest/v1/users?id=eq.${encodeURIComponent(user.id)}&select=id,email,display_name&limit=1`
  );

  if (!Array.isArray(userRows) || userRows.length === 0) {
    return json({
      ok: false,
      error: "Your Reportli AI account was not found in the users table.",
    }, 404);
  }

  const appUser = userRows[0];

  // Construct the checkout request.
  // The product ID and price are controlled by the server.
  const payload = {
    product_cart: [
      {
        product_id: env.DODO_PAYMENTS_PRODUCT_ID,
        quantity: 1,
      },
    ],

    customer: {
      email: user.email,
      ...(appUser.display_name
        ? { name: appUser.display_name }
        : {}),
    },

    metadata: {
      user_id: user.id,
      plan: "premium",
      source: "reportli_ai",
    },

    return_url:
      "https://dodo-payments-worker.reportliaihq.workers.dev/return",
  };

  const response = await fetch(`${dodoBaseUrl(env)}/checkouts`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.DODO_PAYMENTS_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const raw = await response.text();

  let result = {};

  try {
    result = raw ? JSON.parse(raw) : {};
  } catch {
    result = {};
  }

  if (!response.ok) {
    console.error("Dodo checkout error:", {
      status: response.status,
      response: JSON.stringify(result).slice(0, 1000),
      environment: env.DODO_PAYMENTS_ENVIRONMENT,
    });

    // Do not return the raw provider response to the browser.
    return json({
      ok: false,
      error: "Dodo could not create the checkout session.",
      provider_status: response.status,
      hint: response.status === 403
        ? "Check API key permissions, environment, and account access."
        : response.status === 401
          ? "Check the Dodo API key and environment."
          : "Check the Dodo API request and product configuration.",
    }, 502);
  }

  const checkoutUrl = result.checkout_url || result.checkoutUrl;

  if (!checkoutUrl) {
    console.error(
      "Dodo returned no checkout URL:",
      JSON.stringify(result).slice(0, 1000)
    );

    return json({
      ok: false,
      error: "Dodo did not return a checkout URL.",
    }, 502);
  }

  // Do not activate subscriptions or grant credits here.
  return json({
    ok: true,
    checkout_url: checkoutUrl,
  });
}

// ============================================================
// DODO WEBHOOK SIGNATURE VERIFICATION
// ============================================================
//
// This follows Standard Webhooks signature construction.
// Confirm the exact signing-secret format and headers in your
// Dodo webhook dashboard before relying on it in production.
// ============================================================

function base64ToBytes(value) {
  const binary = atob(value);
  const result = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    result[i] = binary.charCodeAt(i);
  }

  return result;
}

function bytesToBase64(value) {
  let binary = "";

  for (const byte of value) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;

  let mismatch = 0;

  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return mismatch === 0;
}

async function verifyWebhook(request, rawBody, secret) {
  const webhookId = request.headers.get("webhook-id");
  const timestamp = request.headers.get("webhook-timestamp");
  const signatureHeader = request.headers.get("webhook-signature");

  if (!webhookId || !timestamp || !signatureHeader) {
    return false;
  }

  const seconds = Number(timestamp);

  if (!Number.isFinite(seconds)) return false;

  if (Math.abs(Date.now() / 1000 - seconds) > 300) {
    return false;
  }

  let secretBytes;

  try {
    const encoded = secret.startsWith("whsec_")
      ? secret.slice(6)
      : secret;

    secretBytes = base64ToBytes(encoded);
  } catch {
    return false;
  }

  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes,
    {
      name: "HMAC",
      hash: "SHA-256",
    },
    false,
    ["sign"]
  );

  const signedContent = `${webhookId}.${timestamp}.${rawBody}`;

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(signedContent)
  );

  const expected = bytesToBase64(new Uint8Array(signature));

  return signatureHeader.split(/\s+/).some((entry) => {
    const [version, value] = entry.split(",");

    return version === "v1" &&
      value &&
      constantTimeEqual(value, expected);
  });
}

// ============================================================
// HANDLE DODO WEBHOOK
// ============================================================

async function handleWebhook(request, env) {
  validateConfig(env);

  const rawBody = await request.text();

  const valid = await verifyWebhook(
    request,
    rawBody,
    env.DODO_PAYMENTS_WEBHOOK_KEY
  );

  if (!valid) {
    return json({
      ok: false,
      error: "Invalid webhook signature.",
    }, 401);
  }

  let event;

  try {
    event = JSON.parse(rawBody);
  } catch {
    return json({
      ok: false,
      error: "Invalid webhook JSON.",
    }, 400);
  }

  const eventType = event.type;
  const data = event.data || {};
  const metadata = data.metadata || {};
  const userId = metadata.user_id;

  console.log("Verified Dodo event:", eventType);

  // A valid but unrelated event can be acknowledged.
  const subscriptionEvents = new Set([
    "subscription.created",
    "subscription.active",
    "subscription.updated",
    "subscription.renewed",
    "subscription.on_hold",
    "subscription.failed",
    "subscription.cancelled",
    "subscription.expired",
  ]);

  if (!subscriptionEvents.has(eventType)) {
    return json({
      ok: true,
      received: true,
      ignored: true,
      event_type: eventType || "unknown",
    });
  }

  if (!userId) {
    console.error("Missing user_id in verified event metadata.");

    return json({
      ok: false,
      error: "Missing user_id in subscription metadata.",
    }, 500);
  }

  const subscriptionId =
    data.subscription_id || data.id;

  if (!subscriptionId) {
    return json({
      ok: false,
      error: "Missing subscription ID in webhook.",
    }, 500);
  }

  // Ensure the application user exists.
  const users = await supabaseRequest(
    env,
    `/rest/v1/users?id=eq.${encodeURIComponent(userId)}&select=id&limit=1`
  );

  if (!Array.isArray(users) || users.length === 0) {
    return json({
      ok: false,
      error: "Subscription user was not found in Supabase.",
    }, 500);
  }

  const statusMap = {
    "subscription.created": "pending",
    "subscription.active": "active",
    "subscription.updated": data.status || "active",
    "subscription.renewed": "active",
    "subscription.on_hold": "on_hold",
    "subscription.failed": "failed",
    "subscription.cancelled": "cancelled",
    "subscription.expired": "expired",
  };

  const customerId =
    data.customer?.customer_id ||
    data.customer_id ||
    null;

  const periodEnd =
    data.next_billing_date ||
    data.current_period_end ||
    null;

  const subscription = {
    user_id: userId,
    dodo_customer_id: customerId,
    dodo_subscription_id: subscriptionId,
    subscription_status: statusMap[eventType],
    current_period_end: periodEnd,
    updated_at: new Date().toISOString(),
  };

  // Assumes public.user_subscriptions has a UNIQUE constraint
  // on user_id and the columns listed above.
  await supabaseRequest(
    env,
    "/rest/v1/user_subscriptions?on_conflict=user_id",
    {
      method: "POST",
      headers: {
        "Prefer": "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(subscription),
    }
  );

  // Credits are intentionally not granted here.
  // Implement idempotent credit grants after confirming the
  // exact Dodo event names and your database's credit ledger.

  return json({
    ok: true,
    received: true,
    subscription_updated: true,
    event_type: eventType,
  });
}

// ============================================================
// RETURN HANDLER
// ============================================================
//
// Returning from checkout is not proof of successful payment.
// Subscription activation is controlled by verified webhooks.
// ============================================================

function handleReturn(env) {
  const destination =
    env.FRONTEND_SETTINGS_URL ||
    "https://reportliai.sbs/settings";

  return Response.redirect(destination, 303);
    }
