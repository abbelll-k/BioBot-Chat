// app/(chat)/api/chat/route.ts
import { NextRequest } from "next/server";

export async function POST(req: NextRequest) {
  // 1) Parse incoming JSON body
  const { message } = (await req.json()) as {
    message: { parts: Array<{ type: "text"; text: string }> };
  };

  // 2) Build a basic prompt array
  const userText = message.parts.map((p) => p.text).join("");
  const messages = [
    { role: "system", content: "You are BioBot, a helpful assistant." },
    { role: "user", content: userText },
  ];

  // 3) Call OpenAI's chat completion endpoint with streaming
  const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4o",
      messages,
      stream: true,
    }),
  });

  // 4) If the OpenAI call failed, return the error
  if (!openaiRes.ok) {
    const errText = await openaiRes.text();
    return new Response(errText, { status: 502 });
  }

  // 5) Pipe the OpenAI stream straight back to the client
  return new Response(openaiRes.body, {
    headers: { "Content-Type": "text/event-stream" },
  });
}
