// api/check-code.js
// Called by success.html after checkout. Given the access code (passed back
// via the redirect_url query string from start-checkout.js), reports whether
// the Lemon Squeezy webhook has activated it yet.
//
// Requires: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN

async function redisCmd(...parts) {
  const url = `${process.env.UPSTASH_REDIS_REST_URL}/${parts.map(encodeURIComponent).join('/')}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` },
  });
  const data = await response.json();
  return data.result;
}

export default async function handler(req, res) {
  const code = req.query.code;

  if (!code || typeof code !== 'string') {
    return res.status(400).json({ error: 'Missing code' });
  }

  try {
    const raw = await redisCmd('get', `access:${code}`);
    if (!raw) {
      return res.status(200).json({ ready: false });
    }
    const access = JSON.parse(raw);
    return res.status(200).json({ ready: !!access.active });
  } catch (err) {
    console.error('check-code error:', err.message);
    return res.status(500).json({ error: 'Could not check status' });
  }
}
