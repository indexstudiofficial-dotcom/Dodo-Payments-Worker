// ============================================================
// REPORTLI AI — DODO PAYMENTS CLOUDFLARE WORKER
// ============================================================
//
// Endpoints:
// POST /checkout
// POST /webhook
// GET  /return
// GET  /health
//
// Frontend request:
// {
//   "user_id": "SUPABASE_USER_ID",
//   "plan": "premium"
// }
//
// Required environment variables:
// SUPABASE_URL
// SUPABASE_SERVICE_ROLE_KEY
// DODO_PAYMENTS_API_KEY
// DODO_PAYMENTS_WEBHOOK_KEY
// DODO_PAYMENTS_PRODUCT_ID
// DODO_PAYMENTS_ENVIRONMENT
// FRONTEND_SETTINGS_URL
//
// IMPORTANT:
// - Never trust user_id without validating the Supabase token.
// - Never grant credits based only on a checkout redirect.
// - Verify all Dodo webhook signatures.
// ============================================================

const DODO_LIVE_API = "https://live.dodopayments.com";
const DODO_TEST_API = "https://test.dodopayments.com";

const TRIAL_DAYS = 2;

// ============================================================
// MAIN REQUEST ROUTER
// ============================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight for browser requests.
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(env),
      });
    }

    try {
      if (url.pathname === "/health" && request.method === "GET") {
        return jsonResponse({
          ok: true,
          worker: "reportli-dodo-payments",
        }, 200, env);
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

      return jsonResponse({
        ok: false,
        error: "Endpoint not found",
      }, 404, env);

    } catch (error) {
      console.error("Worker request failed:", error.message);

      return jsonResponse({
        ok: false,
        error: "An internal error occurred.",
      }, 500, env);
    }
  },
};

// ============================================================
// CORS
// ============================================================

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": "https://reportliai.sbs",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function jsonResponse(data, status, env) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders(env),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

// ============================================================
// CONFIGURATION VALIDATION
// ============================================================

function getDodoBaseUrl(env) {
  if (
    env.DODO_PAYMENTS_ENVIRONMENT === "live_mode"
  ) {
    return DODO_LIVE_API;
  }

  if (
    env.DODO_PAYMENTS_ENVIRONMENT === "test_mode"
  ) {
    return DODO_TEST_API;
  }

  throw new Error(
    "DODO_PAYMENTS_ENVIRONMENT must be live_mode or test_mode"
  );
}

function validateEnvironment(env) {
  const required = [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "DODO_PAYMENTS_API_KEY",
    "DODO_PAYMENTS_WEBHOOK_KEY",
    "DODO_PAYMENTS_PRODUCT_ID",
    "FRONTEND_SETTINGS_URL",
  ];

  for (const key of required) {
    if (!env[key]) {
      throw new Error(`Missing Worker configuration: ${key}`);
    }
  }

  getDodoBaseUrl(env);
}

// ============================================================
// SUPABASE REQUEST HELPER
// ============================================================

async function supabaseRequest(env, path, options = {}) {
  const baseUrl = env.SUPABASE_URL.replace(/\/+$/, "");

  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  const text = await response.text();

  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    console.error(
      "Supabase request failed:",
      response.status,
      typeof data === "string" ? data.slice(0, 500) : JSON.stringify(data)
    );

    throw new Error("Supabase database request failed");
  }

  return data;
}

// ============================================================
// AUTHENTICATE SUPABASE USER
// ============================================================

async function authenticateUser(request, env) {
  const authorization = request.headers.get("Authorization");

  if (!authorization || !authorization.startsWith("Bearer ")) {
    return {
      error: "Missing Supabase access token",
      status: 401,
    };
  }

  const accessToken = authorization.slice(7).trim();

  if (!accessToken) {
    return {
      error: "Invalid access token",
      status: 401,
    };
  }

  const baseUrl = env.SUPABASE_URL.replace(/\/+$/, "");

  const response = await fetch(`${baseUrl}/auth/v1/user`, {
    method: "GET",
    headers: {
      "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    return {
      error: "Your session is invalid or expired. Please log in again.",
      status: 401,
    };
  }

  const user = await response.json();

  if (!user || !user.id || !user.email) {
    return {
      error: "Unable to verify the authenticated user",
      status: 401,
    };
  }

  return { user };
}

// ============================================================
// CREATE DODO CHECKOUT SESSION
// ============================================================

async function createCheckout(request, env) {
  validateEnvironment(env);

  // Step 1: Verify the Supabase session.
  const auth = await authenticateUser(request, env);

  if (auth.error) {
    return jsonResponse({
      ok: false,
      error: auth.error,
    }, auth.status, env);
  }

  const authenticatedUser = auth.user;

  // Step 2: Parse the frontend request.
  let body;

  try {
    body = await request.json();
  } catch {
    return jsonResponse({
      ok: false,
      error: "Invalid JSON request body",
    }, 400, env);
  }

  // Step 3: Validate the requested plan.
  if (body.plan !== "premium") {
    return jsonResponse({
      ok: false,
      error: "Unsupported subscription plan",
    }, 400, env);
  }

  // Step 4: Ensure the frontend ID matches the authenticated user.
  if (
    typeof body.user_id !== "string" ||
    body.user_id !== authenticatedUser.id
  ) {
    return jsonResponse({
      ok: false,
      error: "The supplied user_id does not match your authenticated account",
    }, 403, env);
  }

  // Step 5: Check that the application user exists.
  // The database's users.id is expected to match the Supabase Auth ID.
  const userRows = await supabaseRequest(
    env,
    `/rest/v1/users?id=eq.${encodeURIComponent(authenticatedUser.id)}&select=id,email,display_name&limit=1`,
    { method: "GET" }
  );

  if (!Array.isArray(userRows) || userRows.length === 0) {
    return jsonResponse({
      ok: false,
      error: "Your application account was not found in Supabase",
    }, 404, env);
  }

  const appUser = userRows[0];

  // Step 6: Use only verified account details.
  const customerEmail = authenticatedUser.email;
  const customerName =
    appUser.display_name ||
    authenticatedUser.user_metadata?.full_name ||
    authenticatedUser.user_metadata?.name ||
    undefined;

  // Step 7: Create the Dodo Checkout Session.
  //
  // The product ID comes from Worker configuration, not the browser.
  // The user's verified Supabase ID is saved in checkout metadata.
  //
  // The 2-day trial should be configured using the supported trial
  // settings for your Dodo subscription product/account.
  // This request deliberately does not invent an undocumented
  // trial field in the Checkout Sessions API payload.

  const dodoBaseUrl = getDodoBaseUrl(env);

  const checkoutPayload = {
    product_cart: [
      {
        product_id: env.DODO_PAYMENTS_PRODUCT_ID,
        quantity: 1,
      },
    ],

    customer: {
      email: customerEmail,
      ...(customerName ? { name: customerName } : {}),
    },

    metadata: {
      user_id: authenticatedUser.id,
      plan: "premium",
      source: "reportli_ai",
    },

    return_url:
      "https://dodo-payments-worker.reportliaihq.workers.dev/return",
  };

  const dodoResponse = await fetch(
    `${dodoBaseUrl}/checkouts`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.DODO_PAYMENTS_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(checkoutPayload),
    }
  );

  const dodoText = await dodoResponse.text();

  let dodoData;

  try {
    dodoData = dodoText ? JSON.parse(dodoText) : {};
  } catch {
    dodoData = {};
  }

  if (!dodoResponse.ok) {
    // Do not log the API key or other secrets.
    console.error("Dodo checkout creation failed:", {
      status: dodoResponse.status,
      response: JSON.stringify(dodoData).slice(0, 1000),
      environment: env.DODO_PAYMENTS_ENVIRONMENT,
    });

    return jsonResponse({
      ok: false,
      error: "Dodo could not create the checkout session",
      provider_status: dodoResponse.status,
      details: sanitizeProviderError(dodoData),
    }, 502, env);
  }

  const checkoutUrl =
    dodoData.checkout_url ||
    dodoData.checkoutUrl;

  if (!checkoutUrl) {
    console.error(
      "Dodo response did not contain checkout_url:",
      JSON.stringify(dodoData).slice(0, 1000)
    );

    return jsonResponse({
      ok: false,
      error: "Dodo did not return a checkout URL",
    }, 502, env);
  }

  // Step 8: Return the URL to the frontend.
  // No subscription activation or credits are granted here.

  return jsonResponse({
    ok: true,
    checkout_url: checkoutUrl,
  }, 200, env);
}

function sanitizeProviderError(data) {
  if (!data || typeof data !== "object") {
    return "Check the Cloudflare Worker logs for the provider response.";
  }

  // Return a small, non-secret diagnostic message only.
  return (
    data.message ||
    data.error ||
    "Check your Dodo API key, environment, product ID, and permissions."
  );
}

// ============================================================
// DODO WEBHOOK SIGNATURE VERIFICATION
// ============================================================
//
// Dodo follows Standard Webhooks:
// signed content = webhook-id + "." + webhook-timestamp + "." + raw body
//
// This verifies the original raw body before JSON parsing.
// ============================================================

function bytesToBase64(bytes) {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;

  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return result === 0;
}

async function verifyDodoSignature(request, rawBody, secret) {
  const webhookId = request.headers.get("webhook-id");
  const signatureHeader = request.headers.get("webhook-signature");
  const timestampHeader = request.headers.get("webhook-timestamp");

  if (!webhookId || !signatureHeader || !timestampHeader) {
    return false;
  }

  const timestamp = Number(timestampHeader);

  if (!Number.isFinite(timestamp)) {
    return false;
  }

  // Reject timestamps older than 5 minutes or too far in the future.
  const now = Math.floor(Date.now() / 1000);

  if (Math.abs(now - timestamp) > 300) {
    return false;
  }

  let signingKey;

  try {
    let encodedSecret = secret;

    if (encodedSecret.startsWith("whsec_")) {
      encodedSecret = encodedSecret.slice("whsec_".length);
    }

    signingKey = base64ToBytes(encodedSecret);
  } catch {
    return false;
  }

  const signedContent =
    `${webhookId}.${timestampHeader}.${rawBody}`;

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    signingKey,
    {
      name: "HMAC",
      hash: "SHA-256",
    },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(signedContent)
  );

  const expectedSignature = bytesToBase64(
    new Uint8Array(signature)
  );

  // Standard Webhooks allows multiple signatures in the header.
  const signatures = signatureHeader.split(/\s+/);

  return signatures.some((item) => {
    const parts = item.split(",");

    if (parts.length !== 2 || parts[0] !== "v1") {
      return false;
    }

    return constantTimeEqual(parts[1], expectedSignature);
  });
}

// ============================================================
// HANDLE DODO WEBHOOK
// ============================================================

async function handleWebhook(request, env) {
  validateEnvironment(env);

  // Read raw request body. Do not JSON-parse it before verification.
  const rawBody = await request.text();

  const validSignature = await verifyDodoSignature(
    request,
    rawBody,
    env.DODO_PAYMENTS_WEBHOOK_KEY
  );

  if (!validSignature) {
    return jsonResponse({
      ok: false,
      error: "Invalid webhook signature",
    }, 401, env);
  }

  let event;

  try {
    event = JSON.parse(rawBody);
  } catch {
    return jsonResponse({
      ok: false,
      error: "Invalid webhook JSON",
    }, 400, env);
  }

  const eventType = event.type;
  const data = event.data || {};

  console.log("Verified Dodo webhook:", eventType);

  // Only synchronize subscription-related events here.
  // Expand this list after confirming the exact events enabled
  // in your Dodo dashboard.

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
    // Acknowledge unrelated, valid events.
    return jsonResponse({
      ok: true,
      received: true,
      ignored: true,
      event_type: eventType || "unknown",
    }, 200, env);
  }

  // Dodo subscription events commonly contain metadata on the
  // subscription data object. Never trust metadata from the
  // frontend directly; this metadata came from a verified webhook.
  const metadata = data.metadata || {};
  const userId = metadata.user_id;

  if (!userId || typeof userId !== "string") {
    console.error(
      "Verified subscription webhook has no metadata.user_id",
      eventType
    );

    // Return an error so Dodo retries and the missing mapping can
    // be investigated rather than silently losing the event.
    return jsonResponse({
      ok: false,
      error: "Subscription metadata is missing user_id",
    }, 500, env);
  }

  // Confirm the associated Supabase application user exists.
  const userRows = await supabaseRequest(
    env,
    `/rest/v1/users?id=eq.${encodeURIComponent(userId)}&select=id&limit=1`,
    { method: "GET" }
  );

  if (!Array.isArray(userRows) || userRows.length === 0) {
    console.error("Webhook user was not found in Supabase:", userId);

    return jsonResponse({
      ok: false,
      error: "Subscription user does not exist in Supabase",
    }, 500, env);
  }

  const subscriptionId =
    data.subscription_id ||
    data.id;

  const customerId =
    data.customer?.customer_id ||
    data.customer_id ||
    null;

  const subscriptionStatus =
    data.status ||
    statusFromEvent(eventType);

  const currentPeriodEnd =
    data.next_billing_date ||
    data.current_period_end ||
    null;

  if (!subscriptionId) {
    console.error(
      "Webhook does not contain a subscription ID",
      eventType
    );

    return jsonResponse({
      ok: false,
      error: "Subscription ID is missing from webhook data",
    }, 500, env);
  }

  // This upsert assumes public.user_subscriptions has:
  // user_id, dodo_customer_id, dodo_subscription_id,
  // subscription_status, current_period_end.
  //
  // NOTE: A database constraint/unique index on user_id is required
  // for on_conflict=user_id to work.
  //
  // This synchronizes subscription data. It does NOT grant credits:
  // credit grants require a persistent idempotency ledger and an
  // atomic database transaction to prevent duplicate grants.

  const subscriptionRow = {
    user_id: userId,
    dodo_customer_id: customerId,
    dodo_subscription_id: subscriptionId,
    subscription_status: subscriptionStatus,
    current_period_end: currentPeriodEnd,
    updated_at: new Date().toISOString(),
  };

  await supabaseRequest(
    env,
    "/rest/v1/user_subscriptions?on_conflict=user_id",
    {
      method: "POST",
      headers: {
        "Prefer": "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(subscriptionRow),
    }
  );

  return jsonResponse({
    ok: true,
    received: true,
    subscription_updated: true,
    event_type: eventType,
  }, 200, env);
}

function statusFromEvent(eventType) {
  switch (eventType) {
    case "subscription.created":
      return "pending";

    case "subscription.active":
    case "subscription.renewed":
      return "active";

    case "subscription.on_hold":
      return "on_hold";

    case "subscription.failed":
      return "failed";

    case "subscription.cancelled":
      return "cancelled";

    case "subscription.expired":
      return "expired";

    default:
      return "pending";
  }
}

// ============================================================
// RETURN HANDLER
// ============================================================
//
// This is a browser return route, not proof of payment.
// The verified webhook is responsible for subscription updates.
// ============================================================

function handleReturn(env) {
  const destination =
    env.FRONTEND_SETTINGS_URL ||
    "https://reportliai.sbs/settings";

  return Response.redirect(destination, 303);
      }
