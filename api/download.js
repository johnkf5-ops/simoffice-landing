const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const DOWNLOADS = {
  arm64: 'https://github.com/johnkf5-ops/simoffice/releases/download/v1.0.0-beta/SimOffice-1.0.0-mac-arm64.dmg',
  x64: 'https://github.com/johnkf5-ops/simoffice/releases/download/v1.0.0-beta/SimOffice-1.0.0-mac-x64.dmg',
};

module.exports = async (req, res) => {
  const { session_id, arch } = req.query;

  if (!session_id) {
    return res.status(400).json({ error: 'Missing session_id' });
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);

    // Verify payment succeeded or trial is active
    if (session.payment_status === 'paid' || session.status === 'complete') {
      const url = DOWNLOADS[arch] || DOWNLOADS.arm64;
      return res.status(200).json({ url, valid: true });
    }

    return res.status(403).json({ error: 'Payment not completed', valid: false });
  } catch (err) {
    console.error('Download verification error:', err.message);
    return res.status(500).json({ error: 'Verification failed', valid: false });
  }
};
