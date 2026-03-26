const { Redis } = require('@upstash/redis');

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { key } = req.body || {};
  if (!key || typeof key !== 'string') {
    return res.status(400).json({ valid: false, reason: 'missing_key' });
  }

  const license = await redis.hgetall(`license:${key}`);

  // hgetall returns null for non-existent keys (verified)
  if (!license) {
    return res.status(200).json({ valid: false, reason: 'not_found' });
  }

  const now = Math.floor(Date.now() / 1000);
  const validUntil = parseInt(license.valid_until) || 0;
  const status = license.status;

  // Canceled and past grace period
  if (status === 'canceled' && validUntil < now) {
    return res.status(200).json({ valid: false, reason: 'canceled' });
  }

  // Any non-active/trialing status where valid_until has passed
  if (validUntil > 0 && validUntil < now && status !== 'active' && status !== 'trialing') {
    return res.status(200).json({ valid: false, reason: 'expired' });
  }

  // Valid states: trialing, active, past_due, canceling (still within period)
  return res.status(200).json({
    valid: true,
    status,
    valid_until: validUntil,
    email: license.email || null,
  });
};
