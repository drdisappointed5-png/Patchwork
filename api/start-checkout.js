// api/start-checkout.js
// Creates a Lemon Squeezy checkout via their API (not a static hosted link),
// which is the only way to set a real post-payment redirect_url. Also
// generates a fresh access code, stores it as "pending" in Redis, and
// attaches it to the checkout as custom data so the webhook can activate it.
//
// The access code is also appended to the redirect_url as a query param so
// success.html knows which code to poll for after Lemon Squeezy redirects back.
//
// Requires these Vercel environment variables:
//   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN,
//   LEMONSQUEEZY_API_KEY, LEMONSQUEEZY_STORE_ID, LEMONSQUEEZY_VARIANT_ID

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

  const { LEMONSQUEEZY_API_KEY, LEMONSQUEEZY_STORE_ID, LEMONSQUEEZY_VARIANT_ID } = process.env;
  if (!LEMONSQUEEZY_API_KEY || !LEMONSQUEEZY_STORE_ID || !LEMONSQUEEZY_VARIANT_ID) {
    return res.status(500).json({ error: 'Checkout is not configured yet.' });
  }

  try {
    const code = generateAccessCode();

    await redisCmd('set', `access:${code}`, JSON.stringify({
      active: false,
      createdAt: Date.now(),
    }));

    const lsResponse = await fetch('https://api.lemonsqueezy.com/v1/checkouts', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${LEMONSQUEEZY_API_KEY}`,
        'Content-Type': 'application/vnd.api+json',
        Accept: 'application/vnd.api+json',
      },
      body: JSON.stringify({
        data: {
          type: 'checkouts',
          attributes: {
            product_options: {
              redirect_url: `https://patchwork-rho.vercel.app/success.html?code=${code}`,
            },
            checkout_data: {
              custom: { code },
            },
          },
          relationships: {
            store: { data: { type: 'stores', id: String(LEMONSQUEEZY_STORE_ID) } },
            variant: { data: { type: 'variants', id: String(LEMONSQUEEZY_VARIANT_ID) } },
          },
        },
      }),
    });

    if (!lsResponse.ok) {
      const errText = await lsResponse.text();
      console.error('Lemon Squeezy checkout creation failed:', lsResponse.status, errText);
      return res.status(502).json({ error: `Could not create checkout (${lsResponse.status})` });
    }

    const lsData = await lsResponse.json();
    const checkoutUrl = lsData.data.attributes.url;

    return res.status(200).json({ code, checkoutUrl });
  } catch (err) {
    console.error('start-checkout error:', err.message);
    return res.status(500).json({ error: 'Could not start checkout' });
  }
}
