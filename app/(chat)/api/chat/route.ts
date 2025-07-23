// app/(chat)/api/chat/route.ts
import { createUIMessageStream, JsonToSseTransformStream } from 'ai';

export const runtime = 'edge';

export async function POST(request: Request) {
  // 1) parse the incoming JSON
  let body: { prompt?: string };
  try {
    body = await request.json();
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  const prompt = body.prompt?.trim();
  if (!prompt) {
    return new Response('Missing "prompt" field', { status: 400 });
  }

  // 2) build a tiny streaming response
  const stream = createUIMessageStream({
    execute: ({ writer }) => {
      // you can split this up however you like to simulate streaming
      writer.write({
        role: 'assistant',
        parts: [{ type: 'text', text: `You said: ` }],
      });
      for (const word of prompt.split(' ')) {
        writer.write({
          role: 'assistant',
          parts: [{ type: 'text', text: word + ' ' }],
        });
      }
      writer.write({
        role: 'assistant',
        parts: [{ type: 'text', text: `🎉` }],
      });
    },
  });

  // 3) wrap it in SSE and return
  return new Response(stream.pipeThrough(new JsonToSseTransformStream()), {
    headers: {
      'Content-Type': 'text/event-stream',
      // recommended for SSE
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}

export async function DELETE() {
  // a no-op delete so your front end can still call DELETE
  return new Response(null, { status: 204 });
}
