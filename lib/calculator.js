// Порт main.py / utils.py (Python → JS).
// Логика идентична оригинальному скрипту.

import { API_URL, BLACKLIST_ADDRESSES, TITLE_BLACKLIST } from "./config.js";
import { POWER_VALUES } from "./powerValues.js";

const BLACKLIST_SET = new Set(BLACKLIST_ADDRESSES.map((a) => a.toLowerCase()));
const TITLE_BLACKLIST_LOWER = TITLE_BLACKLIST.map((t) => t.toLowerCase());

// Пагинируем все NFT. API отдаёт { items, total, skip, limit, count }.
// Максимальный рабочий limit ~5000, используем 2000 для надёжности.
const PAGE_LIMIT = 2000;

export async function fetchNfts() {
  const apiKey = process.env.SENDLER_API_KEY || "";

  const headers = {
    "User-Agent": "DaraiStakingCalculator/1.0",
    Accept: "application/json",
  };
  if (apiKey) headers["X-API-Key"] = apiKey;

  async function fetchPage(skip) {
    const url = `${API_URL}&skip=${skip}&limit=${PAGE_LIMIT}`;
    const resp = await fetch(url, { cache: "no-store", headers });

    if (!resp.ok) {
      let detail = "";
      try {
        const body = await resp.text();
        detail = body ? ` — ${body.slice(0, 200)}` : "";
      } catch {}
      if (resp.status === 401 || resp.status === 403) {
        throw new Error(
          `NFT API вернул ${resp.status}${detail}. Укажи переменную окружения SENDLER_API_KEY (локально в .env.local, на Vercel — в Settings → Environment Variables).`
        );
      }
      throw new Error(
        `NFT API вернул ${resp.status} ${resp.statusText}${detail}`
      );
    }
    return resp.json();
  }

  const first = await fetchPage(0);
  const all = Array.isArray(first.items) ? [...first.items] : [];
  const total = Number(first.total) || all.length;

  // Защита от бесконечного цикла: максимум 20 страниц.
  for (let skip = PAGE_LIMIT, page = 1; skip < total && page < 20; skip += PAGE_LIMIT, page++) {
    const next = await fetchPage(skip);
    if (!Array.isArray(next.items) || next.items.length === 0) break;
    all.push(...next.items);
  }

  return all;
}

export function filterAndGroup(nfts) {
  const walletNfts = new Map();
  const allTitles = [];

  for (const nft of nfts) {
    const ownerRaw = nft?.owner_id;
    // Новая схема API — title плоский; старая — в metadata.title.
    const titleRaw = nft?.title ?? nft?.metadata?.title;

    if (!ownerRaw || !titleRaw) continue;

    const owner = String(ownerRaw).toLowerCase();
    const title = String(titleRaw).trim().toLowerCase();

    if (BLACKLIST_SET.has(owner)) continue;
    if (TITLE_BLACKLIST_LOWER.some((bad) => title.includes(bad))) continue;

    if (!walletNfts.has(owner)) walletNfts.set(owner, []);
    walletNfts.get(owner).push(title);
    allTitles.push(title);
  }

  return { walletNfts, allTitles };
}

export function calculatePowerForTitle(title) {
  for (const [keyword, power] of Object.entries(POWER_VALUES)) {
    if (title.includes(keyword.toLowerCase())) {
      return power;
    }
  }
  return 0;
}

export function calculatePowerByWallet(walletNfts) {
  const powerMap = new Map();
  for (const [wallet, titles] of walletNfts.entries()) {
    const totalPower = titles.reduce(
      (acc, title) => acc + calculatePowerForTitle(title),
      0
    );
    powerMap.set(wallet, totalPower);
  }
  return powerMap;
}

// round(x, 6) — как в Python
function round6(x) {
  return Math.round(x * 1e6) / 1e6;
}

export function distributeRewards(powerMap, totalStaking) {
  let totalPower = 0;
  for (const p of powerMap.values()) totalPower += p;

  const rewards = new Map();
  for (const [wallet, power] of powerMap.entries()) {
    if (totalPower === 0) {
      rewards.set(wallet, 0);
    } else {
      rewards.set(wallet, round6((power / totalPower) * totalStaking));
    }
  }
  return { rewards, totalPower };
}

export function buildStats(allTitles, totalPower) {
  const counts = {};
  for (const title of allTitles) {
    let matched = false;
    for (const keyword of Object.keys(POWER_VALUES)) {
      if (title.includes(keyword.toLowerCase())) {
        counts[keyword] = (counts[keyword] || 0) + 1;
        matched = true;
        break;
      }
    }
    if (!matched) counts.unknown = (counts.unknown || 0) + 1;
  }

  // Сортировка по убыванию power (как в save_stats)
  const sorted = Object.entries(counts).sort((a, b) => {
    const pa = POWER_VALUES[a[0]] ?? 0;
    const pb = POWER_VALUES[b[0]] ?? 0;
    return pb - pa;
  });

  return {
    totalNfts: allTitles.length,
    totalPower,
    breakdown: sorted.map(([rarity, count]) => ({ rarity, count })),
  };
}

// Разбивает массив [ {wallet, amount}, ... ] на батчи по batchSize
export function createBatches(rewardsArray, batchSize = 50) {
  const batches = [];
  for (let i = 0; i < rewardsArray.length; i += batchSize) {
    batches.push(rewardsArray.slice(i, i + batchSize));
  }
  return batches;
}

// Главный пайплайн — возвращает всё, что нужно UI
export async function runCalculation(totalStaking, batchSize = 50) {
  const nfts = await fetchNfts();
  const { walletNfts, allTitles } = filterAndGroup(nfts);
  const powerMap = calculatePowerByWallet(walletNfts);
  const { rewards, totalPower } = distributeRewards(powerMap, totalStaking);
  const stats = buildStats(allTitles, totalPower);

  const rewardsArray = Array.from(rewards.entries()).map(([wallet, amount]) => ({
    wallet,
    amount,
  }));

  const powerArray = Array.from(powerMap.entries()).map(([wallet, power]) => ({
    wallet,
    power,
  }));

  const batches = createBatches(rewardsArray, batchSize);

  return {
    totalStaking,
    totalPower,
    stats,
    rewards: rewardsArray,
    powers: powerArray,
    batches,
    totalWallets: rewardsArray.length,
  };
}
