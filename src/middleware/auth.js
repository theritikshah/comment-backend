const crypto = require('crypto');

const { authToken } = require('../config');

function safeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

// Simple shared-token auth: requests must send `Authorization: Bearer <API_AUTH_TOKEN>`.
function requireAuth(req, res, next) {
  if (!authToken) {
    return res.status(500).json({ error: 'API_AUTH_TOKEN is not set' });
  }

  const [scheme, token] = (req.get('authorization') || '').split(' ');
  if (scheme !== 'Bearer' || !token || !safeEqual(token, authToken)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
}

module.exports = { requireAuth };
