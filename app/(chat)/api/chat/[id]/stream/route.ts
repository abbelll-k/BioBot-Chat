// app/(chat)/api/chat/[id]/stream/route.ts
import { NextRequest } from "next/server";

// We’ve disabled resumable streams here.
// Any GET/POST to this route will return 404.
export async function GET(req: NextRequest) {
  return new Response("Not Found", { status: 404 });
}

export async function POST(req: NextRequest) {
  return new Response("Not Found", { status: 404 });
}
