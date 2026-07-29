// Порт config.py
export const API_URL =
  "https://api.sendler.xyz/nft/?contract_address=darai.mintbase1.near";

// ─── Рассылка наград (FT-мультиотправка на NEAR) ───────────────────────────
// Токен, которым всегда раздаём стейкинг-награды.
export const FT_CONTRACT = "darai.tkn.near";
export const FT_DECIMALS = 18; // подтверждено через ft_metadata (spec ft-1.0.0)
// Публичные NEAR RPC для read-only проверок (регистрация/метадата/баланс).
// Список с ротацией — на массовых проверках (сотни аккаунтов) один эндпоинт
// быстро упирается в rate-limit, поэтому чередуем и ретраим.
export const NEAR_RPCS = [
  "https://free.rpc.fastnear.com",
  "https://near.lava.build",
  "https://1rpc.io/near",
];
export const NEAR_RPC = NEAR_RPCS[0]; // back-compat

export const BLACKLIST_ADDRESSES = [
  "0000000000000000000000000000000000000000000000000000000000000000",
  "darai_nft.near",
  "darai_ng.near",
  "darai_collection.near",
  "a.mitte-orderbook.near",
  "widget.near",
  "alchemistshop.near",
  "darai_team.near",
  "sofiya_562-hot.tg",
  "yupileya.near",
  "darai_yupalka.near",
  "intents.near",
  "feed_yupiks.near",
];

export const TITLE_BLACKLIST = [
  "egg",
  "passport",
  "Yupik - Chiter",
  "Chest",
  "Press",
  "тест",
  "boost",
  "mystical",
  "Ellie (0th generation - Ancient)",
  "Phi-So (0th generation - Ancient)",
  "O-Ra (2nd generation universal)",
  "AL-FA (0 Generation - Ancient)",
];
