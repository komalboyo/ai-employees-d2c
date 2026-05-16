import { NextResponse } from "next/server";
import { chatTurn } from "@/chat/engine";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = (await req.json()) as {
    merchant_id: string;
    session_id?: string;
    user_message: string;
  };
  if (!body.merchant_id || !body.user_message) {
    return NextResponse.json({ error: "merchant_id and user_message required" }, { status: 400 });
  }
  try {
    const result = await chatTurn(body);
    return NextResponse.json(result);
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "unknown error" },
      { status: 500 }
    );
  }
}
