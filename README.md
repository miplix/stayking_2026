# Darai NFT Staking Calculator — Web

Веб-версия Python-скрипта `nft_staking_calc`. Логика расчёта портирована 1-в-1:
фильтры (`BLACKLIST_ADDRESSES`, `TITLE_BLACKLIST`), таблица мощностей
(`POWER_VALUES`), распределение наград и разбиение на батчи по 50.

Оригинальные Python-файлы лежат в родительской папке и никак не затронуты —
их можно продолжать использовать параллельно.

## Что делает сайт

1. Спрашивает сумму стейкинга и размер батча (по умолчанию 50).
2. Серверная функция (`/api/calculate`) забирает NFT с `api.sendler.xyz`,
   выполняет расчёт и возвращает JSON. Запрос идёт с сервера, поэтому
   CORS-проблем в браузере нет.
3. Показывает общую статистику + разбивку по редкости.
4. Рисует карточки батчей по 50 записей — каждая с кнопками:
   - **Копировать** — содержимое batch_N.csv в буфер обмена
   - **Скачать CSV** — скачивает файл `batch_N.csv`
5. Дополнительно: скачать все награды одним файлом (CSV / TXT) и
   скопировать все в буфер.

## ⚠️ API-ключ sendler.xyz

С недавнего времени `api.sendler.xyz` требует API-ключ — без него и оригинальный
Python-скрипт, и веб-версия получают `403 {"detail":"Invalid or missing API key"}`.
Получи ключ у владельца API и положи его в переменную окружения
`SENDLER_API_KEY`. Ключ передаётся сразу в двух заголовках
(`Authorization: Bearer <key>` и `X-API-Key: <key>`) — какой нужен, тот и сработает.

- Локально: скопируй `.env.example` в `.env.local` и подставь ключ.
- На Vercel: Settings → Environment Variables → добавь `SENDLER_API_KEY`.

## Локальный запуск

```bash
cd web
cp .env.example .env.local    # и впиши SENDLER_API_KEY
npm install
npm run dev
```

Откроется `http://localhost:3000`.

## Деплой на Vercel

### Вариант 1 — через CLI

```bash
cd web
npm i -g vercel
vercel       # первый раз — залогинит и создаст проект
vercel --prod
```

### Вариант 2 — через GitHub

1. Залей папку `web/` (или весь репозиторий) в GitHub.
2. На vercel.com → **Add New → Project** → выбери репозиторий.
3. **Root Directory** установи в `web` (если деплоишь весь репозиторий).
4. Framework Preset определится автоматически как **Next.js**.
5. Нажми **Deploy**. Никаких переменных окружения не нужно.

## Структура

```
web/
├── app/
│   ├── api/calculate/route.js  — серверная функция (fetch NFT + расчёт)
│   ├── layout.js
│   ├── page.js                 — UI (форма, статистика, карточки батчей)
│   └── globals.css
├── lib/
│   ├── config.js               — порт config.py
│   ├── powerValues.js          — порт power_values.py
│   └── calculator.js           — порт main.py / utils.py
├── package.json
├── next.config.mjs
└── jsconfig.json
```

## Соответствие Python-скрипту

| Python                      | JS                                    |
| --------------------------- | ------------------------------------- |
| `config.py`                 | `lib/config.js`                       |
| `power_values.py`           | `lib/powerValues.js`                  |
| `fetch_nfts()`              | `fetchNfts()`                         |
| `filter_and_group()`        | `filterAndGroup()`                    |
| `calculate_power_for_title` | `calculatePowerForTitle()`            |
| `calculate_power_by_wallet` | `calculatePowerByWallet()`            |
| `distribute_rewards()`      | `distributeRewards()` (round → 6 зн.) |
| `save_stats()`              | `buildStats()`                        |
| `create_sender_batches()`   | `createBatches()` + UI с карточками   |

Формат файлов батчей — `Wallet,Amount` с заголовком, как в оригинале.

## Редактирование чёрных списков / мощностей

Правь `web/lib/config.js` и `web/lib/powerValues.js`. При деплое на Vercel
достаточно сделать `git push` — перезапустится автоматически.

Изменения нужно дублировать в Python-файлах вручную (или наоборот), если
хочешь, чтобы оба способа давали одинаковый результат.
