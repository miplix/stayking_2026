// NEAR FT-мультиотправка. Логика портирована из lotoreya/lib/payout.ts.
// Всё чистые функции — считают действия/транзакции, ничего сами не подписывают.

import { FT_CONTRACT, NEAR_RPC } from "./config.js";

// ─── Газ/депозиты ───────────────────────────────────────────────────────────
// ft_transfer на стандартном NEP-141 к зарегистрированному аккаунту реально
// стоит ~2.5–3.5 Tgas. Газ на перевод считаем динамически под размер батча:
// сколько переводов хотим в одной транзакции, столько и делим бюджет (см.
// computeFtGas). Практика (Sendler и т.п.): до ~100 ft_transfer в одну tx.
export const STORAGE_DEPOSIT_GAS = "10000000000000"; // 10 Tgas
export const STORAGE_DEPOSIT_AMOUNT = "1250000000000000000000"; // 0.00125 NEAR
export const TX_GAS_BUDGET = 290_000_000_000_000; // потолок на 1 tx (< лимит 300)

// Газ на один ft_transfer под желаемое число переводов в транзакции.
// Зажимаем в [3 Tgas, 30 Tgas]: 3 Tgas — минимум, что реально хватает; 30 —
// с запасом для мелких батчей.
export function computeFtGas(perTx) {
  const n = Math.max(1, Math.min(100, Math.floor(perTx || 80)));
  const per = Math.floor(TX_GAS_BUDGET / n);
  const clamped = Math.max(3_000_000_000_000, Math.min(30_000_000_000_000, per));
  return String(clamped);
}

// Дефолтный газ (батч 80) — для обратной совместимости импортов.
export const FT_TRANSFER_GAS = computeFtGas(80);

// human (число/строка) → минимальные единицы токена (строка BigInt), без float-дрейфа.
export function humanToRaw(human, decimals) {
  const s = String(human);
  if (decimals === 0) {
    // округляем к целому
    const [i] = s.split(".");
    return BigInt(i || "0").toString();
  }
  const [intPart, fracPart = ""] = s.split(".");
  const fracPadded = (fracPart + "0".repeat(decimals)).slice(0, decimals);
  const combined = (intPart || "0") + fracPadded;
  return BigInt(combined).toString();
}

// raw (строка) → human-строка для показа (без лишних нулей).
export function rawToHuman(raw, decimals) {
  const neg = String(raw).startsWith("-");
  const digits = String(raw).replace("-", "").padStart(decimals + 1, "0");
  const intPart = digits.slice(0, digits.length - decimals);
  let frac = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return (neg ? "-" : "") + intPart + (frac ? "." + frac : "");
}

export function buildFtStorageDepositAction(receiverId) {
  return {
    type: "FunctionCall",
    params: {
      methodName: "storage_deposit",
      args: { account_id: receiverId, registration_only: true },
      gas: STORAGE_DEPOSIT_GAS,
      deposit: STORAGE_DEPOSIT_AMOUNT,
    },
  };
}

export function buildFtTransferAction(receiverId, rawAmount, memo = "staking payout", gas = FT_TRANSFER_GAS) {
  return {
    type: "FunctionCall",
    params: {
      methodName: "ft_transfer",
      args: { receiver_id: receiverId, amount: rawAmount, memo },
      gas,
      deposit: "1",
    },
  };
}

// Режем список действий на транзакции по газовому бюджету. Все действия идут
// на один и тот же receiverId (контракт токена).
export function splitTxs(actions, receiverId, budget = TX_GAS_BUDGET) {
  const txs = [];
  let cur = [];
  let curGas = 0;
  for (const a of actions) {
    const g = parseInt(a.params.gas, 10);
    if (cur.length && curGas + g > budget) {
      txs.push({ receiverId, actions: cur });
      cur = [];
      curGas = 0;
    }
    cur.push(a);
    curGas += g;
  }
  if (cur.length) txs.push({ receiverId, actions: cur });
  return txs;
}

// ─── read-only view-вызовы к NEAR RPC ───────────────────────────────────────
async function viewCall(accountId, method, args, rpc = NEAR_RPC) {
  const argsB64 =
    typeof btoa === "function"
      ? btoa(JSON.stringify(args))
      : Buffer.from(JSON.stringify(args)).toString("base64");
  const resp = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "1",
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: accountId,
        method_name: method,
        args_base64: argsB64,
      },
    }),
  });
  const json = await resp.json();
  if (json.error) throw new Error(json.error.message || "RPC error");
  const bytes = json.result?.result;
  if (!bytes) return null;
  const text =
    typeof Buffer !== "undefined"
      ? Buffer.from(bytes).toString()
      : new TextDecoder().decode(new Uint8Array(bytes));
  return JSON.parse(text);
}

export async function isRegistered(accountId, ftContract = FT_CONTRACT, rpc = NEAR_RPC) {
  const res = await viewCall(ftContract, "storage_balance_of", { account_id: accountId }, rpc);
  return res !== null;
}

export async function ftBalanceOf(accountId, ftContract = FT_CONTRACT, rpc = NEAR_RPC) {
  const res = await viewCall(ftContract, "ft_balance_of", { account_id: accountId }, rpc);
  return String(res ?? "0");
}

export async function ftDecimals(ftContract = FT_CONTRACT, rpc = NEAR_RPC) {
  const meta = await viewCall(ftContract, "ft_metadata", {}, rpc);
  return Number(meta?.decimals ?? 18);
}
