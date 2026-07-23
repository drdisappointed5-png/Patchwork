// api/stripe-webhook.js
// Listens for Stripe events and manages access codes in Upstash Redis.
//
// - checkout.session.completed → generates a new access code, stores it as
//   active, and links it to this checkout session (so the success page can
//   look it up) and to the Stripe customer (so cancellations can find it).
// - customer.subscription.deleted → marks the associated access code inactive.
//
// Requires these Vercel environment variables:
//   STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
//   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
//
// Requires the "stripe" npm package (see package.json).
//
// In the Stripe dashboard, this endpoint must be registered at:
//   https://<your-domain>/api/stripe-webhook
// subscribed to: checkout.session.completed, customer.subscription.deleted

import Stripe from 'stripe';

export const config = {
  api: { bodyParser: false }, // Stripe needs the raw request body to verify signatures
};

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

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

function generateAccessCode() {
  // Avoids visually ambiguous characters (0/O, 1/I/L)
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

  const rawBody = await readRawBody(req);
  const signature = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe webhook signature verification failed:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const code = generateAccessCode();

      await redisCmd('set', `access:${code}`, JSON.stringify({
        active: true,
        customerId: session.customer || null,
        subscriptionId: session.subscription || null,
        createdAt: Date.now(),
      }));

      // Lets the success page look up the code by checkout session id
      await redisCmd('set', `session:${session.id}`, code);
      await redisCmd('expire', `session:${session.id}`, 3600);

      // Lets a future cancellation event find and deactivate this code
      if (session.customer) {
        await redisCmd('set', `customer:${session.customer}`, code);
      }
    }

    if (event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object;
      const customerId = subscription.customer;
      const code = await redisCmd('get', `customer:${customerId}`);

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
    console.error('Stripe webhook handler error:', err);
    return res.status(500).json({ error: 'Webhook handler failed' });
  }
}
