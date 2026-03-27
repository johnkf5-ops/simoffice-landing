const https = require('https');
const { Redis } = require('@upstash/redis');

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const DOWNLOADS = {
  arm64: 'https://github.com/johnkf5-ops/simoffice/releases/download/v2.0.4/SimOffice-2.0.4-mac-arm64.dmg',
  x64: 'https://github.com/johnkf5-ops/simoffice/releases/download/v2.0.4/SimOffice-2.0.4-mac-x64.dmg',
};

function stripeGet(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.stripe.com',
      port: 443,
      path: `/v1${path}`,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      },
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

module.exports = async (req, res) => {
  const { session_id, arch } = req.query;

  if (!session_id) {
    return res.status(400).json({ error: 'Missing session_id' });
  }

  try {
    const session = await stripeGet(`/checkout/sessions/${session_id}`);
    const licenseKey = session.metadata?.license_key || null;

    if (session.payment_status === 'paid' || session.payment_status === 'no_payment_required') {
      // CRITICAL: Eager write to Redis — user lands here BEFORE webhook fires
      // Webhook is an idempotent backup (hset overwrites with same data)
      if (licenseKey) {
        const customerId = session.customer;
        const subscriptionId = session.subscription;
        const email = (session.customer_details?.email || '').toLowerCase();

        // Fetch subscription to get trial_end / current_period_end
        let validUntil = Math.floor(Date.now() / 1000) + (3 * 86400); // fallback: 3 days
        if (subscriptionId) {
          try {
            const sub = await stripeGet(`/subscriptions/${subscriptionId}`);
            validUntil = sub.trial_end || sub.current_period_end || validUntil;
          } catch {
            // Use fallback validUntil
          }
        }

        await redis.hset(`license:${licenseKey}`, {
          customer_id: customerId,
          subscription_id: subscriptionId,
          email,
          status: 'trialing',
          valid_until: String(validUntil),
          created_at: String(Math.floor(Date.now() / 1000)),
        });
        await redis.set(`customer:${customerId}`, licenseKey);
        if (email) await redis.set(`email:${email}`, customerId);
      }

      const url = DOWNLOADS[arch] || DOWNLOADS.arm64;
      return res.status(200).json({ url, valid: true, license_key: licenseKey });
    }

    return res.status(403).json({ error: 'Payment not completed', valid: false });
  } catch (err) {
    return res.status(500).json({ error: 'Verification failed', valid: false });
  }
};
