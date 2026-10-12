import { getAdminSnapshot, setAdminConfig, setAdminRole, setTrackedWallets, type AdminConfig } from "@/lib/admin-store";

const initData = (request: Request) => request.headers.get("x-telegram-init-data") ?? "";
const status = (error: unknown) => error instanceof Error && error.message === "UNAUTHORIZED" ? 401 : error instanceof Error && error.message === "FORBIDDEN" ? 403 : 400;

export async function GET(request: Request) {
  try { return Response.json(await getAdminSnapshot(initData(request))); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "ADMIN_ERROR" }, { status: status(error) }); }
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { action?: unknown; userId?: unknown; isAdmin?: unknown; trackedWallets?: unknown; key?: unknown; value?: unknown };
    if (body.action === "setAdmin" && typeof body.userId === "string" && typeof body.isAdmin === "boolean") await setAdminRole(initData(request), body.userId, body.isAdmin);
    else if (body.action === "setTrackedWallets" && typeof body.trackedWallets === "number") await setTrackedWallets(initData(request), body.trackedWallets);
    else if (body.action === "setConfig" && typeof body.key === "string" && ["trackedWallets", "signalThreshold", "liveMarkets", "confluenceMinutes"].includes(body.key) && typeof body.value === "number") await setAdminConfig(initData(request), body.key as keyof AdminConfig, body.value);
    else return Response.json({ error: "INVALID_ACTION" }, { status: 400 });
    return Response.json(await getAdminSnapshot(initData(request)));
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "ADMIN_ERROR" }, { status: status(error) }); }
}
