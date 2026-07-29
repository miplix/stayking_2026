"use client";

import { useEffect, useMemo, useState } from "react";
import { getConnector } from "@/lib/nearConnector";
import {
  FT_CONTRACT,
  FT_DECIMALS,
} from "@/lib/config";
import {
  humanToRaw,
  rawToHuman,
  buildFtTransferAction,
  buildFtStorageDepositAction,
  TX_GAS_BUDGET,
  STORAGE_DEPOSIT_AMOUNT,
} from "@/lib/nearSend";

// Killswitch: рассылку можно скрыть, задав NEXT_PUBLIC_SEND_ENABLED=false.
const SEND_ENABLED = process.env.NEXT_PUBLIC_SEND_ENABLED !== "false";

function isOutcomeSuccess(o) {
  if (!o) return false;
  const st = o.status ?? o?.final_execution_outcome?.status;
  if (st == null) return true; // no-throw без явного статуса — считаем успехом
  if (typeof st === "object" && st.Failure) return false;
  return true;
}

// Группируем получателей в NEAR-транзакции по газовому бюджету. Storage_deposit
// и ft_transfer одного получателя всегда в одной транзакции. Возвращаем массив
// { receiverId, actions, wallets } — по одному на транзакцию.
function buildPlan(recipients, decimals, unregSet, includeUnreg) {
  const txs = [];
  let cur = { actions: [], wallets: [], gas: 0 };
  const flush = () => {
    if (cur.actions.length)
      txs.push({ receiverId: FT_CONTRACT, actions: cur.actions, wallets: cur.wallets });
    cur = { actions: [], wallets: [], gas: 0 };
  };
  for (const r of recipients) {
    const raw = humanToRaw(r.amount, decimals);
    if (raw === "0") continue; // нулевые пропускаем
    const acts = [];
    if (includeUnreg && unregSet.has(r.wallet)) acts.push(buildFtStorageDepositAction(r.wallet));
    acts.push(buildFtTransferAction(r.wallet, raw));
    const g = acts.reduce((s, a) => s + parseInt(a.params.gas, 10), 0);
    if (cur.actions.length && cur.gas + g > TX_GAS_BUDGET) flush();
    cur.actions.push(...acts);
    cur.wallets.push(r.wallet);
    cur.gas += g;
  }
  flush();
  return txs;
}

export default function SendPanel({ rewards }) {
  const [wallet, setWallet] = useState(null);
  const [walletObj, setWalletObj] = useState(null);
  const [walletBusy, setWalletBusy] = useState(false);

  const [preflight, setPreflight] = useState(null); // {decimals, unregistered, unknown, senderBalance, ...}
  const [preflightBusy, setPreflightBusy] = useState(false);
  const [includeUnreg, setIncludeUnreg] = useState(false);

  const [sending, setSending] = useState(false);
  const [progress, setProgress] = useState(null); // {total, done, okWallets:Set, failWallets:Set}
  const [pendingWallets, setPendingWallets] = useState(null); // Set | null (для докидки)
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  const decimals = preflight?.decimals ?? FT_DECIMALS;
  const unregSet = useMemo(() => new Set(preflight?.unregistered ?? []), [preflight]);
  const unknownSet = useMemo(() => new Set(preflight?.unknown ?? []), [preflight]);

  // Подписка на состояние кошелька.
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
      /* отменено / popup заблокирован */
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

  // Итоговый набор получателей (ненулевые). Кого реально отправляем — зависит
  // от того, регистрируем ли незарегистрированных.
  const nonZero = useMemo(
    () => (rewards || []).filter((r) => humanToRaw(r.amount, decimals) !== "0"),
    [rewards, decimals]
  );

  const sendable = useMemo(() => {
    if (!preflight) return nonZero;
    return nonZero.filter((r) => {
      if (unknownSet.has(r.wallet)) return false; // не смогли проверить — не рискуем
      if (unregSet.has(r.wallet)) return includeUnreg; // незарег — только если регистрируем
      return true;
    });
  }, [nonZero, preflight, unregSet, unknownSet, includeUnreg]);

  const totalRaw = useMemo(
    () => sendable.reduce((acc, r) => acc + BigInt(humanToRaw(r.amount, decimals)), 0n),
    [sendable, decimals]
  );

  const plan = useMemo(
    () => buildPlan(sendable, decimals, unregSet, includeUnreg),
    [sendable, decimals, unregSet, includeUnreg]
  );

  const senderBalRaw = preflight?.senderBalance ? BigInt(preflight.senderBalance) : null;
  const insufficient = senderBalRaw != null && senderBalRaw < totalRaw;

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
      setProgress(null);
      setPendingWallets(null);
    } catch (e) {
      setErr(e.message || "Ошибка проверки получателей");
    } finally {
      setPreflightBusy(false);
    }
  };

  async function doSend(recipients) {
    if (!walletObj?.signAndSendTransactions) {
      setErr("Кошелёк не поддерживает пакетную отправку");
      return;
    }
    const txs = buildPlan(recipients, decimals, unregSet, includeUnreg);
    if (!txs.length) {
      setErr("Нечего отправлять");
      return;
    }
    setSending(true);
    setErr("");
    setMsg(`Отправка ${txs.length} транзакций… подтверди в кошельке`);
    const okWallets = new Set();
    const failWallets = new Set();
    try {
      const outcomes = await walletObj.signAndSendTransactions({
        transactions: txs.map((t) => ({ receiverId: t.receiverId, actions: t.actions })),
      });
      const arr = Array.isArray(outcomes) ? outcomes : null;
      txs.forEach((t, i) => {
        const ok = arr ? isOutcomeSuccess(arr[i]) : true;
        for (const w of t.wallets) (ok ? okWallets : failWallets).add(w);
      });
      setProgress({ total: recipients.length, ok: okWallets, fail: failWallets });
      const pend = new Set(failWallets);
      setPendingWallets(pend.size ? pend : null);
      setMsg(
        failWallets.size
          ? `Готово частично: успешно ${okWallets.size}, не прошло ${failWallets.size}. Можно докинуть оставшиеся.`
          : `✅ Разослано всем: ${okWallets.size} кошельков.`
      );
    } catch (e) {
      // Пользователь отклонил или ошибка кошелька — считаем всё неотправленным.
      setPendingWallets(new Set(recipients.map((r) => r.wallet)));
      setErr(e?.message || "Отправка отменена / ошибка кошелька");
    } finally {
      setSending(false);
    }
  }

  const sendAll = () => doSend(sendable);
  const sendRemaining = () => {
    if (!pendingWallets) return;
    doSend(sendable.filter((r) => pendingWallets.has(r.wallet)));
  };

  if (!SEND_ENABLED) return null;
  if (!rewards?.length) return null;

  const fmt = (raw) => rawToHuman(raw.toString(), decimals);

  return (
    <div className="card" style={{ borderColor: "#3a2a5a" }}>
      <div className="batches-header">
        <div>
          <h2>Рассылка наград ({FT_CONTRACT})</h2>
          <div className="hint">
            Автоматическая мультиотправка токена держателям пачками. Подписываешь
            подключённым NEAR-кошельком — средства двигаешь только ты.
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
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
            <button type="button" className="secondary" onClick={runPreflight} disabled={preflightBusy}>
              {preflightBusy ? "Проверяем получателей…" : "Проверить получателей"}
            </button>
          </div>

          {preflight && (
            <div className="stats-grid" style={{ marginTop: 12 }}>
              <div className="stat">
                <div className="label">Получателей (ненулевых)</div>
                <div className="value">{nonZero.length}</div>
              </div>
              <div className="stat">
                <div className="label">Зарегистрировано</div>
                <div className="value">{preflight.registeredCount}</div>
              </div>
              <div className="stat">
                <div className="label">Не зарегистрировано</div>
                <div className="value">{preflight.unregistered.length}</div>
              </div>
              <div className="stat">
                <div className="label">К отправке</div>
                <div className="value">{sendable.length}</div>
              </div>
              <div className="stat">
                <div className="label">Транзакций к подписи</div>
                <div className="value">{plan.length}</div>
              </div>
              <div className="stat">
                <div className="label">Сумма к отправке</div>
                <div className="value">{fmt(totalRaw)}</div>
              </div>
              <div className="stat">
                <div className="label">Баланс кошелька</div>
                <div className="value">
                  {senderBalRaw != null ? fmt(senderBalRaw) : "—"}
                </div>
              </div>
            </div>
          )}

          {preflight && preflight.unregistered.length > 0 && (
            <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12 }}>
              <input
                type="checkbox"
                checked={includeUnreg}
                onChange={(e) => setIncludeUnreg(e.target.checked)}
              />
              <span>
                Регистрировать незарегистрированных ({preflight.unregistered.length}) — +
                {rawToHuman(
                  (BigInt(STORAGE_DEPOSIT_AMOUNT) * BigInt(preflight.unregistered.length)).toString(),
                  24
                )}{" "}
                NEAR за storage. Иначе они пропускаются.
              </span>
            </label>
          )}

          {preflight && preflight.unknown.length > 0 && (
            <div className="hint" style={{ marginTop: 8 }}>
              ⚠️ {preflight.unknown.length} кошельков не удалось проверить — они
              исключены из отправки. Повтори проверку.
            </div>
          )}

          {insufficient && (
            <div className="error" style={{ marginTop: 12 }}>
              ❌ Недостаточно токена на кошельке: нужно {fmt(totalRaw)}, есть{" "}
              {fmt(senderBalRaw)}.
            </div>
          )}

          {preflight && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 16 }}>
              <button
                type="button"
                onClick={sendAll}
                disabled={sending || insufficient || !sendable.length}
                style={{ background: "#7a2e3e" }}
              >
                {sending ? <span className="spinner" /> : null}
                {sending ? "Отправка…" : `Разослать (${sendable.length})`}
              </button>
              {pendingWallets && pendingWallets.size > 0 && (
                <button
                  type="button"
                  className="secondary"
                  onClick={sendRemaining}
                  disabled={sending}
                >
                  Докинуть оставшиеся ({pendingWallets.size})
                </button>
              )}
            </div>
          )}

          {msg && <div className="batches-summary" style={{ marginTop: 12 }}>{msg}</div>}
          {err && <div className="error" style={{ marginTop: 12 }}>❌ {err}</div>}

          {progress && (
            <div className="hint" style={{ marginTop: 8 }}>
              Успешно: <b>{progress.ok.size}</b> · Не прошло: <b>{progress.fail.size}</b>
            </div>
          )}
        </>
      )}
    </div>
  );
}
