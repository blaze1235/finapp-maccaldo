"""
FinApp ERP — Railway service (PostgreSQL backend).

One process:
  1. Serves webapp/index.html (the Telegram Mini App).
  2. POST /api — JSON action API backed by PostgreSQL (no Google Sheets / GAS).
  3. Telegram bot in a background thread (calls the handlers in-process).

Data lives in PostgreSQL on Railway (DATABASE_URL). The webapp keeps its existing
action-based contract, so the frontend is unchanged.

Environment (Railway):
  DATABASE_URL  — auto-set when you add a PostgreSQL plugin
  BOT_TOKEN     — from @BotFather
  WEBAPP_URL    — public URL (auto from RAILWAY_PUBLIC_DOMAIN if unset)
  WEB_ACCESS_CODE — optional shared code for non-Telegram web login
  PORT          — injected by Railway
"""

import os
import json
import logging
import threading
import time
from contextlib import contextmanager
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
    from zoneinfo import ZoneInfo
    TZ = ZoneInfo("Asia/Tashkent")
except Exception:
    TZ = None

import psycopg2
import psycopg2.extras
from psycopg2.pool import ThreadedConnectionPool

# ── Config ──────────────────────────────────────────────────────────────────
APP_VERSION  = "4"
DATABASE_URL = os.getenv("DATABASE_URL", "")
BOT_TOKEN    = os.getenv("BOT_TOKEN", "")
PORT         = int(os.getenv("PORT", os.getenv("API_PORT", "8080")))
WEBAPP_URL   = os.getenv("WEBAPP_URL", "")
if not WEBAPP_URL and os.getenv("RAILWAY_PUBLIC_DOMAIN"):
    WEBAPP_URL = "https://" + os.getenv("RAILWAY_PUBLIC_DOMAIN")
WEB_ACCESS_CODE = os.getenv("WEB_ACCESS_CODE", "")

OWNER_ID   = 1398614118
OWNER_NAME = "Abdulaziz"
ROLE_RANK  = {"workshop": 1, "manager": 2, "owner": 3}
VALID_ROLES = ("workshop", "manager", "owner")

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("finapp")

HERE = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(HERE, "webapp", "index.html"), "rb") as _f:
    INDEX_BYTES = _f.read()

POOL = None
DB_ERROR = "База данных ещё не инициализирована."


def resolve_db_url():
    for k in ("DATABASE_URL", "DATABASE_PRIVATE_URL", "POSTGRES_URL", "POSTGRESQL_URL"):
        v = os.getenv(k)
        if v:
            return v
    host = os.getenv("PGHOST")
    if host:
        return "postgresql://%s:%s@%s:%s/%s" % (
            os.getenv("PGUSER", "postgres"), os.getenv("PGPASSWORD", ""),
            host, os.getenv("PGPORT", "5432"), os.getenv("PGDATABASE", "railway"))
    return ""


def ensure_db():
    """Lazily connect + init schema. Returns True if DB is ready, else sets DB_ERROR."""
    global POOL, DB_ERROR
    if POOL is not None:
        return True
    url = resolve_db_url()
    if not url:
        DB_ERROR = ("База данных не подключена. В Railway: + New → Database → PostgreSQL, "
                    "и проверьте, что у сервиса есть переменная DATABASE_URL.")
        return False
    try:
        POOL = ThreadedConnectionPool(1, 10, url)
        init_db()
        DB_ERROR = None
        log.info("PostgreSQL connected, schema ready.")
        return True
    except Exception as e:
        POOL = None
        DB_ERROR = "Не удалось подключиться к базе данных: " + str(e)
        log.error(DB_ERROR)
        return False


# ── Small pure helpers (unit-testable without a DB) ──────────────────────────
def num(v):
    if v is None or v == "":
        return 0.0
    try:
        return float(v)
    except Exception:
        try:
            return float(str(v).replace(" ", "").replace(",", "."))
        except Exception:
            return 0.0


def r2(v):
    return round(num(v) + 0.0, 2)


def health_color(current, threshold):
    if not (threshold and threshold > 0):
        return "green"
    ratio = current / threshold
    if ratio >= 0.5:
        return "green"
    if ratio >= 0.2:
        return "amber"
    return "red"


def unit_factor(unit_options, base_unit, label):
    opts = unit_options or [{"label": base_unit, "factor": 1}]
    for o in opts:
        if str(o.get("label")) == str(label):
            return num(o.get("factor")) or 1
    return 1


def normalise_unit_options(unit_options, base_unit, input_units_text):
    if unit_options:
        return [{"label": str(o["label"]), "factor": num(o.get("factor")) or 1} for o in unit_options]
    if input_units_text:
        parts = [p.strip() for p in str(input_units_text).split(",") if p.strip()]
        out = []
        for p in parts:
            bits = p.split(":")
            out.append({"label": bits[0].strip(), "factor": (num(bits[1]) or 1) if len(bits) > 1 else 1})
        if out:
            return out
    return [{"label": str(base_unit or "ед."), "factor": 1}]


def opts_or_default(unit_options, base_unit):
    if unit_options:
        return [{"label": str(o["label"]), "factor": num(o.get("factor")) or 1} for o in unit_options]
    return [{"label": str(base_unit or "ед."), "factor": 1}]


def now_parts():
    d = datetime.now(TZ) if TZ else datetime.now()
    return d.strftime("%Y-%m-%d"), d.strftime("%H:%M")


def ok(data, alerts=None):
    return {"success": True, "data": data or {}, "alerts": alerts or [], "error": None}


def err(msg):
    return {"success": False, "data": None, "alerts": [], "error": msg}


class Denied(Exception):
    pass


# ── DB ───────────────────────────────────────────────────────────────────────
@contextmanager
def db():
    conn = POOL.getconn()
    conn.cursor_factory = psycopg2.extras.RealDictCursor
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        POOL.putconn(conn)


def q(conn, sql, params=None):
    with conn.cursor() as cur:
        cur.execute(sql, params or [])
        return cur.fetchall()


def q1(conn, sql, params=None):
    with conn.cursor() as cur:
        cur.execute(sql, params or [])
        return cur.fetchone()


def ex(conn, sql, params=None):
    with conn.cursor() as cur:
        cur.execute(sql, params or [])


SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  telegram_id  BIGINT PRIMARY KEY,
  name         TEXT NOT NULL DEFAULT '',
  role         TEXT NOT NULL DEFAULT 'workshop',
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS raw_materials (
  material_id  BIGSERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  unit         TEXT NOT NULL DEFAULT 'кг',
  input_units  TEXT NOT NULL DEFAULT '',
  unit_options JSONB NOT NULL DEFAULT '[]',
  category     TEXT NOT NULL DEFAULT 'seasoning',
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  low_stock_threshold NUMERIC NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS finished_products (
  sku_id        BIGSERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  flavour       TEXT NOT NULL DEFAULT '',
  weight_g      NUMERIC NOT NULL DEFAULT 0,
  packs_per_box NUMERIC NOT NULL DEFAULT 1,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS purchases (
  id            BIGSERIAL PRIMARY KEY,
  entry_date    DATE NOT NULL,
  entry_time    TEXT NOT NULL DEFAULT '',
  material_id   BIGINT NOT NULL REFERENCES raw_materials(material_id) ON DELETE CASCADE,
  quantity_input NUMERIC NOT NULL DEFAULT 0,
  unit_input    TEXT NOT NULL DEFAULT '',
  quantity_base NUMERIC NOT NULL DEFAULT 0,
  unit_base     TEXT NOT NULL DEFAULT '',
  total_sum_uzs NUMERIC,
  price_per_base_unit NUMERIC,
  supplier      TEXT NOT NULL DEFAULT '',
  logged_by     BIGINT,
  price_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  price_confirmed_by BIGINT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS production_runs (
  run_id        BIGSERIAL PRIMARY KEY,
  entry_date    DATE NOT NULL,
  entry_time    TEXT NOT NULL DEFAULT '',
  sku_id        BIGINT NOT NULL REFERENCES finished_products(sku_id) ON DELETE CASCADE,
  packs_produced NUMERIC NOT NULL DEFAULT 0,
  boxes_produced NUMERIC NOT NULL DEFAULT 0,
  total_material_cost_uzs NUMERIC NOT NULL DEFAULT 0,
  cost_per_pack_uzs NUMERIC NOT NULL DEFAULT 0,
  cost_per_box_uzs  NUMERIC NOT NULL DEFAULT 0,
  logged_by     BIGINT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS consumption (
  id            BIGSERIAL PRIMARY KEY,
  run_id        BIGINT REFERENCES production_runs(run_id) ON DELETE CASCADE,
  entry_date    DATE NOT NULL,
  material_id   BIGINT NOT NULL REFERENCES raw_materials(material_id) ON DELETE CASCADE,
  quantity_base NUMERIC NOT NULL DEFAULT 0,
  unit_base     TEXT NOT NULL DEFAULT '',
  for_sku_id    BIGINT,
  logged_by     BIGINT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS transfers_out (
  id            BIGSERIAL PRIMARY KEY,
  entry_date    DATE NOT NULL,
  entry_time    TEXT NOT NULL DEFAULT '',
  sku_id        BIGINT NOT NULL REFERENCES finished_products(sku_id) ON DELETE CASCADE,
  packs_transferred NUMERIC NOT NULL DEFAULT 0,
  logged_by     BIGINT,
  notes         TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pur_mat   ON purchases(material_id);
CREATE INDEX IF NOT EXISTS idx_pur_conf  ON purchases(price_confirmed);
CREATE INDEX IF NOT EXISTS idx_con_mat   ON consumption(material_id);
CREATE INDEX IF NOT EXISTS idx_con_run   ON consumption(run_id);
CREATE INDEX IF NOT EXISTS idx_run_sku   ON production_runs(sku_id);
CREATE INDEX IF NOT EXISTS idx_tr_sku    ON transfers_out(sku_id);
"""


def init_db():
    with db() as conn:
        with conn.cursor() as cur:
            cur.execute(SCHEMA)
        # Idempotent migrations for existing databases.
        with conn.cursor() as cur:
            cur.execute("ALTER TABLE consumption ADD COLUMN IF NOT EXISTS cost_uzs NUMERIC NOT NULL DEFAULT 0")
        with conn.cursor() as cur:
            cur.execute("INSERT INTO users(telegram_id,name,role) VALUES(%s,%s,'owner') ON CONFLICT (telegram_id) DO NOTHING",
                        (OWNER_ID, OWNER_NAME))
    log.info("DB schema ready")


# ── Auth ─────────────────────────────────────────────────────────────────────
def require_role(conn, tid, minrank):
    if not tid:
        raise Denied("Пользователь не найден. Обратитесь к менеджеру для доступа.")
    u = q1(conn, "SELECT * FROM users WHERE telegram_id=%s", [int(tid)])
    if not u:
        raise Denied("Пользователь не найден. Обратитесь к менеджеру для доступа.")
    if not u["active"]:
        raise Denied("Доступ отключён. Обратитесь к менеджеру.")
    if ROLE_RANK.get(u["role"], -1) < minrank:
        raise Denied("Недостаточно прав для этого действия.")
    return u


# ── Read helpers ─────────────────────────────────────────────────────────────
def material_map(conn):
    return {r["material_id"]: r for r in q(conn, "SELECT material_id,name,unit,unit_options FROM raw_materials")}


def sku_name_map(conn):
    return {r["sku_id"]: r["name"] for r in q(conn, "SELECT sku_id,name FROM finished_products")}


def material_name_map(conn):
    return {r["material_id"]: r["name"] for r in q(conn, "SELECT material_id,name FROM raw_materials")}


def get_materials(conn, include_inactive=False):
    sql = "SELECT * FROM raw_materials" + ("" if include_inactive else " WHERE active") + " ORDER BY material_id"
    out = []
    for r in q(conn, sql):
        out.append({
            "material_id": str(r["material_id"]), "name": r["name"], "unit": r["unit"],
            "input_units": r["input_units"], "unit_options": opts_or_default(r["unit_options"], r["unit"]),
            "category": r["category"], "active": r["active"], "low_stock_threshold": r2(r["low_stock_threshold"]),
        })
    return out


def get_skus(conn, include_inactive=False):
    sql = "SELECT * FROM finished_products" + ("" if include_inactive else " WHERE active") + " ORDER BY sku_id"
    return [{
        "sku_id": str(r["sku_id"]), "name": r["name"], "flavour": r["flavour"],
        "weight_g": r2(r["weight_g"]), "packs_per_box": r2(r["packs_per_box"]) or 1, "active": r["active"],
    } for r in q(conn, sql)]


def wac_map(conn):
    out = {}
    for r in q(conn, """SELECT material_id, SUM(total_sum_uzs) s, SUM(quantity_base) qb
                        FROM purchases WHERE price_confirmed AND total_sum_uzs IS NOT NULL GROUP BY material_id"""):
        qb = num(r["qb"])
        out[r["material_id"]] = (num(r["s"]) / qb) if qb > 0 else 0
    return out


def material_stock(conn):
    purchased = {r["material_id"]: num(r["s"]) for r in q(conn, "SELECT material_id, SUM(quantity_base) s FROM purchases GROUP BY material_id")}
    consumed = {r["material_id"]: num(r["s"]) for r in q(conn, "SELECT material_id, SUM(quantity_base) s FROM consumption GROUP BY material_id")}
    rows = []
    for m in q(conn, "SELECT material_id,name,unit,category,low_stock_threshold FROM raw_materials WHERE active ORDER BY material_id"):
        cur = purchased.get(m["material_id"], 0) - consumed.get(m["material_id"], 0)
        rows.append({"material_id": m["material_id"], "name": m["name"], "unit": m["unit"],
                     "category": m["category"], "threshold": num(m["low_stock_threshold"]), "current": cur})
    return rows


def finished_map(conn):
    produced = {r["sku_id"]: num(r["s"]) for r in q(conn, "SELECT sku_id, SUM(packs_produced) s FROM production_runs GROUP BY sku_id")}
    transferred = {r["sku_id"]: num(r["s"]) for r in q(conn, "SELECT sku_id, SUM(packs_transferred) s FROM transfers_out GROUP BY sku_id")}
    return produced, transferred


def latest_cost(conn):
    out = {}
    for r in q(conn, "SELECT DISTINCT ON (sku_id) sku_id, cost_per_pack_uzs, cost_per_box_uzs FROM production_runs ORDER BY sku_id, created_at DESC"):
        out[r["sku_id"]] = {"cpp": num(r["cost_per_pack_uzs"]), "cpb": num(r["cost_per_box_uzs"])}
    return out


def get_stock(conn, with_prices):
    rows = material_stock(conn)
    wac = wac_map(conn) if with_prices else {}
    raw = []
    for r in rows:
        o = {"material_id": str(r["material_id"]), "name": r["name"], "unit": r["unit"], "category": r["category"],
             "current_stock": r2(r["current"]), "low_stock_threshold": r2(r["threshold"]),
             "health": health_color(r["current"], r["threshold"])}
        if with_prices:
            w = wac.get(r["material_id"], 0)
            o["wac_price"] = r2(w); o["total_value"] = r2(r["current"] * w)
        raw.append(o)

    produced, transferred = finished_map(conn)
    costs = latest_cost(conn) if with_prices else {}
    fin = []
    for s in q(conn, "SELECT * FROM finished_products WHERE active ORDER BY sku_id"):
        ppb = num(s["packs_per_box"]) or 1
        packs = produced.get(s["sku_id"], 0) - transferred.get(s["sku_id"], 0)
        o = {"sku_id": str(s["sku_id"]), "name": s["name"], "flavour": s["flavour"], "weight_g": r2(s["weight_g"]),
             "packs_per_box": r2(ppb), "packs_in_stock": r2(packs), "boxes_in_stock": r2(packs / ppb)}
        if with_prices:
            c = costs.get(s["sku_id"], {"cpp": 0})
            o["cost_per_pack"] = r2(c["cpp"]); o["cost_per_box"] = r2(c["cpp"] * ppb); o["total_value"] = r2(packs * c["cpp"])
        fin.append(o)
    return {"raw_materials": raw, "finished_goods": fin, "with_prices": with_prices}


def compute_alerts(conn):
    return [{"material_id": str(r["material_id"]), "name": r["name"], "unit": r["unit"],
             "current_stock": r2(r["current"]), "threshold": r2(r["threshold"])}
            for r in material_stock(conn) if r["threshold"] > 0 and r["current"] < r["threshold"]]


def get_pending(conn):
    mn = material_name_map(conn)
    return [{"id": str(r["id"]), "date": str(r["entry_date"]), "time": r["entry_time"],
             "material": mn.get(r["material_id"], str(r["material_id"])),
             "quantity_input": r2(r["quantity_input"]), "unit_input": r["unit_input"],
             "quantity_base": r2(r["quantity_base"]), "unit_base": r["unit_base"], "supplier": r["supplier"]}
            for r in q(conn, "SELECT * FROM purchases WHERE NOT price_confirmed ORDER BY created_at DESC")]


def get_purchase_logs(conn, limit, with_prices):
    mn = material_name_map(conn)
    out = []
    for r in q(conn, "SELECT * FROM purchases ORDER BY created_at DESC LIMIT %s", [limit]):
        out.append({"id": str(r["id"]), "date": str(r["entry_date"]), "time": r["entry_time"],
                    "material_id": str(r["material_id"]),
                    "material": mn.get(r["material_id"], str(r["material_id"])),
                    "quantity_input": r2(r["quantity_input"]), "unit_input": r["unit_input"],
                    "quantity_base": r2(r["quantity_base"]), "unit_base": r["unit_base"],
                    "total_sum_uzs": (r2(r["total_sum_uzs"]) if (with_prices and r["total_sum_uzs"] is not None) else None),
                    "supplier": r["supplier"], "price_confirmed": r["price_confirmed"]})
    return out


def get_production_logs(conn, limit, with_prices):
    sn = sku_name_map(conn)
    mn = material_name_map(conn)
    runs = q(conn, "SELECT * FROM production_runs ORDER BY created_at DESC LIMIT %s", [limit])
    if not runs:
        return []
    ids = [r["run_id"] for r in runs]
    by_run = {}
    for c in q(conn, "SELECT run_id, material_id, quantity_base, unit_base, cost_uzs FROM consumption WHERE run_id = ANY(%s)", [ids]):
        by_run.setdefault(c["run_id"], []).append({"material_id": str(c["material_id"]),
                                                    "material": mn.get(c["material_id"], str(c["material_id"])),
                                                    "quantity_base": r2(c["quantity_base"]), "unit": c["unit_base"],
                                                    "cost": (r2(c["cost_uzs"]) if with_prices else None)})
    out = []
    for r in runs:
        out.append({"id": str(r["run_id"]), "run_id": str(r["run_id"]), "sku_id": str(r["sku_id"]),
                    "date": str(r["entry_date"]), "time": r["entry_time"],
                    "sku": sn.get(r["sku_id"], str(r["sku_id"])),
                    "packs_produced": r2(r["packs_produced"]), "boxes_produced": r2(r["boxes_produced"]),
                    "total_material_cost_uzs": (r2(r["total_material_cost_uzs"]) if with_prices else None),
                    "cost_per_pack_uzs": (r2(r["cost_per_pack_uzs"]) if with_prices else None),
                    "cost_per_box_uzs": (r2(r["cost_per_box_uzs"]) if with_prices else None),
                    "materials": by_run.get(r["run_id"], [])})
    return out


def get_transfer_logs(conn, limit):
    sn = sku_name_map(conn)
    return [{"id": str(r["id"]), "date": str(r["entry_date"]), "time": r["entry_time"],
             "sku": sn.get(r["sku_id"], str(r["sku_id"])), "packs_transferred": r2(r["packs_transferred"]),
             "notes": r["notes"]}
            for r in q(conn, "SELECT * FROM transfers_out ORDER BY created_at DESC LIMIT %s", [limit])]


def get_today_production(conn):
    sn = sku_name_map(conn)
    today, _ = now_parts()
    return [{"sku_id": str(r["sku_id"]), "name": sn.get(r["sku_id"], str(r["sku_id"])), "packs": r2(r["s"])}
            for r in q(conn, "SELECT sku_id, SUM(packs_produced) s FROM production_runs WHERE entry_date=%s GROUP BY sku_id", [today])]


def get_recent(conn, limit):
    sn = sku_name_map(conn)
    mn = material_name_map(conn)
    items = []
    for r in q(conn, "SELECT sku_id, entry_date, entry_time, packs_produced, created_at FROM production_runs ORDER BY created_at DESC LIMIT %s", [limit]):
        items.append({"type": "production", "ts": r["created_at"], "date": str(r["entry_date"]), "time": r["entry_time"],
                      "title": sn.get(r["sku_id"], str(r["sku_id"])), "detail": fmt_num(r["packs_produced"]) + " пачек"})
    for r in q(conn, "SELECT material_id, entry_date, entry_time, quantity_input, unit_input, created_at FROM purchases ORDER BY created_at DESC LIMIT %s", [limit]):
        items.append({"type": "purchase", "ts": r["created_at"], "date": str(r["entry_date"]), "time": r["entry_time"],
                      "title": mn.get(r["material_id"], str(r["material_id"])), "detail": "+" + fmt_num(r["quantity_input"]) + " " + (r["unit_input"] or "")})
    items.sort(key=lambda x: x["ts"], reverse=True)
    for it in items:
        it.pop("ts", None)
    return items[:limit]


def list_users(conn):
    return [{"telegram_id": str(r["telegram_id"]), "name": r["name"], "role": r["role"], "active": r["active"]}
            for r in q(conn, "SELECT * FROM users ORDER BY created_at")]


def fmt_num(n):
    x = r2(n)
    x = int(x) if x == int(x) else x
    return f"{x:,}".replace(",", " ")


# ── Action handlers ──────────────────────────────────────────────────────────
def act_get_user(tid):
    with db() as conn:
        if not tid:
            return err("Пользователь не найден. Проверьте Telegram ID.")
        u = q1(conn, "SELECT * FROM users WHERE telegram_id=%s", [int(tid)])
        if not u:
            return err("Пользователь не найден. Проверьте Telegram ID или обратитесь к менеджеру.")
        if not u["active"]:
            return err("Доступ отключён. Обратитесь к менеджеру.")
        return ok({"telegram_id": str(u["telegram_id"]), "name": u["name"], "role": u["role"]})


def act_bootstrap(tid):
    with db() as conn:
        u = require_role(conn, tid, 1)
        rk = ROLE_RANK[u["role"]]
        wp = rk >= 2
        pending = get_pending(conn) if wp else []
        data = {
            "version": APP_VERSION,
            "user": {"telegram_id": str(u["telegram_id"]), "name": u["name"], "role": u["role"]},
            "materials": get_materials(conn),
            "skus": get_skus(conn),
            "stock": get_stock(conn, wp),
            "logs": {"purchases": get_purchase_logs(conn, 80, wp),
                     "production": get_production_logs(conn, 80, wp),
                     "transfers": get_transfer_logs(conn, 80)},
            "pending": pending,
            "pending_count": len(pending),
            "today_production": get_today_production(conn),
            "recent": get_recent(conn, 4),
            "costs": [],
            "can_prices": wp,
        }
        if rk >= 2:
            data["users"] = list_users(conn)
        return ok(data, compute_alerts(conn))


def act_log_purchase(tid, b):
    with db() as conn:
        require_role(conn, tid, 1)
        m = q1(conn, "SELECT * FROM raw_materials WHERE material_id=%s", [int(b.get("material_id") or 0)]) if b.get("material_id") else None
        if not m:
            return err("Материал не найден. Проверьте список материалов.")
        qty = num(b.get("quantity_input"))
        if qty <= 0:
            return err("Укажите количество больше нуля.")
        unit_in = str(b.get("unit_input") or m["unit"])
        qty_base = qty * unit_factor(opts_or_default(m["unit_options"], m["unit"]), m["unit"], unit_in)
        d, t = now_parts()
        q1(conn, """INSERT INTO purchases(entry_date,entry_time,material_id,quantity_input,unit_input,quantity_base,unit_base,supplier,logged_by,price_confirmed)
                    VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,FALSE) RETURNING id""",
           [d, t, m["material_id"], qty, unit_in, qty_base, m["unit"], str(b.get("supplier") or ""), int(tid)])
        return ok({"logged": True, "quantity_base": r2(qty_base), "unit_base": m["unit"]}, compute_alerts(conn))


def act_confirm_price(tid, b):
    with db() as conn:
        require_role(conn, tid, 2)
        pid = b.get("id")
        if not pid:
            return err("Не указана закупка для подтверждения.")
        total = num(b.get("total_sum_uzs"))
        if total < 0:
            return err("Укажите корректную сумму в сумах.")
        p = q1(conn, "SELECT quantity_base FROM purchases WHERE id=%s", [int(pid)])
        if not p:
            return err("Закупка не найдена.")
        qb = num(p["quantity_base"])
        per = (total / qb) if qb > 0 else 0
        q1(conn, """UPDATE purchases SET total_sum_uzs=%s, price_per_base_unit=%s, price_confirmed=TRUE, price_confirmed_by=%s
                    WHERE id=%s RETURNING id""", [total, per, int(tid), int(pid)])
        return ok({"confirmed": True, "price_per_base_unit": r2(per)})


def act_log_production(tid, b):
    with db() as conn:
        require_role(conn, tid, 1)
        sku = q1(conn, "SELECT * FROM finished_products WHERE sku_id=%s", [int(b.get("sku_id") or 0)]) if b.get("sku_id") else None
        if not sku:
            return err("Продукт (SKU) не найден. Проверьте список продукции.")
        packs = num(b.get("packs_produced"))
        if packs <= 0:
            return err("Укажите количество пачек больше нуля.")
        lines = b.get("materials") or []
        if not lines:
            return err("Добавьте хотя бы один материал расхода.")
        ppb = num(sku["packs_per_box"]) or 1
        boxes = packs / ppb
        wac = wac_map(conn)

        consumed, total = [], 0.0
        for i, ln in enumerate(lines):
            m = q1(conn, "SELECT * FROM raw_materials WHERE material_id=%s", [int(ln.get("material_id") or 0)]) if ln.get("material_id") else None
            if not m:
                return err("Материал не найден в строке %d. Проверьте список материалов." % (i + 1))
            qb = num(ln.get("quantity_input")) * unit_factor(opts_or_default(m["unit_options"], m["unit"]), m["unit"], ln.get("unit_input") or m["unit"])
            if qb <= 0:
                return err("Укажите количество для «%s» больше нуля." % m["name"])
            lc = qb * wac.get(m["material_id"], 0)
            total += lc
            consumed.append((m["material_id"], qb, m["unit"], lc))

        cpp = (total / packs) if packs > 0 else 0
        cpb = (total / boxes) if boxes > 0 else 0
        d, t = now_parts()
        run = q1(conn, """INSERT INTO production_runs(entry_date,entry_time,sku_id,packs_produced,boxes_produced,total_material_cost_uzs,cost_per_pack_uzs,cost_per_box_uzs,logged_by)
                          VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING run_id""",
                  [d, t, sku["sku_id"], packs, r2(boxes), r2(total), r2(cpp), r2(cpb), int(tid)])
        for mid, qb, unit, lc in consumed:
            q1(conn, """INSERT INTO consumption(run_id,entry_date,material_id,quantity_base,unit_base,for_sku_id,logged_by,cost_uzs)
                        VALUES(%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id""", [run["run_id"], d, mid, qb, unit, sku["sku_id"], int(tid), r2(lc)])
        return ok({"logged": True, "run_id": str(run["run_id"]), "packs_produced": r2(packs),
                   "total_material_cost_uzs": r2(total), "cost_per_pack_uzs": r2(cpp), "cost_per_box_uzs": r2(cpb)},
                  compute_alerts(conn))


def act_transfer_out(tid, b):
    with db() as conn:
        require_role(conn, tid, 2)
        sku = q1(conn, "SELECT * FROM finished_products WHERE sku_id=%s", [int(b.get("sku_id") or 0)]) if b.get("sku_id") else None
        if not sku:
            return err("Продукт (SKU) не найден.")
        packs = num(b.get("packs_transferred"))
        if packs <= 0:
            return err("Укажите количество пачек больше нуля.")
        produced, transferred = finished_map(conn)
        avail = produced.get(sku["sku_id"], 0) - transferred.get(sku["sku_id"], 0)
        if packs > avail:
            return err("Недостаточно на складе. Доступно пачек: " + fmt_num(avail))
        d, t = now_parts()
        q1(conn, """INSERT INTO transfers_out(entry_date,entry_time,sku_id,packs_transferred,logged_by,notes)
                    VALUES(%s,%s,%s,%s,%s,%s) RETURNING id""", [d, t, sku["sku_id"], packs, int(tid), str(b.get("notes") or "")])
        return ok({"transferred": True, "remaining_packs": r2(avail - packs)})


def act_manage_users(tid, b):
    with db() as conn:
        require_role(conn, tid, 2)
        op = b.get("op", "list")
        p = b.get("payload") or {}
        if op == "list":
            return ok({"users": list_users(conn)})
        if op == "add":
            nid = str(p.get("telegram_id") or "").strip()
            if not nid.isdigit():
                return err("Telegram ID должен быть числом.")
            if p.get("role") not in VALID_ROLES:
                return err("Некорректная роль.")
            if q1(conn, "SELECT 1 FROM users WHERE telegram_id=%s", [int(nid)]):
                return err("Пользователь с таким ID уже существует.")
            q1(conn, "INSERT INTO users(telegram_id,name,role,active) VALUES(%s,%s,%s,TRUE) RETURNING telegram_id",
               [int(nid), str(p.get("name") or ""), p["role"]])
            return ok({"added": True})
        if op == "update":
            sets, vals = [], []
            if p.get("name") is not None:
                sets.append("name=%s"); vals.append(str(p["name"]))
            if p.get("role") is not None:
                if p["role"] not in VALID_ROLES:
                    return err("Некорректная роль.")
                sets.append("role=%s"); vals.append(p["role"])
            if p.get("active") is not None:
                sets.append("active=%s"); vals.append(bool(p["active"]))
            if not sets:
                return err("Нет изменений.")
            vals.append(int(p.get("telegram_id")))
            row = q1(conn, "UPDATE users SET " + ",".join(sets) + " WHERE telegram_id=%s RETURNING telegram_id", vals)
            return ok({"updated": True}) if row else err("Пользователь не найден.")
        return err("Неизвестная операция.")


def act_manage_materials(tid, b):
    with db() as conn:
        require_role(conn, tid, 2)
        op = b.get("op", "list")
        p = b.get("payload") or {}
        if op == "list":
            return ok({"materials": get_materials(conn, True)})
        if op == "add":
            if not p.get("name"):
                return err("Укажите название материала.")
            unit = str(p.get("unit") or "кг")
            opts = normalise_unit_options(p.get("unit_options"), unit, p.get("input_units"))
            iu = str(p.get("input_units") or ", ".join(o["label"] for o in opts))
            q1(conn, """INSERT INTO raw_materials(name,unit,input_units,unit_options,category,active,low_stock_threshold)
                        VALUES(%s,%s,%s,%s,%s,TRUE,%s) RETURNING material_id""",
               [str(p["name"]), unit, iu, psycopg2.extras.Json(opts), str(p.get("category") or "seasoning"), num(p.get("low_stock_threshold"))])
            return ok({"added": True})
        if op == "update":
            sets, vals = [], []
            if p.get("name") is not None: sets.append("name=%s"); vals.append(str(p["name"]))
            if p.get("unit") is not None: sets.append("unit=%s"); vals.append(str(p["unit"]))
            if p.get("category") is not None: sets.append("category=%s"); vals.append(str(p["category"]))
            if p.get("low_stock_threshold") is not None: sets.append("low_stock_threshold=%s"); vals.append(num(p["low_stock_threshold"]))
            if p.get("active") is not None: sets.append("active=%s"); vals.append(bool(p["active"]))
            if p.get("input_units") is not None:
                base = str(p.get("unit") or "")
                if not base:
                    cur = q1(conn, "SELECT unit FROM raw_materials WHERE material_id=%s", [int(p.get("material_id"))])
                    base = cur["unit"] if cur else "кг"
                opts = normalise_unit_options(p.get("unit_options"), base, p.get("input_units"))
                sets.append("unit_options=%s"); vals.append(psycopg2.extras.Json(opts))
                sets.append("input_units=%s"); vals.append(str(p.get("input_units") or ", ".join(o["label"] for o in opts)))
            if not sets:
                return err("Нет изменений.")
            vals.append(int(p.get("material_id")))
            row = q1(conn, "UPDATE raw_materials SET " + ",".join(sets) + " WHERE material_id=%s RETURNING material_id", vals)
            return ok({"updated": True}) if row else err("Материал не найден.")
        if op == "delete":
            row = q1(conn, "UPDATE raw_materials SET active=FALSE WHERE material_id=%s RETURNING material_id", [int(p.get("material_id"))])
            return ok({"deleted": True}) if row else err("Материал не найден.")
        return err("Неизвестная операция.")


def act_manage_skus(tid, b):
    with db() as conn:
        require_role(conn, tid, 2)
        op = b.get("op", "list")
        p = b.get("payload") or {}
        if op == "list":
            return ok({"skus": get_skus(conn, True)})
        if op == "add":
            if not p.get("name"):
                return err("Укажите название продукта.")
            q1(conn, """INSERT INTO finished_products(name,flavour,weight_g,packs_per_box,active)
                        VALUES(%s,%s,%s,%s,TRUE) RETURNING sku_id""",
               [str(p["name"]), str(p.get("flavour") or ""), num(p.get("weight_g")), num(p.get("packs_per_box")) or 1])
            return ok({"added": True})
        if op == "update":
            sets, vals = [], []
            if p.get("name") is not None: sets.append("name=%s"); vals.append(str(p["name"]))
            if p.get("flavour") is not None: sets.append("flavour=%s"); vals.append(str(p["flavour"]))
            if p.get("weight_g") is not None: sets.append("weight_g=%s"); vals.append(num(p["weight_g"]))
            if p.get("packs_per_box") is not None: sets.append("packs_per_box=%s"); vals.append(num(p["packs_per_box"]) or 1)
            if p.get("active") is not None: sets.append("active=%s"); vals.append(bool(p["active"]))
            if not sets:
                return err("Нет изменений.")
            vals.append(int(p.get("sku_id")))
            row = q1(conn, "UPDATE finished_products SET " + ",".join(sets) + " WHERE sku_id=%s RETURNING sku_id", vals)
            return ok({"updated": True}) if row else err("Продукт не найден.")
        if op == "delete":
            row = q1(conn, "UPDATE finished_products SET active=FALSE WHERE sku_id=%s RETURNING sku_id", [int(p.get("sku_id"))])
            return ok({"deleted": True}) if row else err("Продукт не найден.")
        return err("Неизвестная операция.")


# ── Owner-only: edit / delete log entries ───────────────────────────────────
def act_delete_entry(tid, b):
    with db() as conn:
        require_role(conn, tid, 3)
        kind, eid = b.get("kind"), b.get("id")
        if not eid:
            return err("Не указана запись.")
        if kind == "purchase":
            row = q1(conn, "DELETE FROM purchases WHERE id=%s RETURNING id", [int(eid)])
        elif kind == "production":
            row = q1(conn, "DELETE FROM production_runs WHERE run_id=%s RETURNING run_id", [int(eid)])  # cascades consumption
        elif kind == "transfer":
            row = q1(conn, "DELETE FROM transfers_out WHERE id=%s RETURNING id", [int(eid)])
        else:
            return err("Неизвестный тип записи.")
        return ok({"deleted": True}, compute_alerts(conn)) if row else err("Запись не найдена.")


def act_edit_purchase(tid, b):
    with db() as conn:
        require_role(conn, tid, 3)
        p = q1(conn, "SELECT * FROM purchases WHERE id=%s", [int(b.get("id") or 0)]) if b.get("id") else None
        if not p:
            return err("Закупка не найдена.")
        m = q1(conn, "SELECT * FROM raw_materials WHERE material_id=%s", [p["material_id"]])
        qty = num(b.get("quantity_input"))
        if qty <= 0:
            return err("Укажите количество больше нуля.")
        unit_in = str(b.get("unit_input") or p["unit_input"] or m["unit"])
        qb = qty * unit_factor(opts_or_default(m["unit_options"], m["unit"]), m["unit"], unit_in)
        per = (num(p["total_sum_uzs"]) / qb) if (p["total_sum_uzs"] is not None and qb > 0) else p["price_per_base_unit"]
        sup = str(b["supplier"]) if b.get("supplier") is not None else p["supplier"]
        ex(conn, "UPDATE purchases SET quantity_input=%s, unit_input=%s, quantity_base=%s, supplier=%s, price_per_base_unit=%s WHERE id=%s",
           [qty, unit_in, qb, sup, per, int(b["id"])])
        return ok({"updated": True}, compute_alerts(conn))


def act_edit_transfer(tid, b):
    with db() as conn:
        require_role(conn, tid, 3)
        t = q1(conn, "SELECT * FROM transfers_out WHERE id=%s", [int(b.get("id") or 0)]) if b.get("id") else None
        if not t:
            return err("Передача не найдена.")
        packs = num(b.get("packs_transferred"))
        if packs <= 0:
            return err("Укажите количество пачек больше нуля.")
        produced, transferred = finished_map(conn)
        avail = produced.get(t["sku_id"], 0) - (transferred.get(t["sku_id"], 0) - num(t["packs_transferred"]))
        if packs > avail:
            return err("Недостаточно на складе. Доступно пачек: " + fmt_num(avail))
        ex(conn, "UPDATE transfers_out SET packs_transferred=%s, notes=%s WHERE id=%s",
           [packs, str(b.get("notes") or ""), int(b["id"])])
        return ok({"updated": True})


def act_edit_production(tid, b):
    with db() as conn:
        require_role(conn, tid, 3)
        run = q1(conn, "SELECT * FROM production_runs WHERE run_id=%s", [int(b.get("id") or 0)]) if b.get("id") else None
        if not run:
            return err("Прогон не найден.")
        sku = q1(conn, "SELECT * FROM finished_products WHERE sku_id=%s", [run["sku_id"]])
        packs = num(b.get("packs_produced"))
        if packs <= 0:
            return err("Укажите количество пачек больше нуля.")
        lines = b.get("materials") or []
        if not lines:
            return err("Добавьте хотя бы один материал расхода.")
        ppb = num(sku["packs_per_box"]) or 1
        boxes = packs / ppb
        wac = wac_map(conn)
        consumed, total = [], 0.0
        for i, ln in enumerate(lines):
            m = q1(conn, "SELECT * FROM raw_materials WHERE material_id=%s", [int(ln.get("material_id") or 0)]) if ln.get("material_id") else None
            if not m:
                return err("Материал не найден в строке %d." % (i + 1))
            qb = num(ln.get("quantity_input")) * unit_factor(opts_or_default(m["unit_options"], m["unit"]), m["unit"], ln.get("unit_input") or m["unit"])
            if qb <= 0:
                return err("Укажите количество для «%s» больше нуля." % m["name"])
            lc = qb * wac.get(m["material_id"], 0)
            total += lc
            consumed.append((m["material_id"], qb, m["unit"], lc))
        cpp = (total / packs) if packs > 0 else 0
        cpb = (total / boxes) if boxes > 0 else 0
        ex(conn, "UPDATE production_runs SET packs_produced=%s,boxes_produced=%s,total_material_cost_uzs=%s,cost_per_pack_uzs=%s,cost_per_box_uzs=%s WHERE run_id=%s",
           [packs, r2(boxes), r2(total), r2(cpp), r2(cpb), run["run_id"]])
        ex(conn, "DELETE FROM consumption WHERE run_id=%s", [run["run_id"]])
        d = str(run["entry_date"])
        for mid, qb, unit, lc in consumed:
            ex(conn, """INSERT INTO consumption(run_id,entry_date,material_id,quantity_base,unit_base,for_sku_id,logged_by,cost_uzs)
                        VALUES(%s,%s,%s,%s,%s,%s,%s,%s)""", [run["run_id"], d, mid, qb, unit, run["sku_id"], int(tid), r2(lc)])
        return ok({"updated": True, "cost_per_pack_uzs": r2(cpp)}, compute_alerts(conn))


ACTIONS = {
    "get_user": lambda tid, b: act_get_user(tid),
    "bootstrap": lambda tid, b: act_bootstrap(tid),
    "log_purchase": act_log_purchase,
    "confirm_price": act_confirm_price,
    "log_production": act_log_production,
    "transfer_out": act_transfer_out,
    "manage_users": act_manage_users,
    "manage_materials": act_manage_materials,
    "manage_skus": act_manage_skus,
    "delete_entry": act_delete_entry,
    "edit_purchase": act_edit_purchase,
    "edit_production": act_edit_production,
    "edit_transfer": act_edit_transfer,
}


def handle(body):
    action = body.get("action", "")
    tid = body.get("telegram_id")
    tid = str(tid) if tid is not None else ""
    if WEB_ACCESS_CODE and str(body.get("access_code") or "") != WEB_ACCESS_CODE:
        return err("Неверный код доступа")
    if not ensure_db():
        return err(DB_ERROR)
    fn = ACTIONS.get(action)
    if not fn:
        return err("Неизвестное действие: " + action)
    try:
        return fn(tid, body)
    except Denied as e:
        return err(str(e))
    except Exception as e:
        log.exception("handle %s", action)
        return err("Ошибка сервера: " + str(e))


# ── HTTP ─────────────────────────────────────────────────────────────────────
class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_OPTIONS(self):
        self._send(204, b"")

    def do_GET(self):
        path = self.path.split("?")[0]
        if path in ("/", "/index.html"):
            self._send(200, INDEX_BYTES, "text/html; charset=utf-8")
        elif path == "/health":
            body = json.dumps({"status": "ok", "version": APP_VERSION,
                               "db": ensure_db(), "db_error": DB_ERROR}).encode("utf-8")
            self._send(200, body)
        else:
            self._send(404, b'{"error":"not found"}')

    def do_POST(self):
        if self.path.split("?")[0] != "/api":
            self._send(404, b'{"error":"not found"}')
            return
        try:
            n = int(self.headers.get("Content-Length", "0") or 0)
        except ValueError:
            n = 0
        raw = self.rfile.read(n) if n else b"{}"
        try:
            body = json.loads(raw.decode("utf-8") or "{}")
            resp = handle(body)
        except Exception as e:
            log.exception("request")
            resp = err("Ошибка запроса: " + str(e))
        self._send(200, json.dumps(resp, ensure_ascii=False, default=str).encode("utf-8"))

    def log_message(self, *a):
        pass


def run_server():
    httpd = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    log.info("HTTP server on :%s  (webapp + /api on PostgreSQL)", PORT)
    httpd.serve_forever()


# ── Telegram bot (calls handlers in-process) ─────────────────────────────────
def run_bot():
    if not BOT_TOKEN:
        log.warning("BOT_TOKEN не задан — Telegram-бот выключен.")
        return
    import telebot
    from telebot.types import InlineKeyboardMarkup, InlineKeyboardButton, WebAppInfo
    bot = telebot.TeleBot(BOT_TOKEN, parse_mode="HTML")

    # Register the Mini App as the bot's menu button (the button next to the input
    # field) so it opens automatically for every user — no BotFather setup needed.
    if WEBAPP_URL.startswith("https://"):
        try:
            from telebot.types import MenuButtonWebApp
            bot.set_chat_menu_button(menu_button=MenuButtonWebApp(text="FinApp", web_app=WebAppInfo(url=WEBAPP_URL)))
            log.info("Telegram menu button → Mini App (%s)", WEBAPP_URL)
        except Exception as e:
            log.warning("set_chat_menu_button недоступен: %s", e)

    def menu_kb():
        kb = InlineKeyboardMarkup()
        if WEBAPP_URL.startswith("https://"):
            kb.add(InlineKeyboardButton("🏭 Открыть FinApp", web_app=WebAppInfo(url=WEBAPP_URL)))
        kb.add(InlineKeyboardButton("📦 Остатки сырья", callback_data="stock"))
        return kb

    @bot.message_handler(commands=["start"])
    def cmd_start(m):
        name = m.from_user.first_name or "коллега"
        u = handle({"action": "get_user", "telegram_id": str(m.from_user.id)})
        if not u.get("success"):
            bot.send_message(m.chat.id, f"👋 Здравствуйте, <b>{name}</b>!\n\nЭто <b>FinApp · Цех приправ</b>.\n\n"
                             f"⚠️ Ваш Telegram ID не найден в системе. Передайте его менеджеру:\n<code>{m.from_user.id}</code>")
            return
        role = u["data"]["role"]
        role_ru = {"owner": "Владелец", "manager": "Менеджер", "workshop": "Цех приправ"}.get(role, role)
        bot.send_message(m.chat.id, f"👋 С возвращением, <b>{name}</b>!\nРоль: <b>{role_ru}</b>\n\nОткройте приложение 👇", reply_markup=menu_kb())

    @bot.message_handler(commands=["id"])
    def cmd_id(m):
        bot.send_message(m.chat.id, f"Ваш Telegram ID:\n<code>{m.from_user.id}</code>")

    @bot.message_handler(commands=["help"])
    def cmd_help(m):
        bot.send_message(m.chat.id, "<b>FinApp · Цех приправ</b>\n\n/start — меню\n/stock — остатки сырья\n/id — мой Telegram ID", reply_markup=menu_kb())

    def show_stock(chat_id, uid):
        r = handle({"action": "bootstrap", "telegram_id": str(uid)})
        if not r.get("success"):
            bot.send_message(chat_id, "⚠️ " + (r.get("error") or "Не удалось получить данные."))
            return
        raw = (((r.get("data") or {}).get("stock") or {}).get("raw_materials")) or []
        if not raw:
            bot.send_message(chat_id, "📦 Материалов пока нет. Добавьте их в приложении (Настройки).")
            return
        dot = {"green": "🟢", "amber": "🟡", "red": "🔴"}
        lines = ["📦 <b>Остатки сырья</b>\n"] + [f"{dot.get(m_['health'],'⚪')} {m_['name']}: <b>{fmt_num(m_['current_stock'])} {m_['unit']}</b>" for m_ in raw]
        bot.send_message(chat_id, "\n".join(lines), reply_markup=menu_kb())

    @bot.message_handler(commands=["stock"])
    def cmd_stock(m):
        show_stock(m.chat.id, m.from_user.id)

    @bot.callback_query_handler(func=lambda c: True)
    def on_cb(c):
        if c.data == "stock":
            bot.answer_callback_query(c.id)
            show_stock(c.message.chat.id, c.from_user.id)

    log.info("Telegram bot polling… (webapp: %s)", WEBAPP_URL or "не задан")
    try:
        bot.delete_webhook(drop_pending_updates=True)
    except Exception as e:
        log.warning("delete_webhook: %s", e)
    while True:
        try:
            bot.infinity_polling(timeout=30, long_polling_timeout=20, logger_level=logging.ERROR)
        except Exception as e:
            log.error("Bot polling crashed: %s. Retry in 10s…", e)
            time.sleep(10)


# ── Entry ────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    # Never hard-crash: start the web server regardless, so the site loads and can
    # report a clear error (e.g. "add PostgreSQL") instead of going dark.
    if not ensure_db():
        log.warning("Запуск без базы данных: %s", DB_ERROR)
    threading.Thread(target=run_bot, daemon=True).start()
    run_server()
