# FinApp ERP — Цех приправ (Seasoning Factory)

Веб‑приложение и Telegram Mini App для учёта на мини‑заводе приправ:
закупки сырья, расход, производство, передача готовой продукции на главный завод,
себестоимость (WAC) и контроль остатков. Интерфейс — на русском, валюта — UZS.

## Архитектура

```
Браузер / Telegram Mini App  (webapp/index.html)
            │  POST /api   (тот же домен — без CORS)
            ▼
Railway  (app.py)  ── serves webapp + proxy + Telegram‑бот
            │  POST  (JSON)
            ▼
Google Apps Script Web App  (Code.gs)  ── вся логика и роли
            │
            ▼
Google Sheets  ── база данных (9 листов)
```

- **Google Sheets** — источник данных.
- **Google Apps Script (`Code.gs`)** — API: читает/пишет в таблицу, считает остатки,
  WAC‑себестоимость, проверяет роли. Разворачивается в вашем Google‑аккаунте.
- **Railway (`app.py`)** — хостит сам webapp и Telegram‑бота. Все запросы webapp идут
  на свой же домен (`/api`) и проксируются в GAS, поэтому проблем с CORS нет.
- Нет отдельной СУБД и тяжёлого бэкенда — только Google Sheets.

---

## Схема Google Sheets (9 листов)

`Code.gs` → функция `initSheets()` создаёт все листы с этими заголовками и заполняет владельца.

| Лист | Колонки |
|---|---|
| **users** | telegram_id · name · role · active · created_at |
| **raw_materials** | material_id · name · unit · input_units · unit_options · category · active · low_stock_threshold · created_at |
| **finished_products** | sku_id · name · flavour · weight_g · packs_per_box · active · created_at |
| **purchases** | id · date · time · material_id · quantity_input · unit_input · quantity_base · unit_base · total_sum_uzs · price_per_base_unit · supplier · logged_by_telegram_id · price_confirmed · price_confirmed_by · created_at |
| **consumption** | id · date · time · material_id · quantity_base · unit_base · for_sku_id · logged_by_telegram_id · notes · created_at |
| **production** | id · date · time · sku_id · boxes_produced · packs_produced · logged_by_telegram_id · created_at |
| **finished_goods_stock** | sku_id · boxes_in_stock · packs_in_stock · last_updated |
| **transfers_out** | id · date · time · sku_id · boxes_transferred · logged_by_telegram_id · notes · created_at |
| **cost_log** | id · date · sku_id · period · total_material_cost_uzs · packs_produced · cost_per_pack_uzs · cost_per_box_uzs · created_at |

Владелец засевается автоматически: `1398614118` · Abdulaziz · `owner`.

### Роли

| Роль | Доступ |
|---|---|
| **worker** (Рабочий) | Закупки (без цены), расход, производство, просмотр остатков (без цен) |
| **manager** (Менеджер) | Всё выше + цены, себестоимость, передачи, пороги, управление пользователями/материалами/SKU |
| **owner** (Владелец) | Полный доступ + переключатель ролей в шапке (только отображение) |
| **viewer** (Наблюдатель) | Только просмотр: остатки и журнал производства |

Проверка роли выполняется и на сервере (GAS), и в интерфейсе.

---

## Бизнес‑логика

- **Остаток сырья** = Σ `purchases.quantity_base` − Σ `consumption.quantity_base` (считается на лету).
- **Готовая продукция** = Σ `production.boxes_produced` − Σ `transfers_out.boxes_transferred`.
- **WAC‑себестоимость**: для каждого SKU за день берётся расход по материалам и средневзвешенная
  цена материала = Σ(сумма подтверждённых закупок) / Σ(объём подтверждённых закупок). Запись — в `cost_log`.
- **Низкий остаток**: если остаток < порога (`low_stock_threshold` > 0) — в ответе API приходит
  флаг, в приложении показывается янтарный баннер. По умолчанию пороги = 0 (отключены).
- **Единицы ввода**: у материала можно задать список «название:множитель» (напр. `кг:1, мешок 25кг:25`).
  При вводе количество × множитель = объём в базовой единице.

---

## Развёртывание (по шагам)

> Нужны три ваших аккаунта: Google (таблица + Apps Script), Telegram (@BotFather), Railway.
> Код полностью готов — остаются только клики по настройке.

### Шаг 1. Google Sheets + Apps Script

1. Создайте новую таблицу на https://sheets.new
2. **Расширения → Apps Script**. Удалите код по умолчанию.
3. Скопируйте весь файл **`Code.gs`** из этого репозитория и вставьте.
4. Сверху выберите функцию **`initSheets`** и нажмите **Выполнить** (Run).
   Разрешите доступ, когда Google спросит. Появятся все 9 листов и строка владельца.
5. **Развернуть → Новое развёртывание → тип «Веб‑приложение»**:
   - *Выполнять от имени*: **Я**
   - *Доступ*: **Все** (Anyone)
   - Нажмите **Развернуть**, скопируйте **URL веб‑приложения** (это `GAS_URL`).
6. Проверка: откройте этот URL в браузере — должно вернуться `{"success":true,...}`.

### Шаг 2. Telegram‑бот

1. В Telegram откройте **@BotFather → /newbot**, задайте имя.
2. Скопируйте **токен** (это `BOT_TOKEN`).

### Шаг 3. Railway (хостинг webapp + бот)

1. Залейте этот репозиторий на GitHub (или используйте текущий).
2. https://railway.app → **New Project → Deploy from GitHub repo** → выберите репозиторий.
   Railway сам соберёт по `Dockerfile`.
3. В сервисе → **Variables** добавьте:
   ```
   BOT_TOKEN = <токен от BotFather>
   GAS_URL   = <URL веб‑приложения из шага 1>
   ```
4. Включите публичный домен: **Settings → Networking → Generate Domain**.
   `WEBAPP_URL` определится автоматически из `RAILWAY_PUBLIC_DOMAIN` (можно задать вручную).
5. Дождитесь деплоя. Проверка: `https://<ваш-домен>.up.railway.app/health` → `{"status":"ok"}`.

### Шаг 4. Готово

- Откройте `https://<ваш-домен>.up.railway.app` в браузере — экран входа, введите Telegram ID `1398614118`.
- В Telegram отправьте боту **/start** → кнопка **🏭 Открыть FinApp** запустит Mini App
  с моментальным входом (без ввода ID).

---

## Переменные окружения (Railway)

| Переменная | Обязательно | Значение |
|---|---|---|
| `BOT_TOKEN` | да (для бота) | Токен @BotFather |
| `GAS_URL` | да | URL веб‑приложения Apps Script |
| `WEBAPP_URL` | нет | Публичный URL сервиса (иначе из `RAILWAY_PUBLIC_DOMAIN`) |
| `PORT` | нет | Railway задаёт сам |

### Необязательный код доступа (защита веб‑входа)

В Apps Script: **Настройки проекта → Свойства скрипта** добавьте `WEB_ACCESS_CODE` = ваш код.
Тогда каждый запрос потребует код (в приложении появится поле «Код доступа»). По умолчанию —
выключено, чтобы вход в Telegram оставался моментальным.

---

## Заполнение данными

Списки SKU и материалов создаются пустыми. Зайдите как владелец/менеджер →
вкладка **⚙️ Настройки**:
- **Материалы** → «+ Добавить материал» (название, базовая единица, единицы ввода, порог).
- **Продукция (SKU)** → «+ Добавить продукт» (название, вкус, вес, пачек в коробке).
- **Пользователи** → «+ Добавить пользователя» (Telegram ID, имя, роль).

Пороги низкого остатка по умолчанию `0` (оповещения выключены) — задайте при необходимости.

---

## Локальный запуск (для разработки)

```bash
pip install -r requirements.txt
GAS_URL="https://script.google.com/.../exec" python app.py
# откройте http://localhost:8080
```

`BOT_TOKEN` можно не задавать — тогда поднимется только webapp без бота.

---

## Структура репозитория

```
finapp-maccaldo/
├── Code.gs            # Google Apps Script — API + логика (вставить в Apps Script)
├── app.py             # Railway: хост webapp + /api прокси + Telegram‑бот
├── webapp/
│   └── index.html     # SPA (Mini App) — весь интерфейс в одном файле
├── requirements.txt
├── Dockerfile
├── railway.toml
└── README.md
```
