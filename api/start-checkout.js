// api/start-checkout.js
// Generates a fresh access code, stores it as "pending" (inactive) in Redis,
// and returns a Lemon Squeezy checkout URL with that code attached as custom
// data. The webhook (lemonsqueezy-webhook.js) activates the code once
// payment actually succeeds.
//
// Requires these Vercel environment variables:
//   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, LEMONSQUEEZY_CHECKOUT_URL
//
// LEMONSQUEEZY_CHECKOUT_URL should be the base "Buy" link for your
// subscription product/variant, e.g.
//   https://yourstore.lemonsqueezy.com/buy/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx

async function redisCmd(...parts) {
  const url = `${process.env.UPSTASH_REDIS_REST_URL}/${parts.map(encodeURIComponent).join('/')}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` },
  });
  const data = await response.json();
  return data.result;
}

function generateAccessCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 12; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
    if (i === 3 || i === 7) code += '-';
  }
  return code;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const baseUrl = process.env.LEMONSQUEEZY_CHECKOUT_URL;
  if (!baseUrl) {
    return res.status(500).json({ error: 'Checkout is not configured yet.' });
  }

  try {
    const code = generateAccessCode();

    await redisCmd('set', `access:${code}`, JSON.stringify({
      active: false,
      createdAt: Date.now(),
    }));

    const separator = baseUrl.includes('?') ? '&' : '?';
    const checkoutUrl = `${baseUrl}${separator}checkout[custom][code]=${encodeURIComponent(code)}`;

    return res.status(200).json({ code, checkoutUrl });
  } catch (err) {
    console.error('start-checkout error:', err.message);
    return res.status(500).json({ error: 'Could not start checkout' });
  }
}
