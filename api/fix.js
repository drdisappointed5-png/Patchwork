export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { lang, code, error, mode } = req.body || {};

  if (!code || typeof code !== 'string') {
    return res.status(400).json({ error: 'Missing "code" in request body' });
  }

  const isExplainOnly = mode === 'explain';

  const systemPrompt = isExplainOnly
    ? `You are a code debugging assistant. The user will give you ${lang || 'code'} and (optionally) an error message. Your job is to explain what is wrong with the code in plain language — do NOT return a fixed version.

Respond ONLY with a JSON object in this exact shape:
{"explanation": "..."}

- "explanation" should be 2-4 short paragraphs in plain text (you may use \`backticks\` for inline code references). No markdown headers or bullet lists.`

    : `You are a code-fixing assistant. The user will give you ${lang || 'code'} and (optionally) an error message or traceback. Your job:

1. Identify the bug(s) causing the error.
2. Produce a corrected, complete version of the code.
3. Briefly explain what was wrong and what you changed.

Respond ONLY with a JSON object in this exact shape:
{"fixedCode": "...", "explanation": "..."}

- "fixedCode" must be the full corrected code as a plain string (use \\n for newlines).
- "explanation" should be 2-4 short paragraphs in plain text (you may use \`backticks\` for inline code). No markdown headers or bullet lists.
- If the code looks correct and you can't find a bug, say so in the explanation and return the code unchanged in "fixedCode".`;

  const userContent = `Language: ${lang || 'unspecified'}\n\nCode:\n${code}\n\n${
    error ? `Error/traceback:\n${error}` : 'No error message provided — please look for bugs yourself.'
  }`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        system: systemPrompt,
        messages: [{ role: 'user', content: userContent }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Anthropic API error:', response.status, errText);
      return res.status(502).json({ error: `Anthropic API error (${response.status})` });
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
