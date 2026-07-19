// api/generate.js
// Vercel serverless function with server-side IP rate limiting (10 req/day/IP)
//
// NOTE: the rate-limit store below is in-memory (a Map) and resets whenever
// the function cold-starts, which can happen often on Vercel. This is the
// same limitation the previous version of this file had — it's a soft limit,
// not a hard guarantee. For a daily cap that survives cold starts, swap this
// Map for Vercel KV or Upstash Redis.

const ipStore = new Map();

const DAILY_LIMIT = 10;

function getTodayKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

function checkRateLimit(ip) {
  const today = getTodayKey();
  const key = `${ip}::${today}`;

  if (!ipStore.has(key)) {
    for (const k of ipStore.keys()) {
      if (!k.endsWith(today)) ipStore.delete(k);
    }
    ipStore.set(key, 0);
  }

  const count = ipStore.get(key);
  if (count >= DAILY_LIMIT) return false;

  ipStore.set(key, count + 1);
  return true;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // --- IP RATE LIMIT CHECK ---
  const ip = getClientIp(req);
  if (!checkRateLimit(ip)) {
    return res.status(429).json({
      error: 'Daily limit reached (10 drafts/day per IP). Try again tomorrow.'
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
