// Tell Next to run this in Node.js (so you can import postgres, crypto, etc)
export const runtime = 'nodejs';

import { auth } from '@/app/(auth)/auth';
import {
  convertToModelMessages,
  createUIMessageStream,
  JsonToSseTransformStream,
  smoothStream,
  stepCountIs,
  streamText,
} from 'ai';
import type { ChatMessage } from '@/lib/types';
import type { ChatModel } from '@/lib/ai/models';
import type { VisibilityType } from '@/components/visibility-selector';
import {
  createStreamId,
  deleteChatById,
  getChatById,
  getMessageCountByUserId,
  getMessagesByChatId,
  saveChat,
  saveMessages,
} from '@/lib/db/queries';
import { generateUUID } from '@/lib/utils';
import { systemPrompt, type RequestHints } from '@/lib/ai/prompts';
import {
  createDocument,
  updateDocument,
  requestSuggestions,
  getWeather,
} from '@/lib/ai/tools';
import { myProvider } from '@/lib/ai/providers';
import { entitlementsByUserType } from '@/lib/ai/entitlements';
import { isProductionEnvironment } from '@/lib/constants';
import { postRequestBodySchema, type PostRequestBody } from './schema';
import { geolocation } from '@vercel/functions';
import {
  createResumableStreamContext,
  type ResumableStreamContext,
} from 'resumable-stream';
import { after } from 'next/server';
import { ChatSDKError } from '@/lib/errors';

// max minutes before giving up on a live stream
export const maxDuration = 60;

let globalStreamContext: ResumableStreamContext | null = null;
function getStreamContext() {
  if (!globalStreamContext) {
    try {
      globalStreamContext = createResumableStreamContext({ waitUntil: after });
    } catch (e: any) {
      // if you didn’t set REDIS_URL it’ll disable resumable streams gracefully
    }
  }
  return globalStreamContext;
}

export async function POST(request: Request) {
  // 1) parse + validate
  let body: PostRequestBody;
  try {
    body = postRequestBodySchema.parse(await request.json());
  } catch {
    return new ChatSDKError('bad_request:api').toResponse();
  }

  const { id, message, selectedChatModel, selectedVisibilityType } = body;
  const session = await auth();
  if (!session?.user) return new ChatSDKError('unauthorized:chat').toResponse();

  // 2) rate‐limit
  const count = await getMessageCountByUserId({
    id: session.user.id,
    differenceInHours: 24,
  });
  if (count > entitlementsByUserType[session.user.type].maxMessagesPerDay) {
    return new ChatSDKError('rate_limit:chat').toResponse();
  }

  // 3) ensure chat exists (or create it)
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

  // 4) persist user’s new message
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

  // 5) stream setup
  const streamId = generateUUID();
  await createStreamId({ streamId, chatId: id });
  const uiHistory = [
    ...convertToUIMessages(await getMessagesByChatId({ id })),
    message,
  ];
  const ctx = getStreamContext();

  const stream = createUIMessageStream({
    execute: ({ writer: dataStream }) => {
      const result = streamText({
        model: myProvider.languageModel(selectedChatModel),
        system: systemPrompt({ selectedChatModel, requestHints: geolocation(request) }),
        messages: convertToModelMessages(uiHistory),
        stopWhen: stepCountIs(5),
        experimental_activeTools:
          selectedChatModel === 'chat-model-reasoning'
            ? []
            : ['getWeather', 'createDocument', 'updateDocument', 'requestSuggestions'],
        tools: { getWeather, createDocument: createDocument({ session, dataStream }), updateDocument: updateDocument({ session, dataStream }), requestSuggestions: requestSuggestions({ session, dataStream }) },
        experimental_transform: smoothStream({ chunking: 'word' }),
        experimental_telemetry: {
          isEnabled: isProductionEnvironment,
          functionId: 'stream-text',
        },
      });
      result.consumeStream();
      dataStream.merge(
        result.toUIMessageStream({ sendReasoning: true })
      );
    },
    generateId: generateUUID,
    onFinish: async ({ messages }) => {
      await saveMessages({
        messages: messages.map((m) => ({
          id: m.id,
          role: m.role,
          parts: m.parts,
          createdAt: new Date(),
          attachments: [],
          chatId: id,
        })),
      });
    },
    onError: () => 'Oops, something went wrong.',
  });

  if (ctx) {
    return new Response(
      await ctx.resumableStream(streamId, () =>
        stream.pipeThrough(new JsonToSseTransformStream())
      )
    );
  }
  return new Response(stream.pipeThrough(new JsonToSseTransformStream()));
}
