// app/(chat)/api/chat/route.ts
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
  deleteChatById,
  getChatById,
  getMessageCountByUserId,
  getMessagesByChatId,
  saveChat,
  saveMessages,
} from '@/lib/db/queries';
import { convertToUIMessages, generateUUID } from '@/lib/utils';
import { generateTitleFromUserMessage } from '@/app/(chat)/actions';
import { createDocument } from '@/lib/ai/tools/create-document';
import { updateDocument } from '@/lib/ai/tools/update-document';
import { requestSuggestions } from '@/lib/ai/tools/request-suggestions';
import { getWeather } from '@/lib/ai/tools/get-weather';
import { isProductionEnvironment } from '@/lib/constants';
import { myProvider } from '@/lib/ai/providers';
import { entitlementsByUserType } from '@/lib/ai/entitlements';
import { postRequestBodySchema, type PostRequestBody } from '@/app/(chat)/api/chat/schema';
import { geolocation } from '@vercel/functions';
import {
  createResumableStreamContext,
  type ResumableStreamContext,
} from 'resumable-stream';
import { after } from 'next/server';
import { ChatSDKError } from '@/lib/errors';
import type { ChatMessage } from '@/lib/types';
import type { VisibilityType } from '@/components/visibility-selector';

export const maxDuration = 60;

// Make getStreamContext available for the nested /[id]/stream/route.ts
let globalStreamContext: ResumableStreamContext | null = null;
export function getStreamContext() {
  if (!globalStreamContext) {
    try {
      globalStreamContext = createResumableStreamContext({ waitUntil: after });
    } catch (e: any) {
      if (e.message.includes('REDIS_URL')) {
        console.log('> Resumable streams disabled (no REDIS_URL)');
      } else {
        console.error(e);
      }
    }
  }
  return globalStreamContext;
}

export async function POST(request: Request) {
  let body: PostRequestBody;
  try {
    body = postRequestBodySchema.parse(await request.json());
  } catch {
    return new ChatSDKError('bad_request:api').toResponse();
  }

  const forcedModel = 'gpt-4o';

  const session = await auth();
  if (!session?.user) return new ChatSDKError('unauthorized:chat').toResponse();
  const userType: UserType = session.user.type;
  const count = await getMessageCountByUserId({
    id: session.user.id,
    differenceInHours: 24,
  });
  if (count > entitlementsByUserType[userType].maxMessagesPerDay) {
    return new ChatSDKError('rate_limit:chat').toResponse();
  }

  const chat = await getChatById({ id: body.id });
  if (!chat) {
    const title = await generateTitleFromUserMessage({ message: body.message });
    await saveChat({
      id: body.id,
      userId: session.user.id,
      title,
      visibility: body.selectedVisibilityType,
    });
  } else if (chat.userId !== session.user.id) {
    return new ChatSDKError('forbidden:chat').toResponse();
  }

  const history = await getMessagesByChatId({ id: body.id });
  const uiMessages = [...convertToUIMessages(history), body.message];

  await saveMessages({
    messages: [
      {
        chatId: body.id,
        id: body.message.id,
        role: 'user',
        parts: body.message.parts,
        attachments: [],
        createdAt: new Date(),
      },
    ],
  });

  const { longitude, latitude, city, country } = geolocation(request);
  const hints: RequestHints = { longitude, latitude, city, country };

  const streamId = generateUUID();
  await createStreamId({ streamId, chatId: body.id });

  const stream = createUIMessageStream({
    execute: ({ writer }) => {
      const result = streamText({
        model: myProvider.languageModel(forcedModel),
        system: systemPrompt({ selectedChatModel: forcedModel, requestHints: hints }),
        messages: convertToModelMessages(uiMessages),
        stopWhen: stepCountIs(5),
        experimental_activeTools: [
          'getWeather',
          'createDocument',
          'updateDocument',
          'requestSuggestions',
        ],
        experimental_transform: smoothStream({ chunking: 'word' }),
        tools: {
          getWeather,
          createDocument: createDocument({ session, dataStream: writer }),
          updateDocument: updateDocument({ session, dataStream: writer }),
          requestSuggestions: requestSuggestions({ session, dataStream: writer }),
        },
        experimental_telemetry: {
          isEnabled: isProductionEnvironment,
          functionId: 'stream-text',
        },
      });

      result.consumeStream();
      writer.merge(result.toUIMessageStream({ sendReasoning: true }));
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
          chatId: body.id,
        })),
      });
    },
    onError: () => 'Oops, something went wrong.',
  });

  const ctx = getStreamContext();
  if (ctx) {
    return new Response(
      await ctx.resumableStream(streamId, () =>
        stream.pipeThrough(new JsonToSseTransformStream())
      )
    );
  }
  return new Response(stream.pipeThrough(new JsonToSseTransformStream()));
}

export async function DELETE(request: Request) {
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  if (!id) {
    return new ChatSDKError('bad_request:api').toResponse();
  }
  const session = await auth();
  if (!session?.user) {
    return new ChatSDKError('unauthorized:chat').toResponse();
  }
  const chat = await getChatById({ id });
  if (chat.userId !== session.user.id) {
    return new ChatSDKError('forbidden:chat').toResponse();
  }
  const deleted = await deleteChatById({ id });
  return Response.json(deleted, { status: 200 });
}
