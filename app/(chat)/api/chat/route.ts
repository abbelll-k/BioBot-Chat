// app/(chat)/api/chat/route.ts
export const runtime = 'edge';

interface ChatRequest {
  prompt?: string;
}

export async function POST(request: Request) {
  // 1) Parse JSON body
  let body: ChatRequest;
  try {
    body = (await request.json()) as ChatRequest;
  } catch {
    return new Response(
      JSON.stringify({ error: 'Invalid JSON' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const prompt = body.prompt?.trim();
  if (!prompt) {
    return new Response(
      JSON.stringify({ error: 'Missing `prompt` field' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // 2) Fetch a streaming ChatCompletion from OpenAI
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    return new Response(
      JSON.stringify({ error: 'OpenAI API key not configured' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const openaiRes = await fetch(
    'https://api.openai.com/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o',           // ← or whatever model you want
        messages: [{ role: 'user', content: prompt }],
        stream: true,
      }),
    }
  );

  if (!openaiRes.ok || !openaiRes.body) {
    const errText = await openaiRes.text();
    return new Response(errText, { status: openaiRes.status });
  }

  // 3) Proxy the raw event-stream back to the client
  return new Response(openaiRes.body, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}

export async function DELETE() {
  // still satisfy your front-end's DELETE call
  return new Response(null, { status: 204 });
}
