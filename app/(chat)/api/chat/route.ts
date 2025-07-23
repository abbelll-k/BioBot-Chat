// app/(chat)/api/chat/route.ts
import { NextRequest } from 'next/server';
import { OpenAIStream, StreamingTextResponse } from 'ai';

export async function POST(req: NextRequest) {
  // 1) Parse the incoming JSON body
  const { id, message, selectedChatModel } = (await req.json()) as {
    id: string;
    message: { parts: Array<{ type: 'text'; text: string }> };
    selectedChatModel?: string;
  };

  // 2) Build a simple system+user prompt
  const userText = message.parts.map((p) => p.text).join('');
  const messages = [
    { role: 'system', content: 'You are BioBot, a helpful assistant.' },
    { role: 'user',   content: userText },
  ];

  // 3) Kick off a streaming OpenAI call
  const model = selectedChatModel ?? 'gpt-4o';
  const stream = await OpenAIStream({ model, messages });

  // 4) Return an SSE response
  return new StreamingTextResponse(stream);
}
