"use client";

import { useMemo, useState } from "react";

function batchToCsv(batch) {
  // формат как в Python create_sender_batches:
  // заголовок "Wallet,Amount", затем строки wallet,amount
  const lines = ["Wallet,Amount"];
  for (const r of batch) lines.push(`${r.wallet},${r.amount}`);
  return lines.join("\n");
}

function allRewardsToCsv(rewards) {
  const lines = ["Wallet,Reward"];
  for (const r of rewards) lines.push(`${r.wallet},${r.amount}`);
  return lines.join("\n");
}

function allRewardsToTxt(rewards) {
  return rewards.map((r) => `${r.wallet}: ${r.amount}`).join("\n");
}

function downloadFile(filename, content, mime = "text/csv") {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function Page() {
  const [amount, setAmount] = useState("");
  const [batchSize, setBatchSize] = useState(50);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [data, setData] = useState(null);
  const [copiedIdx, setCopiedIdx] = useState(-1); // -1 = none, -2 = "all"
  const [processed, setProcessed] = useState(() => new Set()); // индексы обработанных батчей

  async function onCalculate(e) {
    e.preventDefault();
    setError("");
    setData(null);
    setProcessed(new Set()); // сброс отметок при новом расчёте
    setLoading(true);
    try {
      const resp = await fetch("/api/calculate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          totalStaking: Number(amount),
          batchSize: Number(batchSize) || 50,
        }),
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json?.error || `HTTP ${resp.status}`);
      setData(json);
    } catch (err) {
      setError(err.message || "Неизвестная ошибка");
    } finally {
      setLoading(false);
    }
  }

  function markProcessed(idx) {
    setProcessed((prev) => {
      if (prev.has(idx)) return prev;
      const next = new Set(prev);
      next.add(idx);
      return next;
    });
  }

  async function copyBatch(idx, text) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedIdx(idx);
      if (idx >= 0) markProcessed(idx); // не отмечаем "all"
      setTimeout(() => setCopiedIdx((c) => (c === idx ? -1 : c)), 1600);
    } catch {
      setError("Не удалось скопировать в буфер обмена");
    }
  }

  function downloadBatch(idx, filename, content) {
    downloadFile(filename, content);
    markProcessed(idx);
  }

  const batchesView = useMemo(() => {
    if (!data?.batches) return [];
    return data.batches.map((batch, idx) => ({
      idx,
      number: idx + 1,
      count: batch.length,
      rows: batch,
      csv: batchToCsv(batch),
    }));
  }, [data]);

  return (
    <div className="container">
      <div className="header">
        <div>
          <h1>Darai NFT Staking Calculator</h1>
          <div className="subtitle">
            Распределение наград по держателям коллекции{" "}
            <code>darai.mintbase1.near</code>
          </div>
        </div>
      </div>

      <form className="card" onSubmit={onCalculate}>
        <div className="form-row">
          <div className="field">
            <label htmlFor="amount">Сумма стейкинга</label>
            <input
              id="amount"
              type="number"
              step="any"
              min="0"
              placeholder="например, 1000"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              required
            />
          </div>
          <div className="field" style={{ flex: "0 1 180px" }}>
            <label htmlFor="batch">Размер батча</label>
            <input
              id="batch"
              type="number"
              min="1"
              max="500"
              value={batchSize}
              onChange={(e) => setBatchSize(e.target.value)}
            />
          </div>
          <div style={{ display: "flex", alignItems: "flex-end" }}>
            <button type="submit" disabled={loading || !amount}>
              {loading && <span className="spinner" />}
              {loading ? "Считаем…" : "Рассчитать"}
            </button>
          </div>
        </div>
        {error && <div className="error">❌ {error}</div>}
      </form>

      {data && (
        <>
          <div className="card">
            <div className="stats-grid">
              <div className="stat">
                <div className="label">Всего NFT</div>
                <div className="value">{data.stats.totalNfts}</div>
              </div>
              <div className="stat">
                <div className="label">Суммарная мощность</div>
                <div className="value">{data.totalPower}</div>
              </div>
              <div className="stat">
                <div className="label">Кошельков</div>
                <div className="value">{data.totalWallets}</div>
              </div>
              <div className="stat">
                <div className="label">Сумма стейкинга</div>
                <div className="value">{data.totalStaking}</div>
              </div>
              <div className="stat">
                <div className="label">Батчей</div>
                <div className="value">{data.batches.length}</div>
              </div>
            </div>

            <div className="rarity-list">
              {data.stats.breakdown.map(({ rarity, count }) => (
                <div className="rarity-row" key={rarity}>
                  <span className="name">{rarity}</span>
                  <span className="count">{count}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="card">
            <div className="batches-header">
              <div>
                <h2>Батчи для рассылки</h2>
                <div className="hint">
                  Каждый блок — отдельный файл по {batchSize} записей. Можно
                  копировать или скачать CSV.
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button
                  type="button"
                  className="secondary"
                  onClick={() =>
                    downloadFile(
                      "staking_result.csv",
                      allRewardsToCsv(data.rewards)
                    )
                  }
                >
                  Скачать все (CSV)
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() =>
                    downloadFile(
                      "staking_result.txt",
                      allRewardsToTxt(data.rewards),
                      "text/plain"
                    )
                  }
                >
                  Скачать все (TXT)
                </button>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => copyBatch(-2, allRewardsToTxt(data.rewards))}
                >
                  {copiedIdx === -2 ? "✓ Скопировано" : "Копировать все"}
                </button>
              </div>
            </div>

            <div className="batches-summary">
              Обработано: <b>{processed.size}</b> / {batchesView.length}
            </div>

            {batchesView.map((b) => {
              const done = processed.has(b.idx);
              return (
                <div className={`batch ${done ? "done" : ""}`} key={b.idx}>
                  <div className="batch-head">
                    <div className="batch-title">
                      <span className="batch-badge">
                        {done ? "✓ " : ""}BATCH {b.number}
                      </span>
                      <span>Файл batch_{b.number}.csv</span>
                      <span className="batch-meta">{b.count} записей</span>
                      <span
                        className={`copied-tag ${
                          copiedIdx === b.idx ? "show" : ""
                        }`}
                      >
                        скопировано в буфер
                      </span>
                    </div>
                    <div className="batch-actions">
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => copyBatch(b.idx, b.csv)}
                      >
                        Копировать
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() =>
                          downloadBatch(
                            b.idx,
                            `batch_${b.number}.csv`,
                            b.csv
                          )
                        }
                      >
                        Скачать CSV
                      </button>
                    </div>
                  </div>
                  <div className="batch-body">
                    {b.rows.map((r, i) => (
                      <div key={i}>
                        <span className="row-wallet">{r.wallet}</span>
                        <span className="row-comma">,</span>
                        <span className="row-amount">{r.amount}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      <div className="footer-note">
        Логика расчёта идентична Python-скрипту · рассчёт выполняется на сервере
        (Vercel serverless)
      </div>
    </div>
  );
}
