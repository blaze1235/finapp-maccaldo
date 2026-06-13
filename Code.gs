/**
 * FinApp ERP — Цех приправ (Seasoning Factory module)
 * Google Apps Script backend. Google Sheets is the database.
 *
 * DEPLOY (see README.md):
 *   1. Create a new Google Sheet.
 *   2. Extensions → Apps Script. Delete the default code, paste THIS file.
 *   3. Run initSheets() once (authorise when prompted) — builds all tabs + seeds the owner.
 *   4. Deploy → New deployment → Web app → Execute as: Me, Who has access: Anyone.
 *   5. Copy the Web app URL → paste it into Railway as the GAS_URL env variable.
 *
 * All requests are POST with a JSON body: { action, telegram_id, ... }.
 * All responses: { success, data, alerts, error }.
 */

// ───────────────────────── Config ─────────────────────────
// Leave SPREADSHEET_ID empty when the script is bound to its Sheet (the normal case).
var SPREADSHEET_ID = '';
var OWNER_ID   = '1398614118';
var OWNER_NAME = 'Abdulaziz';

var ROLE_RANK = { viewer: 0, worker: 1, manager: 2, owner: 3 };

// Tab name → header row. The single source of truth for the schema.
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

  consumption: ['id', 'date', 'time', 'material_id', 'quantity_base', 'unit_base',
                'for_sku_id', 'logged_by_telegram_id', 'notes', 'created_at'],

  production: ['id', 'date', 'time', 'sku_id', 'boxes_produced', 'packs_produced',
               'logged_by_telegram_id', 'created_at'],

  finished_goods_stock: ['sku_id', 'boxes_in_stock', 'packs_in_stock', 'last_updated'],

  transfers_out: ['id', 'date', 'time', 'sku_id', 'boxes_transferred',
                  'logged_by_telegram_id', 'notes', 'created_at'],

  cost_log: ['id', 'date', 'sku_id', 'period', 'total_material_cost_uzs',
             'packs_produced', 'cost_per_pack_uzs', 'cost_per_box_uzs', 'created_at']
};

var TAB_ORDER = ['users', 'raw_materials', 'finished_products', 'purchases',
                 'consumption', 'production', 'finished_goods_stock',
                 'transfers_out', 'cost_log'];

// ───────────────────────── HTTP entrypoints ─────────────────────────
function doPost(e) {
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
  // Health check + lets you sanity-check the deployment in a browser.
  return jsonOut_(ok_({ status: 'ok', service: 'FinApp ERP — Цех приправ' }));
}

function jsonOut_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function ok_(data, alerts)  { return { success: true,  data: data || {}, alerts: alerts || [], error: null }; }
function err_(msg)          { return { success: false, data: null,       alerts: [],          error: msg }; }

// ───────────────────────── Router ─────────────────────────
function route_(body) {
  var action = body.action || '';
  var tid = body.telegram_id != null ? String(body.telegram_id) : '';

  // Optional shared gate. Set a Script Property WEB_ACCESS_CODE to require a code
  // on every request. Leave it unset (default) for instant Telegram login.
  var code = PropertiesService.getScriptProperties().getProperty('WEB_ACCESS_CODE') || '';
  if (code && action !== 'init_sheets' && String(body.access_code || '') !== code) {
    return err_('Неверный код доступа');
  }

  switch (action) {
    // No auth — used by the login screen.
    case 'get_user':       return action_get_user_(tid);
    case 'init_sheets':    return action_init_sheets_(tid);

    // One-shot load for the SPA.
    case 'bootstrap':      return action_bootstrap_(tid);

    case 'get_materials':  requireRole_(tid, 0); return ok_({ materials: getMaterials_() });
    case 'get_skus':       requireRole_(tid, 0); return ok_({ skus: getSkus_() });
    case 'get_stock':      requireRole_(tid, 0); return ok_(getStock_(false));
    case 'get_stock_full': requireRole_(tid, 2); return ok_(getStock_(true));

    case 'log_purchase':     return action_log_purchase_(tid, body);
    case 'confirm_price':    return action_confirm_price_(tid, body);
    case 'log_consumption':  return action_log_consumption_(tid, body);
    case 'log_production':   return action_log_production_(tid, body);

    case 'get_logs':       return action_get_logs_(tid, body);
    case 'get_costs':      requireRole_(tid, 2); return ok_({ costs: getCosts_() });
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

function roleRank_(role) {
  return ROLE_RANK.hasOwnProperty(role) ? ROLE_RANK[role] : -1;
}

// Returns the user object or throws (doPost turns the throw into a clean error).
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
  // Allow when run as an owner via the API, or from the editor (no tid present).
  if (tid) {
    var u = findUser_(tid);
    if (u && roleRank_(String(u.role)) < 3) throw new Error('Только владелец может инициализировать таблицы.');
  }
  initSheets();
  return ok_({ initialised: true, tabs: TAB_ORDER });
}

function action_bootstrap_(tid) {
  var u = requireRole_(tid, 0);
  var rank = roleRank_(String(u.role));
  var stock = getStock_(rank >= 2);
  var data = {
    user: { telegram_id: String(u.telegram_id), name: String(u.name), role: String(u.role) },
    materials: getMaterials_(),
    skus: getSkus_(),
    stock: stock,
    pending_count: rank >= 2 ? countPending_() : 0,
    today_production: getTodayProduction_(),
    recent: getRecentMixed_(3, rank),
    can_prices: rank >= 2
  };
  return ok_(data, computeAlerts_());
}

function action_log_purchase_(tid, body) {
  var u = requireRole_(tid, 1);
  var m = findMaterial_(body.material_id);
  if (!m) return err_('Материал не найден. Проверьте список материалов.');

  var qtyInput = toNum_(body.quantity_input);
  if (!(qtyInput > 0)) return err_('Укажите количество больше нуля.');

  var unitInput = String(body.unit_input || m.unit);
  var factor = unitFactor_(m, unitInput);
  var qtyBase = qtyInput * factor;
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

  var sheet = getRows_('purchases');
  var target = null;
  for (var i = 0; i < sheet.rows.length; i++) {
    if (String(sheet.rows[i].id) === id) { target = sheet.rows[i]; break; }
  }
  if (!target) return err_('Закупка не найдена.');

  var qtyBase = toNum_(target.quantity_base);
  var perUnit = qtyBase > 0 ? total / qtyBase : 0;
  updateRow_('purchases', 'id', id, {
    total_sum_uzs: total,
    price_per_base_unit: perUnit,
    price_confirmed: true,
    price_confirmed_by: String(tid)
  });
  return ok_({ confirmed: true, price_per_base_unit: perUnit });
}

function action_log_consumption_(tid, body) {
  var u = requireRole_(tid, 1);
  var m = findMaterial_(body.material_id);
  if (!m) return err_('Материал не найден. Проверьте список материалов.');

  var qtyInput = toNum_(body.quantity_input);
  if (!(qtyInput > 0)) return err_('Укажите количество больше нуля.');

  var unitInput = String(body.unit_input || m.unit);
  var qtyBase = qtyInput * unitFactor_(m, unitInput);
  var skuId = String(body.for_sku_id || '');
  var now = nowParts_();

  appendRow_('consumption', {
    id: genId_(), date: now.date, time: now.time,
    material_id: String(m.material_id),
    quantity_base: qtyBase, unit_base: String(m.unit),
    for_sku_id: skuId,
    logged_by_telegram_id: String(tid),
    notes: String(body.notes || ''),
    created_at: now.iso
  });

  // If tied to a SKU, refresh that SKU's daily cost (WAC).
  if (skuId) recomputeCost_(skuId, now.date);

  return ok_({ logged: true, quantity_base: qtyBase }, computeAlerts_());
}

function action_log_production_(tid, body) {
  var u = requireRole_(tid, 1);
  var sku = findSku_(body.sku_id);
  if (!sku) return err_('Продукт (SKU) не найден. Проверьте список продукции.');

  var boxes = toNum_(body.boxes_produced);
  if (!(boxes > 0)) return err_('Укажите количество коробок больше нуля.');

  var ppb = toNum_(sku.packs_per_box) || 1;
  var packs = boxes * ppb;
  var now = nowParts_();

  appendRow_('production', {
    id: genId_(), date: now.date, time: now.time,
    sku_id: String(sku.sku_id),
    boxes_produced: boxes, packs_produced: packs,
    logged_by_telegram_id: String(tid),
    created_at: now.iso
  });

  var cost = recomputeCost_(String(sku.sku_id), now.date);
  refreshFinishedStock_();

  return ok_({ logged: true, packs_produced: packs, cost: cost }, computeAlerts_());
}

function action_get_logs_(tid, body) {
  var type = String(body.type || 'production');
  // viewer may see production only; purchases/consumption need worker+.
  if (type === 'production') requireRole_(tid, 0);
  else requireRole_(tid, 1);
  return ok_({ type: type, logs: getLogs_(type, 60) });
}

function action_transfer_out_(tid, body) {
  requireRole_(tid, 2);
  var sku = findSku_(body.sku_id);
  if (!sku) return err_('Продукт (SKU) не найден.');
  var boxes = toNum_(body.boxes_transferred);
  if (!(boxes > 0)) return err_('Укажите количество коробок больше нуля.');

  var avail = finishedBoxes_(String(sku.sku_id));
  if (boxes > avail) return err_('Недостаточно на складе. Доступно коробок: ' + fmtNum_(avail));

  var now = nowParts_();
  appendRow_('transfers_out', {
    id: genId_(), date: now.date, time: now.time,
    sku_id: String(sku.sku_id),
    boxes_transferred: boxes,
    logged_by_telegram_id: String(tid),
    notes: String(body.notes || ''),
    created_at: now.iso
  });
  refreshFinishedStock_();
  return ok_({ transferred: true, remaining_boxes: avail - boxes });
}

// ───────────────────────── Management (CRUD) ─────────────────────────
function action_manage_users_(tid, body) {
  requireRole_(tid, 2);
  var op = String(body.op || 'list');
  var p = body.payload || {};

  if (op === 'list') {
    return ok_({ users: getRows_('users').rows.map(function (r) {
      return { telegram_id: String(r.telegram_id), name: String(r.name),
               role: String(r.role), active: toBool_(r.active) };
    }) });
  }
  if (op === 'add') {
    var newId = String(p.telegram_id || '').trim();
    if (!/^\d+$/.test(newId)) return err_('Telegram ID должен быть числом.');
    if (!ROLE_RANK.hasOwnProperty(p.role)) return err_('Некорректная роль.');
    if (findUser_(newId)) return err_('Пользователь с таким ID уже существует.');
    appendRow_('users', { telegram_id: newId, name: String(p.name || ''),
                          role: String(p.role), active: true, created_at: nowParts_().iso });
    return ok_({ added: true });
  }
  if (op === 'update') {
    var upd = {};
    if (p.name != null) upd.name = String(p.name);
    if (p.role != null) { if (!ROLE_RANK.hasOwnProperty(p.role)) return err_('Некорректная роль.'); upd.role = String(p.role); }
    if (p.active != null) upd.active = toBool_(p.active);
    var found = updateRow_('users', 'telegram_id', String(p.telegram_id), upd);
    return found ? ok_({ updated: true }) : err_('Пользователь не найден.');
  }
  if (op === 'deactivate') {
    if (String(p.telegram_id) === OWNER_ID) return err_('Нельзя отключить владельца.');
    var ok = updateRow_('users', 'telegram_id', String(p.telegram_id), { active: false });
    return ok ? ok_({ deactivated: true }) : err_('Пользователь не найден.');
  }
  return err_('Неизвестная операция.');
}

function action_manage_materials_(tid, body) {
  requireRole_(tid, 2);
  var op = String(body.op || 'list');
  var p = body.payload || {};

  if (op === 'list') return ok_({ materials: getMaterials_(true) });

  if (op === 'add') {
    if (!p.name) return err_('Укажите название материала.');
    var unit = String(p.unit || 'кг');
    var opts = normaliseUnitOptions_(p.unit_options, unit, p.input_units);
    appendRow_('raw_materials', {
      material_id: genId_(), name: String(p.name), unit: unit,
      input_units: String(p.input_units || opts.map(function (o) { return o.label; }).join(', ')),
      unit_options: JSON.stringify(opts),
      category: String(p.category || 'seasoning'),
      active: true,
      low_stock_threshold: toNum_(p.low_stock_threshold),
      created_at: nowParts_().iso
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
    if (p.unit_options != null) {
      var optsU = normaliseUnitOptions_(p.unit_options, upd.unit || (findMaterial_(p.material_id) || {}).unit || 'кг', p.input_units);
      upd.unit_options = JSON.stringify(optsU);
      upd.input_units = String(p.input_units || optsU.map(function (o) { return o.label; }).join(', '));
    }
    var f = updateRow_('raw_materials', 'material_id', String(p.material_id), upd);
    return f ? ok_({ updated: true }) : err_('Материал не найден.');
  }
  if (op === 'delete') {
    var d = updateRow_('raw_materials', 'material_id', String(p.material_id), { active: false });
    return d ? ok_({ deleted: true }) : err_('Материал не найден.');
  }
  return err_('Неизвестная операция.');
}

function action_manage_skus_(tid, body) {
  requireRole_(tid, 2);
  var op = String(body.op || 'list');
  var p = body.payload || {};

  if (op === 'list') return ok_({ skus: getSkus_(true) });

  if (op === 'add') {
    if (!p.name) return err_('Укажите название продукта.');
    appendRow_('finished_products', {
      sku_id: genId_(), name: String(p.name),
      flavour: String(p.flavour || ''),
      weight_g: toNum_(p.weight_g),
      packs_per_box: toNum_(p.packs_per_box) || 1,
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
    var f = updateRow_('finished_products', 'sku_id', String(p.sku_id), upd);
    return f ? ok_({ updated: true }) : err_('Продукт не найден.');
  }
  if (op === 'delete') {
    var d = updateRow_('finished_products', 'sku_id', String(p.sku_id), { active: false });
    return d ? ok_({ deleted: true }) : err_('Продукт не найден.');
  }
  return err_('Неизвестная операция.');
}

// ───────────────────────── Domain reads ─────────────────────────
function getMaterials_(includeInactive) {
  return getRows_('raw_materials').rows
    .filter(function (r) { return includeInactive || toBool_(r.active); })
    .map(function (r) {
      return {
        material_id: String(r.material_id), name: String(r.name), unit: String(r.unit),
        input_units: String(r.input_units || ''),
        unit_options: parseUnitOptions_(r),
        category: String(r.category || ''), active: toBool_(r.active),
        low_stock_threshold: toNum_(r.low_stock_threshold)
      };
    });
}

function getSkus_(includeInactive) {
  return getRows_('finished_products').rows
    .filter(function (r) { return includeInactive || toBool_(r.active); })
    .map(function (r) {
      return {
        sku_id: String(r.sku_id), name: String(r.name), flavour: String(r.flavour || ''),
        weight_g: toNum_(r.weight_g), packs_per_box: toNum_(r.packs_per_box) || 1,
        active: toBool_(r.active)
      };
    });
}

// Aggregated maps used by stock / cost calculations.
function sumByMaterial_(tab, col) {
  var out = {};
  getRows_(tab).rows.forEach(function (r) {
    var k = String(r.material_id);
    out[k] = (out[k] || 0) + toNum_(r[col]);
  });
  return out;
}

function wacMap_() {
  // WAC = Σ(confirmed total_sum_uzs) / Σ(confirmed quantity_base), per material.
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
    return {
      material_id: m.material_id, name: m.name, unit: m.unit, category: m.category,
      low_stock_threshold: m.low_stock_threshold,
      current_stock: round_(cur)
    };
  });
}

function getStock_(withPrices) {
  var rows = materialStockRows_();
  var wac = withPrices ? wacMap_() : null;
  var raw = rows.map(function (r) {
    var o = {
      material_id: r.material_id, name: r.name, unit: r.unit, category: r.category,
      current_stock: r.current_stock, low_stock_threshold: r.low_stock_threshold,
      health: healthColor_(r.current_stock, r.low_stock_threshold)
    };
    if (withPrices) {
      var w = wac[r.material_id] || 0;
      o.wac_price = round_(w);
      o.total_value = round_(r.current_stock * w);
    }
    return o;
  });

  var finished = finishedGoodsList_(withPrices);
  return { raw_materials: raw, finished_goods: finished, with_prices: !!withPrices };
}

function finishedGoodsList_(withPrices) {
  var prod = {}, trans = {};
  getRows_('production').rows.forEach(function (r) {
    var k = String(r.sku_id); prod[k] = (prod[k] || 0) + toNum_(r.boxes_produced);
  });
  getRows_('transfers_out').rows.forEach(function (r) {
    var k = String(r.sku_id); trans[k] = (trans[k] || 0) + toNum_(r.boxes_transferred);
  });
  var costBySku = withPrices ? latestCostBySku_() : null;

  return getSkus_().map(function (s) {
    var boxes = (prod[s.sku_id] || 0) - (trans[s.sku_id] || 0);
    var o = {
      sku_id: s.sku_id, name: s.name, flavour: s.flavour, weight_g: s.weight_g,
      packs_per_box: s.packs_per_box,
      boxes_in_stock: round_(boxes),
      packs_in_stock: round_(boxes * s.packs_per_box)
    };
    if (withPrices) {
      var c = costBySku[s.sku_id] || { cost_per_box: 0 };
      o.cost_per_box = round_(c.cost_per_box || 0);
      o.total_value = round_(boxes * (c.cost_per_box || 0));
    }
    return o;
  });
}

function finishedBoxes_(skuId) {
  var p = 0, t = 0;
  getRows_('production').rows.forEach(function (r) { if (String(r.sku_id) === skuId) p += toNum_(r.boxes_produced); });
  getRows_('transfers_out').rows.forEach(function (r) { if (String(r.sku_id) === skuId) t += toNum_(r.boxes_transferred); });
  return p - t;
}

function latestCostBySku_() {
  var out = {};
  getRows_('cost_log').rows.forEach(function (r) {
    var k = String(r.sku_id);
    var d = String(r.date);
    if (!out[k] || d >= out[k]._date) {
      out[k] = { _date: d, cost_per_box: toNum_(r.cost_per_box_uzs), cost_per_pack: toNum_(r.cost_per_pack_uzs) };
    }
  });
  return out;
}

function computeAlerts_() {
  return materialStockRows_()
    .filter(function (r) { return r.low_stock_threshold > 0 && r.current_stock < r.low_stock_threshold; })
    .map(function (r) {
      return { material_id: r.material_id, name: r.name, unit: r.unit,
               current_stock: r.current_stock, threshold: r.low_stock_threshold };
    });
}

function healthColor_(current, threshold) {
  if (!(threshold > 0)) return 'green'; // alerts disabled for this material
  var ratio = current / threshold;
  if (ratio >= 0.5) return 'green';
  if (ratio >= 0.2) return 'amber';
  return 'red';
}

function countPending_() {
  var n = 0;
  getRows_('purchases').rows.forEach(function (r) { if (!toBool_(r.price_confirmed)) n++; });
  return n;
}

function getTodayProduction_() {
  var today = nowParts_().date;
  var byS = {};
  getRows_('production').rows.forEach(function (r) {
    if (String(r.date) === today) {
      var k = String(r.sku_id);
      byS[k] = (byS[k] || 0) + toNum_(r.boxes_produced);
    }
  });
  var names = skuNameMap_();
  return Object.keys(byS).map(function (k) {
    return { sku_id: k, name: names[k] || k, boxes: round_(byS[k]) };
  });
}

function getRecentMixed_(limit, rank) {
  var items = [];
  var matNames = materialNameMap_(), skuNames = skuNameMap_();

  getRows_('production').rows.forEach(function (r) {
    items.push({ type: 'production', ts: String(r.created_at || (r.date + ' ' + r.time)),
                 date: String(r.date), time: String(r.time),
                 title: skuNames[String(r.sku_id)] || String(r.sku_id),
                 detail: fmtNum_(toNum_(r.boxes_produced)) + ' кор.' });
  });
  if (rank >= 1) {
    getRows_('purchases').rows.forEach(function (r) {
      items.push({ type: 'purchase', ts: String(r.created_at || (r.date + ' ' + r.time)),
                   date: String(r.date), time: String(r.time),
                   title: matNames[String(r.material_id)] || String(r.material_id),
                   detail: fmtNum_(toNum_(r.quantity_input)) + ' ' + String(r.unit_input || '') });
    });
    getRows_('consumption').rows.forEach(function (r) {
      items.push({ type: 'consumption', ts: String(r.created_at || (r.date + ' ' + r.time)),
                   date: String(r.date), time: String(r.time),
                   title: matNames[String(r.material_id)] || String(r.material_id),
                   detail: '−' + fmtNum_(toNum_(r.quantity_base)) + ' ' + String(r.unit_base || '') });
    });
  }
  items.sort(function (a, b) { return a.ts < b.ts ? 1 : (a.ts > b.ts ? -1 : 0); });
  return items.slice(0, limit);
}

function getLogs_(type, limit) {
  var matNames = materialNameMap_(), skuNames = skuNameMap_();
  var rows, mapper;

  if (type === 'purchases') {
    rows = getRows_('purchases').rows;
    mapper = function (r) {
      return { id: String(r.id), date: String(r.date), time: String(r.time),
               material: matNames[String(r.material_id)] || String(r.material_id),
               quantity_input: toNum_(r.quantity_input), unit_input: String(r.unit_input || ''),
               quantity_base: toNum_(r.quantity_base), unit_base: String(r.unit_base || ''),
               total_sum_uzs: toNum_(r.total_sum_uzs), supplier: String(r.supplier || ''),
               price_confirmed: toBool_(r.price_confirmed) };
    };
  } else if (type === 'consumption') {
    rows = getRows_('consumption').rows;
    mapper = function (r) {
      return { id: String(r.id), date: String(r.date), time: String(r.time),
               material: matNames[String(r.material_id)] || String(r.material_id),
               quantity_base: toNum_(r.quantity_base), unit_base: String(r.unit_base || ''),
               for_sku: skuNames[String(r.for_sku_id)] || '', notes: String(r.notes || '') };
    };
  } else {
    rows = getRows_('production').rows;
    mapper = function (r) {
      return { id: String(r.id), date: String(r.date), time: String(r.time),
               sku: skuNames[String(r.sku_id)] || String(r.sku_id),
               boxes_produced: toNum_(r.boxes_produced), packs_produced: toNum_(r.packs_produced) };
    };
  }

  var out = rows.map(function (r) { return { _ts: String(r.created_at || (r.date + ' ' + r.time)), v: mapper(r) }; });
  out.sort(function (a, b) { return a._ts < b._ts ? 1 : (a._ts > b._ts ? -1 : 0); });
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
  rows.sort(function (a, b) { return a._ts < b._ts ? 1 : (a._ts > b._ts ? -1 : 0); });
  return rows.slice(0, 100).map(function (x) { return x.v; });
}

// ───────────────────────── Cost & stock recompute ─────────────────────────
function recomputeCost_(skuId, dateStr) {
  var sku = findSku_(skuId);
  if (!sku) return null;
  var ppb = toNum_(sku.packs_per_box) || 1;
  var wac = wacMap_();

  // Consumption for this SKU on this date, summed per material.
  var perMat = {};
  getRows_('consumption').rows.forEach(function (r) {
    if (String(r.for_sku_id) === String(skuId) && String(r.date) === String(dateStr)) {
      var k = String(r.material_id);
      perMat[k] = (perMat[k] || 0) + toNum_(r.quantity_base);
    }
  });
  var totalCost = 0;
  Object.keys(perMat).forEach(function (k) { totalCost += perMat[k] * (wac[k] || 0); });

  // Production for this SKU on this date.
  var boxes = 0, packs = 0;
  getRows_('production').rows.forEach(function (r) {
    if (String(r.sku_id) === String(skuId) && String(r.date) === String(dateStr)) {
      boxes += toNum_(r.boxes_produced);
      packs += toNum_(r.packs_produced);
    }
  });
  if (packs === 0) packs = boxes * ppb;

  var costPerPack = packs > 0 ? totalCost / packs : 0;
  var costPerBox  = boxes > 0 ? totalCost / boxes : 0;

  var record = {
    date: String(dateStr), sku_id: String(skuId), period: 'daily',
    total_material_cost_uzs: round_(totalCost), packs_produced: round_(packs),
    cost_per_pack_uzs: round_(costPerPack), cost_per_box_uzs: round_(costPerBox)
  };

  // Upsert the single daily row for (sku, date).
  var existing = findCostRow_(skuId, dateStr);
  if (existing) {
    updateRow_('cost_log', 'id', String(existing.id), {
      total_material_cost_uzs: record.total_material_cost_uzs,
      packs_produced: record.packs_produced,
      cost_per_pack_uzs: record.cost_per_pack_uzs,
      cost_per_box_uzs: record.cost_per_box_uzs
    });
  } else {
    record.id = genId_();
    record.created_at = nowParts_().iso;
    appendRow_('cost_log', record);
  }
  return record;
}

function findCostRow_(skuId, dateStr) {
  var rows = getRows_('cost_log').rows;
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].sku_id) === String(skuId) &&
        String(rows[i].date) === String(dateStr) &&
        String(rows[i].period) === 'daily') return rows[i];
  }
  return null;
}

function refreshFinishedStock_() {
  var prod = {}, trans = {};
  getRows_('production').rows.forEach(function (r) {
    var k = String(r.sku_id); prod[k] = (prod[k] || 0) + toNum_(r.boxes_produced);
  });
  getRows_('transfers_out').rows.forEach(function (r) {
    var k = String(r.sku_id); trans[k] = (trans[k] || 0) + toNum_(r.boxes_transferred);
  });
  var sheet = getSheet_('finished_goods_stock');
  var iso = nowParts_().iso;
  var data = [SCHEMA.finished_goods_stock];
  getSkus_(true).forEach(function (s) {
    var boxes = (prod[s.sku_id] || 0) - (trans[s.sku_id] || 0);
    data.push([s.sku_id, round_(boxes), round_(boxes * s.packs_per_box), iso]);
  });
  sheet.clearContents();
  sheet.getRange(1, 1, data.length, SCHEMA.finished_goods_stock.length).setValues(data);
}

// ───────────────────────── Lookups ─────────────────────────
function findMaterial_(id) {
  if (!id) return null;
  var rows = getRows_('raw_materials').rows;
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].material_id) === String(id)) {
      return { material_id: String(rows[i].material_id), name: String(rows[i].name),
               unit: String(rows[i].unit), unit_options: parseUnitOptions_(rows[i]) };
    }
  }
  return null;
}

function findSku_(id) {
  if (!id) return null;
  var rows = getRows_('finished_products').rows;
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].sku_id) === String(id)) {
      return { sku_id: String(rows[i].sku_id), name: String(rows[i].name),
               packs_per_box: toNum_(rows[i].packs_per_box) || 1 };
    }
  }
  return null;
}

function materialNameMap_() {
  var m = {};
  getRows_('raw_materials').rows.forEach(function (r) { m[String(r.material_id)] = String(r.name); });
  return m;
}
function skuNameMap_() {
  var m = {};
  getRows_('finished_products').rows.forEach(function (r) { m[String(r.sku_id)] = String(r.name); });
  return m;
}

function parseUnitOptions_(r) {
  var raw = r.unit_options;
  if (raw) {
    try {
      var arr = (typeof raw === 'string') ? JSON.parse(raw) : raw;
      if (arr && arr.length) {
        return arr.map(function (o) { return { label: String(o.label), factor: toNum_(o.factor) || 1 }; });
      }
    } catch (e) {}
  }
  return [{ label: String(r.unit || 'ед.'), factor: 1 }];
}

function unitFactor_(material, label) {
  var opts = material.unit_options || [{ label: material.unit, factor: 1 }];
  for (var i = 0; i < opts.length; i++) {
    if (String(opts[i].label) === String(label)) return toNum_(opts[i].factor) || 1;
  }
  return 1;
}

function normaliseUnitOptions_(unitOptions, baseUnit, inputUnitsText) {
  // Accept an explicit array, otherwise fall back to "label:factor, label:factor" text or the base unit.
  if (unitOptions && unitOptions.length) {
    return unitOptions.map(function (o) { return { label: String(o.label), factor: toNum_(o.factor) || 1 }; });
  }
  if (inputUnitsText) {
    var parts = String(inputUnitsText).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    if (parts.length) {
      return parts.map(function (p) {
        var bits = p.split(':');
        return { label: bits[0].trim(), factor: bits[1] ? (toNum_(bits[1]) || 1) : 1 };
      });
    }
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
  var s = getSheet_(name);
  var values = s.getDataRange().getValues();
  if (values.length < 2) return { headers: values[0] || SCHEMA[name] || [], rows: [] };
  var headers = values[0];
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    if (values[i].join('') === '') continue; // skip blank rows
    var o = { _row: i + 1 };
    for (var j = 0; j < headers.length; j++) o[headers[j]] = values[i][j];
    rows.push(o);
  }
  return { headers: headers, rows: rows };
}

function appendRow_(name, obj) {
  var s = getSheet_(name);
  var headers = s.getRange(1, 1, 1, s.getLastColumn()).getValues()[0];
  var row = headers.map(function (h) { return obj.hasOwnProperty(h) ? obj[h] : ''; });
  s.appendRow(row);
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
      Object.keys(updates).forEach(function (k) {
        var cj = headers.indexOf(k);
        if (cj >= 0) s.getRange(rowNum, cj + 1).setValue(updates[k]);
      });
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

  // Seed the owner if missing.
  if (!findUser_(OWNER_ID)) {
    appendRow_('users', {
      telegram_id: OWNER_ID, name: OWNER_NAME, role: 'owner',
      active: true, created_at: nowParts_().iso
    });
  }

  // Remove the default "Sheet1"/"Лист1" if it's still empty.
  ['Sheet1', 'Лист1'].forEach(function (n) {
    var sh = ss.getSheetByName(n);
    if (sh && TAB_ORDER.indexOf(n) < 0 && ss.getSheets().length > 1) {
      try { ss.deleteSheet(sh); } catch (e) {}
    }
  });

  return 'Готово: создано ' + TAB_ORDER.length + ' листов, владелец засеян.';
}

// ───────────────────────── Small utils ─────────────────────────
function toNum_(v) {
  if (v === '' || v == null) return 0;
  if (typeof v === 'number') return v;
  var n = parseFloat(String(v).replace(/\s/g, '').replace(',', '.'));
  return isNaN(n) ? 0 : n;
}

function toBool_(v) {
  return v === true || String(v).toLowerCase() === 'true' || String(v) === '1';
}

function round_(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function fmtNum_(n) {
  var x = round_(n);
  return String(x).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

function genId_() {
  return Utilities.getUuid().replace(/-/g, '').substring(0, 12);
}

function nowParts_() {
  var tz = Session.getScriptTimeZone() || 'Asia/Tashkent';
  var d = new Date();
  return {
    date: Utilities.formatDate(d, tz, 'yyyy-MM-dd'),
    time: Utilities.formatDate(d, tz, 'HH:mm'),
    iso: Utilities.formatDate(d, tz, "yyyy-MM-dd'T'HH:mm:ss")
  };
}
