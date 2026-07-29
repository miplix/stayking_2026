import { NextResponse } from "next/server";
import { FT_CONTRACT } from "@/lib/config";
import { isRegistered, ftBalanceOf, ftDecimals } from "@/lib/nearSend";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Проверяем регистрацию получателей на контракте токена (storage_balance_of).
// Незарегистрированным ft_transfer упадёт — их надо либо зарегистрировать
// (storage_deposit), либо пропустить. Считаем серверно, чтобы не упереться
// в rate-limit публичного RPC из браузера.
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
    const senderId = typeof body.senderId === "string" ? body.senderId : "";

    if (!wallets.length) {
      return NextResponse.json({ error: "Пустой список кошельков" }, { status: 400 });
    }

    const decimals = await ftDecimals(FT_CONTRACT).catch(() => 18);

    // Первый проход — быстро, высокий параллелизм.
    let results = await mapLimit(wallets, 24, async (w, idx) => {
      try {
        return { wallet: w, registered: await isRegistered(w, FT_CONTRACT, { offset: idx }) };
      } catch {
        return { wallet: w, registered: null }; // null = не удалось проверить
      }
    });

    // Второй проход — бережно (низкий параллелизм + больше попыток) добиваем тех,
    // кого зарезал rate-limit, чтобы «не проверено» стремилось к нулю.
    const stragglers = results.filter((r) => r.registered === null).map((r) => r.wallet);
    if (stragglers.length) {
      const retry = await mapLimit(stragglers, 6, async (w, idx) => {
        try {
          return { wallet: w, registered: await isRegistered(w, FT_CONTRACT, { offset: idx + 1, attempts: 8 }) };
        } catch {
          return { wallet: w, registered: null };
        }
      });
      const fixed = new Map(retry.map((r) => [r.wallet, r.registered]));
      results = results.map((r) =>
        fixed.has(r.wallet) ? { wallet: r.wallet, registered: fixed.get(r.wallet) } : r
      );
    }

    const unregistered = results.filter((r) => r.registered === false).map((r) => r.wallet);
    const unknown = results.filter((r) => r.registered === null).map((r) => r.wallet);

    let senderBalance = null;
    if (senderId) {
      senderBalance = await ftBalanceOf(senderId, FT_CONTRACT).catch(() => null);
    }

    return NextResponse.json({
      ftContract: FT_CONTRACT,
      decimals,
      total: wallets.length,
      registeredCount: results.filter((r) => r.registered === true).length,
      unregistered,
      unknown,
      senderBalance, // raw-строка или null
    });
  } catch (e) {
    console.error("[preflight]", e);
    return NextResponse.json({ error: e?.message || "Ошибка pre-flight" }, { status: 500 });
  }
}
