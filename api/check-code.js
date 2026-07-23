// api/check-code.js
// Called by success.html after a Stripe Checkout redirect. Given a
// checkout session id, returns the access code once the stripe-webhook
// handler has generated it (usually within a couple seconds of payment).
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
  const sessionId = req.query.session_id;

  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'Missing session_id' });
  }

  try {
    const code = await redisCmd('get', `session:${sessionId}`);
    if (!code) {
      return res.status(200).json({ ready: false });
    }
    return res.status(200).json({ ready: true, code });
  } catch (err) {
    console.error('check-code error:', err.message);
    return res.status(500).json({ error: 'Could not check status' });
  }
}
