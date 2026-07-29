import { NextResponse } from "next/server";
import { FT_CONTRACT } from "@/lib/config";
import { ftBalanceOf } from "@/lib/nearSend";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Снимок ft_balance_of по списку кошельков. Используется дважды: до и после
// рассылки — чтобы по дельте убедиться, что каждому реально дошло.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const wallets = Array.isArray(body.wallets) ? body.wallets : [];
    if (!wallets.length) {
      return NextResponse.json({ error: "Пустой список кошельков" }, { status: 400 });
    }
    const rows = await mapLimit(wallets, 24, async (w, idx) => {
      try {
        return [w, await ftBalanceOf(w, FT_CONTRACT, { offset: idx })];
      } catch {
        return [w, null]; // null = не удалось прочитать
      }
    });
    const balances = {};
    for (const [w, b] of rows) balances[w] = b;
    return NextResponse.json({ ftContract: FT_CONTRACT, balances });
  } catch (e) {
    console.error("[balances]", e);
    return NextResponse.json({ error: e?.message || "Ошибка снимка балансов" }, { status: 500 });
  }
}
