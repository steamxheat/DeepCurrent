import { registerSession } from "@/lib/admin-store";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as { initData?: unknown };
  const session = await registerSession(typeof body.initData === "string" ? body.initData : "");
  return session ? Response.json(session) : Response.json({ error: "Telegram session is not valid" }, { status: 401 });
}
