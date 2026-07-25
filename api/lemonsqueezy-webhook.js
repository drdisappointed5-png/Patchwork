// api/lemonsqueezy-webhook.js
// Verifies the Lemon Squeezy webhook signature (using Node's built-in crypto
// — no extra package needed) and activates/deactivates access codes in
// Upstash Redis.
//
// - subscription_created → activates the code passed in as custom data
// - subscription_cancelled / subscription_expired → deactivates that code
//
// Requires these Vercel environment variables:
//   LEMONSQUEEZY_WEBHOOK_SECRET, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
//
// In the Lemon Squeezy dashboard, register this endpoint at:
//   https://<your-domain>/api/lemonsqueezy-webhook
// subscribed to: subscription_created, subscription_cancelled, subscription_expired

import crypto from 'node:crypto';

export const config = {
  api: { bodyParser: false }, // need the raw body to verify the signature
};

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function redisCmd(...parts) {
  const url = `${process.env.UPSTASH_REDIS_REST_URL}/${parts.map(encodeURIComponent).join('/')}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` },
  });
  const data = await response.json();
  return data.result;
}

function verifySignature(rawBody, signatureHeader) {
  const secret = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
  const hmac = crypto.createHmac('sha256', secret);
  const digest = Buffer.from(hmac.update(rawBody).digest('hex'), 'utf8');
  const signature = Buffer.from(signatureHeader || '', 'utf8');
  if (digest.length !== signature.length) return false;
  return crypto.timingSafeEqual(digest, signature);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const rawBody = await readRawBody(req);
  const signature = req.headers['x-signature'];

  if (!verifySignature(rawBody, signature)) {
    console.error('Lemon Squeezy webhook signature verification failed');
    return res.status(400).json({ error: 'Invalid signature' });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (err) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const eventName = payload.meta?.event_name;
  const attributes = payload.data?.attributes || {};

  try {
    if (eventName === 'subscription_created') {
      const code = payload.meta?.custom_data?.code;
      if (code) {
        await redisCmd('set', `access:${code}`, JSON.stringify({
          active: true,
          customerId: attributes.customer_id || null,
          subscriptionId: payload.data.id,
          createdAt: Date.now(),
        }));

        if (attributes.customer_id) {
          await redisCmd('set', `customer:${attributes.customer_id}`, code);
        }
      }
    }

    if (eventName === 'subscription_cancelled' || eventName === 'subscription_expired') {
      const customerId = attributes.customer_id;
      const code = customerId ? await redisCmd('get', `customer:${customerId}`) : null;

      if (code) {
        const raw = await redisCmd('get', `access:${code}`);
        if (raw) {
          const access = JSON.parse(raw);
          access.active = false;
          await redisCmd('set', `access:${code}`, JSON.stringify(access));
        }
      }
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('Lemon Squeezy webhook handler error:', err);
    return res.status(500).json({ error: 'Webhook handler failed' });
  }
}
