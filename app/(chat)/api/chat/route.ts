// /app/(chat)/api/chat/route.ts
export const runtime = 'nodejs';

import {
  convertToModelMessages,
  createUIMessageStream,
  JsonToSseTransformStream,
  smoothStream,
  stepCountIs,
  streamText,
} from 'ai';
import { auth, type UserType } from '@/app/(auth)/auth';
import { type RequestHints, systemPrompt } from '@/lib/ai/prompts';
import {
  createStreamId,
  getChatById,
  getMessageCountByUserId,
  getMessagesByChatId,
  saveChat,
  saveMessages,
} from '@/lib/db/queries';
import { convertToUIMessages, generateUUID } from '@/lib/utils';
// — fixed import path:
import { generateTitleFromUserMessage } from '../../actions';
import { createDocument } from '@/lib/ai/tools/create-document';
import { updateDocument } from '@/lib/ai/tools/update-document';
import { requestSuggestions } from '@/lib/ai/tools/request-suggestions';
import { getWeather } from '@/lib/ai/tools/get-weather';
import { isProductionEnvironment } from '@/lib/constants';
import { myProvider } from '@/lib/ai/providers';
import { entitlementsByUserType } from '@/lib/ai/entitlements';
import { postRequestBodySchema, type PostRequestBody } from './schema';
import { geolocation } from '@vercel/functions';
import {
  createResumableStreamContext,
  type ResumableStreamContext,
} from 'resumable-stream';
import { after } from 'next/server';
import { ChatSDKError } from '@/lib/errors';
import type { ChatMessage } from '@/lib/types';
import type { ChatModel } from '@/lib/ai/models';

export async function POST(request: Request) {
  // 1️⃣ Parse & validate JSON body
  let body: PostRequestBody;
  try {
    body = postRequestBodySchema.parse(await request.json());
  } catch {
    return new ChatSDKError('bad_request:api').toResponse();
  }
  const { id, message, selectedChatModel, selectedVisibilityType } = body;

  // 2️⃣ Authenticate
  const session = await auth();
  if (!session?.user) {
    return new ChatSDKError('unauthorized:chat').toResponse();
  }
  const userType: UserType = session.user.type;

  // 3️⃣ Rate-limit: count messages in last 24h
  const messageCount = await getMessageCountByUserId({
    id: session.user.id,
    differenceInHours: 24,
  });
  if (messageCount > entitlementsByUserType[userType].maxMessagesPerDay) {
    return new ChatSDKError('rate_limit:chat').toResponse();
  }

  // 4️⃣ Create or verify chat record
  const existingChat = await getChatById({ id });
  if (!existingChat) {
    const title = await generateTitleFromUserMessage({ message });
    await saveChat({
      id,
      userId: session.user.id,
      title,
      visibility: selectedVisibilityType,
    });
  } else if (existingChat.userId !== session.user.id) {
    return new ChatSDKError('forbidden:chat').toResponse();
  }

  // 5️⃣ Append the user’s message to the DB
  const history = await getMessagesByChatId({ id });
  const uiHistory = [...convertToUIMessages(history), message];
  await saveMessages({
    messages: [
      {
        chatId: id,
        id: message.id,
        role: 'user',
        parts: message.parts,
        attachments: [],
        createdAt: new Date(),
      },
    ],
  });

  // 6️⃣ Reserve a stream ID for this response
  const streamId = generateUUID();
  await createStreamId({ chatId: id, streamId });

  // 7️⃣ Initialize resumable‐stream context
  let globalCtx: ResumableStreamContext | null = null;
  try {
    globalCtx = createResumableStreamContext({ waitUntil: after });
  } catch (e: any) {
    if (!e.message.includes('REDIS_URL')) throw e;
    console.warn('Resumable streams disabled (missing REDIS_URL)');
  }

  // 8️⃣ Build the AI‐response stream
  const aiStream = createUIMessageStream<ChatMessage>({
    execute: ({ writer: ds }) => {
      const result = streamText({
        model: myProvider.languageModel(selectedChatModel),
        system: systemPrompt({
          selectedChatModel,
          longitude: geolocation(request).longitude,
          latitude: geolocation(request).latitude,
          city: geolocation(request).city,
          country: geolocation(request).country,
        } as RequestHints),
        messages: convertToModelMessages(uiHistory),
        stopWhen: stepCountIs(5),
        experimental_activeTools:
          selectedChatModel === 'chat-model-reasoning'
            ? []
            : ['getWeather', 'createDocument', 'updateDocument', 'requestSuggestions'],
        experimental_transform: smoothStream({ chunking: 'word' }),
        tools: {
          getWeather,
          createDocument: createDocument({ session, dataStream: ds }),
          updateDocument: updateDocument({ session, dataStream: ds }),
          requestSuggestions: requestSuggestions({ session, dataStream: ds }),
        },
        experimental_telemetry: {
          isEnabled: isProductionEnvironment,
          functionId: 'stream-text',
        },
      });
      result.consumeStream();
      ds.merge(result.toUIMessageStream({ sendReasoning: true }));
    },
    generateId: generateUUID,
    onFinish: async ({ messages }) => {
      await saveMessages({
        messages: messages.map((m) => ({
          id: m.id,
          chatId: id,
          role: m.role,
          parts: m.parts,
          attachments: [],
          createdAt: new Date(),
        })),
      });
    },
    onError: () => 'An error occurred.',
  });

  // 9️⃣ Return the SSE stream (resumable if Redis is configured)
  const responseStream = globalCtx
    ? await globalCtx.resumableStream(streamId, () =>
        aiStream.pipeThrough(new JsonToSseTransformStream())
      )
    : aiStream.pipeThrough(new JsonToSseTransformStream());

  return new Response(responseStream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}
