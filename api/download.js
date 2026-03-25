const https = require('https');

const DOWNLOADS = {
  arm64: 'https://github.com/johnkf5-ops/simoffice/releases/download/v1.2.3/SimOffice-1.2.3-mac-arm64.dmg',
  x64: 'https://github.com/johnkf5-ops/simoffice/releases/download/v1.2.3/SimOffice-1.2.3-mac-x64.dmg',
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

    if (session.payment_status === 'paid' || session.status === 'complete') {
      const url = DOWNLOADS[arch] || DOWNLOADS.arm64;
      return res.status(200).json({ url, valid: true });
    }

    return res.status(403).json({ error: 'Payment not completed', valid: false });
  } catch (err) {
    return res.status(500).json({ error: 'Verification failed', valid: false });
  }
};
