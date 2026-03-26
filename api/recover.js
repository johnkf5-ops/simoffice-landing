const { Redis } = require('@upstash/redis');

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email } = req.body || {};
  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: 'Email required' });
  }

  const normalizedEmail = email.toLowerCase().trim();

  // Rate limit: 3 per email per hour
  const rateKey = `recover_rate:${normalizedEmail}`;
  const count = await redis.incr(rateKey);
  if (count === 1) await redis.expire(rateKey, 3600);
  if (count > 3) {
    // Silent rate limit — always return success to prevent email enumeration
    return res.status(200).json({ success: true });
  }

  // Lookup chain: email → customer → license key
  const customerId = await redis.get(`email:${normalizedEmail}`);
  if (!customerId) return res.status(200).json({ success: true }); // silent — don't leak

  const licenseKey = await redis.get(`customer:${customerId}`);
  if (!licenseKey) return res.status(200).json({ success: true });

  // Send recovery email (non-blocking — don't fail if email fails)
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'SimOffice <noreply@simoffice.xyz>',
        to: normalizedEmail,
        subject: 'Your SimOffice License Key',
        text: [
          `Your license key: ${licenseKey}`,
          '',
          'Enter this key in SimOffice to activate.',
          '',
          "If you didn't request this, you can ignore this email.",
        ].join('\n'),
      }),
    });
  } catch {
    // Don't fail the response if email fails
  }

  return res.status(200).json({ success: true });
};
