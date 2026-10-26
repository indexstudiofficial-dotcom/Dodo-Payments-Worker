// ============================================================
// REPORTLI AI — DODO PAYMENTS WORKER
// ============================================================
// Routes:
//   GET  /health
//   POST /checkout
//   POST /webhook
//   GET  /return
//
// EXISTING DATABASE TABLES:
//   public.users
//   public.user_subscriptions
//
// CREDIT RULES:
//   1. Trial start:
//      Set balance to 20 only if balance is 0 or NULL.
//      Never overwrite a positive existing balance.
//
//   2. First successful payment after trial:
//      No additional credits.
//
//   3. Subsequent monthly renewal:
//      Reset balance to exactly 20.
//
//   4. Failed/cancelled/expired/on-hold:
//      No credits.
//
//   5. Duplicate renewal:
//      Compare current_period_end with the stored period.
//
// IMPORTANT:
// No SQL changes or new tables are required.
// Renewal deduplication is best-effort because the existing
// schema has no dedicated webhook-event ledger.
//
// REQUIRED SECRETS:
//   SUPABASE_SERVICE_ROLE_KEY
//   DODO_PAYMENTS_API_KEY
//   DODO_PAYMENTS_WEBHOOK_KEY
//
// REQUIRED VARIABLES:
//   SUPABASE_URL
//   DODO_PAYMENTS_PRODUCT_ID
//   DODO_PAYMENTS_ENVIRONMENT
//   FRONTEND_SETTINGS_URL
//
// OPTIONAL SECRET:
//   CHECKOUT_API_SECRET
// ============================================================

const LIVE_API = "https://live.dodopayments.com";
const TEST_API = "https://test.dodopayments.com";

const ALLOWED_ORIGIN = "https://reportliai.sbs";

const RETURN_URL =
  "https://dodo-payments-worker.reportliaihq.workers.dev/return";

const TRIAL_CREDITS = 20;
const RENEWAL_CREDITS = 20;

// ============================================================
// ROUTER
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
      if (
        url.pathname === "/health" &&
        request.method === "GET"
      ) {
        return json({
          ok: true,
          worker: "reportli-dodo-payments",
        });
      }

      if (
        url.pathname === "/checkout" &&
        request.method === "POST"
      ) {
        return await createCheckout(request, env);
      }

      if (
        url.pathname === "/webhook" &&
        request.method === "POST"
      ) {
        return await handleWebhook(request, env);
      }

      if (
        url.pathname === "/return" &&
        request.method === "GET"
      ) {
        return handleReturn(env);
      }

      return json({
        ok: false,
        error: "Endpoint not found",
      }, 404);

    } catch (error) {
      console.error(
        "Worker error:",
        error?.stack || error?.message || error
      );

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
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, X-Checkout-Secret",
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
      throw new Error(
        `Missing Worker configuration: ${name}`
      );
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

  let settingsUrl;

  try {
    settingsUrl = new URL(env.FRONTEND_SETTINGS_URL);
  } catch {
    throw new Error(
      "FRONTEND_SETTINGS_URL is not a valid URL"
    );
  }

  if (settingsUrl.protocol !== "https:") {
    throw new Error(
      "FRONTEND_SETTINGS_URL must use HTTPS"
    );
  }
}

function dodoBaseUrl(env) {
  return env.DODO_PAYMENTS_ENVIRONMENT === "live_mode"
    ? LIVE_API
    : TEST_API;
}

// ============================================================
// OPTIONAL CHECKOUT AUTHORIZATION
// ============================================================

function authorizeCheckout(request, env) {
  if (!env.CHECKOUT_API_SECRET) {
    console.warn(
      "WARNING: /checkout is public because CHECKOUT_API_SECRET is not configured."
    );

    return true;
  }

  const supplied =
    request.headers.get("X-Checkout-Secret");

  return Boolean(
    supplied &&
    supplied === env.CHECKOUT_API_SECRET
  );
}

// ============================================================
// SUPABASE REST HELPER
// ============================================================

async function supabaseRequest(
  env,
  path,
  options = {}
) {
  const base =
    env.SUPABASE_URL.replace(/\/+$/, "");

  const response = await fetch(
    `${base}${path}`,
    {
      ...options,
      headers: {
        "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
        "Authorization":
          `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    }
  );

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
      `Supabase request failed (${response.status}). Check Worker logs.`
    );
  }

  return data;
}

// ============================================================
// CHECKOUT
// ============================================================

async function createCheckout(request, env) {
  validateConfig(env);

  if (!authorizeCheckout(request, env)) {
    return json({
      ok: false,
      error: "Unauthorized checkout request.",
    }, 401);
  }

  let body;

  try {
    body = await request.json();
  } catch {
    return json({
      ok: false,
      error: "Request body must contain valid JSON.",
    }, 400);
  }

  if (
    !body ||
    typeof body.user_id !== "string" ||
    !body.user_id.trim()
  ) {
    return json({
      ok: false,
      error: "Missing user_id in request body.",
    }, 400);
  }

  if (body.plan !== "premium") {
    return json({
      ok: false,
      error: "Unsupported plan. Expected plan: premium.",
    }, 400);
  }

  const userId = body.user_id.trim();

  const userRows = await supabaseRequest(
    env,
    "/rest/v1/users" +
    `?id=eq.${encodeURIComponent(userId)}` +
    "&select=id,email,display_name,balance&limit=1"
  );

  if (
    !Array.isArray(userRows) ||
    userRows.length === 0
  ) {
    return json({
      ok: false,
      error: "User was not found in Supabase.",
    }, 404);
  }

  const appUser = userRows[0];

  if (!appUser.email) {
    return json({
      ok: false,
      error: "The Supabase user does not have an email address.",
    }, 400);
  }

  const payload = {
    product_cart: [
      {
        product_id: env.DODO_PAYMENTS_PRODUCT_ID,
        quantity: 1,
      },
    ],

    customer: {
      email: appUser.email,
      ...(appUser.display_name
        ? { name: appUser.display_name }
        : {}),
    },

    metadata: {
      user_id: appUser.id,
      plan: "premium",
      source: "reportli_ai",
    },

    return_url: RETURN_URL,
  };

  const response = await fetch(
    `${dodoBaseUrl(env)}/checkouts`,
    {
      method: "POST",
      headers: {
        "Authorization":
          `Bearer ${env.DODO_PAYMENTS_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    }
  );

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

    return json({
      ok: false,
      error: "Dodo could not create the checkout session.",
      provider_status: response.status,
      hint: response.status === 401
        ? "Check the Dodo API key and environment."
        : response.status === 403
          ? "Check the API key permissions and account access."
          : "Check the Dodo request and product configuration.",
    }, 502);
  }

  const checkoutUrl =
    result.checkout_url ||
    result.checkoutUrl;

  if (
    typeof checkoutUrl !== "string" ||
    !checkoutUrl.startsWith("https://")
  ) {
    console.error(
      "Dodo returned no valid checkout URL:",
      JSON.stringify(result).slice(0, 1000)
    );

    return json({
      ok: false,
      error: "Dodo did not return a valid checkout URL.",
    }, 502);
  }

  return json({
    ok: true,
    checkout_url: checkoutUrl,
  });
}

// ============================================================
// WEBHOOK SIGNATURE VERIFICATION
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
  if (a.length !== b.length) {
    return false;
  }

  let mismatch = 0;

  for (let i = 0; i < a.length; i++) {
    mismatch |=
      a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return mismatch === 0;
}

async function verifyWebhook(
  request,
  rawBody,
  secret
) {
  const webhookId =
    request.headers.get("webhook-id");

  const timestamp =
    request.headers.get("webhook-timestamp");

  const signatureHeader =
    request.headers.get("webhook-signature");

  if (
    !webhookId ||
    !timestamp ||
    !signatureHeader
  ) {
    return false;
  }

  const seconds = Number(timestamp);

  if (!Number.isFinite(seconds)) {
    return false;
  }

  if (
    Math.abs(Date.now() / 1000 - seconds) > 300
  ) {
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

  const signedContent =
    `${webhookId}.${timestamp}.${rawBody}`;

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(signedContent)
  );

  const expected = bytesToBase64(
    new Uint8Array(signature)
  );

  return signatureHeader
    .split(/\s+/)
    .some((entry) => {
      const [version, value] = entry.split(",");

      return (
        version === "v1" &&
        value &&
        constantTimeEqual(value, expected)
      );
    });
}

// ============================================================
// USER LOOKUP
// ============================================================
//
// Prefer metadata.user_id.
// If absent, fall back to the customer's email.
//
// Email fallback is provided for compatibility with webhook
// payloads where subscription metadata is missing.
// ============================================================

async function findUserForWebhook(
  env,
  data
) {
  const metadata = data.metadata || {};

  let userId =
    metadata.user_id ||
    data.checkout_session?.metadata?.user_id ||
    data.payment?.metadata?.user_id ||
    null;

  if (userId) {
    const rows = await supabaseRequest(
      env,
      "/rest/v1/users" +
      `?id=eq.${encodeURIComponent(userId)}` +
      "&select=id,email,balance&limit=1"
    );

    if (Array.isArray(rows) && rows.length > 0) {
      return rows[0];
    }

    console.warn(
      "Metadata user_id did not match a user. Trying customer email."
    );
  }

  const email =
    data.customer?.email ||
    data.customer_email ||
    null;

  if (!email) {
    return null;
  }

  const rows = await supabaseRequest(
    env,
    "/rest/v1/users" +
    `?email=eq.${encodeURIComponent(email)}` +
    "&select=id,email,balance&limit=1"
  );

  if (!Array.isArray(rows) || rows.length === 0) {
    return null;
  }

  return rows[0];
}

// ============================================================
// EXISTING SUBSCRIPTION LOOKUP
// ============================================================

async function getExistingSubscription(
  env,
  userId
) {
  const rows = await supabaseRequest(
    env,
    "/rest/v1/user_subscriptions" +
    `?user_id=eq.${encodeURIComponent(userId)}` +
    "&select=id,user_id,dodo_customer_id," +
    "dodo_subscription_id,subscription_status," +
    "current_period_end,created_at,updated_at&limit=1"
  );

  return Array.isArray(rows) && rows.length > 0
    ? rows[0]
    : null;
}

// ============================================================
// CREDIT HELPERS
// ============================================================

// Trial rule:
// - Only set the balance to 20 when the existing balance is
//   zero or NULL.
// - Preserve positive balances.
//
// The conditional PATCH prevents overwriting a positive
// balance that was observed before this request.

async function grantTrialCredits(
  env,
  user
) {
  const current = Number(user.balance || 0);

  if (current > 0) {
    console.log("Trial credits not granted:", {
      user_id: user.id,
      reason: "Existing positive balance preserved",
      balance: current,
    });

    return {
      granted: false,
      reason: "existing_balance_preserved",
      balance: current,
    };
  }

  // Update only if the balance is still zero.
  const zeroRows = await supabaseRequest(
    env,
    "/rest/v1/users" +
    `?id=eq.${encodeURIComponent(user.id)}` +
    "&balance=eq.0" +
    "&select=id,balance",
    {
      method: "PATCH",
      headers: {
        "Prefer": "return=representation",
      },
      body: JSON.stringify({
        balance: TRIAL_CREDITS,
      }),
    }
  );

  if (
    Array.isArray(zeroRows) &&
    zeroRows.length > 0
  ) {
    console.log("Trial credits granted:", {
      user_id: user.id,
      credits: TRIAL_CREDITS,
    });

    return {
      granted: true,
      reason: "trial_balance_initialized",
      balance: Number(zeroRows[0].balance),
    };
  }

  // NULL balance requires a separate conditional update.
  const nullRows = await supabaseRequest(
    env,
    "/rest/v1/users" +
    `?id=eq.${encodeURIComponent(user.id)}` +
    "&balance=is.null" +
    "&select=id,balance",
    {
      method: "PATCH",
      headers: {
        "Prefer": "return=representation",
      },
      body: JSON.stringify({
        balance: TRIAL_CREDITS,
      }),
    }
  );

  if (
    Array.isArray(nullRows) &&
    nullRows.length > 0
  ) {
    console.log("Trial credits granted:", {
      user_id: user.id,
      credits: TRIAL_CREDITS,
    });

    return {
      granted: true,
      reason: "trial_balance_initialized",
      balance: Number(nullRows[0].balance),
    };
  }

  // Balance changed between lookup and update.
  return {
    granted: false,
    reason: "balance_changed_or_already_initialized",
  };
}

// Renewal rule:
// Set balance to 20, NOT current balance + 20.

async function resetRenewalCredits(
  env,
  userId
) {
  const rows = await supabaseRequest(
    env,
    "/rest/v1/users" +
    `?id=eq.${encodeURIComponent(userId)}` +
    "&select=id,balance",
    {
      method: "PATCH",
      headers: {
        "Prefer": "return=representation",
      },
      body: JSON.stringify({
        balance: RENEWAL_CREDITS,
      }),
    }
  );

  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(
      "Could not reset renewal credits: user was not updated."
    );
  }

  console.log("Renewal credits reset:", {
    user_id: userId,
    balance: Number(rows[0].balance),
  });

  return Number(rows[0].balance);
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

  console.log("Verified Dodo event:", {
    event_type: eventType,
    event_id: event.id || event.event_id || null,
  });

  // ----------------------------------------------------------
  // Subscription event allowlist
  // ----------------------------------------------------------

  const subscriptionEvents = new Set([
    "subscription.created",
    "subscription.active",
    "subscription.updated",
    "subscription.renewed",
    "subscription.on_hold",
    "subscription.failed",
    "subscription.past_due",
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

  const user = await findUserForWebhook(env, data);

  if (!user) {
    console.error(
      "Cannot map subscription event to a Reportli user.",
      {
        event_type: eventType,
        subscription_id:
          data.subscription_id || data.id || null,
      }
    );

    return json({
      ok: false,
      error:
        "Could not identify the Reportli user. Check subscription metadata and customer email.",
    }, 500);
  }

  const subscriptionId =
    data.subscription_id ||
    data.id ||
    null;

  if (!subscriptionId) {
    return json({
      ok: false,
      error: "Missing subscription ID in webhook.",
    }, 500);
  }

  // ----------------------------------------------------------
  // Determine subscription status
  // ----------------------------------------------------------

  const statusMap = {
    "subscription.created": "pending",
    "subscription.active": "active",
    "subscription.updated":
      data.status || "active",
    "subscription.renewed": "active",
    "subscription.on_hold": "on_hold",
    "subscription.failed": "failed",
    "subscription.past_due": "past_due",
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

  // ----------------------------------------------------------
  // Read existing subscription before updating it.
  // ----------------------------------------------------------

  const existing = await getExistingSubscription(
    env,
    user.id
  );

  const previousPeriodEnd =
    existing?.current_period_end || null;

  const newPeriodEnd = periodEnd
    ? new Date(periodEnd).toISOString()
    : null;

  // ----------------------------------------------------------
  // TRIAL CREDIT RULE
  // ----------------------------------------------------------
  //
  // Trial detection uses trial_period_days supplied in the
  // subscription payload.
  //
  // This only initializes the balance when it is zero/NULL.
  // Existing positive balances are preserved.
  //
  // IMPORTANT:
  // If Dodo does not include trial_period_days in a particular
  // event, this event cannot be reliably identified as trial
  // activation by this check alone.
  // ----------------------------------------------------------

  let creditResult = {
    processed: false,
    reason: "not_a_credit_event",
  };

  const trialDays = Number(
    data.trial_period_days || 0
  );

  const isTrialActivation =
    trialDays > 0 &&
    (
      eventType === "subscription.created" ||
      eventType === "subscription.active"
    );

  if (isTrialActivation) {
    creditResult = await grantTrialCredits(
      env,
      user
    );
  }

  // ----------------------------------------------------------
  // RENEWAL CREDIT RULE
  // ----------------------------------------------------------
  //
  // Only subscription.renewed can grant renewal credits here.
  //
  // subscription_period_count must be greater than 1 to avoid
  // treating the initial subscription period as a renewal.
  //
  // current_period_end is used as a best-effort duplicate
  // marker using your existing schema.
  // ----------------------------------------------------------

  const periodCount = Number(
    data.subscription_period_count || 0
  );

  const isSubsequentRenewal =
    eventType === "subscription.renewed" &&
    periodCount > 1;

  if (isSubsequentRenewal) {
    if (!newPeriodEnd) {
      console.error(
        "Renewal event has no billing-period end date."
      );

      return json({
        ok: false,
        error:
          "Cannot safely process renewal without next_billing_date or current_period_end.",
      }, 500);
    }

    if (
      previousPeriodEnd &&
      newPeriodEnd ===
        new Date(previousPeriodEnd).toISOString()
    ) {
      console.log("Duplicate renewal period ignored:", {
        user_id: user.id,
        subscription_id: subscriptionId,
        period_end: newPeriodEnd,
      });

      creditResult = {
        processed: false,
        reason: "duplicate_renewal_period",
      };
    } else {
      const newBalance = await resetRenewalCredits(
        env,
        user.id
      );

      creditResult = {
        processed: true,
        reason: "subsequent_monthly_renewal",
        balance: newBalance,
      };
    }
  }

  // ----------------------------------------------------------
  // SAVE SUBSCRIPTION
  // ----------------------------------------------------------

  const subscription = {
    user_id: user.id,
    dodo_customer_id: customerId,
    dodo_subscription_id: subscriptionId,
    subscription_status: statusMap[eventType],
    current_period_end: newPeriodEnd,
    updated_at: new Date().toISOString(),
  };

  await supabaseRequest(
    env,
    "/rest/v1/user_subscriptions?on_conflict=user_id",
    {
      method: "POST",
      headers: {
        "Prefer":
          "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(subscription),
    }
  );

  console.log("Subscription webhook processed:", {
    user_id: user.id,
    event_type: eventType,
    subscription_status: statusMap[eventType],
    credit_result: creditResult,
  });

  return json({
    ok: true,
    received: true,
    subscription_updated: true,
    event_type: eventType,
    subscription_status: statusMap[eventType],
    credits: creditResult,
  });
}

// ============================================================
// RETURN HANDLER
// ============================================================

function handleReturn(env) {
  const destination =
    env.FRONTEND_SETTINGS_URL ||
    "https://reportliai.sbs/settings";

  return Response.redirect(destination, 303);
        }
