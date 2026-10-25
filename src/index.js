// ============================================================
// REPORTLI AI — DODO PAYMENTS WORKER
// ============================================================
//
// FEATURES
// 1. Create Dodo checkout sessions.
// 2. Verify Supabase Auth users.
// 3. Verify Dodo webhook signatures.
// 4. Track subscriptions in public.user_subscriptions.
// 5. Use public.users.balance for credits.
// 6. Grant 20 credits when a new trial starts.
// 7. Do not grant credits on the first payment after trial.
// 8. Grant 20 credits on subsequent monthly renewals.
// 9. Avoid duplicate grants for ordinary webhook retries.
// 10. Return subscription status and credit balance.
//
// REQUIRED EXISTING TABLES
// public.users
// public.user_subscriptions
//
// ENVIRONMENT VALUES
// test_mode = Dodo testing
// live_mode = real payments
//
// ============================================================


export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // --------------------------------------------------------
    // 1. CORS
    // --------------------------------------------------------

    const origin = request.headers.get("Origin");

    const allowedOrigins = [
      "https://reportliai.sbs",
      "https://www.reportliai.sbs",
    ];

    const corsHeaders = {
      "Access-Control-Allow-Origin":
        allowedOrigins.includes(origin) ? origin : "https://reportliai.sbs",

      "Access-Control-Allow-Methods":
        "GET, POST, OPTIONS",

      "Access-Control-Allow-Headers":
        "Content-Type, Authorization",

      "Vary": "Origin",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    try {
      // ------------------------------------------------------
      // 2. HEALTH CHECK
      // ------------------------------------------------------

      if (url.pathname === "/health" && request.method === "GET") {
        return json({
          ok: true,
          worker: "reportli-dodo-payments",
          environment: getDodoEnvironment(env),
        }, 200, corsHeaders);
      }

      // ------------------------------------------------------
      // 3. VERIFY REQUIRED CONFIGURATION
      // ------------------------------------------------------

      const missing = getMissingEnvironmentVariables(env);

      if (missing.length > 0) {
        return json({
          ok: false,
          error: "Worker configuration is incomplete.",
          missing,
        }, 500, corsHeaders);
      }

      // ------------------------------------------------------
      // 4. DODO WEBHOOK
      //
      // Do not require Supabase user authentication here.
      // Dodo authenticates itself using its webhook signature.
      // ------------------------------------------------------

      if (url.pathname === "/webhook") {
        if (request.method !== "POST") {
          return json({
            ok: false,
            error: "Method not allowed",
          }, 405, corsHeaders);
        }

        return handleWebhook(request, env, corsHeaders);
      }

      // ------------------------------------------------------
      // 5. VERIFY THE LOGGED-IN SUPABASE USER
      //
      // Checkout and subscription routes require an access
      // token from the currently logged-in Supabase user.
      // ------------------------------------------------------

      const user = await authenticateSupabaseUser(request, env);

      if (!user) {
        return json({
          ok: false,
          error: "Authentication required. Please sign in again.",
        }, 401, corsHeaders);
      }

      // ------------------------------------------------------
      // 6. CREATE CHECKOUT
      // ------------------------------------------------------

      if (url.pathname === "/checkout") {
        if (request.method !== "POST") {
          return json({
            ok: false,
            error: "Method not allowed",
          }, 405, corsHeaders);
        }

        return createCheckout(user, env, corsHeaders);
      }

      // ------------------------------------------------------
      // 7. GET SUBSCRIPTION AND BALANCE
      // ------------------------------------------------------

      if (url.pathname === "/subscription") {
        if (request.method !== "GET") {
          return json({
            ok: false,
            error: "Method not allowed",
          }, 405, corsHeaders);
        }

        return getSubscription(user, env, corsHeaders);
      }

      // ------------------------------------------------------
      // 8. UNKNOWN ROUTE
      // ------------------------------------------------------

      return json({
        ok: false,
        error: "Route not found",
      }, 404, corsHeaders);

    } catch (error) {
      // Never expose API keys or raw secret values.
      console.error("Reportli payments worker error:", error.message);

      return json({
        ok: false,
        error: "An internal error occurred.",
      }, 500, corsHeaders);
    }
  },
};


// ============================================================
// ENVIRONMENT CONFIGURATION
// ============================================================

function getDodoEnvironment(env) {
  const value = String(
    env.DODO_PAYMENTS_ENVIRONMENT || "test_mode"
  ).trim().toLowerCase();

  // Accept the official values and convenient aliases.
  if (value === "live_mode" || value === "live" || value === "active") {
    return "live_mode";
  }

  // Unknown values must never silently enable real payments.
  return "test_mode";
}


function getDodoBaseUrl(env) {
  return getDodoEnvironment(env) === "live_mode"
    ? "https://live.dodopayments.com"
    : "https://test.dodopayments.com";
}


function getMissingEnvironmentVariables(env) {
  const required = [
    "DODO_PAYMENTS_API_KEY",
    "DODO_PAYMENTS_WEBHOOK_KEY",
    "DODO_PAYMENTS_PRODUCT_ID",
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
  ];

  return required.filter((key) => !env[key]);
}


// ============================================================
// JSON RESPONSE HELPER
// ============================================================

function json(data, status = 200, corsHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders,
    },
  });
}


// ============================================================
// SUPABASE AUTHENTICATION
// ============================================================
//
// The frontend sends:
//
// Authorization: Bearer SUPABASE_ACCESS_TOKEN
//
// The access token is verified against Supabase Auth.
// We never trust a user ID supplied in the request body.
// ============================================================

async function authenticateSupabaseUser(request, env) {
  const authorization = request.headers.get("Authorization");

  if (!authorization || !authorization.startsWith("Bearer ")) {
    return null;
  }

  const accessToken = authorization.slice(7).trim();

  if (!accessToken) {
    return null;
  }

  const response = await fetch(
    `${env.SUPABASE_URL.replace(/\/$/, "")}/auth/v1/user`,
    {
      method: "GET",
      headers: {
        "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${accessToken}`,
      },
    }
  );

  if (!response.ok) {
    return null;
  }

  const user = await response.json();

  if (!user || !user.id || !user.email) {
    return null;
  }

  return {
    id: user.id,
    email: user.email,
    name:
      user.user_metadata?.full_name ||
      user.user_metadata?.name ||
      "",
  };
}


// ============================================================
// SUPABASE REST API HELPER
// ============================================================

async function supabaseRequest(env, path, options = {}) {
  const baseUrl = env.SUPABASE_URL.replace(/\/$/, "");

  const headers = {
    "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
    "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
    ...options.headers,
  };

  const response = await fetch(`${baseUrl}/rest/v1/${path}`, {
    ...options,
    headers,
  });

  const text = await response.text();

  let data = null;

  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    console.error(
      "Supabase request failed:",
      response.status,
      typeof data === "string" ? data : JSON.stringify(data)
    );

    throw new Error(`Supabase request failed: ${response.status}`);
  }

  return data;
}


// ============================================================
// ENSURE THE EXISTING USER ROW EXISTS
// ============================================================
//
// Your public.users.id is the Supabase Auth ID converted to
// text. We do not overwrite a user's existing balance.
//
// ============================================================

async function ensureUserRow(user, env) {
  const query =
    `users?id=eq.${encodeURIComponent(user.id)}` +
    "&select=id,balance,email&limit=1";

  const rows = await supabaseRequest(env, query);

  if (Array.isArray(rows) && rows.length > 0) {
    return rows[0];
  }

  const created = await supabaseRequest(
    env,
    "users?on_conflict=id",
    {
      method: "POST",
      headers: {
        "Prefer": "resolution=ignore-duplicates,return=representation",
      },
      body: JSON.stringify({
        id: user.id,
        email: user.email,
        balance: 0,
      }),
    }
  );

  if (Array.isArray(created) && created.length > 0) {
    return created[0];
  }

  const retryRows = await supabaseRequest(env, query);

  if (Array.isArray(retryRows) && retryRows.length > 0) {
    return retryRows[0];
  }

  throw new Error("Unable to initialize user balance");
}


// ============================================================
// CREDIT BALANCE — COMPARE-AND-SET INCREMENT
// ============================================================
//
// No additional SQL function is required for this operation.
//
// We read the current balance, then update only if it still
// equals the value we read. If another update changed it,
// we retry instead of overwriting that newer value.
//
// This reduces race conditions but does not replace a
// database transaction for complete cross-worker atomicity.
// ============================================================

async function addCredits(userId, amount, env) {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Invalid credit amount");
  }

  const id = encodeURIComponent(userId);

  for (let attempt = 0; attempt < 8; attempt++) {
    const rows = await supabaseRequest(
      env,
      `users?id=eq.${id}&select=id,balance&limit=1`
    );

    if (!Array.isArray(rows) || rows.length === 0) {
      throw new Error("User balance row does not exist");
    }

    const currentBalance = Number(rows[0].balance ?? 0);

    if (!Number.isFinite(currentBalance) || currentBalance < 0) {
      throw new Error("Invalid existing balance");
    }

    // Use two decimal places for the credit balance.
    const nextBalance = Number(
      (currentBalance + amount).toFixed(2)
    );

    const updated = await supabaseRequest(
      env,
      `users?id=eq.${id}` +
      `&balance=eq.${encodeURIComponent(String(currentBalance))}` +
      "&select=id,balance",
      {
        method: "PATCH",
        headers: {
          "Prefer": "return=representation",
        },
        body: JSON.stringify({
          balance: nextBalance,
        }),
      }
    );

    if (Array.isArray(updated) && updated.length > 0) {
      return nextBalance;
    }

    // The balance changed between reading and writing.
    // Retry using the newest balance.
  }

  throw new Error("Could not safely update the credit balance");
}


// ============================================================
// CREATE DODO CHECKOUT SESSION
// ============================================================
//
// New users receive a 2-day trial.
//
// Existing subscriptions are not given a second free trial.
// Existing active subscriptions cannot start another checkout.
//
// The product must already be configured in Dodo as a
// $19/month recurring subscription product.
// ============================================================

async function createCheckout(user, env, corsHeaders) {
  await ensureUserRow(user, env);

  const userId = user.id;

  const existingRows = await supabaseRequest(
    env,
    `user_subscriptions?user_id=eq.${encodeURIComponent(userId)}` +
    "&select=id,user_id,dodo_customer_id,dodo_subscription_id," +
    "subscription_status,current_period_end&limit=1"
  );

  const existing =
    Array.isArray(existingRows) && existingRows.length > 0
      ? existingRows[0]
      : null;

  if (
    existing &&
    ["active", "trialing", "pending", "pending_paid",
     "trial_credit_pending"].includes(
      String(existing.subscription_status).toLowerCase()
    )
  ) {
    return json({
      ok: false,
      error: "A subscription or checkout is already in progress.",
      subscription_status: existing.subscription_status,
    }, 409, corsHeaders);
  }

  // Give the trial only to users without a previous subscription.
  const hasPreviousSubscription = Boolean(
    existing?.dodo_subscription_id
  );

  const isNewTrial = !hasPreviousSubscription;

  const checkoutBody = {
    product_cart: [
      {
        product_id: env.DODO_PAYMENTS_PRODUCT_ID,
        quantity: 1,
      },
    ],

    customer: {
      email: user.email,
      ...(user.name ? { name: user.name } : {}),
      ...(existing?.dodo_customer_id
        ? { customer_id: existing.dodo_customer_id }
        : {}),
    },

    return_url: "https://reportliai.sbs/?billing=complete",

    // The webhook uses this metadata to identify the Supabase user.
    metadata: {
      supabase_user_id: userId,
      application: "reportli_ai",
    },

    ...(isNewTrial
      ? {
          subscription_data: {
            trial_period_days: 2,
          },
        }
      : {}),
  };

  // ----------------------------------------------------------
  // Create the hosted checkout session.
  // ----------------------------------------------------------

  const dodoResponse = await fetch(
    `${getDodoBaseUrl(env)}/checkout-sessions`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.DODO_PAYMENTS_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(checkoutBody),
    }
  );

  const dodoText = await dodoResponse.text();

  let checkout;

  try {
    checkout = JSON.parse(dodoText);
  } catch {
    checkout = {};
  }

  if (!dodoResponse.ok) {
    console.error(
      "Dodo checkout creation failed:",
      dodoResponse.status,
      JSON.stringify(checkout)
    );

    return json({
      ok: false,
      error: "Unable to create checkout. Please try again.",
    }, 502, corsHeaders);
  }

  if (!checkout.checkout_url) {
    console.error("Dodo returned no checkout_url");

    return json({
      ok: false,
      error: "Dodo did not return a checkout URL.",
    }, 502, corsHeaders);
  }

  // ----------------------------------------------------------
  // Prepare the existing subscription record.
  //
  // We do not grant credits here. Credits are granted only
  // after receiving a verified webhook.
  // ----------------------------------------------------------

  const now = new Date().toISOString();

  if (existing) {
    await supabaseRequest(
      env,
      `user_subscriptions?user_id=eq.${encodeURIComponent(userId)}`,
      {
        method: "PATCH",
        headers: {
          "Prefer": "return=representation",
        },
        body: JSON.stringify({
          subscription_status: isNewTrial
            ? "pending"
            : "pending_paid",
          current_period_end: null,
          updated_at: now,
        }),
      }
    );
  } else {
    await supabaseRequest(
      env,
      "user_subscriptions?on_conflict=user_id",
      {
        method: "POST",
        headers: {
          "Prefer": "resolution=merge-duplicates,return=representation",
        },
        body: JSON.stringify({
          user_id: userId,
          subscription_status: "pending",
          created_at: now,
          updated_at: now,
        }),
      }
    );
  }

  return json({
    ok: true,
    checkout_url: checkout.checkout_url,
    session_id: checkout.session_id || null,
    trial_days: isNewTrial ? 2 : 0,
  }, 200, corsHeaders);
}


// ============================================================
// VERIFY DODO WEBHOOK SIGNATURE
// ============================================================
//
// Dodo uses the Standard Webhooks signing format.
//
// Signed message:
// webhook-id.webhook-timestamp.raw_request_body
//
// Never parse and reserialize the body before verification.
// ============================================================

function decodeBase64(value) {
  const binary = atob(value);

  return Uint8Array.from(
    binary,
    (character) => character.charCodeAt(0)
  );
}


function bytesToBase64(bytes) {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
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


async function verifyDodoSignature(request, rawBody, env) {
  const webhookId = request.headers.get("webhook-id");
  const timestamp = request.headers.get("webhook-timestamp");
  const signatureHeader = request.headers.get("webhook-signature");

  if (!webhookId || !timestamp || !signatureHeader) {
    return false;
  }

  const timestampNumber = Number(timestamp);

  if (!Number.isFinite(timestampNumber)) {
    return false;
  }

  // Reject stale webhook deliveries to reduce replay risk.
  const currentTime = Math.floor(Date.now() / 1000);

  if (Math.abs(currentTime - timestampNumber) > 300) {
    return false;
  }

  let secret = env.DODO_PAYMENTS_WEBHOOK_KEY.trim();

  // Standard Webhooks secrets commonly use the whsec_ prefix.
  if (secret.startsWith("whsec_")) {
    secret = secret.slice(6);
  }

  let secretBytes;

  try {
    secretBytes = decodeBase64(secret);
  } catch {
    return false;
  }

  const encoder = new TextEncoder();

  const signedContent =
    `${webhookId}.${timestamp}.${rawBody}`;

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    secretBytes,
    {
      name: "HMAC",
      hash: "SHA-256",
    },
    false,
    ["sign"]
  );

  const signatureBytes = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      cryptoKey,
      encoder.encode(signedContent)
    )
  );

  const expectedSignature = bytesToBase64(signatureBytes);

  // A header may contain multiple versioned signatures.
  const candidates = signatureHeader.split(/\s+/);

  return candidates.some((candidate) => {
    const separator = candidate.indexOf(",");

    if (separator === -1) {
      return false;
    }

    const version = candidate.slice(0, separator);
    const value = candidate.slice(separator + 1);

    return (
      version === "v1" &&
      constantTimeEqual(value, expectedSignature)
    );
  });
}


// ============================================================
// WEBHOOK DATA HELPERS
// ============================================================

function getMetadataUserId(data) {
  const metadata =
    data?.metadata ||
    data?.subscription?.metadata ||
    data?.customer?.metadata ||
    {};

  return (
    metadata.supabase_user_id ||
    metadata.supabaseUserId ||
    null
  );
}


function getSubscriptionId(data) {
  return (
    data?.subscription_id ||
    data?.subscription?.subscription_id ||
    data?.subscription?.id ||
    data?.id ||
    null
  );
}


function getCustomerId(data) {
  return (
    data?.customer?.customer_id ||
    data?.customer_id ||
    null
  );
}


function getPeriodEnd(data) {
  const value =
    data?.current_period_end ||
    data?.next_billing_date ||
    data?.subscription?.current_period_end ||
    data?.subscription?.next_billing_date ||
    null;

  if (!value) {
    return null;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString();
}


// ============================================================
// WEBHOOK SUBSCRIPTION LOOKUP
// ============================================================

async function getSubscriptionByUser(userId, env) {
  const rows = await supabaseRequest(
    env,
    `user_subscriptions?user_id=eq.${encodeURIComponent(userId)}` +
    "&select=id,user_id,dodo_customer_id,dodo_subscription_id," +
    "subscription_status,current_period_end&limit=1"
  );

  return Array.isArray(rows) && rows.length > 0
    ? rows[0]
    : null;
}


// ============================================================
// HANDLE DODO WEBHOOK
// ============================================================

async function handleWebhook(request, env, corsHeaders) {
  const rawBody = await request.text();

  const validSignature = await verifyDodoSignature(
    request,
    rawBody,
    env
  );

  if (!validSignature) {
    return json({
      ok: false,
      error: "Invalid webhook signature",
    }, 401, corsHeaders);
  }

  let event;

  try {
    event = JSON.parse(rawBody);
  } catch {
    return json({
      ok: false,
      error: "Invalid webhook JSON",
    }, 400, corsHeaders);
  }

  const eventType = event.type;
  const data = event.data || {};

  const userId = getMetadataUserId(data);
  const subscriptionId = getSubscriptionId(data);
  const customerId = getCustomerId(data);
  const periodEnd = getPeriodEnd(data);

  console.log("Dodo webhook received:", eventType);

  // Ignore unrelated event types.
  const supportedEvents = [
    "subscription.active",
    "subscription.renewed",
    "subscription.cancelled",
    "subscription.on_hold",
    "subscription.past_due",
    "subscription.failed",
    "subscription.expired",
  ];

  if (!supportedEvents.includes(eventType)) {
    return json({
      ok: true,
      processed: false,
      reason: "Event type not handled",
    }, 200, corsHeaders);
  }

  if (!userId || !subscriptionId) {
    console.error(
      "Webhook missing Supabase user metadata or subscription ID"
    );

    // Return a failure so the delivery can be investigated/retried.
    return json({
      ok: false,
      error: "Webhook is missing required subscription metadata.",
    }, 400, corsHeaders);
  }

  let subscription = await getSubscriptionByUser(userId, env);

  if (!subscription) {
    console.error("Subscription row not found for webhook user");

    return json({
      ok: false,
      error: "Subscription record not found.",
    }, 500, corsHeaders);
  }

  // Never let an event for an old subscription modify a newer one.
  if (
    subscription.dodo_subscription_id &&
    subscription.dodo_subscription_id !== subscriptionId &&
    !["pending", "pending_paid"].includes(
      String(subscription.subscription_status).toLowerCase()
    )
  ) {
    return json({
      ok: true,
      processed: false,
      reason: "Event belongs to an older subscription",
    }, 200, corsHeaders);
  }

  // ----------------------------------------------------------
  // EVENT: subscription.active
  //
  // A new trial begins when a new checkout has status pending.
  // Grant 20 credits once.
  //
  // If the subscription was already trialing, do not grant
  // credits again.
  //
  // For a previously subscribed user, pending_paid means
  // this checkout has no new trial.
  // ----------------------------------------------------------

  if (eventType === "subscription.active") {
    const status = String(
      subscription.subscription_status || ""
    ).toLowerCase();

    if (status === "pending") {
      const claimed = await supabaseRequest(
        env,
        `user_subscriptions?user_id=eq.${encodeURIComponent(userId)}` +
        "&subscription_status=eq.pending",
        {
          method: "PATCH",
          headers: {
            "Prefer": "return=representation",
          },
          body: JSON.stringify({
            dodo_customer_id:
              customerId || subscription.dodo_customer_id,
            dodo_subscription_id: subscriptionId,
            subscription_status: "trialing",
            current_period_end: periodEnd,
            updated_at: new Date().toISOString(),
          }),
        }
      );

      // Only the delivery that changes pending -> trialing
      // can claim the initial trial credit grant.
      if (Array.isArray(claimed) && claimed.length > 0) {
        await addCredits(userId, 20, env);

        return json({
          ok: true,
          processed: true,
          credits_granted: 20,
          reason: "Initial trial credit grant",
        }, 200, corsHeaders);
      }

      return json({
        ok: true,
        processed: false,
        reason: "Trial already initialized",
      }, 200, corsHeaders);
    }

    // A returning subscriber's checkout must not create
    // another trial grant.
    if (status === "pending_paid") {
      await supabaseRequest(
        env,
        `user_subscriptions?user_id=eq.${encodeURIComponent(userId)}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            dodo_customer_id:
              customerId || subscription.dodo_customer_id,
            dodo_subscription_id: subscriptionId,
            subscription_status: "active",
            current_period_end: periodEnd,
            updated_at: new Date().toISOString(),
          }),
        }
      );

      return json({
        ok: true,
        processed: true,
        credits_granted: 0,
        reason: "Subscription activated without a new trial",
      }, 200, corsHeaders);
    }

    // Duplicate active event or reactivation.
    // Do not grant another trial allowance.
    await supabaseRequest(
      env,
      `user_subscriptions?user_id=eq.${encodeURIComponent(userId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          dodo_customer_id:
            customerId || subscription.dodo_customer_id,
          dodo_subscription_id: subscriptionId,
          updated_at: new Date().toISOString(),
        }),
      }
    );

    return json({
      ok: true,
      processed: false,
      reason: "No new trial credits granted",
    }, 200, corsHeaders);
  }

  // ----------------------------------------------------------
  // EVENT: subscription.renewed
  //
  // First payment after the trial:
  // trialing -> active, no credits.
  //
  // Subsequent monthly renewal:
  // active + later period end -> +20 credits.
  // ----------------------------------------------------------

  if (eventType === "subscription.renewed") {
    const status = String(
      subscription.subscription_status || ""
    ).toLowerCase();

    // The first payment after the free trial must not grant
    // another 20 credits.
    if (status === "trialing") {
      await supabaseRequest(
        env,
        `user_subscriptions?user_id=eq.${encodeURIComponent(userId)}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            dodo_customer_id:
              customerId || subscription.dodo_customer_id,
            dodo_subscription_id: subscriptionId,
            subscription_status: "active",
            current_period_end:
              periodEnd || subscription.current_period_end,
            updated_at: new Date().toISOString(),
          }),
        }
      );

      return json({
        ok: true,
        processed: true,
        credits_granted: 0,
        reason: "First payment after trial",
      }, 200, corsHeaders);
    }

    if (status !== "active" || !periodEnd) {
      return json({
        ok: true,
        processed: false,
        reason: "Subscription is not eligible for renewal credits",
      }, 200, corsHeaders);
    }

    const oldEnd = subscription.current_period_end
      ? new Date(subscription.current_period_end).getTime()
      : 0;

    const newEnd = new Date(periodEnd).getTime();

    // The period must advance. A repeated webhook for the
    // same billing period cannot grant credits a second time.
    if (!newEnd || newEnd <= oldEnd || !oldEnd) {
      return json({
        ok: true,
        processed: false,
        reason: "Billing period did not advance",
      }, 200, corsHeaders);
    }

    // Compare-and-set on the old period end.
    // Only one delivery can claim this billing-period change.
    const claimed = await supabaseRequest(
      env,
      `user_subscriptions?user_id=eq.${encodeURIComponent(userId)}` +
      `&subscription_status=eq.active` +
      `&current_period_end=eq.${encodeURIComponent(
        subscription.current_period_end
      )}`,
      {
        method: "PATCH",
        headers: {
          "Prefer": "return=representation",
        },
        body: JSON.stringify({
          dodo_customer_id:
            customerId || subscription.dodo_customer_id,
          dodo_subscription_id: subscriptionId,
          current_period_end: periodEnd,
          updated_at: new Date().toISOString(),
        }),
      }
    );

    if (!Array.isArray(claimed) || claimed.length === 0) {
      return json({
        ok: true,
        processed: false,
        reason: "Renewal already processed or subscription changed",
      }, 200, corsHeaders);
    }

    await addCredits(userId, 20, env);

    return json({
      ok: true,
      processed: true,
      credits_granted: 20,
      reason: "Monthly renewal",
    }, 200, corsHeaders);
  }

  // ----------------------------------------------------------
  // OTHER SUBSCRIPTION STATUS EVENTS
  // ----------------------------------------------------------

  const statusMap = {
    "subscription.cancelled": "canceled",
    "subscription.on_hold": "on_hold",
    "subscription.past_due": "past_due",
    "subscription.failed": "past_due",
    "subscription.expired": "expired",
  };

  const newStatus = statusMap[eventType];

  if (newStatus) {
    await supabaseRequest(
      env,
      `user_subscriptions?user_id=eq.${encodeURIComponent(userId)}` +
      `&dodo_subscription_id=eq.${encodeURIComponent(subscriptionId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          subscription_status: newStatus,
          updated_at: new Date().toISOString(),
        }),
      }
    );

    return json({
      ok: true,
      processed: true,
      subscription_status: newStatus,
    }, 200, corsHeaders);
  }

  return json({
    ok: true,
    processed: false,
  }, 200, corsHeaders);
}


// ============================================================
// GET CURRENT SUBSCRIPTION AND BALANCE
// ============================================================

async function getSubscription(user, env, corsHeaders) {
  const userRow = await ensureUserRow(user, env);

  const subscription = await getSubscriptionByUser(
    user.id,
    env
  );

  return json({
    ok: true,

    user: {
      id: user.id,
      email: user.email,
    },

    balance: Number(userRow.balance ?? 0),

    subscription: subscription
      ? {
          status: subscription.subscription_status,
          customer_id: subscription.dodo_customer_id,
          subscription_id: subscription.dodo_subscription_id,
          current_period_end: subscription.current_period_end,
        }
      : null,
  }, 200, corsHeaders);
      }
