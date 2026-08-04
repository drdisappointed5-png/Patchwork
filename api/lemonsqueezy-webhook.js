// api/lemonsqueezy-webhook.js
// Verifies the Lemon Squeezy webhook signature (using Node's built-in crypto
// — no extra package needed) and activates/deactivates access codes in
// Upstash Redis. Also emails the customer a backup of their access code via
// Resend, so losing localStorage (new device, cleared browser) doesn't lose
// them their subscription.
//
// - subscription_created → activates the code passed in as custom data, emails it
// - subscription_cancelled / subscription_expired → deactivates that code, emails a notice
//
// Requires these Vercel environment variables:
//   LEMONSQUEEZY_WEBHOOK_SECRET, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
//   RESEND_API_KEY (optional — if unset, emails are silently skipped, nothing else breaks)
//   RESEND_FROM_EMAIL (optional — defaults to Resend's shared test sender)
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

// Fire-and-forget email helper. Never throws — a failed email should never
// break webhook processing or cause Lemon Squeezy to retry unnecessarily.
async function sendEmail(to, subject, html) {
  if (!process.env.RESEND_API_KEY || !to) return;
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.RESEND_FROM_EMAIL || 'Patchwork <onboarding@resend.dev>',
        to,
        subject,
        html,
      }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Resend email failed:', resp.status, errText);
    }
  } catch (err) {
    console.error('Resend email error:', err.message);
  }
}

function accessCodeEmailHtml(code) {
  return `
    <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
      <h2 style="color: #2F5233;">You're subscribed to Patchwork Premium</h2>
      <p>Here's your access code — save this email in case you ever need it again:</p>
      <p style="font-family: monospace; font-size: 20px; font-weight: 600; background: #F3EEE0; border: 1.5px dashed #2F5233; border-radius: 4px; padding: 16px; text-align: center; letter-spacing: 0.04em;">${code}</p>
      <p>Paste this into Patchwork's "Enter your access code" box to unlock 50 drafts a day.</p>
      <p style="color: #5B6472; font-size: 13px;">If you didn't subscribe to Patchwork, you can ignore this email.</p>
    </div>
  `;
}

function cancellationEmailHtml() {
  return `
    <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
      <h2 style="color: #1B2430;">Your Patchwork Premium subscription has ended</h2>
      <p>Your access code has been deactivated and your account is back on the free tier (10 drafts/day).</p>
      <p>If this wasn't intentional, or you'd like to resubscribe, just head back to Patchwork and tap Subscribe again.</p>
    </div>
  `;
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
  const customerEmail = attributes.user_email || null;

  try {
    if (eventName === 'subscription_created') {
      const code = payload.meta?.custom_data?.code;
      if (code) {
        await redisCmd('set', `access:${code}`, JSON.stringify({
          active: true,
          customerId: attributes.customer_id || null,
          subscriptionId: payload.data.id,
          customerEmail,
          createdAt: Date.now(),
        }));

        if (attributes.customer_id) {
          await redisCmd('set', `customer:${attributes.customer_id}`, code);
        }

        // Don't block the response on email — send it but don't await failure paths
        await sendEmail(customerEmail, 'Your Patchwork access code', accessCodeEmailHtml(code));
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

          const emailTo = customerEmail || access.customerEmail;
          await sendEmail(emailTo, 'Your Patchwork subscription has ended', cancellationEmailHtml());
        }
      }
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('Lemon Squeezy webhook handler error:', err);
    return res.status(500).json({ error: 'Webhook handler failed' });
  }
}
