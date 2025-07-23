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
// ⬇️ FIXED import path here:
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
  // 1) Validate body
  let body: PostRequestBody;
  try {
    const json = await request.json();
    body = postRequestBodySchema.parse(json);
  } catch {
    return new ChatSDKError('bad_request:api').toResponse();
  }

  const { id, message, selectedChatModel, selectedVisibilityType } = body;
  const session = await auth();
  if (!session?.user) {
    return new ChatSDKError('unauthorized:chat').toResponse();
  }
  const userType: UserType = session.user.type;

  // 2) Rate-limit
  const count = await getChatById({ id: session.user.id, differenceInHours: 24 })
    .then(() => getMessageCountByUserId({ id: session.user.id, differenceInHours: 24 }))
    .catch(() => 0);

  if (count > entitlementsByUserType[userType].maxMessagesPerDay) {
    return new ChatSDKError('rate_limit:chat').toResponse();
  }

  // 3) Create or verify chat
  const existing = await getChatById({ id });
  if (!existing) {
    const title = await generateTitleFromUserMessage({ message });
    await saveChat({
      id,
      userId: session.user.id,
      title,
      visibility: selectedVisibilityType,
    });
  } else if (existing.userId !== session.user.id) {
    return new ChatSDKError('forbidden:chat').toResponse();
  }

  // 4) Append user message to history
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

  // 5) Create a resumable stream ID
  const streamId = generateUUID();
  await createStreamId({ streamId, chatId: id });

  // 6) Wire up the AI stream
  let globalCtx: ResumableStreamContext | null = null;
  try {
    globalCtx = createResumableStreamContext({ waitUntil: after });
  } catch (e: any) {
    if (!e.message.includes('REDIS_URL')) throw e;
    console.warn('Resumable streams disabled (no REDIS_URL)');
  }

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
    onError: () => 'An error occurred while streaming.',
  });

  // 7) Return the SSE stream
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
