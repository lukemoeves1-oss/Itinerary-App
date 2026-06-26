// Edge Runtime — streams Claude's response chunk-by-chunk to avoid Vercel's timeout.
export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: 'Server is missing ANTHROPIC_API_KEY. Add it in your Vercel dashboard under Environment Variables.' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  let prompt, sessionId;
  try {
    const body = await req.json();
    prompt = body.prompt;
    sessionId = body.sessionId;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid request body.' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!prompt) {
    return new Response(JSON.stringify({ error: 'Missing prompt.' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Verify the customer actually paid before spending any API credits.
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    return new Response(
      JSON.stringify({ error: 'Server is missing STRIPE_SECRET_KEY. Add it in your Vercel dashboard.' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
  if (!sessionId) {
    return new Response(JSON.stringify({ error: 'Payment required. Please complete checkout first.' }), {
      status: 402,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const verifyRes = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
    headers: { Authorization: `Bearer ${stripeKey}` },
  });
  const session = await verifyRes.json().catch(() => ({}));
  if (!verifyRes.ok || session.payment_status !== 'paid') {
    return new Response(JSON.stringify({ error: 'We could not verify your payment. If you were charged, please contact support.' }), {
      status: 402,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 16000,
      stream: true,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!anthropicRes.ok) {
    const errData = await anthropicRes.json().catch(() => ({}));
    return new Response(
      JSON.stringify({ error: errData.error?.message || `Claude API error (${anthropicRes.status})` }),
      { status: anthropicRes.status, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Forward Claude's streaming SSE events as plain text chunks to the browser.
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const reader = anthropicRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const json = line.slice(6).trim();
            if (json === '[DONE]') continue;
            try {
              const event = JSON.parse(json);
              if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
                controller.enqueue(encoder.encode(event.delta.text));
              }
            } catch {
              // Skip malformed SSE lines
            }
          }
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'X-Runtime': 'edge-streaming',
    },
  });
}
