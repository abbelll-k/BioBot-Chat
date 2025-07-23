// /app/(chat)/api/chat/route.ts
import { auth, type UserType } from '@/app/(auth)/auth';
import { NextResponse } from 'next/server';
import { OpenAI } from 'openai-edge';
import { OpenAIStream, StreamingTextResponse } from 'ai';
import { postRequestBodySchema, type PostRequestBody } from './schema';
import {
  getChatById,
  saveChat,
  getMessagesByChatId,
  saveMessages,
  getMessageCountByUserId,
  createStreamId,
  deleteChatById,
} from '@/lib/db/queries';
import { generateUUID } from '@/lib/utils';
import { generateTitleFromUserMessage } from '@/app/(chat)/actions';
import type { ChatMessage } from '@/lib/types';

export const runtime = 'edge';

export async function POST(request: Request) {
  // 1) AUTH
  const session = await auth();
  if (!session?.user) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  // 2) PARSE & VALIDATE BODY
  let body: PostRequestBody;
  try {
    body = postRequestBodySchema.parse(await request.json());
  } catch {
    return new NextResponse('Bad Request', { status: 400 });
  }
  const { id: chatId, message, selectedChatModel } = body;

  // 3) RATE-LIMIT by user type
  const usedIn24h = await getMessageCountByUserId({
    id: session.user.id,
    differenceInHours: 24,
  });
  const maxPerDay = {
    guest: 100,
    user: 1000,
  }[session.user.type as UserType];
  if (usedIn24h >= maxPerDay) {
    return new NextResponse('Rate limit exceeded', { status: 429 });
  }

  // 4) ENSURE CHAT EXISTS (and create with title for first message)
  const existing = await getChatById({ id: chatId });
  if (!existing) {
    const title = await generateTitleFromUserMessage({ message });
    await saveChat({
      id: chatId,
      userId: session.user.id,
      title,
      visibility: 'private',
    });
  } else if (existing.userId !== session.user.id) {
    return new NextResponse('Forbidden', { status: 403 });
  }

  // 5) LOAD HISTORY, APPEND USER MESSAGE
  const history = await getMessagesByChatId({ id: chatId });
  const messages: ChatMessage[] = [...history, message];

  // 6) PERSIST THE USER MESSAGE
  await saveMessages({
    messages: [
      {
        chatId,
        id: message.id,
        role: message.role,
        parts: message.parts,
        attachments: [],
        createdAt: new Date(),
      },
    ],
  });

  // 7) CREATE A STREAM ID FOR RESUMABLE (optional)
  const streamId = generateUUID();
  await createStreamId({ streamId, chatId });

  // 8) CALL OPENAI-EDGE + AI-SDK STREAM WRAP
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
  const aiStream = await OpenAIStream(
    openai.chat.completions.create({
      model: selectedChatModel,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.parts.map((p) => p.text).join(''),
      })),
      stream: true,
    })
  );

  // 9) RETURN A STREAMING RESPONSE
  return new StreamingTextResponse(aiStream);
}

export async function DELETE(request: Request) {
  const url = new URL(request.url);
  const chatId = url.searchParams.get('id');
  if (!chatId) {
    return new NextResponse('Bad Request', { status: 400 });
  }

  const session = await auth();
  if (!session?.user) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const chat = await getChatById({ id: chatId });
  if (!chat || chat.userId !== session.user.id) {
    return new NextResponse('Forbidden', { status: 403 });
  }

  await deleteChatById({ id: chatId });
  return NextResponse.json({ success: true });
}
