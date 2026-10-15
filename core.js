/*
 * CRM ЮАО — ядро.
 * Одна и та же логика работает в двух местах:
 *   1) на сервере (Google Apps Script, хранилище — Google Таблица);
 *   2) в браузере в демо-режиме (хранилище — localStorage).
 * Хранилище подставляется снаружи (объект store), см. gas.js и app.js.
 */
var CRM = (function () {
  'use strict';

  var VERSION = 1;

  var SCHEMA = {
    Users: ['id', 'login', 'name', 'role', 'zone', 'okrug', 'phone', 'active', 'salt', 'hash', 'created', 'lastLogin'],
    Sessions: ['token', 'userId', 'expires'],
    Okrugs: ['id', 'district', 'name', 'zone', 'mandates', 'voters', 'note'],
    Candidates: ['id', 'okrug', 'fio', 'description', 'budget', 'phone', 'status', 'hasPhoto', 'created', 'createdBy', 'updated'],
    Photos: ['id', 'data'],
    Events: ['id', 'okrug', 'type', 'date', 'title', 'address', 'contacts', 'status', 'notes', 'created', 'createdBy', 'updated'],
    Kmb: ['id', 'okrug', 'fio', 'phone', 'address', 'source', 'eventId', 'consent', 'tags', 'comment', 'date', 'created', 'createdBy'],
    Media: ['id', 'okrug', 'kind', 'network', 'title', 'url', 'subscribers', 'candidateId', 'owner', 'status', 'started', 'notes', 'created', 'createdBy', 'updated'],
    Interviews: ['id', 'okrug', 'fio', 'phone', 'date', 'time', 'place', 'interviewer', 'attended', 'verdict', 'comment', 'candidateId', 'created', 'createdBy', 'updated'],
    Plan: ['month', 'meetings', 'actions', 'kmb'],
    Log: ['ts', 'user', 'action', 'details'],
    // Лист для руководителя: открытые логины и пароли, которые он выдал. Сайт его никому не отдаёт.
    'Логины и пароли': ['Логин', 'Пароль', 'Имя', 'Роль', 'Зона или округ', 'Телефон', 'Доступ', 'Изменено', 'id']
  };
  var CRED = 'Логины и пароли';

  var ROLES = { admin: 'Руководитель', coord: 'Координатор', intern: 'Стажёр', member: 'Участник команды' };

  var ZONES = {
    K1: 'Север', K2: 'Нагатино', K3: 'Центр', K4: 'Чертаново',
    K5: 'Бирюлёво', K6: 'Царицыно', K7: 'Орехово', K8: 'Юго-восток'
  };

  // Из презентации «Новые люди · ЮАО 2027», слайды 3, 8, 9
  var DISTRICTS = [
    ['danilovsky', 'Даниловский', 3, 4, 64800, 'K1'],
    ['donskoy', 'Донской', 2, 5, 31000, 'K1'],
    ['nag-sad', 'Нагатино-Садовники', 2, 5, 45400, 'K2'],
    ['nag-zaton', 'Нагатинский Затон', 2, 5, 74400, 'K2'],
    ['moskvorechye', 'Москворечье-Сабурово', 2, 5, 46000, 'K3'],
    ['nagorny', 'Нагорный', 2, 5, 47600, 'K3'],
    ['chert-sev', 'Чертаново Северное', 2, 5, 64437, 'K4'],
    ['chert-cen', 'Чертаново Центральное', 2, 5, 66600, 'K4'],
    ['chert-yuz', 'Чертаново Южное', 2, 5, 91293, 'K4'],
    ['bir-zap', 'Бирюлёво Западное', 2, 5, 52400, 'K5'],
    ['bir-vos', 'Бирюлёво Восточное', 2, 5, 91800, 'K5'],
    ['tsaritsyno', 'Царицыно', 2, 5, 75600, 'K6'],
    ['ob-sev', 'Орехово-Борисово Северное', 2, 5, 75800, 'K7'],
    ['ob-yuz', 'Орехово-Борисово Южное', 2, 5, 87600, 'K7'],
    ['brateevo', 'Братеево', 2, 5, 63400, 'K8'],
    ['zyablikovo', 'Зябликово', 2, 5, 78800, 'K8']
  ];

  // Число избирателей по схемам округов 2017/2022 (решения советов депутатов)
  var SCHEME_VOTERS = {
    'danilovsky-1': 18195, 'danilovsky-2': 18571, 'danilovsky-3': 17774, 'donskoy-1': 13515, 'donskoy-2': 13631,
    'nag-sad-1': 22939, 'nag-sad-2': 23210, 'nag-zaton-1': 33552, 'nag-zaton-2': 32843, 'moskvorechye-1': 22019, 'moskvorechye-2': 22730,
    'nagorny-1': 22462, 'nagorny-2': 23068, 'chert-sev-1': 32539, 'chert-sev-2': 31898, 'chert-cen-1': 33805, 'chert-cen-2': 34289,
    'chert-yuz-1': 46456, 'chert-yuz-2': 44837, 'bir-zap-1': 26077, 'bir-zap-2': 25333, 'bir-vos-1': 45991, 'bir-vos-2': 44499,
    'tsaritsyno-1': 36744, 'tsaritsyno-2': 35944, 'ob-sev-1': 35295, 'ob-sev-2': 35614, 'ob-yuz-1': 43603, 'ob-yuz-2': 43085,
    'brateevo-1': 30554, 'brateevo-2': 30928, 'zyablikovo-1': 36145, 'zyablikovo-2': 36467
  };

  function defaultOkrugs() {
    var out = [];
    DISTRICTS.forEach(function (d) {
      for (var i = 1; i <= d[2]; i++) {
        out.push({ id: d[0] + '-' + i, district: d[1], name: d[1] + ' №' + i, zone: d[5], mandates: d[3], voters: SCHEME_VOTERS[d[0] + '-' + i] || Math.round(d[4] / d[2]), note: '' });
      }
    });
    return out;
  }

  // KPI на один округ в месяц (слайд 6). Сентябрь — половина месяца до ЕДГ.
  function defaultPlan() {
    var p = [['2026-11', 2, 2, 50]];
    ['2026-12', '2027-01', '2027-02'].forEach(function (m) { p.push([m, 3, 2, 65]); });
    ['2027-03', '2027-04', '2027-05'].forEach(function (m) { p.push([m, 4, 4, 100]); });
    ['2027-06', '2027-07', '2027-08'].forEach(function (m) { p.push([m, 8, 8, 200]); });
    p.push(['2027-09', 4, 4, 100]);
    return p.map(function (r) { return { month: r[0], meetings: r[1], actions: r[2], kmb: r[3] }; });
  }

  // Вехи кампании (слайды 2 и 13): команда до 30.11, полные списки кандидатов к 01.02, ЕДГ в сентябре
  var CAMPAIGN = { start: '2026-10-01', team: '2026-11-30', cand: '2027-02-01', end: '2027-09-30', coordinators: 8 };

  // Медиа (слайд 12): 162 канала кандидатов по 300 подписчиков, 16 групп районов по 1000
  var MEDIA_KINDS = { candidate: 'Канал кандидата', okrug: 'Канал округа', district: 'Группа района', other: 'Другое' };
  var NETWORKS = ['Telegram', 'ВКонтакте', 'MAX', 'WhatsApp', 'Одноклассники', 'Дзен', 'YouTube', 'Rutube', 'Instagram', 'TikTok', 'Другое'];
  var MEDIA_PLAN = { candidate: { count: 162, subs: 300 }, district: { count: 16, subs: 1000 }, start: '2027-02-01' };

  var CAND_STATUSES = ['Найден', 'Согласован', 'Документы собраны', 'Выдвинут', 'Зарегистрирован', 'Отказ'];
  var EVENT_TYPES = { meet: 'Встреча', act: 'Акция', other: 'Другое' };

  /* ---------- SHA-256 (без внешних зависимостей, синхронно) ---------- */
  var K = [], H0 = [];
  (function () {
    var n = 2, c = 0;
    while (c < 64) {
      var prime = true;
      for (var d = 2; d * d <= n; d++) if (n % d === 0) { prime = false; break; }
      if (prime) {
        if (c < 8) H0[c] = (Math.pow(n, 1 / 2) % 1) * 4294967296 | 0;
        K[c] = (Math.pow(n, 1 / 3) % 1) * 4294967296 | 0;
        c++;
      }
      n++;
    }
  })();

  function sha256(str) {
    var s = unescape(encodeURIComponent(str)), b = [], i, j;
    for (i = 0; i < s.length; i++) b.push(s.charCodeAt(i));
    var bitLen = b.length * 8;
    b.push(0x80);
    while (b.length % 64 !== 56) b.push(0);
    b.push(0, 0, 0, 0, (bitLen >>> 24) & 255, (bitLen >>> 16) & 255, (bitLen >>> 8) & 255, bitLen & 255);
    var h = H0.slice(), w = new Array(64);
    function rr(v, a) { return (v >>> a) | (v << (32 - a)); }
    for (i = 0; i < b.length; i += 64) {
      for (j = 0; j < 16; j++) w[j] = (b[i + j * 4] << 24) | (b[i + j * 4 + 1] << 16) | (b[i + j * 4 + 2] << 8) | b[i + j * 4 + 3];
      for (j = 16; j < 64; j++) {
        var s0 = rr(w[j - 15], 7) ^ rr(w[j - 15], 18) ^ (w[j - 15] >>> 3);
        var s1 = rr(w[j - 2], 17) ^ rr(w[j - 2], 19) ^ (w[j - 2] >>> 10);
        w[j] = (w[j - 16] + s0 + w[j - 7] + s1) | 0;
      }
      var a = h[0], bb = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
      for (j = 0; j < 64; j++) {
        var t1 = (hh + (rr(e, 6) ^ rr(e, 11) ^ rr(e, 25)) + ((e & f) ^ (~e & g)) + K[j] + w[j]) | 0;
        var t2 = ((rr(a, 2) ^ rr(a, 13) ^ rr(a, 22)) + ((a & bb) ^ (a & c) ^ (bb & c))) | 0;
        hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = bb; bb = a; a = (t1 + t2) | 0;
      }
      h[0] = (h[0] + a) | 0; h[1] = (h[1] + bb) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
      h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
    }
    return h.map(function (x) { return ('00000000' + (x >>> 0).toString(16)).slice(-8); }).join('');
  }

  function hashPassword(salt, password) {
    var h = salt + ':' + password;
    for (var i = 0; i < 400; i++) h = sha256(h + ':' + salt);
    return h;
  }

  /* ---------- утилиты ---------- */
  function nowMsk() { return new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 19); }
  function fail(message, code) { var e = new Error(message); e.code = code || 'ERR'; return e; }
  function str(v) { return v == null ? '' : String(v).trim(); }
  function num(v) { var n = Number(String(v == null ? '' : v).replace(/\s/g, '').replace(',', '.')); return isFinite(n) ? n : 0; }
  function phoneKey(p) { var d = str(p).replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : d; }
  function truthy(v) { return v === true || v === 1 || v === '1' || v === 'TRUE' || v === 'true'; }
  function pick(obj, fields) { var o = {}; fields.forEach(function (f) { o[f] = obj[f] == null ? '' : obj[f]; }); return o; }

  function publicUser(u, full) {
    var o = { id: u.id, name: u.name, role: u.role, zone: u.zone, okrug: u.okrug, phone: u.phone, active: truthy(u.active) };
    if (full) { o.login = u.login; o.created = u.created; o.lastLogin = u.lastLogin; }
    return o;
  }

  function seed(S) {
    if (!S.rows('Okrugs').length) S.insertMany('Okrugs', defaultOkrugs());
    if (!S.rows('Plan').length) S.insertMany('Plan', defaultPlan());
  }

  function okrugMap(S) { var m = {}; S.rows('Okrugs').forEach(function (o) { m[o.id] = o; }); return m; }

  // Какие округа видит и редактирует пользователь
  function scope(S, me) {
    var all = S.rows('Okrugs');
    if (me.role === 'admin') return all.map(function (o) { return o.id; });
    if (me.role === 'coord') return all.filter(function (o) { return o.zone === me.zone; }).map(function (o) { return o.id; });
    return me.okrug ? [me.okrug] : [];
  }
  function inScope(S, me, okrug) { return scope(S, me).indexOf(okrug) >= 0; }

  function log(S, me, action, details) {
    S.insert('Log', { ts: nowMsk(), user: me ? me.login : '', action: action, details: str(details).slice(0, 500) });
  }

  /* ---------- вход ---------- */
  function login(S, req) {
    var lg = str(req.login).toLowerCase(), pw = String(req.password || '');
    var u = S.rows('Users').filter(function (x) { return str(x.login).toLowerCase() === lg; })[0];
    if (!u || !truthy(u.active) || hashPassword(u.salt, pw) !== u.hash) throw fail('Неверный логин или пароль', 'LOGIN');
    var now = Date.now();
    S.removeWhere('Sessions', function (s) { return Number(s.expires) < now; });
    var token = S.uuid() + S.uuid().replace(/-/g, '');
    S.insert('Sessions', { token: token, userId: u.id, expires: now + 30 * 24 * 3600 * 1000 });
    u.lastLogin = nowMsk();
    S.update('Users', u);
    log(S, u, 'login', '');
    return { token: token, me: publicUser(u, true) };
  }

  function auth(S, token) {
    if (!token) return null;
    var s = S.rows('Sessions').filter(function (x) { return x.token === token; })[0];
    if (!s || Number(s.expires) < Date.now()) return null;
    var u = S.rows('Users').filter(function (x) { return x.id === s.userId; })[0];
    if (!u || !truthy(u.active)) return null;
    return u;
  }

  /* ---------- сводная статистика по всем округам (только числа) ---------- */
  function stats(S) {
    var st = {};
    S.rows('Okrugs').forEach(function (o) { st[o.id] = { cand: 0, candD: [], ev: {}, kmb: {} }; });
    S.rows('Candidates').forEach(function (c) { if (st[c.okrug] && c.status !== 'Отказ') { st[c.okrug].cand++; st[c.okrug].candD.push(str(c.created).slice(0, 10)); } });
    S.rows('Events').forEach(function (e) {
      if (!st[e.okrug] || e.status !== 'done') return;
      var m = str(e.date).slice(0, 7), ev = st[e.okrug].ev;
      ev[m] = ev[m] || [0, 0, 0, 0]; // встречи, акции, другое, контакты на мероприятиях
      ev[m][e.type === 'meet' ? 0 : e.type === 'act' ? 1 : 2]++;
      ev[m][3] += num(e.contacts);
    });
    S.rows('Kmb').forEach(function (k) {
      if (!st[k.okrug]) return;
      var m = str(k.date).slice(0, 7);
      st[k.okrug].kmb[m] = (st[k.okrug].kmb[m] || 0) + 1;
    });
    return st;
  }

  /* ---------- проверка и сохранение записей ---------- */
  var ENTITIES = {
    candidates: { sheet: 'Candidates', fields: ['okrug', 'fio', 'description', 'budget', 'phone', 'status'] },
    events: { sheet: 'Events', fields: ['okrug', 'type', 'date', 'title', 'address', 'contacts', 'status', 'notes'] },
    kmb: { sheet: 'Kmb', fields: ['okrug', 'fio', 'phone', 'address', 'source', 'eventId', 'consent', 'tags', 'comment', 'date'] },
    media: { sheet: 'Media', fields: ['okrug', 'kind', 'network', 'title', 'url', 'subscribers', 'candidateId', 'owner', 'status', 'started', 'notes'] },
    interviews: { sheet: 'Interviews', fields: ['okrug', 'fio', 'phone', 'date', 'time', 'place', 'interviewer', 'attended', 'verdict', 'comment', 'candidateId'] }
  };

  function canWrite(S, me, entity, okrug) {
    if (!inScope(S, me, okrug)) return false;
    if ((entity === 'candidates' || entity === 'interviews') && me.role === 'member') return false;
    return true;
  }

  function clean(S, entity, item) {
    var def = ENTITIES[entity], o = {};
    def.fields.forEach(function (f) { o[f] = str(item[f]); });
    if (!okrugMap(S)[o.okrug]) throw fail('Не выбран избирательный округ');
    if (entity === 'candidates') {
      if (!o.fio) throw fail('Укажите ФИО кандидата');
      o.budget = o.budget ? String(num(o.budget)) : '';
      if (CAND_STATUSES.indexOf(o.status) < 0) o.status = CAND_STATUSES[0];
    }
    if (entity === 'events') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(o.date)) throw fail('Укажите дату мероприятия');
      if (!EVENT_TYPES[o.type]) o.type = 'meet';
      if (o.status !== 'done') o.status = 'planned';
      o.contacts = o.contacts ? String(Math.max(0, Math.round(num(o.contacts)))) : '';
    }
    if (entity === 'media') {
      if (!MEDIA_KINDS[o.kind]) o.kind = 'candidate';
      if (NETWORKS.indexOf(o.network) < 0) o.network = 'Другое';
      if (!o.title && !o.url) throw fail('Укажите название или ссылку на канал');
      o.subscribers = o.subscribers ? String(Math.max(0, Math.round(num(o.subscribers)))) : '';
      if (['plan', 'active', 'stopped'].indexOf(o.status) < 0) o.status = 'active';
      if (o.kind !== 'candidate') o.candidateId = '';
    }
    if (entity === 'interviews') {
      if (!o.fio) throw fail('Укажите ФИО');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(o.date)) throw fail('Укажите дату встречи');
      if (['', 'yes', 'no'].indexOf(o.attended) < 0) o.attended = '';
      if (['', 'pass', 'fail'].indexOf(o.verdict) < 0) o.verdict = '';
      if (o.attended !== 'yes') o.verdict = '';
    }
    if (entity === 'kmb') {
      if (!o.fio && !o.phone) throw fail('Нужно ФИО или телефон');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(o.date)) o.date = nowMsk().slice(0, 10);
      o.consent = truthy(item.consent) ? '1' : '';
    }
    return o;
  }

  function findKmbDuplicate(S, phone, exceptId) {
    var key = phoneKey(phone);
    if (key.length < 10) return null;
    return S.rows('Kmb').filter(function (k) { return k.id !== exceptId && phoneKey(k.phone) === key; })[0] || null;
  }

  function save(S, me, req) {
    var entity = req.entity, def = ENTITIES[entity];
    if (!def) throw fail('Неизвестный раздел');
    var item = req.item || {}, now = nowMsk();
    var o = clean(S, entity, item);
    var old = item.id ? S.rows(def.sheet).filter(function (x) { return x.id === item.id; })[0] : null;
    if (item.id && !old) throw fail('Запись не найдена — возможно, её уже удалили');
    if (old && !canWrite(S, me, entity, old.okrug)) throw fail('Нет прав на эту запись', 'FORBIDDEN');
    if (!canWrite(S, me, entity, o.okrug)) throw fail('Нет прав на этот округ', 'FORBIDDEN');
    if (entity === 'kmb') {
      var dup = findKmbDuplicate(S, o.phone, old && old.id);
      if (dup) throw fail('Этот телефон уже есть в КМБ (' + (okrugMap(S)[dup.okrug] || {}).name + ')', 'DUPLICATE');
    }
    var rec;
    if (old) {
      rec = old; def.fields.forEach(function (f) { rec[f] = o[f]; });
      if ('updated' in rec || SCHEMA[def.sheet].indexOf('updated') >= 0) rec.updated = now;
      S.update(def.sheet, rec);
    } else {
      rec = o; rec.id = S.uuid(); rec.created = now; rec.createdBy = me.id;
      if (SCHEMA[def.sheet].indexOf('updated') >= 0) rec.updated = now;
      if (entity === 'candidates') rec.hasPhoto = '';
      S.insert(def.sheet, rec);
    }
    if (entity === 'candidates' && item.photo !== undefined) {
      S.removeWhere('Photos', function (p) { return p.id === rec.id; });
      if (item.photo) {
        if (String(item.photo).length > 48000) throw fail('Фото слишком большое');
        S.insert('Photos', { id: rec.id, data: item.photo });
      }
      rec.hasPhoto = item.photo ? '1' : '';
      S.update(def.sheet, rec);
    }
    log(S, me, (old ? 'edit ' : 'add ') + entity, rec.id + ' ' + (rec.fio || rec.title || rec.date || ''));
    return rec;
  }

  function remove(S, me, req) {
    var def = ENTITIES[req.entity];
    if (!def) throw fail('Неизвестный раздел');
    var old = S.rows(def.sheet).filter(function (x) { return x.id === req.id; })[0];
    if (!old) return { removed: 0 };
    if (!canWrite(S, me, req.entity, old.okrug)) throw fail('Нет прав на эту запись', 'FORBIDDEN');
    S.remove(def.sheet, old.id);
    if (req.entity === 'candidates') S.removeWhere('Photos', function (p) { return p.id === old.id; });
    log(S, me, 'delete ' + req.entity, old.id + ' ' + (old.fio || old.title || ''));
    return { removed: 1 };
  }

  function kmbBulk(S, me, req) {
    var items = req.items || [];
    if (items.length > 3000) throw fail('За один раз — не больше 3000 строк');
    var seen = {}, ok = [], skipped = [], now = nowMsk();
    S.rows('Kmb').forEach(function (k) { var p = phoneKey(k.phone); if (p.length >= 10) seen[p] = 1; });
    items.forEach(function (it, i) {
      try {
        var o = clean(S, 'kmb', it);
        if (!canWrite(S, me, 'kmb', o.okrug)) throw fail('нет прав на округ');
        var p = phoneKey(o.phone);
        if (p.length >= 10) { if (seen[p]) throw fail('телефон уже в базе'); seen[p] = 1; }
        o.id = S.uuid(); o.created = now; o.createdBy = me.id;
        ok.push(o);
      } catch (e) { skipped.push({ row: i + 1, reason: e.message }); }
    });
    if (ok.length) S.insertMany('Kmb', ok);
    log(S, me, 'import kmb', ok.length + ' добавлено, ' + skipped.length + ' пропущено');
    return { added: ok.length, skipped: skipped };
  }

  function kmbList(S, me, req) {
    var sc = {}; scope(S, me).forEach(function (id) { sc[id] = 1; });
    var q = str(req.q).toLowerCase(), qd = q.replace(/\D/g, '');
    var list = S.rows('Kmb').filter(function (k) {
      if (!sc[k.okrug]) return false;
      if (req.okrug && k.okrug !== req.okrug) return false;
      if (req.month && str(k.date).slice(0, 7) !== req.month) return false;
      if (!q) return true;
      return (k.fio + ' ' + k.address + ' ' + k.tags + ' ' + k.comment).toLowerCase().indexOf(q) >= 0 ||
        (qd.length >= 3 && str(k.phone).replace(/\D/g, '').indexOf(qd) >= 0);
    });
    list.sort(function (a, b) { return a.created < b.created ? 1 : -1; });
    var off = Math.max(0, num(req.offset)), lim = Math.min(5000, num(req.limit) || 100);
    return { total: list.length, items: list.slice(off, off + lim) };
  }

  function photos(S, me, req) {
    var sc = {}; scope(S, me).forEach(function (id) { sc[id] = 1; });
    var allowed = {};
    S.rows('Candidates').forEach(function (c) { if (sc[c.okrug]) allowed[c.id] = 1; });
    var want = {}; (req.ids || []).forEach(function (id) { if (allowed[id]) want[id] = 1; });
    var out = {};
    S.rows('Photos').forEach(function (p) { if (want[p.id]) out[p.id] = p.data; });
    return out;
  }

  function bootstrap(S, me) {
    var sc = {}; scope(S, me).forEach(function (id) { sc[id] = 1; });
    var full = me.role === 'admin';
    return {
      me: publicUser(me, true),
      okrugs: S.rows('Okrugs'),
      plan: S.rows('Plan').sort(function (a, b) { return a.month < b.month ? -1 : 1; }),
      users: S.rows('Users').map(function (u) { return publicUser(u, full); }),
      candidates: S.rows('Candidates').filter(function (c) { return sc[c.okrug]; }),
      events: S.rows('Events').filter(function (e) { return sc[e.okrug]; }),
      media: S.rows('Media'),
      interviews: me.role === 'member' ? [] : S.rows('Interviews').filter(function (i) { return sc[i.okrug]; }),
      stats: stats(S),
      server: S.kind,
      credUrl: full && S.credUrl ? S.credUrl() : ''
    };
  }

  /* ---------- пользователи (только руководитель) ---------- */
  function needAdmin(me) { if (me.role !== 'admin') throw fail('Доступно только руководителю', 'FORBIDDEN'); }

  // Строка в листе «Логины и пароли»; password === null — оставить прежний пароль
  function credWrite(S, rec, password, note) {
    var old = S.rows(CRED).filter(function (r) { return r.id === rec.id; })[0];
    S.removeWhere(CRED, function (r) { return r.id === rec.id; });
    var o = rec.okrug && okrugMap(S)[rec.okrug];
    S.insert(CRED, {
      'Логин': rec.login, 'Пароль': password != null ? password : (old ? old['Пароль'] : ''), 'Имя': rec.name, 'Роль': ROLES[rec.role] || rec.role,
      'Зона или округ': rec.role === 'coord' ? 'Зона ' + rec.zone + ' (' + ZONES[rec.zone] + ')' : o ? o.name : 'Весь ЮАО',
      'Телефон': rec.phone, 'Доступ': truthy(rec.active) ? 'включён' : 'отключён',
      'Изменено': nowMsk().replace('T', ' ').slice(0, 16) + (note ? ', ' + note : ''), id: rec.id
    });
  }

  function userSave(S, me, req) {
    needAdmin(me);
    var it = req.item || {}, users = S.rows('Users');
    var login = str(it.login).toLowerCase();
    if (!/^[a-z0-9._-]{2,32}$/.test(login)) throw fail('Логин: 2–32 символа, латиница, цифры, точка, дефис');
    if (!str(it.name)) throw fail('Укажите имя');
    if (!ROLES[it.role]) throw fail('Выберите роль');
    if (users.some(function (u) { return u.login.toLowerCase() === login && u.id !== it.id; })) throw fail('Такой логин уже занят');
    var okr = okrugMap(S);
    if ((it.role === 'intern' || it.role === 'member') && !okr[it.okrug]) throw fail('Стажёру и участнику нужен округ');
    if (it.role === 'coord' && !ZONES[it.zone]) throw fail('Координатору нужна зона');
    var u = it.id ? users.filter(function (x) { return x.id === it.id; })[0] : null;
    if (it.id && !u) throw fail('Пользователь не найден');
    if (u && u.id === me.id && (it.role !== 'admin' || !truthy(it.active))) throw fail('Нельзя снять права или отключить самого себя');
    var rec = u || { id: S.uuid(), created: nowMsk(), lastLogin: '' };
    rec.login = login; rec.name = str(it.name); rec.role = it.role; rec.phone = str(it.phone);
    rec.okrug = (it.role === 'intern' || it.role === 'member') ? it.okrug : '';
    rec.zone = it.role === 'coord' ? it.zone : (rec.okrug ? okr[rec.okrug].zone : '');
    rec.active = truthy(it.active) ? '1' : '';
    if (it.password) {
      if (String(it.password).length < 6) throw fail('Пароль — минимум 6 символов');
      rec.salt = S.uuid(); rec.hash = hashPassword(rec.salt, String(it.password));
      if (u) S.removeWhere('Sessions', function (s) { return s.userId === rec.id; });
    } else if (!u) throw fail('Задайте пароль');
    if (u) S.update('Users', rec); else S.insert('Users', rec);
    credWrite(S, rec, it.password ? String(it.password) : null, it.password ? (u ? 'пароль сброшен' : 'доступ выдан') : 'данные изменены');
    if (!rec.active) S.removeWhere('Sessions', function (s) { return s.userId === rec.id; });
    log(S, me, u ? 'edit user' : 'add user', rec.login + (it.password ? ' (пароль задан)' : ''));
    return publicUser(rec, true);
  }

  function userDelete(S, me, req) {
    needAdmin(me);
    if (req.id === me.id) throw fail('Нельзя удалить самого себя');
    var u = S.rows('Users').filter(function (x) { return x.id === req.id; })[0];
    if (!u) return { removed: 0 };
    S.remove('Users', u.id);
    S.removeWhere(CRED, function (r) { return r.id === u.id; });
    S.removeWhere('Sessions', function (s) { return s.userId === u.id; });
    log(S, me, 'delete user', u.login);
    return { removed: 1 };
  }

  function changePassword(S, me, req) {
    if (hashPassword(me.salt, String(req.old || '')) !== me.hash) throw fail('Текущий пароль неверный');
    if (String(req.password || '').length < 6) throw fail('Новый пароль — минимум 6 символов');
    me.salt = S.uuid(); me.hash = hashPassword(me.salt, String(req.password));
    S.update('Users', me);
    credWrite(S, me, 'сменён самим сотрудником — знает только он', 'пароль сменён в профиле');
    S.removeWhere('Sessions', function (s) { return s.userId === me.id && s.token !== req.token; });
    log(S, me, 'change password', '');
    return { changed: true };
  }

  function okrugSave(S, me, req) {
    var it = req.item || {}, o = okrugMap(S)[it.id];
    if (!o) throw fail('Округ не найден');
    if (me.role === 'admin') {
      o.name = str(it.name) || o.name;
      o.mandates = String(Math.max(1, Math.round(num(it.mandates))) || o.mandates);
      o.voters = String(Math.round(num(it.voters)) || o.voters);
    } else if (!(me.role === 'coord' && o.zone === me.zone)) throw fail('Нет прав', 'FORBIDDEN');
    o.note = str(it.note);
    S.update('Okrugs', o);
    log(S, me, 'edit okrug', o.id);
    return o;
  }

  function planSave(S, me, req) {
    needAdmin(me);
    var rows = (req.rows || []).filter(function (r) { return /^\d{4}-\d{2}$/.test(str(r.month)); }).map(function (r) {
      return { month: str(r.month), meetings: String(num(r.meetings)), actions: String(num(r.actions)), kmb: String(num(r.kmb)) };
    });
    S.replaceAll('Plan', rows);
    log(S, me, 'edit plan', rows.length + ' мес.');
    return rows;
  }

  /* ---------- резервные копии ---------- */
  function exportAll(S, me) {
    needAdmin(me);
    var sheets = {};
    Object.keys(SCHEMA).forEach(function (n) { if (n !== 'Sessions' && n !== CRED) sheets[n] = S.rows(n); });
    log(S, me, 'export', '');
    return { format: 'crm-yuao', version: VERSION, exported: nowMsk(), sheets: sheets };
  }

  function importAll(S, me, req) {
    needAdmin(me);
    var d = req.data;
    if (!d || d.format !== 'crm-yuao' || !d.sheets) throw fail('Это не файл резервной копии CRM');
    if (!(d.sheets.Users || []).some(function (u) { return u.role === 'admin' && truthy(u.active); })) throw fail('В копии нет ни одного активного руководителя — восстановление остановлено');
    Object.keys(SCHEMA).forEach(function (n) {
      if (n === 'Sessions' || n === CRED || !d.sheets[n]) return;
      S.replaceAll(n, d.sheets[n].map(function (r) { return pick(r, SCHEMA[n]); }));
    });
    S.replaceAll('Sessions', []);
    log(S, me, 'import', 'восстановлено из копии от ' + d.exported);
    return { restored: true };
  }

  function backupNow(S, me) { needAdmin(me); if (!S.backup) throw fail('Копии таблицы делаются только на сервере'); var r = S.backup(); log(S, me, 'backup', r.name); return r; }
  function backups(S, me) { needAdmin(me); return S.listBackups ? S.listBackups() : []; }
  function logList(S, me) { needAdmin(me); var l = S.rows('Log'); return l.slice(Math.max(0, l.length - 300)).reverse(); }

  var READ = { bootstrap: bootstrap, kmbList: kmbList, photos: photos, backups: backups, log: logList, exportAll: exportAll };
  var WRITE = {
    save: save, remove: remove, kmbBulk: kmbBulk, userSave: userSave, userDelete: userDelete,
    changePassword: changePassword, okrugSave: okrugSave, planSave: planSave, importAll: importAll, backupNow: backupNow,
    logout: function (S, me, req) { S.removeWhere('Sessions', function (s) { return s.token === req.token; }); return {}; }
  };

  function handle(S, req) {
    try {
      req = req || {};
      if (req.action === 'ping') return { ok: true, data: { service: 'CRM ЮАО', version: VERSION } };
      if (req.action === 'login') return { ok: true, data: S.lock(function () { seed(S); return login(S, req); }) };
      var me = auth(S, req.token);
      if (!me) return { ok: false, error: 'AUTH', message: 'Сессия закончилась — войдите снова' };
      if (READ[req.action]) return { ok: true, data: READ[req.action](S, me, req) };
      if (WRITE[req.action]) return { ok: true, data: S.lock(function () { return WRITE[req.action](S, me, req); }) };
      return { ok: false, error: 'ERR', message: 'Неизвестное действие: ' + req.action };
    } catch (e) {
      return { ok: false, error: e.code || 'ERR', message: e.message || String(e) };
    }
  }

  // Создание первого руководителя (вызывается из setup() на сервере или в демо)
  function createAdmin(S, login, password, name) {
    seed(S);
    var salt = S.uuid();
    var u = { id: S.uuid(), login: login, name: name || 'Руководитель кампании', role: 'admin', zone: '', okrug: '', phone: '', active: '1', salt: salt, hash: hashPassword(salt, password), created: nowMsk(), lastLogin: '' };
    S.insert('Users', u);
    credWrite(S, u, password, 'создан при запуске');
    return u;
  }

  return {
    VERSION: VERSION, CAMPAIGN: CAMPAIGN, MEDIA_KINDS: MEDIA_KINDS, NETWORKS: NETWORKS, MEDIA_PLAN: MEDIA_PLAN, SCHEMA: SCHEMA, ROLES: ROLES, ZONES: ZONES, CAND_STATUSES: CAND_STATUSES, EVENT_TYPES: EVENT_TYPES,
    CRED: CRED, credWrite: credWrite, defaultOkrugs: defaultOkrugs, defaultPlan: defaultPlan, sha256: sha256, _hash: hashPassword, handle: handle, createAdmin: createAdmin, seed: seed
  };
})();

if (typeof module !== 'undefined') module.exports = CRM;
