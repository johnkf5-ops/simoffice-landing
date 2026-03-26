const crypto = require('crypto');
const https = require('https');
const querystring = require('querystring');

const PRICE_ID = process.env.STRIPE_PRICE_ID || 'price_1TFHPT25bYDK6Cmkf0pZx7hr';

function stripeRequest(path, data) {
  return new Promise((resolve, reject) => {
    const body = querystring.stringify(data);
    const options = {
      hostname: 'api.stripe.com',
      port: 443,
      path: `/v1${path}`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => { responseBody += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(responseBody)); }
        catch { reject(new Error(responseBody)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const origin = req.headers.origin || 'https://simoffice.xyz';

  try {
    // Generate license key: SO_ + 32 random base64url characters
    const licenseKey = `SO_${crypto.randomBytes(24).toString('base64url')}`;

    const session = await stripeRequest('/checkout/sessions', {
      mode: 'subscription',
      // Let Stripe Dashboard manage payment methods dynamically
      // payment_method_collection: 'if_required' skips CC form when amount due is $0 (trial)
      'payment_method_collection': 'if_required',
      'line_items[0][price]': PRICE_ID,
      'line_items[0][quantity]': 1,
      'subscription_data[trial_period_days]': 3,
      'subscription_data[trial_settings][end_behavior][missing_payment_method]': 'cancel',
      // License key in BOTH session metadata (readable by download page)
      // AND subscription_data.metadata (flows to subscription, readable by webhooks)
      'subscription_data[metadata][license_key]': licenseKey,
      'metadata[license_key]': licenseKey,
      allow_promotion_codes: 'true',
      success_url: `${origin}/download.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/#download`,
    });

    if (session.error) {
      return res.status(500).json({ error: session.error.message });
    }

    res.status(200).json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create checkout session', detail: err.message });
  }
};
