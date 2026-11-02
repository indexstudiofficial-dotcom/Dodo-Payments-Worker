// ============================================================
// REPORTLI AI — DODO PAYMENTS WORKER
// ============================================================
//
// ROUTES:
// GET  /health
// POST /checkout
// POST /webhook
// GET  /return
//
// SUPABASE TABLES:
// public.users
// public.user_subscriptions
//
// REQUIRED SECRETS:
// SUPABASE_SERVICE_ROLE_KEY
// DODO_PAYMENTS_API_KEY
// DODO_PAYMENTS_WEBHOOK_KEY
//
// REQUIRED VARIABLES:
// SUPABASE_URL
// DODO_PRODUCT_ID_MONTHLY
// DODO_PRODUCT_ID_YEARLY
// DODO_PRODUCT_ID_ONE_TIME
// DODO_PAYMENTS_ENVIRONMENT
// FRONTEND_SETTINGS_URL
//
// OPTIONAL SECRET:
// CHECKOUT_API_SECRET
//
// ============================================================

const LIVE_API = "https://live.dodopayments.com";
const TEST_API = "https://test.dodopayments.com";

const ALLOWED_ORIGIN = "https://reportliai.sbs";

const RETURN_URL =
  "https://dodo-payments-worker.reportliaihq.workers.dev/return";

const TRIAL_CREDITS = 20;
const RENEWAL_CREDITS = 20;

// ============================================================
// PRODUCT CONFIGURATION
// ============================================================

function getProductConfig(env) {
  return {
    monthly: {
      product_id: env.DODO_PRODUCT_ID_MONTHLY,
      plan_name: "Premium",
      billing_period: "monthly",
    },

    yearly: {
      product_id: env.DODO_PRODUCT_ID_YEARLY,
      plan_name: "Premium",
      billing_period: "yearly",
    },

    one_time: {
      product_id: env.DODO_PRODUCT_ID_ONE_TIME,
      plan_name: "Premium",
      billing_period: "one_time",
    },
  };
}

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
        error: error?.message || "Internal server error",
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
// CONFIGURATION VALIDATION
// ============================================================

function validateConfig(env) {
  const required = [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "DODO_PAYMENTS_API_KEY",
    "DODO_PAYMENTS_WEBHOOK_KEY",
    "DODO_PRODUCT_ID_MONTHLY",
    "DODO_PRODUCT_ID_YEARLY",
    "DODO_PRODUCT_ID_ONE_TIME",
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
    !["live_mode", "test_mode"].includes(
      env.DODO_PAYMENTS_ENVIRONMENT
    )
  ) {
    throw new Error(
      "DODO_PAYMENTS_ENVIRONMENT must be live_mode or test_mode"
    );
  }

  const settingsUrl = new URL(
    env.FRONTEND_SETTINGS_URL
  );

  if (settingsUrl.protocol !== "https:") {
    throw new Error(
      "FRONTEND_SETTINGS_URL must use HTTPS"
    );
  }

  const products = getProductConfig(env);
  const ids = Object.values(products).map(
    product => product.product_id
  );

  if (new Set(ids).size !== 3) {
    throw new Error(
      "The three Dodo product IDs must be different."
    );
  }
}

function dodoBaseUrl(env) {
  return env.DODO_PAYMENTS_ENVIRONMENT === "live_mode"
    ? LIVE_API
    : TEST_API;
}

// ============================================================
// CHECKOUT AUTHORIZATION
// ============================================================

function authorizeCheckout(request, env) {
  if (!env.CHECKOUT_API_SECRET) {
    console.warn(
      "WARNING: Checkout endpoint has no shared-secret protection."
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
// SUPABASE REQUEST
// ============================================================

async function supabaseRequest(
  env,
  path,
  options = {}
) {
  const base = env.SUPABASE_URL.replace(/\/+$/, "");

  const response = await fetch(
    `${base}${path}`,
    {
      ...options,
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization:
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
      `Supabase request failed (${response.status}).`
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
      error: "Invalid JSON request.",
    }, 400);
  }

  if (
    !body ||
    typeof body.user_id !== "string" ||
    !body.user_id.trim()
  ) {
    return json({
      ok: false,
      error: "Missing user_id.",
    }, 400);
  }

  const requestedPlan = body.plan;

  const products = getProductConfig(env);

  const selectedProduct = products[requestedPlan];

  if (!selectedProduct) {
    return json({
      ok: false,
      error: "Invalid plan. Use monthly, yearly or one_time.",
    }, 400);
  }

  const userId = body.user_id.trim();

  const users = await supabaseRequest(
    env,
    "/rest/v1/users" +
    `?id=eq.${encodeURIComponent(userId)}` +
    "&select=id,email,display_name,balance&limit=1"
  );

  if (!Array.isArray(users) || users.length === 0) {
    return json({
      ok: false,
      error: "User not found.",
    }, 404);
  }

  const user = users[0];

  if (!user.email) {
    return json({
      ok: false,
      error: "User email is missing.",
    }, 400);
  }

  const payload = {
    product_cart: [
      {
        product_id: selectedProduct.product_id,
        quantity: 1,
      },
    ],

    customer: {
      email: user.email,

      ...(user.display_name
        ? { name: user.display_name }
        : {}),
    },

    metadata: {
      user_id: user.id,
      plan_name: selectedProduct.plan_name,
      billing_period: selectedProduct.billing_period,
      source: "reportli_ai",
    },

    return_url: RETURN_URL,
  };

  const response = await fetch(
    `${dodoBaseUrl(env)}/checkouts`,
    {
      method: "POST",

      headers: {
        Authorization:
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
    });

    return json({
      ok: false,
      error: "Dodo could not create checkout.",
      provider_status: response.status,
    }, 502);
  }

  const checkoutUrl =
    result.checkout_url ||
    result.checkoutUrl;

  if (
    typeof checkoutUrl !== "string" ||
    !checkoutUrl.startsWith("https://")
  ) {
    return json({
      ok: false,
      error: "Invalid checkout URL returned by Dodo.",
    }, 502);
  }

  return json({
    ok: true,
    checkout_url: checkoutUrl,
    plan_name: selectedProduct.plan_name,
    billing_period: selectedProduct.billing_period,
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
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
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

  if (
    !Number.isFinite(seconds) ||
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

  return signatureHeader.split(/\s+/).some(entry => {
    const [version, value] = entry.split(",");

    return (
      version === "v1" &&
      value &&
      constantTimeEqual(value, expected)
    );
  });
}

// ============================================================
// PRODUCT IDENTIFICATION
// ============================================================

function findProductId(data) {
  if (!data || typeof data !== "object") {
    return null;
  }

  if (data.product_id) {
    return data.product_id;
  }

  if (data.product?.product_id) {
    return data.product.product_id;
  }

  if (data.product?.id) {
    return data.product.id;
  }

  if (Array.isArray(data.product_cart)) {
    const item = data.product_cart[0];

    if (item?.product_id) {
      return item.product_id;
    }
  }

  if (Array.isArray(data.items)) {
    const item = data.items[0];

    if (item?.product_id) {
      return item.product_id;
    }
  }

  if (data.payment) {
    return findProductId(data.payment);
  }

  if (data.checkout_session) {
    return findProductId(data.checkout_session);
  }

  return null;
}

function identifyPlan(data, env) {
  const products = getProductConfig(env);

  const productId = findProductId(data);

  if (productId) {
    for (const [key, product] of Object.entries(products)) {
      if (product.product_id === productId) {
        return {
          ...product,
          product_id: productId,
          plan_key: key,
        };
      }
    }
  }

  // Fallback to metadata created by our checkout endpoint.
  const metadata =
    data.metadata ||
    data.payment?.metadata ||
    data.checkout_session?.metadata ||
    {};

  const billingPeriod = metadata.billing_period;

  if (billingPeriod && products[billingPeriod]) {
    return {
      ...products[billingPeriod],
      plan_key: billingPeriod,
    };
  }

  return null;
}

// ============================================================
// USER LOOKUP
// ============================================================

async function findUserForWebhook(env, data) {
  const metadata =
    data.metadata ||
    data.payment?.metadata ||
    data.checkout_session?.metadata ||
    {};

  const userId =
    metadata.user_id ||
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
  }

  const email =
    data.customer?.email ||
    data.customer_email ||
    data.payment?.customer?.email ||
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

  return Array.isArray(rows) && rows.length > 0
    ? rows[0]
    : null;
}

// ============================================================
// EXISTING SUBSCRIPTION LOOKUP
// ============================================================

async function getExistingSubscription(env, userId) {
  const rows = await supabaseRequest(
    env,
    "/rest/v1/user_subscriptions" +
    `?user_id=eq.${encodeURIComponent(userId)}` +
    "&select=id,user_id,dodo_customer_id," +
    "dodo_subscription_id,subscription_status," +
    "current_period_end,plan_name,billing_period&limit=1"
  );

  return Array.isArray(rows) && rows.length > 0
    ? rows[0]
    : null;
}

// ============================================================
// TRIAL CREDITS
// ============================================================

async function grantTrialCredits(env, user) {
  const current = Number(user.balance || 0);

  if (current > 0) {
    return {
      granted: false,
      reason: "existing_balance_preserved",
      balance: current,
    };
  }

  const paths = [
    "/rest/v1/users" +
    `?id=eq.${encodeURIComponent(user.id)}` +
    "&balance=eq.0",

    "/rest/v1/users" +
    `?id=eq.${encodeURIComponent(user.id)}` +
    "&balance=is.null",
  ];

  for (const path of paths) {
    const rows = await supabaseRequest(
      env,
      path + "&select=id,balance",
      {
        method: "PATCH",
        headers: {
          Prefer: "return=representation",
        },
        body: JSON.stringify({
          balance: TRIAL_CREDITS,
        }),
      }
    );

    if (Array.isArray(rows) && rows.length > 0) {
      return {
        granted: true,
        reason: "trial_balance_initialized",
        balance: Number(rows[0].balance),
      };
    }
  }

  return {
    granted: false,
    reason: "balance_changed_or_already_initialized",
  };
}

// ============================================================
// RENEWAL CREDITS
// ============================================================

async function resetRenewalCredits(env, userId) {
  const rows = await supabaseRequest(
    env,
    "/rest/v1/users" +
    `?id=eq.${encodeURIComponent(userId)}` +
    "&select=id,balance",
    {
      method: "PATCH",
      headers: {
        Prefer: "return=representation",
      },
      body: JSON.stringify({
        balance: RENEWAL_CREDITS,
      }),
    }
  );

  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(
      "Could not reset renewal credits."
    );
  }

  return Number(rows[0].balance);
}

// ============================================================
// SAVE SUBSCRIPTION
// ============================================================

async function saveSubscription(
  env,
  subscription
) {
  await supabaseRequest(
    env,
    "/rest/v1/user_subscriptions?on_conflict=user_id",
    {
      method: "POST",
      headers: {
        Prefer:
          "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(subscription),
    }
  );
}

// ============================================================
// HANDLE WEBHOOK
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
  // ONE-TIME PAYMENT
  // ----------------------------------------------------------

  if (eventType === "payment.succeeded") {
    const plan = identifyPlan(data, env);

    if (!plan || plan.plan_key !== "one_time") {
      return json({
        ok: true,
        ignored: true,
        reason: "Not a recognized one-time product.",
      });
    }

    const user = await findUserForWebhook(env, data);

    if (!user) {
      throw new Error(
        "Could not identify user for one-time payment."
      );
    }

    const customerId =
      data.customer?.customer_id ||
      data.customer_id ||
      null;

    await saveSubscription(env, {
      user_id: user.id,
      dodo_customer_id: customerId,
      dodo_subscription_id: null,
      subscription_status: "active",
      plan_name: plan.plan_name,
      billing_period: plan.billing_period,
      current_period_end: null,
      updated_at: new Date().toISOString(),
    });

    console.log("One-time payment saved:", {
      user_id: user.id,
      plan_name: plan.plan_name,
      billing_period: plan.billing_period,
    });

    return json({
      ok: true,
      received: true,
      plan_name: plan.plan_name,
      billing_period: plan.billing_period,
    });
  }

  // ----------------------------------------------------------
  // SUBSCRIPTION EVENTS
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

  const plan = identifyPlan(data, env);

  if (
    !plan ||
    !["monthly", "yearly"].includes(plan.plan_key)
  ) {
    throw new Error(
      "Could not identify monthly or yearly product from webhook."
    );
  }

  const user = await findUserForWebhook(env, data);

  if (!user) {
    throw new Error(
      "Could not identify Reportli user."
    );
  }

  const subscriptionId =
    data.subscription_id ||
    data.id ||
    null;

  if (!subscriptionId) {
    throw new Error(
      "Missing subscription ID."
    );
  }

  // ----------------------------------------------------------
  // STATUS
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

  const newPeriodEnd = periodEnd
    ? new Date(periodEnd).toISOString()
    : null;

  const existing = await getExistingSubscription(
    env,
    user.id
  );

  const previousPeriodEnd =
    existing?.current_period_end || null;

  // ----------------------------------------------------------
  // TRIAL CREDITS
  // ----------------------------------------------------------

  let creditResult = {
    processed: false,
    reason: "not_a_credit_event",
  };

  const trialDays = Number(
    data.trial_period_days || 0
  );

  const isTrialActivation =
    (
      trialDays > 0 ||
      data.status === "trialing"
    ) &&
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
  // SUBSEQUENT RENEWAL CREDITS
  // ----------------------------------------------------------

  const periodCount = Number(
    data.subscription_period_count || 0
  );

  const isSubsequentRenewal =
    eventType === "subscription.renewed" &&
    periodCount > 1;

  if (isSubsequentRenewal) {
    if (!newPeriodEnd) {
      throw new Error(
        "Renewal missing billing-period end date."
      );
    }

    const previousEnd = previousPeriodEnd
      ? new Date(previousPeriodEnd).toISOString()
      : null;

    if (previousEnd === newPeriodEnd) {
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
        reason: "subscription_renewal",
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

    // NEW FIELDS
    plan_name: plan.plan_name,
    billing_period: plan.billing_period,

    current_period_end: newPeriodEnd,
    updated_at: new Date().toISOString(),
  };

  await saveSubscription(env, subscription);

  console.log("Subscription saved:", {
    user_id: user.id,
    plan_name: plan.plan_name,
    billing_period: plan.billing_period,
    subscription_status: statusMap[eventType],
    credit_result: creditResult,
  });

  return json({
    ok: true,
    received: true,
    subscription_updated: true,
    plan_name: plan.plan_name,
    billing_period: plan.billing_period,
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
