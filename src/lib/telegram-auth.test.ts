import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { verifyTelegramInitData } from "./telegram-auth.ts";

function signed(token: string, authDate: number) {
  const params = new URLSearchParams({ auth_date: String(authDate), query_id: "q1", user: JSON.stringify({ id: 42, first_name: "Ilya", username: "ilya" }) });
  const check = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  params.set("hash", createHmac("sha256", secret).update(check).digest("hex"));
  return params.toString();
}

test("Telegram Mini App init data is verified and parsed", () => {
  const now = 1_800_000_000_000;
  assert.deepEqual(verifyTelegramInitData(signed("token", now / 1_000), "token", now), { id: "42", firstName: "Ilya", lastName: "", username: "ilya" });
  assert.equal(verifyTelegramInitData(signed("token", now / 1_000), "wrong", now), null);
  assert.equal(verifyTelegramInitData(signed("token", now / 1_000 - 90_000), "token", now), null);
});
