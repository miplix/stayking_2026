import { NextResponse } from "next/server";
import { runCalculation } from "@/lib/calculator";

// На Vercel — serverless function. Запрос к api.sendler.xyz идёт с сервера,
// поэтому CORS-проблем в браузере не будет.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const totalStaking = Number(body.totalStaking);
    const batchSize = Number.isFinite(Number(body.batchSize))
      ? Number(body.batchSize)
      : 50;

    if (!Number.isFinite(totalStaking) || totalStaking <= 0) {
      return NextResponse.json(
        { error: "Укажите корректную сумму стейкинга (> 0)" },
        { status: 400 }
      );
    }

    const result = await runCalculation(totalStaking, batchSize);
    return NextResponse.json(result);
  } catch (e) {
    console.error(e);
    return NextResponse.json(
      { error: e?.message || "Ошибка при расчёте" },
      { status: 500 }
    );
  }
}
