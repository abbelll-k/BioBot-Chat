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
import type { VisibilityType } from '@/components/visibility-selector';

export const maxDuration = 60;
let globalStreamContext: ResumableStreamContext | null = null;
function getStreamContext() {
  if (!globalStreamContext) {
    try {
      globalStreamContext = createResumableStreamContext({ waitUntil: after });
    } catch (err: any) {
      if (!err.message.includes('REDIS_URL')) console.error(err);
    }
  }
  return globalStreamContext;
}

export async function POST(request: Request) {
  let requestBody: PostRequestBody;
  try {
    requestBody = postRequestBodySchema.parse(await request.json());
  } catch {
    return new ChatSDKError('bad_request:api').toResponse();
  }

  const {
    id,
    message,
    selectedChatModel,
    selectedVisibilityType,
  } = requestBody;
  const session = await auth();
  if (!session?.user) return new ChatSDKError('unauthorized:chat').toResponse();

  // rate‐limit
  const count = await getMessageCountByUserId({
    id: session.user.id,
    differenceInHours: 24,
  });
  if (count > entitlementsByUserType[session.user.type].maxMessagesPerDay) {
    return new ChatSDKError('rate_limit:chat').toResponse();
  }

  // ensure chat exists
  const chat = await getChatById({ id });
  if (!chat) {
    const title = await generateTitleFromUserMessage({ message });
    await saveChat({
      id,
      userId: session.user.id,
      title,
      visibility: selectedVisibilityType,
    });
  } else if (chat.userId !== session.user.id) {
    return new ChatSDKError('forbidden:chat').toResponse();
  }

  // fetch history + geolocation hints
  const history = await getMessagesByChatId({ id });
  const uiHistory = [...convertToUIMessages(history), message];
  const { longitude, latitude, city, country } = geolocation(request);
  const requestHints: RequestHints = { longitude, latitude, city, country };

  // persist user message
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

  // create stream ID
  const streamId = generateUUID();
  await createStreamId({ streamId, chatId: id });

  // build the AI stream
  const result = streamText({
    model: myProvider.languageModel(selectedChatModel),
    system: systemPrompt({
      selectedChatModel,
      requestHints,          // <— fixed: pass both props
    }),
    messages: convertToModelMessages(uiHistory),
    stopWhen: stepCountIs(5),
    experimental_activeTools:
      selectedChatModel === 'chat-model-reasoning'
        ? []
        : ['getWeather', 'createDocument', 'updateDocument', 'requestSuggestions'],
    tools: {
      getWeather,
      createDocument: createDocument({ session, dataStream: () => {} }),
      updateDocument: updateDocument({ session, dataStream: () => {} }),
      requestSuggestions: requestSuggestions({ session, dataStream: () => {} }),
    },
    experimental_transform: smoothStream({ chunking: 'word' }),
    experimental_telemetry: {
      isEnabled: isProductionEnvironment,
      functionId: 'stream-text',
    },
  });

  // hook up to resumable context
  const streamContext = getStreamContext();
  const sse = await (streamContext
    ? streamContext.resumableStream(streamId, () =>
        result.pipeThrough(new JsonToSseTransformStream())
      )
    : result.pipeThrough(new JsonToSseTransformStream()));

  return new Response(sse, { status: 200 });
}

export async function DELETE(request: Request) {
  const url = new URL(request.url);
  const id = url.searchParams.get('id')!;
  if (!id) return new ChatSDKError('bad_request:api').toResponse();

  const session = await auth();
  if (!session?.user) return new ChatSDKError('unauthorized:chat').toResponse();

  const chat = await getChatById({ id });
  if (chat.userId !== session.user.id) {
    return new ChatSDKError('forbidden:chat').toResponse();
  }

  const deleted = await deleteChatById({ id });
  return Response.json(deleted, { status: 200 });
}
