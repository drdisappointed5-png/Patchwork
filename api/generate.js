// api/generate.js
// Vercel serverless function with two-tier rate limiting, backed by Upstash Redis:
// - Free tier: 10 drafts/day per IP
// - Premium tier: 50 drafts/day per access code (unlocked via Stripe subscription)
//
// Requires these Vercel environment variables:
//   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
// If these aren't set, rate limiting fails open (requests are allowed) so the
// free tier doesn't break before Redis is configured — see checkAndIncrement below.

const FREE_LIMIT = 10;
const PREMIUM_LIMIT = 50;

function getTodayKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

async function redisCmd(...parts) {
  const url = `${process.env.UPSTASH_REDIS_REST_URL}/${parts.map(encodeURIComponent).join('/')}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` },
  });
  const data = await response.json();
  return data.result;
}

async function checkAndIncrement(key, limit) {
  try {
    const count = await redisCmd('incr', key);
    if (count === 1) {
      await redisCmd('expire', key, 86400);
    }
    return count <= limit;
  } catch (err) {
    console.error('Redis rate-limit check failed, allowing request:', err.message);
    return true; // fail open — don't block real users if Redis has a hiccup
  }
}

async function getAccessInfo(code) {
  try {
    const raw = await redisCmd('get', `access:${code}`);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.error('Redis access-code check failed, treating as free tier:', err.message);
    return null; // fail closed — don't grant premium if we can't verify it
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // --- RATE LIMIT CHECK (free tier by IP, premium tier by access code) ---
  const today = getTodayKey();
  const accessCode = req.headers['x-access-code'];
  let tier = 'free';
  let allowed;

  if (accessCode) {
    const access = await getAccessInfo(accessCode);
    if (access && access.active) {
      tier = 'premium';
      allowed = await checkAndIncrement(`ratelimit:premium:${accessCode}:${today}`, PREMIUM_LIMIT);
    }
  }

  if (tier === 'free') {
    const ip = getClientIp(req);
    allowed = await checkAndIncrement(`ratelimit:free:${ip}:${today}`, FREE_LIMIT);
  }

  if (!allowed) {
    const limit = tier === 'premium' ? PREMIUM_LIMIT : FREE_LIMIT;
    const upsell = tier === 'free' ? ' Upgrade for a higher daily limit, or' : '';
    return res.status(429).json({
      error: `Daily limit reached (${limit}/day).${upsell} try again tomorrow.`
    });
  }

  const { businessName, clientName, projectDesc, price, timeline, paymentTerms, notes } = req.body || {};

  if (!businessName || typeof businessName !== 'string') {
    return res.status(400).json({ error: 'Missing "businessName" in request body' });
  }
  if (!clientName || typeof clientName !== 'string') {
    return res.status(400).json({ error: 'Missing "clientName" in request body' });
  }
  if (!projectDesc || typeof projectDesc !== 'string') {
    return res.status(400).json({ error: 'Missing "projectDesc" in request body' });
  }
  if (!price || typeof price !== 'string') {
    return res.status(400).json({ error: 'Missing "price" in request body' });
  }

  const systemPrompt = `You are a paperwork assistant for freelancers and consultants. Based on the client engagement details the user provides, generate two documents: a services contract and an invoice.

Respond ONLY with a JSON object in this exact shape:
{"contract": "...", "invoice": "..."}

- "contract" must be a complete, professional freelance services contract (300-450 words) covering: scope of work, payment terms, timeline, intellectual property/ownership transfer upon full payment, and a simple termination clause. Address it between the business and the client using the names given. Use \\n for line breaks between sections, plain text only — no markdown headers or bullet symbols.
- "invoice" must be a simple, complete invoice (under 120 words) with an invoice number placeholder like INV-0001, a line item describing the work, the price, a payment due date or terms, and a placeholder line "Payment details: [add your payment info]". Use \\n for line breaks, plain text only.
- If a detail is thin (e.g. no timeline given), use a reasonable freelance-industry default and mark it clearly as a placeholder in brackets rather than inventing specifics.`;

  const userContent = `Freelancer/business name: ${businessName}
Client name: ${clientName}
Project description: ${projectDesc}
Price: ${price}
Timeline: ${timeline || 'not specified'}
Payment terms: ${paymentTerms || 'not specified'}
Additional notes: ${notes || 'none'}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 1500,
        system: systemPrompt,
        messages: [{ role: 'user', content: userContent }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Anthropic API error:', response.status, errText);
      return res.status(502).json({ error: `Anthropic API error (${response.status}): ${errText}` });
    }

    const data = await response.json();
    const textBlock = data.content?.find((b) => b.type === 'text');

    if (!textBlock) {
      return res.status(502).json({ error: 'No text content in model response' });
    }

    let cleaned = textBlock.text
      .trim()
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/, '')
      .replace(/```\s*$/, '')
      .trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      const firstBrace = cleaned.indexOf('{');
      const lastBrace = cleaned.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        try {
          parsed = JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
        } catch (e2) {
          console.error('Failed to parse model output as JSON:', cleaned);
          return res.status(502).json({ error: 'Model did not return valid JSON' });
        }
      } else {
        console.error('Failed to parse model output as JSON:', cleaned);
        return res.status(502).json({ error: 'Model did not return valid JSON' });
      }
    }

    return res.status(200).json(parsed);
  } catch (err) {
    console.error('Server error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
