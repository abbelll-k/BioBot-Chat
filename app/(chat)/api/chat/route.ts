// file: app/(chat)/api/chat/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/app/(auth)/auth';
import { getChatById } from '@/lib/db/queries';
import { convertToModelMessages } from '@/lib/utils';
import { ChatSDKError } from '@/lib/errors';

export const runtime = 'nodejs'; // or 'nodejs' if you prefer

export async function POST(request: NextRequest) {
  // 1) Make sure we have our key
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    console.error('⚠️ OPENAI_API_KEY is not set');
    return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 });
  }

  // 2) Parse & auth
  let body: { id: string; message: any; selectedChatModel: string };
  try {
    body = await request.json();
  } catch {
    return new ChatSDKError('bad_request:api').toResponse();
  }

  const session = await auth();
  if (!session?.user) {
    return new ChatSDKError('unauthorized:chat').toResponse();
  }

  // 3) Verify chat exists & belongs to user
  const chat = await getChatById({ id: body.id });
  if (!chat) {
    return new ChatSDKError('not_found:chat').toResponse();
  }
  if (chat.userId !== session.user.id) {
    return new ChatSDKError('forbidden:chat').toResponse();
  }

  // 4) Build the OpenAI request
  const messages = convertToModelMessages([
    // you could also pull history from DB here if you like...
    body.message,
  ]);

  const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: body.selectedChatModel,
      messages,
      stream: true,
    }),
  });

  if (!openaiRes.ok) {
    const err = await openaiRes.text();
    console.error('OpenAI error:', err);
    return NextResponse.json({ error: 'OpenAI API error' }, { status: 502 });
  }

  // 5) Proxy the raw event‐stream back to the client
  return new NextResponse(openaiRes.body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      // make sure the browser doesn’t buffer
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
