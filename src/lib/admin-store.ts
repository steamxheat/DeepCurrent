import "server-only";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { verifyTelegramInitData, type TelegramIdentity } from "./telegram-auth";
import { defaultAdminConfig, normalizeAdminConfigValue, type AdminConfig } from "./admin-config";

export type AdminUser = TelegramIdentity & { isAdmin: boolean; firstSeen: number; lastSeen: number; visits: number };
export type { AdminConfig } from "./admin-config";
export type AdminSnapshot = { users: AdminUser[]; config: AdminConfig; updatedAt: number };
type State = AdminSnapshot;

// shortcut: local JSON is single-instance prototype storage; move to Postgres before multi-instance deployment.
const statePath = path.join(process.cwd(), ".data", "admin-state.json");
const defaults = (): State => ({ users: [], config: defaultAdminConfig, updatedAt: Date.now() });
let pending = Promise.resolve();

async function readState(): Promise<State> {
  try {
    const state = JSON.parse(await readFile(statePath, "utf8")) as State;
    return { users: Array.isArray(state.users) ? state.users : [], config: {
      trackedWallets: normalizeAdminConfigValue("trackedWallets", Number(state.config?.trackedWallets) || defaultAdminConfig.trackedWallets),
      signalThreshold: normalizeAdminConfigValue("signalThreshold", Number(state.config?.signalThreshold) || defaultAdminConfig.signalThreshold),
      liveMarkets: normalizeAdminConfigValue("liveMarkets", Number(state.config?.liveMarkets) || defaultAdminConfig.liveMarkets),
      confluenceMinutes: normalizeAdminConfigValue("confluenceMinutes", Number(state.config?.confluenceMinutes) || defaultAdminConfig.confluenceMinutes),
    }, updatedAt: Number(state.updatedAt) || Date.now() };
  } catch { return defaults(); }
}

async function mutate<T>(change: (state: State) => T | Promise<T>): Promise<T> {
  const task = pending.then(async () => {
    const state = await readState();
    const result = await change(state);
    state.updatedAt = Date.now();
    await mkdir(path.dirname(statePath), { recursive: true });
    const temporary = `${statePath}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2));
    await rename(temporary, statePath);
    return result;
  });
  pending = task.then(() => undefined, () => undefined);
  return task;
}

export function getSessionIdentity(initData: string): TelegramIdentity | null {
  if (!initData && process.env.NODE_ENV !== "production") return { id: "dev", firstName: "Local", lastName: "Admin", username: "local-dev" };
  return verifyTelegramInitData(initData, process.env.TELEGRAM_BOT_TOKEN ?? "");
}

const seededAdmins = () => new Set((process.env.ADMIN_TELEGRAM_IDS ?? "").split(",").map((id) => id.trim()).filter(Boolean));

export async function registerSession(initData: string) {
  const actor = getSessionIdentity(initData);
  if (!actor) return null;
  return mutate((state) => {
    const existing = state.users.find((user) => user.id === actor.id);
    const isAdmin = actor.id === "dev" || seededAdmins().has(actor.id) || existing?.isAdmin === true;
    if (existing) Object.assign(existing, actor, { isAdmin, lastSeen: Date.now(), visits: existing.visits + 1 });
    else state.users.push({ ...actor, isAdmin, firstSeen: Date.now(), lastSeen: Date.now(), visits: 1 });
    return { user: actor, isAdmin };
  });
}

async function requireAdmin(initData: string) {
  const actor = getSessionIdentity(initData);
  if (!actor) throw new Error("UNAUTHORIZED");
  const state = await readState();
  const isAdmin = actor.id === "dev" || seededAdmins().has(actor.id) || state.users.some((user) => user.id === actor.id && user.isAdmin);
  if (!isAdmin) throw new Error("FORBIDDEN");
  return actor;
}

export async function getAdminSnapshot(initData: string): Promise<AdminSnapshot> {
  await requireAdmin(initData);
  const state = await readState();
  return { ...state, users: [...state.users].sort((a, b) => b.lastSeen - a.lastSeen) };
}

export async function setAdminRole(initData: string, userId: string, isAdmin: boolean) {
  const actor = await requireAdmin(initData);
  if (actor.id === userId && !isAdmin) throw new Error("SELF_DEMOTION");
  return mutate((state) => {
    const user = state.users.find((item) => item.id === userId);
    if (!user) throw new Error("USER_NOT_FOUND");
    user.isAdmin = isAdmin;
    return user;
  });
}

export async function setTrackedWallets(initData: string, value: number) {
  await requireAdmin(initData);
  const trackedWallets = Math.max(100, Math.min(500, Math.round(value / 50) * 50));
  return mutate((state) => { state.config.trackedWallets = trackedWallets; return trackedWallets; });
}

export async function setAdminConfig(initData: string, key: keyof AdminConfig, value: number) {
  await requireAdmin(initData);
  const normalized = normalizeAdminConfigValue(key, value);
  return mutate((state) => { state.config[key] = normalized; return normalized; });
}

export async function getAdminConfig() {
  return (await readState()).config;
}
