"""
FinApp ERP — Railway host.

One small process does three jobs:
  1. Serves webapp/index.html (the Telegram Mini App) over HTTP.
  2. Exposes POST /api as a same-origin proxy to the Google Apps Script Web App
     (GAS_URL). This removes all browser CORS problems — the webapp only ever
     talks to its own origin.
  3. Runs the Telegram bot in a background thread (opens the Mini App, shows
     quick stock info).

Data lives in Google Sheets, reached through GAS. There is no database here.

Environment variables (set in Railway):
  BOT_TOKEN   — from @BotFather
  GAS_URL     — the deployed Apps Script Web App URL
  WEBAPP_URL  — public URL of this service (auto-detected from RAILWAY_PUBLIC_DOMAIN if unset)
  PORT        — injected by Railway
"""

import os
import json
import logging
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import requests

# ── Config ──────────────────────────────────────────────────────────────────
BOT_TOKEN = os.getenv("BOT_TOKEN", "")
GAS_URL   = os.getenv("GAS_URL", "")
PORT      = int(os.getenv("PORT", os.getenv("API_PORT", "8080")))
WEBAPP_URL = os.getenv("WEBAPP_URL", "")
if not WEBAPP_URL and os.getenv("RAILWAY_PUBLIC_DOMAIN"):
    WEBAPP_URL = "https://" + os.getenv("RAILWAY_PUBLIC_DOMAIN")

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("finapp")

HERE = os.path.dirname(os.path.abspath(__file__))
INDEX_PATH = os.path.join(HERE, "webapp", "index.html")
with open(INDEX_PATH, "rb") as _f:
    INDEX_BYTES = _f.read()


# ── GAS proxy ────────────────────────────────────────────────────────────────
def call_gas(raw_body: bytes):
    """Forward the webapp's JSON body to the Apps Script Web App and return its bytes."""
    if not GAS_URL:
        return json.dumps({
            "success": False,
            "error": "GAS_URL не задан на сервере. Укажите переменную GAS_URL в Railway."
        }).encode("utf-8")
    res = requests.post(
        GAS_URL,
        data=raw_body,
        headers={"Content-Type": "application/json"},
        timeout=30,
        allow_redirects=True,
    )
    return res.content


# ── HTTP server ────────────────────────────────────────────────────────────
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
            self._send(200, b'{"status":"ok"}')
        else:
            self._send(404, b'{"error":"not found"}')

    def do_POST(self):
        path = self.path.split("?")[0]
        if path == "/api":
            try:
                length = int(self.headers.get("Content-Length", "0") or 0)
            except ValueError:
                length = 0
            body = self.rfile.read(length) if length else b"{}"
            try:
                resp = call_gas(body)
            except Exception as e:
                log.error("GAS proxy error: %s", e)
                resp = json.dumps({
                    "success": False,
                    "error": "Нет связи с Google Apps Script. Попробуйте позже."
                }).encode("utf-8")
            self._send(200, resp)
        else:
            self._send(404, b'{"error":"not found"}')

    def log_message(self, *args):
        pass  # keep the logs quiet


def run_server():
    httpd = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    log.info("HTTP server on :%s  (webapp + /api proxy)", PORT)
    httpd.serve_forever()


# ── Telegram bot ──────────────────────────────────────────────────────────
def gas(action, uid, extra=None):
    payload = {"action": action, "telegram_id": str(uid)}
    if extra:
        payload.update(extra)
    try:
        r = requests.post(GAS_URL, json=payload, timeout=20, allow_redirects=True)
        return r.json()
    except Exception as e:
        log.error("bot->gas %s: %s", action, e)
        return {"success": False, "error": "Нет связи с сервером."}


def fmt(n):
    try:
        x = round(float(n), 2)
        x = int(x) if x == int(x) else x
        return f"{x:,}".replace(",", " ")
    except Exception:
        return str(n)


def run_bot():
    if not BOT_TOKEN:
        log.warning("BOT_TOKEN не задан — Telegram-бот выключен.")
        return

    import telebot
    from telebot.types import InlineKeyboardMarkup, InlineKeyboardButton, WebAppInfo

    bot = telebot.TeleBot(BOT_TOKEN, parse_mode="HTML")

    def menu_kb():
        kb = InlineKeyboardMarkup()
        if WEBAPP_URL.startswith("https://"):
            kb.add(InlineKeyboardButton("🏭 Открыть FinApp", web_app=WebAppInfo(url=WEBAPP_URL)))
        kb.add(InlineKeyboardButton("📦 Остатки сырья", callback_data="stock"))
        return kb

    @bot.message_handler(commands=["start"])
    def cmd_start(m):
        name = m.from_user.first_name or "коллега"
        u = gas("get_user", m.from_user.id)
        if not u.get("success"):
            bot.send_message(
                m.chat.id,
                f"👋 Здравствуйте, <b>{name}</b>!\n\n"
                f"Это <b>FinApp · Цех приправ</b> — учёт сырья, производства и себестоимости.\n\n"
                f"⚠️ Ваш Telegram ID не найден в системе.\n"
                f"Передайте этот ID менеджеру для доступа:\n<code>{m.from_user.id}</code>",
            )
            return
        role = u["data"]["role"]
        role_ru = {"owner": "Владелец", "manager": "Менеджер", "worker": "Рабочий", "viewer": "Наблюдатель"}.get(role, role)
        bot.send_message(
            m.chat.id,
            f"👋 С возвращением, <b>{name}</b>!\n"
            f"Роль: <b>{role_ru}</b>\n\n"
            f"Откройте приложение для полного функционала 👇",
            reply_markup=menu_kb(),
        )

    @bot.message_handler(commands=["id"])
    def cmd_id(m):
        bot.send_message(m.chat.id, f"Ваш Telegram ID:\n<code>{m.from_user.id}</code>")

    @bot.message_handler(commands=["help"])
    def cmd_help(m):
        bot.send_message(
            m.chat.id,
            "<b>FinApp · Цех приправ</b>\n\n"
            "/start — меню и кнопка приложения\n"
            "/stock — остатки сырья\n"
            "/id — мой Telegram ID\n\n"
            "Все операции (закупки, расход, производство) — в приложении.",
            reply_markup=menu_kb(),
        )

    def show_stock(chat_id, uid):
        r = gas("get_stock", uid)
        if not r.get("success"):
            bot.send_message(chat_id, "⚠️ " + (r.get("error") or "Не удалось получить данные."))
            return
        raw = (r.get("data") or {}).get("raw_materials", [])
        if not raw:
            bot.send_message(chat_id, "📦 Материалов пока нет. Добавьте их в приложении (Настройки).")
            return
        dot = {"green": "🟢", "amber": "🟡", "red": "🔴"}
        lines = ["📦 <b>Остатки сырья</b>\n"]
        for m_ in raw:
            lines.append(f"{dot.get(m_['health'],'⚪')} {m_['name']}: <b>{fmt(m_['current_stock'])} {m_['unit']}</b>")
        bot.send_message(chat_id, "\n".join(lines), reply_markup=menu_kb())

    @bot.message_handler(commands=["stock"])
    def cmd_stock(m):
        show_stock(m.chat.id, m.from_user.id)

    @bot.callback_query_handler(func=lambda c: True)
    def on_cb(c):
        if c.data == "stock":
            bot.answer_callback_query(c.id)
            show_stock(c.message.chat.id, c.from_user.id)

    log.info("Telegram bot polling… (webapp URL: %s)", WEBAPP_URL or "не задан")
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


# ── Entry ────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    if not GAS_URL:
        log.warning("GAS_URL не задан — приложение и бот не смогут читать/писать данные.")
    threading.Thread(target=run_bot, daemon=True).start()
    run_server()
