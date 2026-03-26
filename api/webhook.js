const crypto = require('crypto');
const { Redis } = require('@upstash/redis');

// CRITICAL: Disable Vercel body parsing — Stripe signature verification needs raw body
module.exports.config = { api: { bodyParser: false } };

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function verifyStripeSignature(rawBody, sigHeader, secret) {
  const parts = sigHeader.split(',').reduce((acc, part) => {
    const [key, val] = part.split('=');
    acc[key] = val;
    return acc;
  }, {});
  const timestamp = parts.t;
  const signature = parts.v1;
  if (!timestamp || !signature) return false;

  const signedPayload = `${timestamp}.${rawBody}`;
  const expected = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');

  // Timing-safe comparison
  if (signature.length !== expected.length) return false;
  const isValid = crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));

  // Reject if timestamp is older than 5 minutes (replay protection)
  const age = Math.abs(Date.now() / 1000 - parseInt(timestamp));
  return isValid && age < 300;
}

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function stripeGet(path) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const options = {
      hostname: 'api.stripe.com',
      port: 443,
      path: `/v1${path}`,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}` },
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error(body)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function sendLicenseEmail(email, licenseKey) {
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'SimOffice <noreply@simoffice.xyz>',
        to: email,
        subject: 'Your SimOffice License Key',
        text: [
          'Welcome to SimOffice!',
          '',
          `Your license key: ${licenseKey}`,
          '',
          'Enter this key when you first open SimOffice to activate.',
          '',
          'Your 3-day free trial has started. Add a payment method at any time',
          'to continue after the trial: https://simoffice.xyz',
          '',
          'Lost your key? Recover it at https://simoffice.xyz/recover.html',
        ].join('\n'),
      }),
    });
  } catch (err) {
    // Email is convenience, not critical path — key is shown on download page
    console.error('Resend email failed:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

async function handleCheckoutCompleted(event) {
  const session = event.data.object;
  const licenseKey = session.metadata?.license_key;
  if (!licenseKey) {
    console.error('checkout.session.completed missing license_key in metadata');
    return;
  }

  const customerId = session.customer;
  const subscriptionId = session.subscription;
  const email = (session.customer_details?.email || '').toLowerCase();

  // Fetch subscription to get trial_end / current_period_end
  let validUntil = Math.floor(Date.now() / 1000) + (3 * 86400); // fallback: 3 days
  if (subscriptionId) {
    try {
      const sub = await stripeGet(`/subscriptions/${subscriptionId}`);
      validUntil = sub.trial_end || sub.current_period_end || validUntil;
    } catch (err) {
      console.error('Failed to fetch subscription:', err.message);
    }
  }

  // Store license in Redis (idempotent — hset overwrites)
  await redis.hset(`license:${licenseKey}`, {
    customer_id: customerId,
    subscription_id: subscriptionId,
    email,
    status: 'trialing',
    valid_until: String(validUntil),
    created_at: String(Math.floor(Date.now() / 1000)),
  });

  // Create lookup mappings
  await redis.set(`customer:${customerId}`, licenseKey);
  if (email) await redis.set(`email:${email}`, customerId);

  // Send welcome email with license key
  if (email) await sendLicenseEmail(email, licenseKey);
}

async function handleInvoicePaid(event) {
  const invoice = event.data.object;

  // Skip $0 invoices (trial invoices)
  if (!invoice.amount_paid || invoice.amount_paid <= 0) return;

  const customerId = invoice.customer;
  const licenseKey = await redis.get(`customer:${customerId}`);
  if (!licenseKey) return;

  // Get period end from invoice line items
  const periodEnd = invoice.lines?.data?.[0]?.period?.end;
  if (!periodEnd) return;

  // valid_until = period end + 3 days grace
  const validUntil = periodEnd + (3 * 86400);

  await redis.hset(`license:${licenseKey}`, {
    status: 'active',
    valid_until: String(validUntil),
  });
}

async function handleInvoicePaymentFailed(event) {
  const invoice = event.data.object;
  const customerId = invoice.customer;
  const licenseKey = await redis.get(`customer:${customerId}`);
  if (!licenseKey) return;

  await redis.hset(`license:${licenseKey}`, { status: 'past_due' });
}

async function handleSubscriptionUpdated(event) {
  const subscription = event.data.object;
  const customerId = subscription.customer;
  const licenseKey = await redis.get(`customer:${customerId}`);
  if (!licenseKey) return;

  // User clicked cancel in portal — access continues until period end
  if (subscription.cancel_at_period_end === true && subscription.status === 'active') {
    await redis.hset(`license:${licenseKey}`, { status: 'canceling' });
    return;
  }

  // Recovery from past_due → active
  if (subscription.status === 'active') {
    await redis.hset(`license:${licenseKey}`, { status: 'active' });
  }
}

async function handleSubscriptionDeleted(event) {
  const subscription = event.data.object;
  const customerId = subscription.customer;
  const licenseKey = await redis.get(`customer:${customerId}`);
  if (!licenseKey) return;

  // 7-day grace period after cancellation to allow re-subscribe
  const validUntil = Math.floor(Date.now() / 1000) + (7 * 86400);
  await redis.hset(`license:${licenseKey}`, {
    status: 'canceled',
    valid_until: String(validUntil),
  });
}

// trial_will_end — informational only, could send reminder email in future
async function handleTrialWillEnd(_event) {
  // No action needed for v1 — user sees trial banner in app
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

const EVENT_HANDLERS = {
  'checkout.session.completed': handleCheckoutCompleted,
  'invoice.paid': handleInvoicePaid,
  'invoice.payment_failed': handleInvoicePaymentFailed,
  'customer.subscription.updated': handleSubscriptionUpdated,
  'customer.subscription.deleted': handleSubscriptionDeleted,
  'customer.subscription.trial_will_end': handleTrialWillEnd,
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Read raw body for signature verification
  let rawBody;
  try {
    rawBody = await getRawBody(req);
  } catch {
    return res.status(400).json({ error: 'Could not read request body' });
  }

  // Verify Stripe signature
  const sigHeader = req.headers['stripe-signature'];
  if (!sigHeader || !verifyStripeSignature(rawBody, sigHeader, process.env.STRIPE_WEBHOOK_SECRET)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  // Event deduplication — Stripe has "at least once" delivery
  const eventObj = event.data?.object;
  if (eventObj?.id) {
    const dedupeKey = `stripe:processed:${eventObj.id}:${event.type}`;
    const already = await redis.get(dedupeKey);
    if (already) return res.status(200).json({ received: true });
    // Mark as processed (4-day TTL > Stripe's 3-day retry window)
    await redis.set(dedupeKey, '1', { ex: 4 * 86400 });
  }

  // Route to handler
  const handler = EVENT_HANDLERS[event.type];
  if (handler) {
    try {
      await handler(event);
    } catch (err) {
      console.error(`Webhook handler error for ${event.type}:`, err);
      // Return 200 anyway to prevent Stripe from retrying on our app errors
      // The event is already deduped, and retrying won't help with code bugs
    }
  }

  return res.status(200).json({ received: true });
};
