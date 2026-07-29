"use client";

import { useEffect, useMemo, useState } from "react";
import { getConnector } from "@/lib/nearConnector";
import { FT_CONTRACT, FT_DECIMALS } from "@/lib/config";
import {
  humanToRaw,
  rawToHuman,
  buildFtTransferAction,
  buildFtStorageDepositAction,
  splitTxs,
  computeFtGas,
  TX_GAS_BUDGET,
  STORAGE_DEPOSIT_AMOUNT,
} from "@/lib/nearSend";

// Killswitch: рассылку можно скрыть, задав NEXT_PUBLIC_SEND_ENABLED=false.
const SEND_ENABLED = process.env.NEXT_PUBLIC_SEND_ENABLED !== "false";

// Чистые переводы (без storage_deposit) — режем по газовому бюджету.
// Регистрацию делаем ОТДЕЛЬНЫМ шагом заранее, чтобы в атомарной транзакции
// переводов не было ни одного действия, способного упасть.
function buildTransferPlan(recipients, decimals, ftGas) {
  const txs = [];
  let cur = { actions: [], wallets: [], gas: 0 };
  const flush = () => {
    if (cur.actions.length)
      txs.push({ receiverId: FT_CONTRACT, actions: cur.actions, wallets: cur.wallets });
    cur = { actions: [], wallets: [], gas: 0 };
  };
  const g = parseInt(ftGas, 10);
  for (const r of recipients) {
    const raw = humanToRaw(r.amount, decimals);
    if (raw === "0") continue;
    if (cur.actions.length && cur.gas + g > TX_GAS_BUDGET) flush();
    cur.actions.push(buildFtTransferAction(r.wallet, raw, "staking payout", ftGas));
    cur.wallets.push(r.wallet);
    cur.gas += g;
  }
  flush();
  return txs;
}

async function fetchBalances(wallets) {
  const resp = await fetch("/staking/api/balances", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ wallets }),
  });
  const json = await resp.json();
  if (!resp.ok) throw new Error(json?.error || `HTTP ${resp.status}`);
  return json.balances || {};
}

export default function SendPanel({ rewards }) {
  const [wallet, setWallet] = useState(null);
  const [walletObj, setWalletObj] = useState(null);
  const [walletBusy, setWalletBusy] = useState(false);

  const [preflight, setPreflight] = useState(null);
  const [preflightBusy, setPreflightBusy] = useState(false);
  const [perTx, setPerTx] = useState(80); // переводов в одной транзакции

  const [registering, setRegistering] = useState(false);
  const [sending, setSending] = useState(false);
  const [pendingWallets, setPendingWallets] = useState(null);
  const [beforeMap, setBeforeMap] = useState(null);
  const [delivery, setDelivery] = useState(null);
  const [verifying, setVerifying] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  const decimals = preflight?.decimals ?? FT_DECIMALS;
  const unregSet = useMemo(() => new Set(preflight?.unregistered ?? []), [preflight]);
  const unknownSet = useMemo(() => new Set(preflight?.unknown ?? []), [preflight]);
  const ftGas = useMemo(() => computeFtGas(perTx), [perTx]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const c = await getConnector();
      if (!c || cancelled) return;
      const refresh = async () => {
        try {
          const existing = await c.getConnectedWallet();
          const id = existing?.accounts?.[0]?.accountId;
          if (cancelled) return;
          if (id) {
            setWallet(id);
            setWalletObj(existing.wallet);
          } else {
            setWallet(null);
            setWalletObj(null);
          }
        } catch {
          /* ignore */
        }
      };
      const onSignIn = () => refresh();
      const onSignOut = () => {
        setWallet(null);
        setWalletObj(null);
      };
      c.on("wallet:signIn", onSignIn);
      c.on("wallet:signOut", onSignOut);
      await refresh();
      return () => {
        c.off("wallet:signIn", onSignIn);
        c.off("wallet:signOut", onSignOut);
      };
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const connect = async () => {
    setWalletBusy(true);
    setErr("");
    try {
      const c = await getConnector();
      if (c) await c.connect();
    } catch {
      /* отменено */
    } finally {
      setWalletBusy(false);
    }
  };

  const disconnect = async () => {
    try {
      const c = await getConnector();
      if (c) await c.disconnect();
    } catch {
      /* ignore */
    }
    setWallet(null);
    setWalletObj(null);
  };

  const nonZero = useMemo(
    () => (rewards || []).filter((r) => humanToRaw(r.amount, decimals) !== "0"),
    [rewards, decimals]
  );

  // Отправляем ТОЛЬКО зарегистрированным (не в unregistered и не unknown).
  const sendable = useMemo(() => {
    if (!preflight) return [];
    return nonZero.filter((r) => !unregSet.has(r.wallet) && !unknownSet.has(r.wallet));
  }, [nonZero, preflight, unregSet, unknownSet]);

  const totalRaw = useMemo(
    () => sendable.reduce((acc, r) => acc + BigInt(humanToRaw(r.amount, decimals)), 0n),
    [sendable, decimals]
  );

  const plan = useMemo(
    () => buildTransferPlan(sendable, decimals, ftGas),
    [sendable, decimals, ftGas]
  );

  const senderBalRaw = preflight?.senderBalance ? BigInt(preflight.senderBalance) : null;
  const insufficient = senderBalRaw != null && senderBalRaw < totalRaw;
  const nearEstimate = (plan.length * 0.03).toFixed(2);
  const busy = registering || sending || verifying || preflightBusy;

  const runPreflight = async () => {
    if (!wallet) return;
    setPreflightBusy(true);
    setErr("");
    setMsg("");
    try {
      const resp = await fetch("/staking/api/preflight", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallets: nonZero.map((r) => r.wallet), senderId: wallet }),
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json?.error || `HTTP ${resp.status}`);
      setPreflight(json);
      setPendingWallets(null);
      setDelivery(null);
      setBeforeMap(null);
    } catch (e) {
      setErr(e.message || "Ошибка проверки получателей");
    } finally {
      setPreflightBusy(false);
    }
  };

  // Шаг 1: регистрируем незарегистрированных ОТДЕЛЬНЫМИ транзакциями (storage_deposit).
  const registerUnregistered = async () => {
    if (!walletObj?.signAndSendTransactions) {
      setErr("Кошелёк не поддерживает пакетную отправку");
      return;
    }
    const targets = preflight?.unregistered ?? [];
    if (!targets.length) return;
    const actions = targets.map((w) => buildFtStorageDepositAction(w));
    const txs = splitTxs(actions, FT_CONTRACT);
    setRegistering(true);
    setErr("");
    setMsg(`Регистрация ${targets.length} адресов (${txs.length} тр.)… подтверди в кошельке`);
    try {
      await walletObj.signAndSendTransactions({
        transactions: txs.map((t) => ({ receiverId: t.receiverId, actions: t.actions })),
      });
      setMsg("Регистрация отправлена. Перепроверяю…");
      await runPreflight();
      setMsg("Готово. Проверь, что незарегистрированных стало 0, и рассылай.");
    } catch (e) {
      setErr(e?.message || "Регистрация отменена / ошибка кошелька");
      setMsg("");
    } finally {
      setRegistering(false);
    }
  };

  // Проверка доставки: балансы после vs снимок «до».
  const verifyDelivery = async (recipients, before) => {
    setVerifying(true);
    try {
      const after = await fetchBalances(recipients.map((r) => r.wallet));
      const rows = recipients.map((r) => {
        const exp = BigInt(humanToRaw(r.amount, decimals));
        const b = before?.[r.wallet] != null ? BigInt(before[r.wallet]) : null;
        const a = after?.[r.wallet] != null ? BigInt(after[r.wallet]) : null;
        const received = b != null && a != null ? a - b : null;
        const ok = received != null && received >= exp;
        return { wallet: r.wallet, expected: exp, received, ok };
      });
      const fail = rows.filter((x) => !x.ok);
      setDelivery({ rows, ok: rows.length - fail.length, fail: fail.length });
      setPendingWallets(fail.length ? new Set(fail.map((x) => x.wallet)) : null);
      return fail;
    } finally {
      setVerifying(false);
    }
  };

  // Шаг 2: чистая рассылка переводов (все получатели уже зарегистрированы).
  async function doSend(recipients) {
    if (!walletObj?.signAndSendTransactions) {
      setErr("Кошелёк не поддерживает пакетную отправку");
      return;
    }
    const txs = buildTransferPlan(recipients, decimals, ftGas);
    if (!txs.length) {
      setErr("Нечего отправлять");
      return;
    }
    setSending(true);
    setErr("");
    setDelivery(null);
    setMsg("Снимаю балансы до отправки…");
    let before = null;
    try {
      before = await fetchBalances(recipients.map((r) => r.wallet));
      setBeforeMap(before);

      setMsg(`Отправка ${txs.length} транзакций… подтверди в кошельке`);
      await walletObj.signAndSendTransactions({
        transactions: txs.map((t) => ({ receiverId: t.receiverId, actions: t.actions })),
      });

      setMsg("Проверяю доставку по балансам…");
      const fail = await verifyDelivery(recipients, before);
      setMsg(
        fail.length
          ? `⚠️ Дошло ${recipients.length - fail.length}/${recipients.length}. Не дошло ${fail.length} — можно докинуть.`
          : `✅ Дошло всем: ${recipients.length}/${recipients.length}.`
      );
    } catch (e) {
      setPendingWallets(new Set(recipients.map((r) => r.wallet)));
      setErr(e?.message || "Отправка отменена / ошибка кошелька");
      if (before) {
        try {
          await verifyDelivery(recipients, before);
        } catch {
          /* ignore */
        }
      }
      setMsg("");
    } finally {
      setSending(false);
    }
  }

  const sendAll = () => doSend(sendable);
  const sendRemaining = () => {
    if (!pendingWallets) return;
    doSend(sendable.filter((r) => pendingWallets.has(r.wallet)));
  };
  const reVerify = () => {
    if (beforeMap) verifyDelivery(sendable, beforeMap);
  };

  if (!SEND_ENABLED) return null;
  if (!rewards?.length) return null;

  // Красивый вывод: группировка разрядов + не более 6 знаков после запятой.
  const numFmt = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 6 });
  const numFmtShort = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 });
  const fmtWith = (nf) => (raw) => {
    const human = rawToHuman(raw.toString(), decimals);
    const n = Number(human);
    return Number.isFinite(n) ? nf.format(n) : human;
  };
  const fmt = fmtWith(numFmt); // суммы наград (до 6 знаков)
  const fmtShort = fmtWith(numFmtShort); // баланс (2 знака)
  const unregCount = preflight?.unregistered.length ?? 0;

  return (
    <div className="card" style={{ borderColor: "#3a2a5a" }}>
      <div className="batches-header">
        <div>
          <h2>Рассылка наград ({FT_CONTRACT})</h2>
          <div className="hint">
            Порядок: 1) проверить всех → 2) зарегистрировать тех, у кого нет
            storage → 3) разослать батчами → 4) сверить, что дошло всем.
            Подписываешь подключённым NEAR-кошельком (лучше HOT — одним батчем).
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {wallet ? (
            <>
              <code style={{ fontSize: 13 }}>{wallet}</code>
              <button type="button" className="ghost" onClick={disconnect}>
                Отключить
              </button>
            </>
          ) : (
            <button type="button" onClick={connect} disabled={walletBusy}>
              {walletBusy ? "Подключаем…" : "Подключить кошелёк"}
            </button>
          )}
        </div>
      </div>

      {wallet && (
        <>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 12, alignItems: "flex-end" }}>
            <button type="button" className="secondary" onClick={runPreflight} disabled={busy}>
              {preflightBusy ? "Проверяем…" : "1. Проверить получателей"}
            </button>
            <div className="field" style={{ flex: "0 1 200px" }}>
              <label htmlFor="pertx">Переводов в транзакции</label>
              <input
                id="pertx"
                type="number"
                min="10"
                max="100"
                value={perTx}
                onChange={(e) => setPerTx(Math.max(10, Math.min(100, Number(e.target.value) || 80)))}
              />
            </div>
          </div>

          {preflight && (
            <>
              <div className="stats-grid" style={{ marginTop: 12 }}>
                <div className="stat">
                  <div className="label">Получателей</div>
                  <div className="value">{nonZero.length}</div>
                </div>
                <div className="stat">
                  <div className="label">Зарегистрировано</div>
                  <div className="value">{preflight.registeredCount}</div>
                </div>
                <div className="stat">
                  <div className="label">Не зарегистр.</div>
                  <div className="value">{unregCount}</div>
                </div>
                <div className="stat">
                  <div className="label">К отправке</div>
                  <div className="value">{sendable.length}</div>
                </div>
                <div className="stat">
                  <div className="label">Транзакций</div>
                  <div className="value">{plan.length}</div>
                </div>
                <div className="stat">
                  <div className="label">Сумма к отправке</div>
                  <div className="value" style={{ overflowWrap: "anywhere" }}>{fmt(totalRaw)}</div>
                </div>
                <div className="stat">
                  <div className="label">Баланс кошелька</div>
                  <div className="value" style={{ overflowWrap: "anywhere" }}>
                    {senderBalRaw != null ? fmtShort(senderBalRaw) : "—"}
                  </div>
                </div>
              </div>

              <div className="hint" style={{ marginTop: 8 }}>
                ~{plan.length} транзакций по ≤{perTx} переводов. Нужно ≈{nearEstimate} NEAR
                на газ (неизрасходованное вернётся) — держи запас на кошельке.
              </div>
            </>
          )}

          {preflight && unregCount > 0 && (
            <div style={{ marginTop: 16, padding: 12, border: "1px solid #6a4a2a", borderRadius: 8 }}>
              <div style={{ marginBottom: 8 }}>
                <b>{unregCount}</b> адресов без storage — им перевод упадёт. Сначала
                зарегистрируй их: +
                {rawToHuman((BigInt(STORAGE_DEPOSIT_AMOUNT) * BigInt(unregCount)).toString(), 24)} NEAR.
              </div>
              <button type="button" onClick={registerUnregistered} disabled={busy} style={{ background: "#6a4a2a" }}>
                {registering ? <span className="spinner" /> : null}
                {registering ? "Регистрация…" : `2. Зарегистрировать (${unregCount})`}
              </button>
            </div>
          )}

          {preflight && preflight.unknown.length > 0 && (
            <div className="hint" style={{ marginTop: 8 }}>
              ⚠️ {preflight.unknown.length} кошельков не удалось проверить — исключены. Повтори проверку.
            </div>
          )}

          {insufficient && (
            <div className="error" style={{ marginTop: 12 }}>
              ❌ Недостаточно токена: нужно {fmt(totalRaw)}, есть {fmt(senderBalRaw)}.
            </div>
          )}

          {preflight && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 16 }}>
              <button
                type="button"
                onClick={sendAll}
                disabled={busy || insufficient || !sendable.length || unregCount > 0}
                style={{ background: "#7a2e3e" }}
                title={unregCount > 0 ? "Сначала зарегистрируй незарегистрированных" : undefined}
              >
                {sending ? <span className="spinner" /> : null}
                {sending ? "Отправка…" : `3. Разослать (${sendable.length})`}
              </button>
              {pendingWallets && pendingWallets.size > 0 && (
                <button type="button" className="secondary" onClick={sendRemaining} disabled={busy}>
                  Докинуть оставшиеся ({pendingWallets.size})
                </button>
              )}
              {beforeMap && (
                <button type="button" className="ghost" onClick={reVerify} disabled={busy}>
                  {verifying ? "Проверяю…" : "4. Проверить доставку ещё раз"}
                </button>
              )}
            </div>
          )}

          {msg && <div className="batches-summary" style={{ marginTop: 12 }}>{msg}</div>}
          {err && <div className="error" style={{ marginTop: 12 }}>❌ {err}</div>}

          {delivery && (
            <div style={{ marginTop: 12 }}>
              <div className="batches-summary">
                Доставка: <b>{delivery.ok}</b> дошло · <b>{delivery.fail}</b> не дошло
              </div>
              {delivery.fail > 0 && (
                <div className="batch-body" style={{ marginTop: 8, maxHeight: 220, overflow: "auto" }}>
                  {delivery.rows
                    .filter((x) => !x.ok)
                    .map((x, i) => (
                      <div key={i}>
                        <span className="row-wallet">{x.wallet}</span>
                        <span className="row-comma"> — ждали </span>
                        <span className="row-amount">{fmt(x.expected)}</span>
                        <span className="row-comma">
                          , получено {x.received == null ? "?" : fmt(x.received)}
                        </span>
                      </div>
                    ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
