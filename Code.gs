/**
 * FinApp ERP — Цех приправ (Seasoning Factory module)
 * Google Apps Script backend. Google Sheets is the database.
 *
 * Roles: owner, manager, workshop ("Цех приправ").
 *
 * DEPLOY (see README.md):
 *   1. Open https://script.google.com → New project. Paste this file.
 *   2. Run initSheets() once (authorise) — builds all tabs + seeds the owner.
 *   3. Deploy → New deployment → Web app → Execute as: Me, Access: Anyone.
 *   4. Copy the Web app URL → Railway env GAS_URL.
 *
 * Requests: POST JSON { action, telegram_id, ... }.  Responses: { success, data, alerts, error }.
 */

// ───────────────────────── Config ─────────────────────────
var SPREADSHEET_ID = '1dArwQHNH5e5gLaelyWS6og5dossjd5o_HgLNEfLsX18'; // "FinApp - Maccaldo"
var OWNER_ID   = '1398614118';
var OWNER_NAME = 'Abdulaziz';

var ROLE_RANK = { workshop: 1, manager: 2, owner: 3 };
var VALID_ROLES = ['workshop', 'manager', 'owner'];

var SCHEMA = {
  users: ['telegram_id', 'name', 'role', 'active', 'created_at'],

  raw_materials: ['material_id', 'name', 'unit', 'input_units', 'unit_options',
                  'category', 'active', 'low_stock_threshold', 'created_at'],

  finished_products: ['sku_id', 'name', 'flavour', 'weight_g', 'packs_per_box',
                       'active', 'created_at'],

  purchases: ['id', 'date', 'time', 'material_id', 'quantity_input', 'unit_input',
              'quantity_base', 'unit_base', 'total_sum_uzs', 'price_per_base_unit',
              'supplier', 'logged_by_telegram_id', 'price_confirmed',
              'price_confirmed_by', 'created_at'],

  // Consumption rows are produced by production runs (shared run_id).
  consumption: ['id', 'run_id', 'date', 'time', 'material_id', 'quantity_base',
                'unit_base', 'for_sku_id', 'logged_by_telegram_id', 'notes', 'created_at'],

  // One row per production run: output packs + locked-in cost.
  production: ['id', 'run_id', 'date', 'time', 'sku_id', 'packs_produced',
               'boxes_produced', 'total_material_cost_uzs', 'cost_per_pack_uzs',
               'cost_per_box_uzs', 'logged_by_telegram_id', 'created_at'],

  finished_goods_stock: ['sku_id', 'packs_in_stock', 'boxes_in_stock', 'last_updated'],

  transfers_out: ['id', 'date', 'time', 'sku_id', 'packs_transferred',
                  'logged_by_telegram_id', 'notes', 'created_at'],

  cost_log: ['id', 'run_id', 'date', 'sku_id', 'period', 'total_material_cost_uzs',
             'packs_produced', 'cost_per_pack_uzs', 'cost_per_box_uzs', 'created_at']
};

var TAB_ORDER = ['users', 'raw_materials', 'finished_products', 'purchases',
                 'consumption', 'production', 'finished_goods_stock',
                 'transfers_out', 'cost_log'];

// ───────────────────────── Per-request cache ─────────────────────────
// Sheets reads are the slow part. We read each tab at most once per request.
var _CACHE = {};
function cacheReset_()    { _CACHE = {}; }
function cacheDrop_(name) { if (_CACHE) delete _CACHE[name]; }

// ───────────────────────── HTTP entrypoints ─────────────────────────
function doPost(e) {
  cacheReset_();
  var resp;
  try {
    var body = (e && e.postData && e.postData.contents) ? JSON.parse(e.postData.contents) : {};
    resp = route_(body);
  } catch (ex) {
    resp = err_('Ошибка сервера: ' + (ex && ex.message ? ex.message : ex));
  }
  return jsonOut_(resp);
}

function doGet(e) {
  return jsonOut_(ok_({ status: 'ok', service: 'FinApp ERP — Цех приправ' }));
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function ok_(data, alerts) { return { success: true,  data: data || {}, alerts: alerts || [], error: null }; }
function err_(msg)         { return { success: false, data: null,       alerts: [],          error: msg }; }

// ───────────────────────── Router ─────────────────────────
function route_(body) {
  var action = body.action || '';
  var tid = body.telegram_id != null ? String(body.telegram_id) : '';

  var code = PropertiesService.getScriptProperties().getProperty('WEB_ACCESS_CODE') || '';
  if (code && action !== 'init_sheets' && String(body.access_code || '') !== code) {
    return err_('Неверный код доступа');
  }

  switch (action) {
    case 'get_user':       return action_get_user_(tid);
    case 'init_sheets':    return action_init_sheets_(tid);
    case 'bootstrap':      return action_bootstrap_(tid);

    case 'get_materials':  requireRole_(tid, 1); return ok_({ materials: getMaterials_() });
    case 'get_skus':       requireRole_(tid, 1); return ok_({ skus: getSkus_() });

    case 'log_purchase':   return action_log_purchase_(tid, body);
    case 'confirm_price':  return action_confirm_price_(tid, body);
    case 'log_production': return action_log_production_(tid, body);
    case 'transfer_out':   return action_transfer_out_(tid, body);

    case 'manage_users':     return action_manage_users_(tid, body);
    case 'manage_materials': return action_manage_materials_(tid, body);
    case 'manage_skus':      return action_manage_skus_(tid, body);

    default: return err_('Неизвестное действие: ' + action);
  }
}

// ───────────────────────── Auth ─────────────────────────
function findUser_(tid) {
  if (!tid) return null;
  var rows = getRows_('users').rows;
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].telegram_id) === String(tid)) return rows[i];
  }
  return null;
}
function roleRank_(role) { return ROLE_RANK.hasOwnProperty(role) ? ROLE_RANK[role] : -1; }

function requireRole_(tid, minRank) {
  var u = findUser_(tid);
  if (!u) throw new Error('Пользователь не найден. Обратитесь к менеджеру для доступа.');
  if (!toBool_(u.active)) throw new Error('Доступ отключён. Обратитесь к менеджеру.');
  if (roleRank_(String(u.role)) < minRank) throw new Error('Недостаточно прав для этого действия.');
  return u;
}

// ───────────────────────── Actions ─────────────────────────
function action_get_user_(tid) {
  var u = findUser_(tid);
  if (!u) return err_('Пользователь не найден. Проверьте Telegram ID или обратитесь к менеджеру.');
  if (!toBool_(u.active)) return err_('Доступ отключён. Обратитесь к менеджеру.');
  return ok_({ telegram_id: String(u.telegram_id), name: String(u.name), role: String(u.role) });
}

function action_init_sheets_(tid) {
  if (tid) {
    var u = findUser_(tid);
    if (u && roleRank_(String(u.role)) < 3) throw new Error('Только владелец может инициализировать таблицы.');
  }
  initSheets();
  return ok_({ initialised: true, tabs: TAB_ORDER });
}

// One-shot payload that fills every screen — keeps the SPA to a single round-trip.
function action_bootstrap_(tid) {
  var u = requireRole_(tid, 1);
  var rank = roleRank_(String(u.role));
  var withPrices = rank >= 2;

  var data = {
    user: { telegram_id: String(u.telegram_id), name: String(u.name), role: String(u.role) },
    materials: getMaterials_(),
    skus: getSkus_(),
    stock: getStock_(withPrices),
    logs: {
      purchases: getPurchaseLogs_(60),
      production: getProductionLogs_(60)
    },
    pending: withPrices ? getPending_() : [],
    pending_count: withPrices ? getPending_().length : 0,
    today_production: getTodayProduction_(),
    recent: getRecent_(4),
    costs: withPrices ? getCosts_() : [],
    can_prices: withPrices
  };
  if (rank >= 2) data.users = listUsers_();
  return ok_(data, computeAlerts_());
}

function action_log_purchase_(tid, body) {
  requireRole_(tid, 1);
  var m = findMaterial_(body.material_id);
  if (!m) return err_('Материал не найден. Проверьте список материалов.');
  var qtyInput = toNum_(body.quantity_input);
  if (!(qtyInput > 0)) return err_('Укажите количество больше нуля.');

  var unitInput = String(body.unit_input || m.unit);
  var qtyBase = qtyInput * unitFactor_(m, unitInput);
  var now = nowParts_();

  appendRow_('purchases', {
    id: genId_(), date: now.date, time: now.time,
    material_id: String(m.material_id),
    quantity_input: qtyInput, unit_input: unitInput,
    quantity_base: qtyBase, unit_base: String(m.unit),
    total_sum_uzs: '', price_per_base_unit: '',
    supplier: String(body.supplier || ''),
    logged_by_telegram_id: String(tid),
    price_confirmed: false, price_confirmed_by: '',
    created_at: now.iso
  });
  return ok_({ logged: true, quantity_base: qtyBase, unit_base: String(m.unit) }, computeAlerts_());
}

function action_confirm_price_(tid, body) {
  requireRole_(tid, 2);
  var id = String(body.id || '');
  if (!id) return err_('Не указана закупка для подтверждения.');
  var total = toNum_(body.total_sum_uzs);
  if (!(total >= 0)) return err_('Укажите корректную сумму в сумах.');

  var target = null, rows = getRows_('purchases').rows;
  for (var i = 0; i < rows.length; i++) if (String(rows[i].id) === id) { target = rows[i]; break; }
  if (!target) return err_('Закупка не найдена.');

  var qtyBase = toNum_(target.quantity_base);
  var perUnit = qtyBase > 0 ? total / qtyBase : 0;
  updateRow_('purchases', 'id', id, {
    total_sum_uzs: total, price_per_base_unit: perUnit,
    price_confirmed: true, price_confirmed_by: String(tid)
  });
  return ok_({ confirmed: true, price_per_base_unit: perUnit });
}

/**
 * Combined production run. Body:
 *   { sku_id, packs_produced, materials: [{material_id, quantity_input, unit_input}], notes }
 * Writes: N consumption rows + 1 production row (with locked-in cost) + 1 cost_log row.
 * Raw stock drops (via consumption) and finished goods rise (via production) automatically.
 */
function action_log_production_(tid, body) {
  requireRole_(tid, 1);
  var sku = findSku_(body.sku_id);
  if (!sku) return err_('Продукт (SKU) не найден. Проверьте список продукции.');

  var packs = toNum_(body.packs_produced);
  if (!(packs > 0)) return err_('Укажите количество пачек больше нуля.');

  var lines = body.materials || [];
  if (!lines.length) return err_('Добавьте хотя бы один материал расхода.');

  var ppb = toNum_(sku.packs_per_box) || 1;
  var boxes = packs / ppb;
  var now = nowParts_();
  var runId = genId_();
  var wac = wacMap_();

  // Validate + collect consumed materials first (so we don't write a half run).
  var consumed = [], totalCost = 0;
  for (var i = 0; i < lines.length; i++) {
    var m = findMaterial_(lines[i].material_id);
    if (!m) return err_('Материал не найден в строке ' + (i + 1) + '. Проверьте список материалов.');
    var qtyBase = toNum_(lines[i].quantity_input) * unitFactor_(m, lines[i].unit_input || m.unit);
    if (!(qtyBase > 0)) return err_('Укажите количество для «' + m.name + '» больше нуля.');
    totalCost += qtyBase * (wac[m.material_id] || 0);
    consumed.push({ material_id: m.material_id, qtyBase: qtyBase, unit: m.unit });
  }

  consumed.forEach(function (c) {
    appendRow_('consumption', {
      id: genId_(), run_id: runId, date: now.date, time: now.time,
      material_id: c.material_id, quantity_base: c.qtyBase, unit_base: c.unit,
      for_sku_id: String(sku.sku_id), logged_by_telegram_id: String(tid),
      notes: String(body.notes || ''), created_at: now.iso
    });
  });

  var costPerPack = packs > 0 ? totalCost / packs : 0;
  var costPerBox  = boxes > 0 ? totalCost / boxes : 0;

  appendRow_('production', {
    id: genId_(), run_id: runId, date: now.date, time: now.time,
    sku_id: String(sku.sku_id), packs_produced: packs, boxes_produced: round_(boxes),
    total_material_cost_uzs: round_(totalCost), cost_per_pack_uzs: round_(costPerPack),
    cost_per_box_uzs: round_(costPerBox), logged_by_telegram_id: String(tid), created_at: now.iso
  });

  appendRow_('cost_log', {
    id: genId_(), run_id: runId, date: now.date, sku_id: String(sku.sku_id), period: 'run',
    total_material_cost_uzs: round_(totalCost), packs_produced: packs,
    cost_per_pack_uzs: round_(costPerPack), cost_per_box_uzs: round_(costPerBox), created_at: now.iso
  });

  refreshFinishedStock_();

  return ok_({
    logged: true, run_id: runId, packs_produced: packs,
    total_material_cost_uzs: round_(totalCost),
    cost_per_pack_uzs: round_(costPerPack), cost_per_box_uzs: round_(costPerBox)
  }, computeAlerts_());
}

function action_transfer_out_(tid, body) {
  requireRole_(tid, 2);
  var sku = findSku_(body.sku_id);
  if (!sku) return err_('Продукт (SKU) не найден.');
  var packs = toNum_(body.packs_transferred);
  if (!(packs > 0)) return err_('Укажите количество пачек больше нуля.');

  var avail = finishedPacks_(String(sku.sku_id));
  if (packs > avail) return err_('Недостаточно на складе. Доступно пачек: ' + fmtNum_(avail));

  var now = nowParts_();
  appendRow_('transfers_out', {
    id: genId_(), date: now.date, time: now.time, sku_id: String(sku.sku_id),
    packs_transferred: packs, logged_by_telegram_id: String(tid),
    notes: String(body.notes || ''), created_at: now.iso
  });
  refreshFinishedStock_();
  return ok_({ transferred: true, remaining_packs: avail - packs });
}

// ───────────────────────── Management (CRUD) ─────────────────────────
function action_manage_users_(tid, body) {
  requireRole_(tid, 2);
  var op = String(body.op || 'list'), p = body.payload || {};
  if (op === 'list') return ok_({ users: listUsers_() });
  if (op === 'add') {
    var newId = String(p.telegram_id || '').trim();
    if (!/^\d+$/.test(newId)) return err_('Telegram ID должен быть числом.');
    if (VALID_ROLES.indexOf(p.role) < 0) return err_('Некорректная роль.');
    if (findUser_(newId)) return err_('Пользователь с таким ID уже существует.');
    appendRow_('users', { telegram_id: newId, name: String(p.name || ''), role: String(p.role),
                          active: true, created_at: nowParts_().iso });
    return ok_({ added: true });
  }
  if (op === 'update') {
    var upd = {};
    if (p.name != null) upd.name = String(p.name);
    if (p.role != null) { if (VALID_ROLES.indexOf(p.role) < 0) return err_('Некорректная роль.'); upd.role = String(p.role); }
    if (p.active != null) upd.active = toBool_(p.active);
    return updateRow_('users', 'telegram_id', String(p.telegram_id), upd) ? ok_({ updated: true }) : err_('Пользователь не найден.');
  }
  if (op === 'deactivate') {
    if (String(p.telegram_id) === OWNER_ID) return err_('Нельзя отключить владельца.');
    return updateRow_('users', 'telegram_id', String(p.telegram_id), { active: false }) ? ok_({ deactivated: true }) : err_('Пользователь не найден.');
  }
  return err_('Неизвестная операция.');
}

function action_manage_materials_(tid, body) {
  requireRole_(tid, 2);
  var op = String(body.op || 'list'), p = body.payload || {};
  if (op === 'list') return ok_({ materials: getMaterials_(true) });
  if (op === 'add') {
    if (!p.name) return err_('Укажите название материала.');
    var unit = String(p.unit || 'кг');
    var opts = normaliseUnitOptions_(p.unit_options, unit, p.input_units);
    appendRow_('raw_materials', {
      material_id: genId_(), name: String(p.name), unit: unit,
      input_units: String(p.input_units || opts.map(function (o) { return o.label; }).join(', ')),
      unit_options: JSON.stringify(opts), category: String(p.category || 'seasoning'),
      active: true, low_stock_threshold: toNum_(p.low_stock_threshold), created_at: nowParts_().iso
    });
    return ok_({ added: true });
  }
  if (op === 'update') {
    var upd = {};
    if (p.name != null) upd.name = String(p.name);
    if (p.unit != null) upd.unit = String(p.unit);
    if (p.category != null) upd.category = String(p.category);
    if (p.low_stock_threshold != null) upd.low_stock_threshold = toNum_(p.low_stock_threshold);
    if (p.active != null) upd.active = toBool_(p.active);
    if (p.input_units != null) {
      var base = upd.unit || (findMaterial_(p.material_id) || {}).unit || 'кг';
      var optsU = normaliseUnitOptions_(p.unit_options, base, p.input_units);
      upd.unit_options = JSON.stringify(optsU);
      upd.input_units = String(p.input_units || optsU.map(function (o) { return o.label; }).join(', '));
    }
    return updateRow_('raw_materials', 'material_id', String(p.material_id), upd) ? ok_({ updated: true }) : err_('Материал не найден.');
  }
  if (op === 'delete') return updateRow_('raw_materials', 'material_id', String(p.material_id), { active: false }) ? ok_({ deleted: true }) : err_('Материал не найден.');
  return err_('Неизвестная операция.');
}

function action_manage_skus_(tid, body) {
  requireRole_(tid, 2);
  var op = String(body.op || 'list'), p = body.payload || {};
  if (op === 'list') return ok_({ skus: getSkus_(true) });
  if (op === 'add') {
    if (!p.name) return err_('Укажите название продукта.');
    appendRow_('finished_products', {
      sku_id: genId_(), name: String(p.name), flavour: String(p.flavour || ''),
      weight_g: toNum_(p.weight_g), packs_per_box: toNum_(p.packs_per_box) || 1,
      active: true, created_at: nowParts_().iso
    });
    return ok_({ added: true });
  }
  if (op === 'update') {
    var upd = {};
    if (p.name != null) upd.name = String(p.name);
    if (p.flavour != null) upd.flavour = String(p.flavour);
    if (p.weight_g != null) upd.weight_g = toNum_(p.weight_g);
    if (p.packs_per_box != null) upd.packs_per_box = toNum_(p.packs_per_box) || 1;
    if (p.active != null) upd.active = toBool_(p.active);
    return updateRow_('finished_products', 'sku_id', String(p.sku_id), upd) ? ok_({ updated: true }) : err_('Продукт не найден.');
  }
  if (op === 'delete') return updateRow_('finished_products', 'sku_id', String(p.sku_id), { active: false }) ? ok_({ deleted: true }) : err_('Продукт не найден.');
  return err_('Неизвестная операция.');
}

// ───────────────────────── Domain reads ─────────────────────────
function listUsers_() {
  return getRows_('users').rows.map(function (r) {
    return { telegram_id: String(r.telegram_id), name: String(r.name), role: String(r.role), active: toBool_(r.active) };
  });
}

function getMaterials_(includeInactive) {
  return getRows_('raw_materials').rows
    .filter(function (r) { return includeInactive || toBool_(r.active); })
    .map(function (r) {
      return { material_id: String(r.material_id), name: String(r.name), unit: String(r.unit),
               input_units: String(r.input_units || ''), unit_options: parseUnitOptions_(r),
               category: String(r.category || ''), active: toBool_(r.active),
               low_stock_threshold: toNum_(r.low_stock_threshold) };
    });
}

function getSkus_(includeInactive) {
  return getRows_('finished_products').rows
    .filter(function (r) { return includeInactive || toBool_(r.active); })
    .map(function (r) {
      return { sku_id: String(r.sku_id), name: String(r.name), flavour: String(r.flavour || ''),
               weight_g: toNum_(r.weight_g), packs_per_box: toNum_(r.packs_per_box) || 1, active: toBool_(r.active) };
    });
}

function sumByMaterial_(tab, col) {
  var out = {};
  getRows_(tab).rows.forEach(function (r) { var k = String(r.material_id); out[k] = (out[k] || 0) + toNum_(r[col]); });
  return out;
}

function wacMap_() {
  var spend = {}, qty = {};
  getRows_('purchases').rows.forEach(function (r) {
    if (!toBool_(r.price_confirmed)) return;
    var k = String(r.material_id);
    spend[k] = (spend[k] || 0) + toNum_(r.total_sum_uzs);
    qty[k]   = (qty[k]   || 0) + toNum_(r.quantity_base);
  });
  var out = {};
  Object.keys(qty).forEach(function (k) { out[k] = qty[k] > 0 ? spend[k] / qty[k] : 0; });
  return out;
}

function materialStockRows_() {
  var purchased = sumByMaterial_('purchases', 'quantity_base');
  var consumed  = sumByMaterial_('consumption', 'quantity_base');
  return getMaterials_().map(function (m) {
    var cur = (purchased[m.material_id] || 0) - (consumed[m.material_id] || 0);
    return { material_id: m.material_id, name: m.name, unit: m.unit, category: m.category,
             low_stock_threshold: m.low_stock_threshold, current_stock: round_(cur) };
  });
}

function getStock_(withPrices) {
  var rows = materialStockRows_();
  var wac = withPrices ? wacMap_() : null;
  var raw = rows.map(function (r) {
    var o = { material_id: r.material_id, name: r.name, unit: r.unit, category: r.category,
              current_stock: r.current_stock, low_stock_threshold: r.low_stock_threshold,
              health: healthColor_(r.current_stock, r.low_stock_threshold) };
    if (withPrices) { var w = wac[r.material_id] || 0; o.wac_price = round_(w); o.total_value = round_(r.current_stock * w); }
    return o;
  });
  return { raw_materials: raw, finished_goods: finishedGoodsList_(withPrices), with_prices: !!withPrices };
}

function finishedGoodsList_(withPrices) {
  var prod = {}, trans = {};
  getRows_('production').rows.forEach(function (r) { var k = String(r.sku_id); prod[k] = (prod[k] || 0) + toNum_(r.packs_produced); });
  getRows_('transfers_out').rows.forEach(function (r) { var k = String(r.sku_id); trans[k] = (trans[k] || 0) + toNum_(r.packs_transferred); });
  var costBySku = withPrices ? latestCostBySku_() : null;

  return getSkus_().map(function (s) {
    var packs = (prod[s.sku_id] || 0) - (trans[s.sku_id] || 0);
    var o = { sku_id: s.sku_id, name: s.name, flavour: s.flavour, weight_g: s.weight_g,
              packs_per_box: s.packs_per_box, packs_in_stock: round_(packs),
              boxes_in_stock: round_(packs / (s.packs_per_box || 1)) };
    if (withPrices) {
      var c = costBySku[s.sku_id] || { cost_per_pack: 0 };
      o.cost_per_pack = round_(c.cost_per_pack || 0);
      o.cost_per_box  = round_((c.cost_per_pack || 0) * (s.packs_per_box || 1));
      o.total_value   = round_(packs * (c.cost_per_pack || 0));
    }
    return o;
  });
}

function finishedPacks_(skuId) {
  var p = 0, t = 0;
  getRows_('production').rows.forEach(function (r) { if (String(r.sku_id) === skuId) p += toNum_(r.packs_produced); });
  getRows_('transfers_out').rows.forEach(function (r) { if (String(r.sku_id) === skuId) t += toNum_(r.packs_transferred); });
  return p - t;
}

function latestCostBySku_() {
  var out = {};
  getRows_('production').rows.forEach(function (r) {
    var k = String(r.sku_id), ts = String(r.created_at || r.date);
    if (!out[k] || ts >= out[k]._ts) out[k] = { _ts: ts, cost_per_pack: toNum_(r.cost_per_pack_uzs), cost_per_box: toNum_(r.cost_per_box_uzs) };
  });
  return out;
}

function computeAlerts_() {
  return materialStockRows_()
    .filter(function (r) { return r.low_stock_threshold > 0 && r.current_stock < r.low_stock_threshold; })
    .map(function (r) { return { material_id: r.material_id, name: r.name, unit: r.unit, current_stock: r.current_stock, threshold: r.low_stock_threshold }; });
}

function healthColor_(current, threshold) {
  if (!(threshold > 0)) return 'green';
  var ratio = current / threshold;
  if (ratio >= 0.5) return 'green';
  if (ratio >= 0.2) return 'amber';
  return 'red';
}

function getPending_() {
  var matNames = materialNameMap_();
  var out = getRows_('purchases').rows.filter(function (r) { return !toBool_(r.price_confirmed); }).map(function (r) {
    return { _ts: String(r.created_at || (r.date + ' ' + r.time)), v: {
      id: String(r.id), date: String(r.date), time: String(r.time),
      material: matNames[String(r.material_id)] || String(r.material_id),
      quantity_input: toNum_(r.quantity_input), unit_input: String(r.unit_input || ''),
      quantity_base: toNum_(r.quantity_base), unit_base: String(r.unit_base || ''),
      supplier: String(r.supplier || '') } };
  });
  out.sort(function (a, b) { return a._ts < b._ts ? 1 : -1; });
  return out.map(function (x) { return x.v; });
}

function getTodayProduction_() {
  var today = nowParts_().date, byS = {}, names = skuNameMap_();
  getRows_('production').rows.forEach(function (r) {
    if (String(r.date) === today) { var k = String(r.sku_id); byS[k] = (byS[k] || 0) + toNum_(r.packs_produced); }
  });
  return Object.keys(byS).map(function (k) { return { sku_id: k, name: names[k] || k, packs: round_(byS[k]) }; });
}

function getRecent_(limit) {
  var items = [], matNames = materialNameMap_(), skuNames = skuNameMap_();
  getRows_('production').rows.forEach(function (r) {
    items.push({ type: 'production', ts: String(r.created_at || (r.date + ' ' + r.time)), date: String(r.date), time: String(r.time),
                 title: skuNames[String(r.sku_id)] || String(r.sku_id), detail: fmtNum_(toNum_(r.packs_produced)) + ' пачек' });
  });
  getRows_('purchases').rows.forEach(function (r) {
    items.push({ type: 'purchase', ts: String(r.created_at || (r.date + ' ' + r.time)), date: String(r.date), time: String(r.time),
                 title: matNames[String(r.material_id)] || String(r.material_id), detail: '+' + fmtNum_(toNum_(r.quantity_input)) + ' ' + String(r.unit_input || '') });
  });
  items.sort(function (a, b) { return a.ts < b.ts ? 1 : -1; });
  return items.slice(0, limit);
}

function getPurchaseLogs_(limit) {
  var matNames = materialNameMap_();
  var out = getRows_('purchases').rows.map(function (r) {
    return { _ts: String(r.created_at || (r.date + ' ' + r.time)), v: {
      id: String(r.id), date: String(r.date), time: String(r.time),
      material: matNames[String(r.material_id)] || String(r.material_id),
      quantity_input: toNum_(r.quantity_input), unit_input: String(r.unit_input || ''),
      quantity_base: toNum_(r.quantity_base), unit_base: String(r.unit_base || ''),
      total_sum_uzs: toNum_(r.total_sum_uzs), supplier: String(r.supplier || ''),
      price_confirmed: toBool_(r.price_confirmed) } };
  });
  out.sort(function (a, b) { return a._ts < b._ts ? 1 : -1; });
  return out.slice(0, limit).map(function (x) { return x.v; });
}

function getProductionLogs_(limit) {
  var skuNames = skuNameMap_(), matNames = materialNameMap_();
  var byRun = {};
  getRows_('consumption').rows.forEach(function (r) {
    var k = String(r.run_id);
    (byRun[k] = byRun[k] || []).push({ material: matNames[String(r.material_id)] || String(r.material_id),
                                       quantity_base: toNum_(r.quantity_base), unit: String(r.unit_base || '') });
  });
  var out = getRows_('production').rows.map(function (r) {
    return { _ts: String(r.created_at || (r.date + ' ' + r.time)), v: {
      id: String(r.id), run_id: String(r.run_id), date: String(r.date), time: String(r.time),
      sku: skuNames[String(r.sku_id)] || String(r.sku_id),
      packs_produced: toNum_(r.packs_produced), boxes_produced: toNum_(r.boxes_produced),
      total_material_cost_uzs: toNum_(r.total_material_cost_uzs),
      cost_per_pack_uzs: toNum_(r.cost_per_pack_uzs), cost_per_box_uzs: toNum_(r.cost_per_box_uzs),
      materials: byRun[String(r.run_id)] || [] } };
  });
  out.sort(function (a, b) { return a._ts < b._ts ? 1 : -1; });
  return out.slice(0, limit).map(function (x) { return x.v; });
}

function getCosts_() {
  var skuNames = skuNameMap_();
  var rows = getRows_('cost_log').rows.map(function (r) {
    return { _ts: String(r.created_at || r.date), v: {
      id: String(r.id), date: String(r.date), sku: skuNames[String(r.sku_id)] || String(r.sku_id),
      period: String(r.period), total_material_cost_uzs: toNum_(r.total_material_cost_uzs),
      packs_produced: toNum_(r.packs_produced), cost_per_pack_uzs: toNum_(r.cost_per_pack_uzs),
      cost_per_box_uzs: toNum_(r.cost_per_box_uzs) } };
  });
  rows.sort(function (a, b) { return a._ts < b._ts ? 1 : -1; });
  return rows.slice(0, 100).map(function (x) { return x.v; });
}

function refreshFinishedStock_() {
  var prod = {}, trans = {};
  getRows_('production').rows.forEach(function (r) { var k = String(r.sku_id); prod[k] = (prod[k] || 0) + toNum_(r.packs_produced); });
  getRows_('transfers_out').rows.forEach(function (r) { var k = String(r.sku_id); trans[k] = (trans[k] || 0) + toNum_(r.packs_transferred); });
  var sheet = getSheet_('finished_goods_stock');
  var iso = nowParts_().iso;
  var data = [SCHEMA.finished_goods_stock];
  getSkus_(true).forEach(function (s) {
    var packs = (prod[s.sku_id] || 0) - (trans[s.sku_id] || 0);
    data.push([s.sku_id, round_(packs), round_(packs / (s.packs_per_box || 1)), iso]);
  });
  sheet.clearContents();
  sheet.getRange(1, 1, data.length, SCHEMA.finished_goods_stock.length).setValues(data);
  cacheDrop_('finished_goods_stock');
}

// ───────────────────────── Lookups ─────────────────────────
function findMaterial_(id) {
  if (!id) return null;
  var rows = getRows_('raw_materials').rows;
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].material_id) === String(id)) {
      return { material_id: String(rows[i].material_id), name: String(rows[i].name), unit: String(rows[i].unit), unit_options: parseUnitOptions_(rows[i]) };
    }
  }
  return null;
}
function findSku_(id) {
  if (!id) return null;
  var rows = getRows_('finished_products').rows;
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].sku_id) === String(id)) {
      return { sku_id: String(rows[i].sku_id), name: String(rows[i].name), packs_per_box: toNum_(rows[i].packs_per_box) || 1 };
    }
  }
  return null;
}
function materialNameMap_() { var m = {}; getRows_('raw_materials').rows.forEach(function (r) { m[String(r.material_id)] = String(r.name); }); return m; }
function skuNameMap_()      { var m = {}; getRows_('finished_products').rows.forEach(function (r) { m[String(r.sku_id)] = String(r.name); }); return m; }

function parseUnitOptions_(r) {
  var raw = r.unit_options;
  if (raw) {
    try {
      var arr = (typeof raw === 'string') ? JSON.parse(raw) : raw;
      if (arr && arr.length) return arr.map(function (o) { return { label: String(o.label), factor: toNum_(o.factor) || 1 }; });
    } catch (e) {}
  }
  return [{ label: String(r.unit || 'ед.'), factor: 1 }];
}
function unitFactor_(material, label) {
  var opts = material.unit_options || [{ label: material.unit, factor: 1 }];
  for (var i = 0; i < opts.length; i++) if (String(opts[i].label) === String(label)) return toNum_(opts[i].factor) || 1;
  return 1;
}
function normaliseUnitOptions_(unitOptions, baseUnit, inputUnitsText) {
  if (unitOptions && unitOptions.length) return unitOptions.map(function (o) { return { label: String(o.label), factor: toNum_(o.factor) || 1 }; });
  if (inputUnitsText) {
    var parts = String(inputUnitsText).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    if (parts.length) return parts.map(function (p) { var b = p.split(':'); return { label: b[0].trim(), factor: b[1] ? (toNum_(b[1]) || 1) : 1 }; });
  }
  return [{ label: String(baseUnit || 'ед.'), factor: 1 }];
}

// ───────────────────────── Sheet helpers ─────────────────────────
function getSS_() {
  if (SPREADSHEET_ID) return SpreadsheetApp.openById(SPREADSHEET_ID);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Скрипт не привязан к таблице. Укажите SPREADSHEET_ID.');
  return ss;
}
function getSheet_(name) {
  var s = getSS_().getSheetByName(name);
  if (!s) throw new Error('Лист не найден: ' + name + '. Запустите initSheets().');
  return s;
}
function getRows_(name) {
  if (_CACHE[name]) return _CACHE[name];
  var s = getSheet_(name);
  var values = s.getDataRange().getValues();
  var result;
  if (values.length < 2) { result = { headers: values[0] || SCHEMA[name] || [], rows: [] }; }
  else {
    var headers = values[0], rows = [];
    for (var i = 1; i < values.length; i++) {
      if (values[i].join('') === '') continue;
      var o = { _row: i + 1 };
      for (var j = 0; j < headers.length; j++) o[headers[j]] = values[i][j];
      rows.push(o);
    }
    result = { headers: headers, rows: rows };
  }
  _CACHE[name] = result;
  return result;
}
function appendRow_(name, obj) {
  var s = getSheet_(name);
  var headers = s.getRange(1, 1, 1, s.getLastColumn()).getValues()[0];
  var row = headers.map(function (h) { return obj.hasOwnProperty(h) ? obj[h] : ''; });
  s.appendRow(row);
  cacheDrop_(name);
  return row;
}
function updateRow_(name, matchCol, matchVal, updates) {
  var s = getSheet_(name);
  var data = s.getDataRange().getValues();
  var headers = data[0];
  var ci = headers.indexOf(matchCol);
  if (ci < 0) throw new Error('Колонка не найдена: ' + matchCol);
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][ci]) === String(matchVal)) {
      var rowNum = i + 1;
      Object.keys(updates).forEach(function (k) { var cj = headers.indexOf(k); if (cj >= 0) s.getRange(rowNum, cj + 1).setValue(updates[k]); });
      cacheDrop_(name);
      return true;
    }
  }
  return false;
}

// ───────────────────────── Init ─────────────────────────
function initSheets() {
  var ss = getSS_();
  TAB_ORDER.forEach(function (name) {
    var sheet = ss.getSheetByName(name);
    if (!sheet) sheet = ss.insertSheet(name);
    var headers = SCHEMA[name];
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  });
  cacheReset_();
  if (!findUser_(OWNER_ID)) {
    appendRow_('users', { telegram_id: OWNER_ID, name: OWNER_NAME, role: 'owner', active: true, created_at: nowParts_().iso });
  }
  ['Sheet1', 'Лист1'].forEach(function (n) {
    var sh = ss.getSheetByName(n);
    if (sh && TAB_ORDER.indexOf(n) < 0 && ss.getSheets().length > 1) { try { ss.deleteSheet(sh); } catch (e) {} }
  });
  return 'Готово: создано ' + TAB_ORDER.length + ' листов, владелец засеян.';
}

// ───────────────────────── Utils ─────────────────────────
function toNum_(v) {
  if (v === '' || v == null) return 0;
  if (typeof v === 'number') return v;
  var n = parseFloat(String(v).replace(/\s/g, '').replace(',', '.'));
  return isNaN(n) ? 0 : n;
}
function toBool_(v) { return v === true || String(v).toLowerCase() === 'true' || String(v) === '1'; }
function round_(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function fmtNum_(n) { return String(round_(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' '); }
function genId_() { return Utilities.getUuid().replace(/-/g, '').substring(0, 12); }
function nowParts_() {
  var tz = Session.getScriptTimeZone() || 'Asia/Tashkent';
  var d = new Date();
  return { date: Utilities.formatDate(d, tz, 'yyyy-MM-dd'), time: Utilities.formatDate(d, tz, 'HH:mm'),
           iso: Utilities.formatDate(d, tz, "yyyy-MM-dd'T'HH:mm:ss") };
}
