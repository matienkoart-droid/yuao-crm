/* CRM ЮАО — интерфейс */
(function () {
  'use strict';

  var CFG = window.CRM_CONFIG || {};
  var DEMO = !CFG.API_URL;
  var TOKEN_KEY = 'crm-yuao-token';
  var demoStore = null;
  if (DEMO) {
    demoStore = MemoryStore('crm-yuao-demo');
    if (!demoStore.rows('Users').length) CRM.createAdmin(demoStore, 'admin', 'admin123');
  }

  var S = { token: lsGet(TOKEN_KEY), me: null, okrugs: [], plan: [], users: [], candidates: [], events: [], media: [], interviews: [], passports: [], stats: {}, photos: {}, geo: null };
  var UI = { pOkrug: '', month: null, mode: 'month', layer: 'traffic', uikF: { q: '', district: '', okrug: '' }, selOkrug: null, candF: { okrug: '', status: '', q: '' }, evF: { month: '', okrug: '', status: '' }, ivF: { okrug: '', status: 'upcoming' }, mdF: { kind: '', network: '', okrug: '', q: '' }, kmbF: { q: '', okrug: '', offset: 0 } };
  var app = document.getElementById('app');
  var map = null, geoLayer = null, labelLayer = null, districtLayer = null;

  /* ---------- общие помощники ---------- */
  function lsGet(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function lsSet(k, v) { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch (e) { } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fmt(n) { return Math.round(Number(n) || 0).toLocaleString('ru-RU'); }
  function money(n) { return n ? fmt(n) + ' ₽' : '—'; }
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function todayMsk() { return new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10); }
  function curMonth() { return todayMsk().slice(0, 7); }
  var MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
  function monthName(m) { if (!m) return ''; var p = m.split('-'); return MONTHS[+p[1] - 1] + ' ' + p[0]; }
  function dateRu(d) { if (!d) return ''; var p = String(d).slice(0, 10).split('-'); return p[2] + '.' + p[1] + '.' + p[0]; }
  function okrug(id) { return S.okrugs.filter(function (o) { return o.id === id; })[0]; }
  function okrugName(id) { var o = okrug(id); return o ? o.name : '—'; }
  function user(id) { return S.users.filter(function (u) { return u.id === id; })[0]; }
  function isAdmin() { return S.me && S.me.role === 'admin'; }
  function myOkrugs() {
    if (!S.me) return [];
    if (S.me.role === 'admin') return S.okrugs.map(function (o) { return o.id; });
    if (S.me.role === 'coord') return S.okrugs.filter(function (o) { return o.zone === S.me.zone; }).map(function (o) { return o.id; });
    return S.me.okrug ? [S.me.okrug] : [];
  }
  function canEdit(okrugId, entity) { return myOkrugs().indexOf(okrugId) >= 0 && !(entity === 'candidates' && S.me.role === 'member'); }
  function internOf(okrugId) { return S.users.filter(function (u) { return u.role === 'intern' && u.okrug === okrugId && u.active; })[0]; }
  function coordOf(zone) { return S.users.filter(function (u) { return u.role === 'coord' && u.zone === zone && u.active; }); }

  function toast(msg, bad) {
    var t = document.createElement('div');
    t.className = 'toast' + (bad ? ' bad' : '');
    t.textContent = msg;
    t.setAttribute('role', bad ? 'alert' : 'status');
    document.body.appendChild(t);
    requestAnimationFrame(function () { t.classList.add('in'); });
    setTimeout(function () { t.classList.remove('in'); setTimeout(function () { t.remove(); }, 200); }, bad ? 5000 : 2500);
  }

  // Запросы к серверу Google. Чтение повторяем до 3 раз при сбоях; запись — только если сервер точно её не получил.
  var READ_ACTIONS = { bootstrap: 1, kmbList: 1, photos: 1, log: 1, backups: 1, ping: 1, exportAll: 1 };
  function retryErr(msg, lost) { var e = new Error(msg); e.retry = true; e.lost = !!lost; return e; }
  function callServer(req, attempt) {
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctl && setTimeout(function () { ctl.abort(); }, 60000);
    return fetch(CFG.API_URL, { method: 'POST', body: JSON.stringify(req), signal: ctl ? ctl.signal : undefined })
      .then(function (r) {
        if (!r.ok) throw retryErr('Сервер не отвечает (' + r.status + ')');
        return r.text();
      })
      .then(function (t) {
        var res;
        try { res = JSON.parse(t); } catch (e) { throw retryErr('Сервер Google временно ответил ошибкой'); }
        // Google по пути потерял запрос и вернул служебный ответ без данных — запрос не выполнялся, повтор безопасен
        if (res && res.ok && !('data' in res) && req.action !== 'ping') throw retryErr('Сервер не получил запрос', true);
        return res;
      })
      .catch(function (err) {
        if (timer) clearTimeout(timer);
        var network = err.name === 'AbortError' || err instanceof TypeError;
        var canRetry = attempt < 3 && (err.lost || ((err.retry || network) && READ_ACTIONS[req.action]));
        if (canRetry) return new Promise(function (ok) { setTimeout(ok, 1200 * attempt); }).then(function () { return callServer(req, attempt + 1); });
        if (network) throw new Error(READ_ACTIONS[req.action] ? 'Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.' : 'Нет связи с сервером — изменение могло не сохраниться. Проверьте и при необходимости повторите.');
        throw err;
      })
      .then(function (res) { if (timer) clearTimeout(timer); return res; });
  }

  function api(action, data) {
    var req = Object.assign({ action: action, token: S.token }, data || {});
    var p = DEMO
      ? new Promise(function (r) { setTimeout(function () { r(CRM.handle(demoStore, JSON.parse(JSON.stringify(req)))); }, 30); })
      : callServer(req, 1);
    return p.then(function (res) {
      if (!res || !res.ok) {
        if (res && res.error === 'AUTH' && action !== 'login') { logout(true); }
        var e = new Error((res && res.message) || 'Ошибка сервера'); e.code = res && res.error; throw e;
      }
      return res.data;
    });
  }

  function fail(e) { toast(e.message || String(e), true); }

  /* ---------- план и прогресс ---------- */
  var CAMP = CRM.CAMPAIGN;
  function planOf(m) { return S.plan.filter(function (p) { return p.month === m; })[0] || null; }
  function campaignMonths() {
    var out = [], d = new Date(CAMP.start.slice(0, 7) + '-01T12:00:00Z'), end = CAMP.end.slice(0, 7);
    S.plan.forEach(function (p) { if (p.month > end) end = p.month; });
    for (var i = 0; i < 36; i++) { var m = d.toISOString().slice(0, 7); if (m > end) break; out.push(m); d.setUTCMonth(d.getUTCMonth() + 1); }
    return out;
  }
  function defaultMonth() {
    var cm = curMonth(), ms = campaignMonths();
    if (ms.indexOf(cm) >= 0) return cm;
    return cm < ms[0] ? ms[0] : ms[ms.length - 1];
  }
  function lastDay(m) { var d = new Date(m + '-01T12:00:00Z'); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0); return d.toISOString().slice(0, 10); }
  function dayFrac() { var t = todayMsk(); return +t.slice(8, 10) / +lastDay(t.slice(0, 7)).slice(8, 10); }
  function share(a, b) { return b > 0 ? Math.min(1, a / b) : 1; }
  function colorOf(r) { return r == null ? 'grey' : r >= 0.9 ? 'green' : r >= 0.5 ? 'yellow' : 'red'; }
  // Доля плана месяца, которую к сегодняшнему дню уже пора выполнить
  function paceFactor(m) { var cm = curMonth(); return m < cm ? 1 : m === cm ? dayFrac() : 0; }
  // Дата, на которую оцениваем: конец прошедшего месяца, сегодня для текущего, null для будущего
  function refDate(m) { var cm = curMonth(); return m < cm ? lastDay(m) : m === cm ? todayMsk() : null; }
  function dnum(d) { return Date.parse(d + 'T12:00:00Z') / 864e5; }
  function lin(d, from, to) { return Math.max(0, Math.min(1, (dnum(d) - dnum(from)) / (dnum(to) - dnum(from)))); }
  // Сколько кандидатов в округе должно быть к дате: стажёр к 30.11, затем полный список к 01.02
  function candExpected(d, mandates) { return d <= CAMP.team ? lin(d, CAMP.start, CAMP.team) : 1 + (mandates - 1) * lin(d, CAMP.team, CAMP.cand); }
  function candAt(oid, d) { return ((S.stats[oid] || {}).candD || []).filter(function (x) { return !x || x <= d; }).length; }

  /*
   * Оценка округа по полному плану презентации на выбранный месяц.
   * mode: 'month' — только этот месяц; 'cum' — с начала кампании по этот месяц.
   * Команда и кандидаты всегда считаются на дату (это накопительные цели).
   */
  function evalOkrug(oid, m, mode) {
    var o = okrug(oid), st = S.stats[oid] || { ev: {}, kmb: {} }, date = refDate(m), d = date || lastDay(m);
    var items = [];
    var te = lin(d, CAMP.start, CAMP.team);
    var bin = function (have) { return !date ? null : have ? 1 : te > 0 ? 1 - te : null; };
    var intern = internOf(oid), coord = coordOf(o.zone).length > 0;
    items.push({ key: 'intern', label: 'Стажёр', fact: intern ? 1 : 0, plan: 1, need: 'до ' + dateRu(CAMP.team), score: bin(!!intern) });
    items.push({ key: 'coord', label: 'Координатор зоны', fact: coord ? 1 : 0, plan: 1, need: 'до ' + dateRu(CAMP.team), score: bin(coord) });
    var ce = candExpected(d, +o.mandates), cf = candAt(oid, d);
    items.push({ key: 'cand', label: 'Кандидаты', fact: cf, plan: +o.mandates, now: Math.ceil(ce - 0.001), need: 'все к ' + dateRu(CAMP.cand), score: date && ce > 0 ? share(cf, ce) : null });
    var months = mode === 'cum' ? S.plan.filter(function (p) { return p.month <= m; }) : [planOf(m)].filter(Boolean);
    var t = { meet: [0, 0, 0], act: [0, 0, 0], kmb: [0, 0, 0] }; // факт, план к дате, план полный
    var factMonths = mode === 'cum' ? Object.keys(st.kmb).concat(Object.keys(st.ev)).filter(function (x, i, a) { return x <= m && a.indexOf(x) === i; }) : [m];
    factMonths.forEach(function (x) { var ev = st.ev[x] || [0, 0, 0, 0]; t.meet[0] += ev[0]; t.act[0] += ev[1]; t.kmb[0] += st.kmb[x] || 0; });
    months.forEach(function (p) {
      var f = paceFactor(p.month);
      t.meet[1] += p.meetings * f; t.act[1] += p.actions * f; t.kmb[1] += p.kmb * f;
      t.meet[2] += +p.meetings; t.act[2] += +p.actions; t.kmb[2] += +p.kmb;
    });
    [['meet', 'Встречи'], ['act', 'Акции'], ['kmb', 'КМБ']].forEach(function (x) {
      var v = t[x[0]];
      if (!v[2] && !v[0]) return;
      items.push({ key: x[0], label: x[1], fact: v[0], plan: v[2], now: Math.round(v[1]), score: date && v[1] > 0 ? share(v[0], v[1]) : null });
    });
    var sc = items.filter(function (i) { return i.score != null; });
    var ratio = sc.length ? sc.reduce(function (s, i) { return s + i.score; }, 0) / sc.length : null;
    var note = !date ? 'месяц ещё не начался' : m === curMonth() ? 'на ' + dateRu(todayMsk()) : 'на конец месяца';
    var by = {}; items.forEach(function (i) { by[i.key] = i; });
    return { items: items, by: by, ratio: ratio, color: colorOf(ratio), note: note };
  }
  function kmbTotal(oid) { var st = S.stats[oid] || { kmb: {} }, n = 0; Object.keys(st.kmb).forEach(function (k) { n += st.kmb[k]; }); return n; }

  /* ---------- иконки ---------- */
  // Иконки Tabler Icons (MIT), outline, stroke 1.75
  var ICONS = {"passport": "<path d=\"M14 3v4a1 1 0 0 0 1 1h4\"/><path d=\"M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2z\"/><path d=\"M9 17h6\"/><path d=\"M9 13h6\"/>", "xls": "<path d=\"M14 3v4a1 1 0 0 0 1 1h4\"/><path d=\"M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2z\"/><path d=\"M8 11h8v7h-8z\"/><path d=\"M8 15h8\"/><path d=\"M11 11v7\"/>", "doc": "<path d=\"M14 3v4a1 1 0 0 0 1 1h4\"/><path d=\"M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2\"/><path d=\"M9 12l1.333 5l1.667 -4l1.667 4l1.333 -5\"/>", "calplus": "<path d=\"M12.5 21h-6.5a2 2 0 0 1 -2 -2v-12a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v5\"/><path d=\"M16 3v4\"/><path d=\"M8 3v4\"/><path d=\"M4 11h16\"/><path d=\"M16 19h6\"/><path d=\"M19 16v6\"/>", "eye": "<path d=\"M10 12a2 2 0 1 0 4 0a2 2 0 0 0 -4 0\"/><path d=\"M21 12c-2.4 4 -5.4 6 -9 6c-3.6 0 -6.6 -2 -9 -6c2.4 -4 5.4 -6 9 -6c3.6 0 6.6 2 9 6\"/>", "eyeoff": "<path d=\"M10.585 10.587a2 2 0 0 0 2.829 2.828\"/><path d=\"M16.681 16.673a8.717 8.717 0 0 1 -4.681 1.327c-3.6 0 -6.6 -2 -9 -6c1.272 -2.12 2.712 -3.678 4.32 -4.674m2.86 -1.146a9.055 9.055 0 0 1 1.82 -.18c3.6 0 6.6 2 9 6c-.666 1.11 -1.379 2.067 -2.138 2.87\"/><path d=\"M3 3l18 18\"/>", "uik": "<path d=\"M9 11l3 3l8 -8\"/><path d=\"M20 12v6a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2v-12a2 2 0 0 1 2 -2h9\"/>", "interviews": "<path d=\"M12 21h-6a2 2 0 0 1 -2 -2v-12a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v4.5\"/><path d=\"M16 3v4\"/><path d=\"M8 3v4\"/><path d=\"M4 11h16\"/><path d=\"M19 17m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0\"/><path d=\"M22 22a2 2 0 0 0 -2 -2h-2a2 2 0 0 0 -2 2\"/>", "media": "<path d=\"M18 8a3 3 0 0 1 0 6\"/><path d=\"M10 8v11a1 1 0 0 1 -1 1h-1a1 1 0 0 1 -1 -1v-5\"/><path d=\"M12 8h0l4.524 -3.77a.9 .9 0 0 1 1.476 .692v12.156a.9 .9 0 0 1 -1.476 .692l-4.524 -3.77h-8a1 1 0 0 1 -1 -1v-4a1 1 0 0 1 1 -1h8\"/>", "link": "<path d=\"M12 6h-6a2 2 0 0 0 -2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-6\"/><path d=\"M11 13l9 -9\"/><path d=\"M15 4h5v5\"/>", "usercheck": "<path d=\"M8 7a4 4 0 1 0 8 0a4 4 0 0 0 -8 0\"/><path d=\"M6 21v-2a4 4 0 0 1 4 -4h4\"/><path d=\"M15 19l2 2l4 -4\"/>", "dashboard": "<path d=\"M5 4h4a1 1 0 0 1 1 1v6a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1v-6a1 1 0 0 1 1 -1\"/><path d=\"M5 16h4a1 1 0 0 1 1 1v2a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1v-2a1 1 0 0 1 1 -1\"/><path d=\"M15 12h4a1 1 0 0 1 1 1v6a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1v-6a1 1 0 0 1 1 -1\"/><path d=\"M15 4h4a1 1 0 0 1 1 1v2a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1v-2a1 1 0 0 1 1 -1\"/>", "map": "<path d=\"M12 18.5l-3 -1.5l-6 3v-13l6 -3l6 3l6 -3v7.5\"/><path d=\"M9 4v13\"/><path d=\"M15 7v5.5\"/><path d=\"M21.121 20.121a3 3 0 1 0 -4.242 0c.418 .419 1.125 1.045 2.121 1.879c1.051 -.89 1.759 -1.516 2.121 -1.879z\"/><path d=\"M19 18v.01\"/>", "okrugs": "<path d=\"M13 5h8\"/><path d=\"M13 9h5\"/><path d=\"M13 15h8\"/><path d=\"M13 19h5\"/><path d=\"M3 4m0 1a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1z\"/><path d=\"M3 14m0 1a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1z\"/>", "candidates": "<path d=\"M9 7m-4 0a4 4 0 1 0 8 0a4 4 0 1 0 -8 0\"/><path d=\"M3 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2\"/><path d=\"M16 3.13a4 4 0 0 1 0 7.75\"/><path d=\"M21 21v-2a4 4 0 0 0 -3 -3.85\"/>", "events": "<path d=\"M4 5m0 2a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2z\"/><path d=\"M16 3l0 4\"/><path d=\"M8 3l0 4\"/><path d=\"M4 11l16 0\"/><path d=\"M8 15h2v2h-2z\"/>", "kmb": "<path d=\"M20 6v12a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2v-12a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2z\"/><path d=\"M10 16h6\"/><path d=\"M13 11m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0\"/><path d=\"M4 8h3\"/><path d=\"M4 12h3\"/><path d=\"M4 16h3\"/>", "team": "<path d=\"M10 13a2 2 0 1 0 4 0a2 2 0 0 0 -4 0\"/><path d=\"M8 21v-1a2 2 0 0 1 2 -2h4a2 2 0 0 1 2 2v1\"/><path d=\"M15 5a2 2 0 1 0 4 0a2 2 0 0 0 -4 0\"/><path d=\"M17 10h2a2 2 0 0 1 2 2v1\"/><path d=\"M5 5a2 2 0 1 0 4 0a2 2 0 0 0 -4 0\"/><path d=\"M3 13v-1a2 2 0 0 1 2 -2h2\"/>", "plan": "<path d=\"M3 13a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v6a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1z\"/><path d=\"M15 9a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v10a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1z\"/><path d=\"M9 5a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v14a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1z\"/><path d=\"M4 20h14\"/>", "backup": "<path d=\"M4 6c0 1.657 3.582 3 8 3s8 -1.343 8 -3s-3.582 -3 -8 -3s-8 1.343 -8 3\"/><path d=\"M4 6v6c0 1.657 3.582 3 8 3c1.118 0 2.183 -.086 3.15 -.241\"/><path d=\"M20 12v-6\"/><path d=\"M4 12v6c0 1.657 3.582 3 8 3c.157 0 .312 -.002 .466 -.005\"/><path d=\"M16 19h6\"/><path d=\"M19 16l3 3l-3 3\"/>", "profile": "<path d=\"M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0\"/><path d=\"M12 10m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0\"/><path d=\"M6.168 18.849a4 4 0 0 1 3.832 -2.849h4a4 4 0 0 1 3.834 2.855\"/>", "menu": "<path d=\"M4 6l16 0\"/><path d=\"M4 12l16 0\"/><path d=\"M4 18l16 0\"/>", "refresh": "<path d=\"M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4\"/><path d=\"M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4\"/>", "x": "<path d=\"M18 6l-12 12\"/><path d=\"M6 6l12 12\"/>", "check": "<path d=\"M5 12l5 5l10 -10\"/>", "left": "<path d=\"M15 6l-6 6l6 6\"/>", "right": "<path d=\"M9 6l6 6l-6 6\"/>", "plus": "<path d=\"M12 5l0 14\"/><path d=\"M5 12l14 0\"/>", "upload": "<path d=\"M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2\"/><path d=\"M7 9l5 -5l5 5\"/><path d=\"M12 4l0 12\"/>", "download": "<path d=\"M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2\"/><path d=\"M7 11l5 5l5 -5\"/><path d=\"M12 4l0 12\"/>", "search": "<path d=\"M10 10m-7 0a7 7 0 1 0 14 0a7 7 0 1 0 -14 0\"/><path d=\"M21 21l-6 -6\"/>", "logout": "<path d=\"M14 8v-2a2 2 0 0 0 -2 -2h-7a2 2 0 0 0 -2 2v12a2 2 0 0 0 2 2h7a2 2 0 0 0 2 -2v-2\"/><path d=\"M9 12h12l-3 -3\"/><path d=\"M18 15l3 -3\"/>"};
  function icon(n) { return '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[n] + '</svg>'; }

  var VIEWS = [
    ['dashboard', 'Сводка'], ['map', 'Карта'], ['okrugs', 'Округа'], ['passport', 'Паспорта округов'], ['interviews', 'Встречи с кандидатами'], ['candidates', 'Кандидаты'],
    ['events', 'Мероприятия'], ['kmb', 'КМБ'], ['media', 'Медиа'], ['uik', 'УИК'], ['team', 'Команда'], ['plan', 'План KPI', true], ['backup', 'Резерв', true], ['profile', 'Профиль']
  ];

  /* ---------- вход / выход ---------- */
  function renderLogin(msg) {
    app.innerHTML =
      '<div class="login"><form class="card" id="loginForm">' +
      '<div class="brand" style="padding:0 0 18px"><div class="brand-mark">ЮАО</div><div><b>CRM кампании</b><span>Муниципальные выборы 2027</span></div></div>' +
      '<h1>Вход</h1><p>Логин и пароль выдаёт руководитель кампании.</p>' +
      (DEMO ? '<div class="demo-banner">Демо-режим: сервер ещё не подключён, данные хранятся только в этом браузере. Вход: <b>admin</b> / <b>admin123</b></div>' : '') +
      '<label class="f"><span>Логин</span><input class="input" name="login" autocomplete="username" autocapitalize="none" required></label>' +
      '<label class="f"><span>Пароль</span><div class="pw"><input class="input" name="password" type="password" autocomplete="current-password" required><button type="button" class="pw-eye" aria-label="Показать пароль" title="Показать пароль">' + icon('eye') + '</button></div></label>' +
      '<div class="err" id="loginErr">' + esc(msg || '') + '</div>' +
      '<button class="btn primary" style="width:100%;justify-content:center;padding:10px">Войти</button></form></div>';
    $('#loginForm').onsubmit = function (e) {
      e.preventDefault();
      var f = e.target, b = $('button', f);
      b.disabled = true; b.textContent = 'Входим…';
      api('login', { login: f.login.value, password: f.password.value }).then(function (d) {
        S.token = d.token; lsSet(TOKEN_KEY, d.token);
        load();
      }).catch(function (err) {
        $('#loginErr').textContent = err.message; b.disabled = false; b.textContent = 'Войти';
      });
    };
  }

  function logout(expired) {
    if (S.token && !expired) api('logout').catch(function () { });
    S.token = ''; S.me = null; lsSet(TOKEN_KEY, '');
    map = null;
    renderLogin(expired ? 'Сессия закончилась — войдите снова' : '');
  }

  var loading = null;
  function load() {
    if (loading) return loading; // не запускать вторую загрузку, пока идёт первая
    var first = !S.me;
    if (first) app.innerHTML = '<div class="loading">Загрузка данных…</div>';
    loading = api('bootstrap').then(function (d) {
      if (!d || !d.me) throw new Error('Сервер вернул пустой ответ');
      S.me = d.me; S.okrugs = d.okrugs; S.plan = d.plan; S.users = d.users; S.credUrl = d.credUrl || '';
      S.candidates = d.candidates; S.events = d.events; S.media = d.media || []; S.interviews = d.interviews || []; S.passports = d.passports || []; S.stats = d.stats;
      if (!UI.month || campaignMonths().indexOf(UI.month) < 0) UI.month = defaultMonth();
      if (!UI.evF.month) UI.evF.month = curMonth();
      var y = window.scrollY, onMap = route() === 'map' && !first;
      if (!onMap) { render(); window.scrollTo(0, y); } // карту не перерисовываем при фоновом обновлении
    }).catch(function (e) {
      if (e.code === 'AUTH') return;
      if (!first) { toast('Не удалось обновить данные: ' + e.message, true); return; } // остаёмся на текущем экране
      app.innerHTML = '<div class="loading">Не удалось загрузить данные: ' + esc(e.message) + '<br><br><button class="btn" onclick="location.reload()">Повторить</button></div>';
    }).then(function () { loading = null; });
    return loading;
  }
  function refresh() { return load(); }

  /* ---------- каркас ---------- */
  function route() { var v = (location.hash || '').replace(/^#\/?/, '') || 'dashboard'; return VIEWS.some(function (x) { return x[0] === v; }) ? v : 'dashboard'; }

  function render() {
    if (!S.me) return renderLogin();
    var v = route();
    var nav = VIEWS.filter(function (x) { return !x[2] || isAdmin(); }).map(function (x) {
      return '<a href="#/' + x[0] + '" class="' + (v === x[0] ? 'on' : '') + '">' + icon(x[0]) + x[1] + '</a>';
    }).join('');
    var where = S.me.role === 'coord' ? 'Зона ' + S.me.zone + ' · ' + CRM.ZONES[S.me.zone] : S.me.okrug ? okrugName(S.me.okrug) : 'Весь ЮАО';
    app.innerHTML =
      '<div class="topbar"><button class="btn icon-only" id="menuBtn" aria-label="Меню">' + icon('menu') + '</button><b>' + esc(VIEWS.filter(function (x) { return x[0] === v; })[0][1]) + '</b></div>' +
      '<div class="layout"><aside class="side" id="side">' +
      '<div class="brand"><div class="brand-mark">ЮАО</div><div><b>CRM кампании</b><span>Выборы 2027</span></div></div>' +
      '<nav class="nav">' + nav + '</nav>' +
      '<div class="side-foot"><b>' + esc(S.me.name) + '</b>' + esc(CRM.ROLES[S.me.role]) + ' · ' + esc(where) + '</div>' +
      '</aside><main class="main" id="main"></main></div>';
    $('#menuBtn').onclick = function () { $('#side').classList.toggle('open'); };
    $all('.nav a').forEach(function (a) { a.onclick = function () { $('#side').classList.remove('open'); }; });
    var main = $('#main');
    if (DEMO) main.insertAdjacentHTML('afterbegin', '<div class="demo-banner">Демо-режим: данные хранятся только в этом браузере. Чтобы подключить общий сервер (Google Таблицу), см. инструкцию.</div>');
    var box = document.createElement('div'); main.appendChild(box);
    ({ passport: viewPassport, uik: viewUik, interviews: viewInterviews, media: viewMedia, dashboard: viewDashboard, map: viewMap, okrugs: viewOkrugs, candidates: viewCandidates, events: viewEvents, kmb: viewKmb, team: viewTeam, plan: viewPlan, backup: viewBackup, profile: viewProfile })[v](box);
  }
  window.addEventListener('hashchange', function () { if (S.me) render(); });

  function monthSelect(id, val, withAll) {
    return '<select class="input" id="' + id + '" aria-label="Месяц">' + (withAll ? '<option value="">Все месяцы</option>' : '') +
      campaignMonths().map(function (m) {
        return '<option value="' + m + '"' + (m === val ? ' selected' : '') + '>' + monthName(m) + '</option>';
      }).join('') + '</select>';
  }
  function modeSwitch() {
    return '<div class="seg" role="group" aria-label="Период">' + [['month', 'За месяц'], ['cum', 'Нарастающим итогом']].map(function (x) {
      return '<button type="button" class="' + (UI.mode === x[0] ? 'on' : '') + '" data-mode="' + x[0] + '" aria-pressed="' + (UI.mode === x[0]) + '">' + x[1] + '</button>';
    }).join('') + '</div>';
  }
  function bindPeriod(box, after) {
    var ms = $('#mSel', box); if (ms) ms.onchange = function (e) { UI.month = e.target.value; after(); };
    $all('[data-mode]', box).forEach(function (b) { b.onclick = function () { UI.mode = b.dataset.mode; after(); }; });
  }
  function periodLabel() { return UI.mode === 'cum' ? 'с начала кампании по ' + monthName(UI.month) : monthName(UI.month); }

  function okrugOptions(sel, opts) {
    opts = opts || {};
    var allowed = opts.all ? S.okrugs.map(function (o) { return o.id; }) : myOkrugs();
    var html = opts.empty ? '<option value="">' + esc(opts.empty) + '</option>' : '';
    Object.keys(CRM.ZONES).forEach(function (z) {
      var list = S.okrugs.filter(function (o) { return o.zone === z && allowed.indexOf(o.id) >= 0; });
      if (!list.length) return;
      html += '<optgroup label="' + z + ' · ' + CRM.ZONES[z] + '">' + list.map(function (o) {
        return '<option value="' + o.id + '"' + (o.id === sel ? ' selected' : '') + '>' + esc(o.name) + '</option>';
      }).join('') + '</optgroup>';
    });
    return html;
  }

  function bar(r, cls) { return '<div class="bar ' + (cls || '') + '"><i style="width:' + Math.round(Math.min(1, r || 0) * 100) + '%"></i></div>'; }
  function frac(a, b) { return '<span class="nowrap">' + fmt(a) + (b ? ' / ' + fmt(b) : '') + '</span>'; }

  /* ---------- модальные окна ---------- */
  function modal(title, body, foot, wide) {
    var bg = document.createElement('div');
    bg.className = 'modal-bg';
    bg.innerHTML = '<div class="modal' + (wide ? ' wide' : '') + '" role="dialog"><div class="modal-h"><h2>' + esc(title) + '</h2><button class="x" aria-label="Закрыть">' + icon('x') + '</button></div>' +
      '<div class="modal-b">' + body + '</div>' + (foot ? '<div class="modal-f">' + foot + '</div>' : '') + '</div>';
    document.body.appendChild(bg);
    requestAnimationFrame(function () { bg.classList.add('in'); });
    var f0 = $('input:not([type=hidden]):not([disabled]),select,textarea', bg); if (f0 && window.matchMedia('(pointer: fine)').matches) setTimeout(function () { f0.focus(); }, 60);
    var close = function () { bg.remove(); document.removeEventListener('keydown', onKey); };
    var onKey = function (e) { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    $('.x', bg).onclick = close;
    bg.addEventListener('mousedown', function (e) { if (e.target === bg) close(); });
    return { el: bg, close: close };
  }
  function confirmBox(text, okText) {
    return new Promise(function (res) {
      var m = modal('Подтвердите', '<p style="margin:0">' + esc(text) + '</p>', '<button class="btn" data-no>Отмена</button><button class="btn primary" data-yes>' + esc(okText || 'Да') + '</button>');
      $('[data-no]', m.el).onclick = function () { m.close(); res(false); };
      $('[data-yes]', m.el).onclick = function () { m.close(); res(true); };
    });
  }
  function formData(form) {
    var o = {};
    $all('[name]', form).forEach(function (el) { o[el.name] = el.type === 'checkbox' ? el.checked : el.value; });
    return o;
  }
  function busy(btn, on) { if (!btn) return; btn.disabled = on; if (on) { btn.dataset.t = btn.textContent; btn.textContent = 'Сохраняем…'; } else if (btn.dataset.t) btn.textContent = btn.dataset.t; }

  /* ================= СВОДКА ================= */
  function sumItems(list, key) {
    var r = { fact: 0, plan: 0, now: 0, n: 0 };
    list.forEach(function (e) { var i = e.by[key]; if (!i) return; r.fact += i.fact; r.plan += i.plan; r.now += i.now != null ? i.now : (e.note === 'месяц ещё не начался' ? 0 : i.plan); r.n++; });
    return r;
  }

  function viewDashboard(box) {
    var m = UI.month, all = S.okrugs, mode = UI.mode;
    var ev = {}; all.forEach(function (o) { ev[o.id] = evalOkrug(o.id, m, mode); });
    var list = all.map(function (o) { return ev[o.id]; });
    var lights = { green: 0, yellow: 0, red: 0, grey: 0 };
    list.forEach(function (e) { lights[e.color]++; });
    var date = refDate(m);
    var coords = Object.keys(CRM.ZONES).filter(function (z) { return coordOf(z).length; }).length;
    var kmbAll = all.reduce(function (s2, o) { return s2 + kmbTotal(o.id); }, 0);
    var kmbTarget = S.plan.reduce(function (s2, x) { return s2 + +x.kmb; }, 0) * all.length;
    var kpi = function (l, v, of, sub, r) {
      return '<div class="card kpi"><div class="l">' + l + '</div><div class="v">' + v + (of != null ? ' <span class="muted">/ ' + of + '</span>' : '') + '</div>' +
        (sub ? '<div class="sub">' + sub + '</div>' : '') + (r != null ? '<div class="bar"><i class="' + colorOf(r) + '" style="width:' + Math.round(Math.min(1, r) * 100) + '%"></i></div>' : '') + '</div>';
    };
    var needNow = function (x) { return date && x.now < x.plan ? 'сейчас нужно ' + fmt(x.now) : ''; };
    var cand = sumItems(list, 'cand'), meet = sumItems(list, 'meet'), act = sumItems(list, 'act'), kmb = sumItems(list, 'kmb');
    var interns = sumItems(list, 'intern');

    var zones = Object.keys(CRM.ZONES).map(function (z) {
      var zl = all.filter(function (o) { return o.zone === z; }).map(function (o) { return ev[o.id]; });
      var sc = zl.filter(function (e) { return e.ratio != null; });
      var ratio = sc.length ? sc.reduce(function (s2, e) { return s2 + e.ratio; }, 0) / sc.length : null;
      var c = sumItems(zl, 'cand'), i = sumItems(zl, 'intern'), me = sumItems(zl, 'meet'), ac = sumItems(zl, 'act'), k = sumItems(zl, 'kmb');
      var co = coordOf(z).map(function (u) { return esc(u.name); }).join(', ') || '<span class="pill bad">координатора нет</span>';
      return '<tr><td><span class="dot c-' + colorOf(ratio) + '"></span> <b>' + z + '</b> ' + CRM.ZONES[z] + '<div class="sub">' + co + '</div></td>' +
        '<td class="num">' + (ratio == null ? '—' : Math.round(ratio * 100) + '%') + '</td>' +
        '<td class="num">' + frac(i.fact, i.plan) + '</td><td class="num">' + frac(c.fact, c.plan) + '</td>' +
        '<td class="num">' + frac(me.fact, me.plan) + '</td><td class="num">' + frac(ac.fact, ac.plan) + '</td><td class="num">' + frac(k.fact, k.plan) + '</td></tr>';
    }).join('');

    var cum = 0, cumPlan = 0, maxv = 1;
    var rows = S.plan.map(function (pl) {
      var f = 0; all.forEach(function (o) { f += (S.stats[o.id] || { kmb: {} }).kmb[pl.month] || 0; });
      cum += f; cumPlan += +pl.kmb * all.length; maxv = Math.max(maxv, cumPlan, cum);
      return { m: pl.month, f: f, plan: +pl.kmb * all.length, cum: cum, cumPlan: cumPlan };
    });
    var chart = rows.map(function (r) {
      var future = r.m > curMonth(), v = mode === 'cum' ? r.cum : r.f, pv = mode === 'cum' ? r.cumPlan : r.plan, mx = mode === 'cum' ? maxv : Math.max.apply(null, rows.map(function (x) { return Math.max(x.plan, x.f); }));
      return '<tr' + (r.m === m ? ' class="sel"' : '') + '><td class="nowrap">' + monthName(r.m) + '</td><td style="width:55%"><div class="bar duo"><i class="pl" style="width:' + (pv / mx * 100) + '%"></i><i style="width:' + (future ? 0 : v / mx * 100) + '%"></i></div></td>' +
        '<td class="num">' + (future ? '<span class="muted">—</span>' : fmt(v)) + '</td><td class="num muted">' + fmt(pv) + '</td></tr>';
    }).join('');

    box.innerHTML =
      '<div class="head"><div><h1>Сводка по ЮАО</h1><div class="sub">План из презентации: ' + esc(periodLabel()) + (date ? ', оценка ' + (m === curMonth() ? 'на сегодня' : 'на конец месяца') : ', месяц ещё не начался') + '</div></div>' +
      '<div class="tools">' + modeSwitch() + monthSelect('mSel', m) + '</div></div>' +
      '<div class="grid kpis k6">' +
      kpi('Координаторы', coords, CAMP.coordinators, 'срок ' + dateRu(CAMP.team), date ? share(coords, CAMP.coordinators * lin(date, CAMP.start, CAMP.team) || 1) : null) +
      kpi('Стажёры', interns.fact, interns.plan, 'срок ' + dateRu(CAMP.team), date ? share(interns.fact, interns.plan * lin(date, CAMP.start, CAMP.team) || 1) : null) +
      kpi('Кандидаты', cand.fact, cand.plan, needNow(cand) || 'все к ' + dateRu(CAMP.cand), date ? share(cand.fact, cand.now) : null) +
      kpi('Встречи', fmt(meet.fact), fmt(meet.plan), needNow(meet) || (meet.plan ? '' : 'нет в плане'), date && meet.now ? share(meet.fact, meet.now) : null) +
      kpi('Акции', fmt(act.fact), fmt(act.plan), needNow(act) || (act.plan ? '' : 'нет в плане'), date && act.now ? share(act.fact, act.now) : null) +
      kpi('КМБ', fmt(kmb.fact), fmt(kmb.plan), needNow(kmb) || (kmb.plan ? '' : 'нет в плане'), date && kmb.now ? share(kmb.fact, kmb.now) : null) +
      '</div>' +
      '<div class="grid kpis k4">' +
      [['green', 'Выполняют план'], ['yellow', 'Отстают'], ['red', 'Провал'], ['grey', 'Нет оценки']].map(function (x) {
        return '<div class="card kpi" data-go-map><div class="l"><span class="dot c-' + x[0] + '"></span> ' + x[1] + '</div><div class="v">' + lights[x[0]] + '</div><div class="sub">округов из ' + all.length + '</div></div>';
      }).join('') + '</div>' +
      '<div class="tbl-wrap" style="margin-bottom:var(--s4)"><table class="tbl"><thead><tr><th>Зона и координатор</th><th class="num">План</th><th class="num">Стажёры</th><th class="num">Кандидаты</th><th class="num">Встречи</th><th class="num">Акции</th><th class="num">КМБ</th></tr></thead><tbody>' + zones + '</tbody></table></div>' +
      '<div class="card"><h2>КМБ по ЮАО ' + (mode === 'cum' ? 'нарастающим итогом' : 'по месяцам') + '</h2><div class="legend inline"><div><span class="dot" style="background:var(--accent)"></span> факт</div><div><span class="dot c-grey"></span> план</div><div class="sub">всего в базе: ' + fmt(kmbAll) + ' из ' + fmt(kmbTarget) + ' к ЕДГ</div></div>' +
      '<table class="tbl"><tbody>' + chart + '</tbody></table></div>';
    bindPeriod(box, render);
    $all('[data-go-map]', box).forEach(function (el) { el.onclick = function () { UI.layer = 'traffic'; location.hash = '#/map'; }; });
  }

  /* ================= КАРТА ================= */
  var LAYERS = [
    ['traffic', 'Светофор: выполнение плана'],
    ['cand', 'Кандидаты по округам'],
    ['interns', 'Стажёры'],
    ['events', 'Мероприятия за месяц'],
    ['kmb', 'КМБ нарастающим итогом']
  ];
  var COLORS = { green: '#2e9d5b', yellow: '#e5ad1f', red: '#d6453d', grey: '#9aa3ae' };

  function okrugMetric(oid) {
    var o = okrug(oid), e = evalOkrug(oid, UI.month, UI.mode);
    if (UI.layer === 'traffic') return { color: e.color, label: e.ratio == null ? '—' : Math.round(e.ratio * 100) + '%' };
    if (UI.layer === 'cand') { var c = e.by.cand; return { color: c.score == null ? (c.fact >= c.plan ? 'green' : 'grey') : colorOf(c.score), label: c.fact + '/' + c.plan }; }
    if (UI.layer === 'interns') { var i = internOf(oid); return { color: i ? 'green' : e.by.intern.score == null ? 'grey' : colorOf(e.by.intern.score), label: i ? i.name.split(' ')[0] : 'нет' }; }
    if (UI.layer === 'events') {
      var me = e.by.meet, ac = e.by.act;
      if (!me && !ac) return { color: 'grey', label: '—' };
      var f = (me ? me.fact : 0) + (ac ? ac.fact : 0), n = (me ? me.now : 0) + (ac ? ac.now : 0), pl = (me ? me.plan : 0) + (ac ? ac.plan : 0);
      return { color: refDate(UI.month) && n ? colorOf(share(f, n)) : 'grey', label: f + '/' + pl };
    }
    var k = e.by.kmb;
    if (!k) return { color: 'grey', label: '—' };
    return { color: k.score == null ? 'grey' : colorOf(k.score), label: fmt(k.fact) };
  }

  function legendHtml() {
    var L = {
      traffic: [['green', '≥ 90% плана на дату'], ['yellow', '50–90%: отстают'], ['red', 'меньше 50%: провал'], ['grey', 'месяц ещё не начался']],
      cand: [['green', 'идут по графику'], ['yellow', 'отстают'], ['red', 'сильно отстают']],
      interns: [['green', 'стажёр назначен'], ['yellow', 'нет, срок близко'], ['red', 'нет, срок прошёл или почти']],
      events: [['green', '≥ 90% встреч и акций'], ['yellow', '50–90%'], ['red', 'меньше 50%'], ['grey', 'нет в плане']],
      kmb: [['green', '≥ 90% плана КМБ'], ['yellow', '50–90%'], ['red', 'меньше 50%'], ['grey', 'нет в плане']]
    }[UI.layer];
    var extra = {
      traffic: 'Среднее по всем пунктам плана: стажёр и координатор (до 30.11), кандидаты (стажёр к 30.11, все к 01.02), встречи, акции и КМБ. В текущем месяце план считается пропорционально прошедшим дням.',
      cand: 'Подпись: кандидатов / мандатов. Цвет: сравнение с графиком на дату. Стажёр тоже кандидат, внесите его в список.',
      interns: 'Подпись: фамилия стажёра.',
      events: 'Подпись: проведено / план (встречи + акции).',
      kmb: 'Подпись: контактов в базе за выбранный период.'
    }[UI.layer];
    return '<div class="legend">' + L.map(function (x) { return '<div><span class="dot c-' + x[0] + '"></span>' + x[1] + '</div>'; }).join('') + '</div><p class="sub" style="margin:var(--s3) 0 0">' + extra + '</p>';
  }

  function viewMap(box) {
    box.innerHTML =
      '<div class="head"><div><h1>Карта ЮАО</h1><div class="sub">Избирательные округа муниципальных выборов</div></div><div class="tools">' + modeSwitch() + monthSelect('mSel', UI.month) + '</div></div>' +
      '<div class="map-wrap"><div id="map"></div><div class="map-side">' +
      '<div class="card"><h3>Слой карты</h3><div class="layers">' + LAYERS.map(function (l) {
        return '<label class="' + (UI.layer === l[0] ? 'on' : '') + '"><input type="radio" name="layer" value="' + l[0] + '"' + (UI.layer === l[0] ? ' checked' : '') + '>' + l[1] + '</label>';
      }).join('') + '</div></div>' +
      '<div class="card" id="legend">' + legendHtml() + '</div>' +
      '<div class="card okr-info" id="okrInfo"><p class="muted" style="margin:0">Нажмите на округ, чтобы увидеть детали.</p></div>' +
      '<p class="sub">Границы округов построены по схемам избирательных округов, действовавшим на выборах 2022 года (решения советов депутатов, архив Мосгоризбиркома): каждый дом из перечня найден на карте OpenStreetMap.</p>' +
      '</div></div>';
    bindPeriod(box, function () { $all('[data-mode]', box).forEach(function (b) { b.classList.toggle('on', b.dataset.mode === UI.mode); b.setAttribute('aria-pressed', b.dataset.mode === UI.mode); }); paintMap(); if (UI.selOkrug) showOkrugInfo(UI.selOkrug); });
    $all('input[name=layer]', box).forEach(function (r) {
      r.onchange = function () {
        UI.layer = r.value;
        $all('.layers label', box).forEach(function (l) { l.classList.toggle('on', $('input', l).checked); });
        $('#legend').innerHTML = legendHtml();
        paintMap();
      };
    });
    loadGeo().then(function () { buildMap(); if (UI.selOkrug) showOkrugInfo(UI.selOkrug); }).catch(fail);
  }

  function geoProps(id) { var f = S.geo && S.geo.features.filter(function (x) { return x.properties.id === id; })[0]; return f ? f.properties : {}; }
  function loadGeo() {
    if (S.geo) return Promise.resolve(S.geo);
    return fetch('data/yuao.geojson?v=' + (window.CRM_BUILD || '')).then(function (r) { return r.json(); }).then(function (g) { S.geo = g; return g; });
  }

  function loadUik() {
    if (S.uik) return Promise.resolve(S.uik);
    return fetch('data/uik-2026.json?v=' + (window.CRM_BUILD || '')).then(function (r) { if (!r.ok) throw new Error('Нет файла участков'); return r.json(); }).then(function (d) {
      S.uik = d; S.uikBy = {}; d.uiks.forEach(function (u) { S.uikBy[u.number] = u; }); return d;
    });
  }
  function uikPopup(u) {
    var okr = uikMain(u).map(function (id) { return '<span class="dot" style="background:' + okrColor(id) + '"></span> <b>' + esc(okrugName(id)) + '</b>' + (Object.keys(u.okrugs).length > 1 ? ' (' + u.okrugs[id] + ' д.)' : ''); }).join('<br>');
    return '<b>УИК № ' + u.number + '</b><br>' + esc(u.place) + '<br><span class="sub">' + esc(u.address) + (u.phone ? ', ' + esc(u.phone) : '') + '</span><br>Округ: ' + (okr || '—') + '<br>Домов: ' + u.houses;
  }
  // Цвет избирательного округа внутри района: №1 синий, №2 оранжевый, №3 зелёный
  var OKR_COLORS = { 1: '#3b7dd8', 2: '#f28e2b', 3: '#2fa36b' };
  function okrColor(id) { return OKR_COLORS[+String(id).split('-').pop()] || '#888'; }
  function uikMain(u) { return Object.keys(u.okrugs).sort(function (a, b) { return u.okrugs[b] - u.okrugs[a]; }); }

  function buildMap() {
    if (typeof L === 'undefined') { $('#map').innerHTML = '<div class="empty">Не загрузилась библиотека карты. Проверьте интернет.</div>'; return; }
    map = L.map('map', { zoomControl: true, attributionControl: true }).setView([55.62, 37.64], 11);
    map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18, attribution: '© участники OpenStreetMap'
    }).addTo(map);
    var okr = { type: 'FeatureCollection', features: S.geo.features.filter(function (f) { return f.properties.kind === 'okrug'; }) };
    var dis = { type: 'FeatureCollection', features: S.geo.features.filter(function (f) { return f.properties.kind === 'district'; }) };
    geoLayer = L.geoJSON(okr, {
      style: styleOkrug,
      onEachFeature: function (f, layer) {
        layer.on('click', function () { UI.selOkrug = f.properties.id; paintMap(); showOkrugInfo(f.properties.id); });
        layer.bindTooltip(function () { return esc(okrugName(f.properties.id)); }, { sticky: true });
      }
    }).addTo(map);
    districtLayer = L.geoJSON(dis, { style: { color: '#1d2733', weight: 2.2, fill: false, opacity: .75 }, interactive: false }).addTo(map);
    labelLayer = L.layerGroup().addTo(map);
    map.fitBounds(geoLayer.getBounds(), { padding: [10, 10] });
    paintMap();
  }

  function styleOkrug(f) {
    var mt = okrugMetric(f.properties.id), sel = UI.selOkrug === f.properties.id;
    return { color: sel ? '#0a8fd8' : '#ffffff', weight: sel ? 3 : 1.2, fillColor: COLORS[mt.color], fillOpacity: .62, dashArray: sel ? null : '3 3' };
  }

  function paintMap() {
    if (!map || !geoLayer) return;
    geoLayer.setStyle(styleOkrug);
    labelLayer.clearLayers();
    S.geo.features.forEach(function (f) {
      if (f.properties.kind !== 'okrug') return;
      var lab = '<span>' + esc(okrugMetric(f.properties.id).label) + '</span>';
      L.marker(f.properties.lp, { interactive: false, icon: L.divIcon({ className: 'okr-label', html: lab, iconSize: [0, 0] }) }).addTo(labelLayer);
    });
  }

  function okrugCardHtml(oid) {
    var o = okrug(oid), m = UI.month, e = evalOkrug(oid, m, UI.mode);
    var intern = internOf(oid), coords = coordOf(o.zone);
    var members = S.users.filter(function (u) { return u.role === 'member' && u.okrug === oid && u.active; });
    var row = function (i) {
      var right = i.key === 'intern' || i.key === 'coord' ? (i.fact ? 'есть' : 'нет') : frac(i.fact, i.plan);
      var hint = i.need || (i.now != null && i.now < i.plan && refDate(m) ? 'сейчас нужно ' + fmt(i.now) : '');
      return '<div class="stat"><span><span class="dot c-' + colorOf(i.score) + '"></span> ' + i.label + (hint ? '<div class="sub">' + hint + '</div>' : '') + '</span><span>' + right + '</span></div>';
    };
    return '<h2 style="margin-bottom:2px">' + esc(o.name) + '</h2><div class="sub" style="margin-bottom:var(--s3)">Зона ' + o.zone + ' (' + CRM.ZONES[o.zone] + '), ' + o.mandates + ' мандатов, ≈' + fmt(o.voters) + ' избирателей</div>' +
      '<div class="stat"><span>Стажёр</span><span>' + (intern ? esc(intern.name) + (intern.phone ? '<div class="sub">' + esc(intern.phone) + '</div>' : '') : '<span class="pill bad">не назначен</span>') + '</span></div>' +
      '<div class="stat"><span>Координатор</span><span>' + (coords.map(function (u) { return esc(u.name); }).join(', ') || '<span class="muted">—</span>') + '</span></div>' +
      (members.length ? '<div class="stat"><span>Команда</span><span>' + members.map(function (u) { return esc(u.name); }).join(', ') + '</span></div>' : '') +
      '<h3 style="margin-top:var(--s4)"><span class="dot c-' + e.color + '"></span> План: ' + (e.ratio == null ? '—' : Math.round(e.ratio * 100) + '%') + ' <span class="sub">' + esc(periodLabel()) + ', ' + esc(e.note) + '</span></h3>' +
      e.items.map(row).join('') +
      (o.note ? '<p class="small" style="white-space:pre-wrap">' + esc(o.note) + '</p>' : '') +
      (geoProps(oid).source ? '<p class="sub">Схема: ' + esc(geoProps(oid).source) + '</p>' : '') +
      '<div class="actions">' +
      '<button class="btn sm" data-go="passport">Паспорт</button><button class="btn sm" data-go="candidates">Кандидаты</button><button class="btn sm" data-go="events">Мероприятия</button><button class="btn sm" data-go="kmb">КМБ</button>' +
      (canEdit(oid, 'events') ? '<button class="btn sm primary" data-add-ev>' + icon('plus') + 'Мероприятие</button>' : '') +
      ((isAdmin() || (S.me.role === 'coord' && S.me.zone === o.zone)) ? '<button class="btn sm" data-edit-okr>Изменить</button>' : '') +
      '</div>';
  }

  function bindOkrugCard(root, oid) {
    $all('[data-go]', root).forEach(function (b) {
      b.onclick = function () {
        var v = b.dataset.go;
        if (v === 'candidates') UI.candF.okrug = oid;
        if (v === 'passport') UI.pOkrug = oid;
        if (v === 'events') { UI.evF.okrug = oid; UI.evF.month = UI.mode === 'cum' ? '' : UI.month; }
        if (v === 'kmb') { UI.kmbF.okrug = oid; UI.kmbF.offset = 0; }
        $all('.modal-bg').forEach(function (x) { x.remove(); });
        location.hash = '#/' + v;
      };
    });
    var a = $('[data-add-ev]', root); if (a) a.onclick = function () { editEvent({ okrug: oid, date: todayMsk(), type: 'meet', status: 'planned' }); };
    var e = $('[data-edit-okr]', root); if (e) e.onclick = function () { editOkrug(oid); };
  }

  function showOkrugInfo(oid) {
    var box = $('#okrInfo'); if (!box) return;
    box.innerHTML = okrugCardHtml(oid);
    bindOkrugCard(box, oid);
    if (window.innerWidth < 900) box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function editOkrug(oid) {
    var o = okrug(oid), adm = isAdmin();
    var m = modal('Округ: ' + o.name,
      '<form id="okF">' + (adm ? '<label class="f"><span>Название</span><input class="input" name="name" value="' + esc(o.name) + '"></label>' +
        '<div class="row2"><label class="f"><span>Мандатов</span><input class="input" name="mandates" type="number" min="1" value="' + esc(o.mandates) + '"></label>' +
        '<label class="f"><span>Избирателей (оценка)</span><input class="input" name="voters" type="number" value="' + esc(o.voters) + '"></label></div>' : '') +
      '<label class="f"><span>Заметка по округу</span><textarea class="input" name="note">' + esc(o.note) + '</textarea></label></form>',
      '<button class="btn" data-c>Отмена</button><button class="btn primary" data-s>Сохранить</button>');
    $('[data-c]', m.el).onclick = m.close;
    $('[data-s]', m.el).onclick = function (ev) {
      var it = formData($('#okF', m.el)); it.id = oid; busy(ev.target, true);
      api('okrugSave', { item: it }).then(function () { m.close(); toast('Сохранено'); return refresh(); }).catch(function (e) { busy(ev.target, false); fail(e); });
    };
  }

  /* ================= ОКРУГА ================= */
  function viewOkrugs(box) {
    var m = UI.month;
    var cell = function (i) { return '<td class="num">' + (i ? '<span class="dot c-' + colorOf(i.score) + '"></span> ' + frac(i.fact, i.plan) : '<span class="muted">—</span>') + '</td>'; };
    var rows = S.okrugs.map(function (o) {
      var e = evalOkrug(o.id, m, UI.mode), i = internOf(o.id);
      return '<tr class="click" data-o="' + o.id + '"><td class="num"><b>' + (e.ratio == null ? '—' : Math.round(e.ratio * 100) + '%') + '</b></td><td><span class="dot c-' + e.color + '"></span> <b>' + esc(o.name) + '</b><div class="sub">' + o.zone + ' ' + CRM.ZONES[o.zone] + '</div></td>' +
        '<td>' + (i ? esc(i.name) : '<span class="pill bad">нет</span>') + '</td>' +
        cell(e.by.cand) + cell(e.by.meet) + cell(e.by.act) + cell(e.by.kmb) + '</tr>';
    }).join('');
    box.innerHTML = '<div class="head"><div><h1>Избирательные округа</h1><div class="sub">33 округа, 162 мандата. ' + esc(periodLabel()) + '</div></div><div class="tools">' + modeSwitch() + monthSelect('mSel', m) + '</div></div>' +
      '<div class="tbl-wrap"><table class="tbl"><thead><tr><th class="num">План</th><th>Округ</th><th>Стажёр</th><th class="num">Кандидаты</th><th class="num">Встречи</th><th class="num">Акции</th><th class="num">КМБ</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
    bindPeriod(box, render);
    $all('tr[data-o]', box).forEach(function (tr) {
      tr.onclick = function () {
        var oid = tr.dataset.o, md = modal('Округ', '<div class="okr-info">' + okrugCardHtml(oid) + '</div>');
        $('.modal-h h2', md.el).textContent = okrugName(oid);
        $('.okr-info h2', md.el).remove();
        bindOkrugCard(md.el, oid);
      };
    });
  }


  /* ================= ПАСПОРТА ОКРУГОВ ================= */
  var PASS_FIELDS = [['objects', 'Ключевые объекты', 'Школы, поликлиники, ТЦ, парки, точки сбора жителей'], ['problems', 'Проблемы округа', 'Что волнует жителей: дороги, стройки, транспорт, ЖКХ'],
    ['leaders', 'Лидеры мнений', 'Активные жители, председатели советов домов, админы чатов'], ['competitors', 'Конкуренты', 'Действующие депутаты, другие кандидаты и их ресурс'],
    ['features', 'Особенности', 'Состав жителей, настроения, что работает в агитации']];
  function loadAddr() {
    if (S.addr) return Promise.resolve(S.addr);
    return fetch('data/okruga-2022.json?v=' + (window.CRM_BUILD || '')).then(function (r) { return r.json(); }).then(function (d) { S.addr = d; return d; });
  }
  function loadScript(url, global) {
    if (window[global]) return Promise.resolve(window[global]);
    return new Promise(function (ok, no) {
      var sc = document.createElement('script'); sc.src = url;
      sc.onload = function () { window[global] ? ok(window[global]) : no(new Error('Библиотека не загрузилась')); };
      sc.onerror = function () { no(new Error('Не удалось загрузить библиотеку — проверьте интернет')); };
      document.head.appendChild(sc);
    });
  }

  // Все сведения по округу в одном объекте — для экрана, Word и Excel
  function passportData(oid) {
    var o = okrug(oid), pass = S.passports.filter(function (p) { return p.okrug === oid; })[0] || {};
    var em = evalOkrug(oid, UI.month, 'month'), ec = evalOkrug(oid, UI.month, 'cum');
    var intern = internOf(oid), coords = coordOf(o.zone);
    var cands = S.candidates.filter(function (c) { return c.okrug === oid; }).sort(function (a, b) { return a.fio.localeCompare(b.fio); });
    var inScopeOk = myOkrugs().indexOf(oid) >= 0;
    var uiks = (S.uik ? S.uik.uiks : []).filter(function (u) { return u.okrugs[oid]; }).map(function (u) {
      return { number: u.number, place: u.place, address: u.address, phone: u.phone, houses: u.okrugs[oid], shared: Object.keys(u.okrugs).length > 1 };
    });
    var addr = S.addr && S.addr[oid];
    var st = S.stats[oid] || { kmb: {}, ev: {} }, kmbAll = 0, evAll = [0, 0];
    Object.keys(st.kmb).forEach(function (k) { kmbAll += st.kmb[k]; });
    Object.keys(st.ev).forEach(function (k) { evAll[0] += st.ev[k][0]; evAll[1] += st.ev[k][1]; });
    var item = function (e, key) { var i = e.by[key]; return i ? i.fact + (i.plan ? ' из ' + i.plan : '') : '—'; };
    return {
      o: o, pass: pass,
      main: [['Избирательный округ', o.name], ['Район', o.district], ['Зона', o.zone + ' — ' + CRM.ZONES[o.zone]], ['Мандатов', o.mandates],
        ['Избирателей (по схеме округов)', fmt(o.voters)], ['Координатор зоны', coords.map(function (u) { return u.name + (u.phone ? ', ' + u.phone : ''); }).join('; ') || 'не назначен'],
        ['Стажёр', intern ? intern.name + (intern.phone ? ', ' + intern.phone : '') : 'не назначен'], ['Схема округа', addr ? addr.source : '—']],
      plan: [['Выполнение плана за ' + monthName(UI.month), em.ratio == null ? '—' : Math.round(em.ratio * 100) + '%'], ['Нарастающим итогом', ec.ratio == null ? '—' : Math.round(ec.ratio * 100) + '%'],
        ['Кандидаты', item(em, 'cand')], ['Встречи за месяц', item(em, 'meet')], ['Акции за месяц', item(em, 'act')], ['КМБ за месяц', item(em, 'kmb')],
        ['КМБ всего в базе', fmt(kmbAll)], ['Проведено встреч / акций за всё время', evAll[0] + ' / ' + evAll[1]]],
      cands: inScopeOk ? cands : null, candCount: (S.stats[oid] || {}).cand || 0,
      media: S.media.filter(function (m) { return m.okrug === oid; }),
      uiks: uiks, streets: addr ? addr.streets : []
    };
  }

  function viewPassport(box) {
    var oid = UI.pOkrug || UI.selOkrug || myOkrugs()[0] || S.okrugs[0].id;
    UI.pOkrug = oid;
    box.innerHTML = '<div class="head"><div><h1>Паспорт округа</h1><div class="sub">Справка по избирательному округу: территория, участки, команда, кандидаты, план</div></div><div class="tools">' +
      '<select class="input" id="pO">' + okrugOptions(oid, { all: true }) + '</select>' +
      '<button class="btn" id="pDoc">' + icon('doc') + 'Word</button><button class="btn" id="pDocD">' + icon('doc') + 'Word: весь район</button>' +
      '<button class="btn" id="pXls">' + icon('xls') + 'Excel</button><button class="btn" id="pXlsAll">' + icon('xls') + 'Excel: все 33 округа</button></div></div>' +
      '<div id="pBox"><div class="card empty">Загрузка…</div></div>';
    $('#pO').onchange = function (e) { UI.pOkrug = e.target.value; render(); };
    var run = function (btn, fn) { btn.disabled = true; var t = btn.innerHTML; btn.innerHTML = 'Готовлю файл…'; Promise.resolve().then(fn).then(function () { toast('Файл скачан'); }).catch(fail).then(function () { btn.disabled = false; btn.innerHTML = t; }); };
    $('#pDoc').onclick = function () { run(this, function () { return exportWord([oid], 'Паспорт — ' + okrugName(oid)); }); };
    $('#pDocD').onclick = function () { var d = okrug(oid).district; run(this, function () { return exportWord(S.okrugs.filter(function (o) { return o.district === d; }).map(function (o) { return o.id; }), 'Паспорт района ' + d); }); };
    $('#pXls').onclick = function () { run(this, function () { return exportExcel([oid], 'Паспорт — ' + okrugName(oid)); }); };
    $('#pXlsAll').onclick = function () { run(this, function () { return exportExcel(S.okrugs.map(function (o) { return o.id; }), 'Паспорта округов ЮАО'); }); };
    Promise.all([loadUik().catch(function () { }), loadAddr().catch(function () { })]).then(function () { drawPassport(oid); });
  }

  function kvTable(rows) { return '<table class="tbl kv"><tbody>' + rows.map(function (r) { return '<tr><th>' + esc(r[0]) + '</th><td>' + esc(r[1]) + '</td></tr>'; }).join('') + '</tbody></table>'; }

  function drawPassport(oid) {
    var box = $('#pBox'); if (!box) return;
    var d = passportData(oid), canEditP = myOkrugs().indexOf(oid) >= 0;
    var desc = PASS_FIELDS.map(function (f) { return '<div class="pf"><h3>' + f[1] + '</h3>' + (d.pass[f[0]] ? '<p>' + esc(d.pass[f[0]]) + '</p>' : '<p class="muted">не заполнено</p>') + '</div>'; }).join('');
    box.innerHTML =
      '<div class="grid two" style="margin-bottom:var(--s4)">' +
      '<div class="card"><h2>Основное</h2>' + kvTable(d.main) + '</div>' +
      '<div class="card"><h2>План и работа</h2>' + kvTable(d.plan) + '</div></div>' +
      '<div class="card" style="margin-bottom:var(--s4)"><div class="head" style="margin-bottom:var(--s3)"><h2 style="margin:0">Описание округа</h2>' +
      (canEditP ? '<button class="btn sm" id="pEdit">Изменить</button>' : '') + '</div>' + desc +
      (d.pass.updated ? '<p class="sub">Обновлено ' + dateRu(d.pass.updated) + (d.pass.updatedBy ? ', ' + esc(d.pass.updatedBy) : '') + '</p>' : '') + '</div>' +
      '<div class="card" style="margin-bottom:var(--s4)"><h2>Кандидаты (' + (d.cands ? d.cands.length : d.candCount) + ' из ' + d.o.mandates + ')</h2>' +
      (d.cands ? (d.cands.length ? '<div class="tbl-wrap" style="box-shadow:none"><table class="tbl"><thead><tr><th>ФИО</th><th>Статус</th><th class="num">Бюджет</th><th>Телефон</th></tr></thead><tbody>' +
        d.cands.map(function (c) { return '<tr><td>' + esc(c.fio) + '</td><td>' + esc(c.status) + '</td><td class="num">' + money(c.budget) + '</td><td class="nowrap">' + esc(c.phone) + '</td></tr>'; }).join('') + '</tbody></table></div>' : '<p class="muted">Кандидатов пока нет.</p>')
        : '<p class="muted">Список кандидатов этого округа видят руководитель, координатор зоны и стажёр округа.</p>') + '</div>' +
      '<div class="card" style="margin-bottom:var(--s4)"><h2>Медиа (' + d.media.length + ')</h2>' +
      (d.media.length ? kvTable(d.media.map(function (m) { return [CRM.MEDIA_KINDS[m.kind] + ', ' + m.network, (m.title || m.url) + (m.subscribers ? ' — ' + fmt(m.subscribers) + ' подп.' : '')]; })) : '<p class="muted">Каналов пока нет.</p>') + '</div>' +
      '<div class="card" style="margin-bottom:var(--s4)"><h2>Избирательные участки (' + d.uiks.length + ')</h2>' +
      (d.uiks.length ? '<div class="tbl-wrap" style="box-shadow:none"><table class="tbl"><thead><tr><th class="num">УИК</th><th>Пункт голосования</th><th class="num">Домов в округе</th></tr></thead><tbody>' +
        d.uiks.map(function (u) { return '<tr><td class="num"><b>' + u.number + '</b></td><td>' + esc(u.place) + '<div class="sub">' + esc(u.address) + (u.phone ? ', ' + esc(u.phone) : '') + (u.shared ? ' · участок частично в соседнем округе' : '') + '</div></td><td class="num">' + u.houses + '</td></tr>'; }).join('') + '</tbody></table></div>' : '<p class="muted">Нет данных.</p>') + '</div>' +
      '<div class="card"><h2>Территория: улицы и дома</h2>' + (d.streets.length ? d.streets.map(function (x) { return '<p class="small" style="margin:0 0 var(--s2)"><b>' + esc(x[0]) + ':</b> ' + esc(x[1]) + '</p>'; }).join('') : '<p class="muted">Нет данных.</p>') + '</div>';
    var e = $('#pEdit'); if (e) e.onclick = function () { editPassport(oid); };
  }

  function editPassport(oid) {
    var p = S.passports.filter(function (x) { return x.okrug === oid; })[0] || {};
    var m = modal('Описание: ' + okrugName(oid), '<form id="psF">' + PASS_FIELDS.map(function (f) {
      return '<label class="f"><span>' + f[1] + '</span><textarea class="input" name="' + f[0] + '" rows="3" placeholder="' + esc(f[2]) + '">' + esc(p[f[0]]) + '</textarea></label>';
    }).join('') + '</form>', '<button class="btn" data-c>Отмена</button><button class="btn primary" data-s>Сохранить</button>', true);
    $('[data-c]', m.el).onclick = m.close;
    $('[data-s]', m.el).onclick = function (ev) {
      var it = formData($('#psF', m.el)); it.okrug = oid; busy(ev.target, true);
      api('passportSave', { item: it }).then(function (rec) {
        S.passports = S.passports.filter(function (x) { return x.okrug !== oid; }).concat([rec]);
        m.close(); toast('Сохранено'); drawPassport(oid);
      }).catch(function (e) { busy(ev.target, false); fail(e); });
    };
  }

  function fileName(t) { return String(t).replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').slice(0, 80); }

  // Word (.docx): один или несколько паспортов, каждый с новой страницы
  function exportWord(ids, title) {
    return Promise.all([loadUik().catch(function () { }), loadAddr().catch(function () { }), loadScript('https://unpkg.com/docx@8.5.0/build/index.umd.js', 'docx')]).then(function (r) {
      var D = r[2], F = 'Arial';
      var P = function (text, o) { o = o || {}; return new D.Paragraph({ spacing: { after: o.after == null ? 80 : o.after }, pageBreakBefore: !!o.br, heading: o.h, children: [new D.TextRun({ text: String(text == null ? '' : text), bold: !!o.b, size: o.size || 20, font: F, color: o.color })] }); };
      var cell = function (t, head, w) { return new D.TableCell({ width: w ? { size: w, type: D.WidthType.PERCENTAGE } : undefined, shading: head ? { fill: 'E8EEF6' } : undefined, children: [P(t, { b: head, after: 0 })] }); };
      var table = function (head, rows, widths) {
        return new D.Table({ width: { size: 100, type: D.WidthType.PERCENTAGE }, rows: (head ? [new D.TableRow({ tableHeader: true, children: head.map(function (h, i) { return cell(h, true, widths && widths[i]); }) })] : [])
          .concat(rows.map(function (row) { return new D.TableRow({ children: row.map(function (c, i) { return cell(c, !head && i === 0, widths && widths[i]); }) }); })) });
      };
      var H = function (t) { return P(t, { b: true, size: 24, after: 120 }); };
      var body = [];
      ids.forEach(function (oid, n) {
        var d = passportData(oid);
        body.push(P('Паспорт избирательного округа', { br: n > 0, size: 20, color: '666666', after: 40 }));
        body.push(P(d.o.name, { b: true, size: 36, after: 60 }));
        body.push(P('Муниципальные выборы 2027 · ЮАО · сформирован ' + dateRu(todayMsk()), { size: 18, color: '666666', after: 240 }));
        body.push(H('Основное')); body.push(table(null, d.main, [40, 60])); body.push(P('', { after: 200 }));
        body.push(H('План и работа')); body.push(table(null, d.plan, [40, 60])); body.push(P('', { after: 200 }));
        body.push(H('Описание округа'));
        PASS_FIELDS.forEach(function (f) { body.push(P(f[1], { b: true, after: 40 })); body.push(P(d.pass[f[0]] || '—', { after: 140 })); });
        body.push(H('Кандидаты'));
        if (d.cands && d.cands.length) body.push(table(['ФИО', 'Статус', 'Бюджет', 'Телефон'], d.cands.map(function (c) { return [c.fio, c.status, c.budget ? fmt(c.budget) + ' ₽' : '—', c.phone || '']; }), [40, 20, 20, 20]));
        else body.push(P(d.cands ? 'Кандидатов пока нет.' : 'Всего кандидатов: ' + d.candCount + ' (список доступен руководителю, координатору и стажёру округа).'));
        body.push(P('', { after: 200 }));
        body.push(H('Медиа'));
        body.push(d.media.length ? table(['Канал', 'Тип и соцсеть', 'Подписчики'], d.media.map(function (m) { return [m.title || m.url, CRM.MEDIA_KINDS[m.kind] + ', ' + m.network, m.subscribers || '—']; }), [50, 30, 20]) : P('Каналов пока нет.'));
        body.push(P('', { after: 200 }));
        body.push(H('Избирательные участки (Госдума 2026)'));
        body.push(d.uiks.length ? table(['УИК', 'Пункт голосования', 'Домов в округе'], d.uiks.map(function (u) { return [String(u.number), u.place + ', ' + u.address + (u.phone ? ', ' + u.phone : '') + (u.shared ? ' (участок частично в соседнем округе)' : ''), String(u.houses)]; }), [12, 70, 18]) : P('Нет данных.'));
        body.push(P('', { after: 200 }));
        body.push(H('Территория: улицы и дома'));
        d.streets.forEach(function (x) { body.push(new D.Paragraph({ spacing: { after: 60 }, children: [new D.TextRun({ text: x[0] + ': ', bold: true, size: 18, font: F }), new D.TextRun({ text: x[1], size: 18, font: F })] })); });
      });
      var doc = new D.Document({ creator: 'CRM ЮАО', title: title, sections: [{ properties: { page: { margin: { top: 1000, bottom: 1000, left: 1100, right: 1000 } } }, children: body }] });
      return D.Packer.toBlob(doc);
    }).then(function (blob) { saveBlob(fileName(title) + '.docx', blob); });
  }

  // Excel (.xlsx): по одному округу — несколько листов; по всем — сводка + кандидаты + участки
  function exportExcel(ids, title) {
    return Promise.all([loadUik().catch(function () { }), loadAddr().catch(function () { }), loadScript('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js', 'XLSX')]).then(function (r) {
      var X = r[2], wb = X.utils.book_new();
      var sheet = function (name, aoa, widths) { var ws = X.utils.aoa_to_sheet(aoa); ws['!cols'] = (widths || []).map(function (w) { return { wch: w }; }); X.utils.book_append_sheet(wb, ws, name.slice(0, 31)); };
      var data = ids.map(passportData);
      if (ids.length === 1) {
        var d = data[0];
        sheet('Паспорт', [['Паспорт избирательного округа', d.o.name], []].concat(d.main, [[]], d.plan, [[]], PASS_FIELDS.map(function (f) { return [f[1], d.pass[f[0]] || '']; })), [36, 80]);
      } else {
        sheet('Сводка', [['Округ', 'Район', 'Зона', 'Мандатов', 'Избирателей', 'Координатор', 'Стажёр', 'Кандидатов', 'План месяца, %', 'Нарастающим, %', 'Встречи (мес.)', 'Акции (мес.)', 'КМБ (мес.)', 'КМБ всего', 'Медиа-каналов', 'УИК', 'Проблемы', 'Ключевые объекты']]
          .concat(data.map(function (d) {
            var g = function (k) { return (d.main.concat(d.plan).filter(function (x) { return x[0] === k; })[0] || [])[1]; };
            return [d.o.name, d.o.district, d.o.zone, +d.o.mandates, +d.o.voters, g('Координатор зоны'), g('Стажёр'), d.cands ? d.cands.length : d.candCount,
              g('Выполнение плана за ' + monthName(UI.month)), g('Нарастающим итогом'), g('Встречи за месяц'), g('Акции за месяц'), g('КМБ за месяц'), g('КМБ всего в базе'),
              d.media.length, d.uiks.map(function (u) { return u.number; }).join(', '), d.pass.problems || '', d.pass.objects || ''];
          })), [26, 22, 6, 9, 11, 26, 26, 10, 12, 12, 12, 12, 12, 10, 10, 30, 40, 40]);
      }
      var multi = ids.length > 1;
      var cands = [], uiks = [], streets = [], media = [];
      data.forEach(function (d) {
        (d.cands || []).forEach(function (c) { cands.push((multi ? [d.o.name] : []).concat([c.fio, c.status, +c.budget || '', c.phone || '', c.description || ''])); });
        d.uiks.forEach(function (u) { uiks.push((multi ? [d.o.name] : []).concat([u.number, u.place, u.address, u.phone, u.houses, u.shared ? 'да' : ''])); });
        d.streets.forEach(function (x) { streets.push((multi ? [d.o.name] : []).concat([x[0], x[1]])); });
        d.media.forEach(function (m) { media.push((multi ? [d.o.name] : []).concat([m.title || '', m.url || '', CRM.MEDIA_KINDS[m.kind], m.network, +m.subscribers || ''])); });
      });
      var pre = multi ? ['Округ'] : [];
      sheet('Кандидаты', [pre.concat(['ФИО', 'Статус', 'Бюджет, ₽', 'Телефон', 'Описание'])].concat(cands), (multi ? [26] : []).concat([32, 18, 12, 18, 50]));
      sheet('Участки (УИК)', [pre.concat(['УИК', 'Пункт голосования', 'Адрес', 'Телефон', 'Домов в округе', 'Частично в другом округе'])].concat(uiks), (multi ? [26] : []).concat([8, 50, 34, 18, 14, 12]));
      sheet('Улицы и дома', [pre.concat(['Улица', 'Дома'])].concat(streets), (multi ? [26] : []).concat([32, 100]));
      sheet('Медиа', [pre.concat(['Канал', 'Ссылка', 'Тип', 'Соцсеть', 'Подписчики'])].concat(media), (multi ? [26] : []).concat([32, 36, 18, 14, 12]));
      var out = X.write(wb, { bookType: 'xlsx', type: 'array' });
      saveBlob(fileName(title) + '.xlsx', new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    });
  }

  function saveBlob(name, blob) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  }

  /* ================= КАНДИДАТЫ ================= */
  function initials(fio) { return String(fio || '?').split(/\s+/).slice(0, 2).map(function (x) { return x[0] || ''; }).join('').toUpperCase(); }

  function viewCandidates(box) {
    var F = UI.candF, q = F.q.toLowerCase();
    var list = S.candidates.filter(function (c) {
      return (!F.okrug || c.okrug === F.okrug) && (!F.status || c.status === F.status) &&
        (!q || (c.fio + ' ' + c.description + ' ' + c.phone).toLowerCase().indexOf(q) >= 0);
    }).sort(function (a, b) { return okrugName(a.okrug).localeCompare(okrugName(b.okrug)) || a.fio.localeCompare(b.fio); });
    var active = list.filter(function (c) { return c.status !== 'Отказ'; });
    var budget = active.reduce(function (s, c) { return s + (+c.budget || 0); }, 0);
    var canAdd = S.me.role !== 'member' && myOkrugs().length;
    box.innerHTML = '<div class="head"><div><h1>Кандидаты</h1><div class="sub">' + active.length + ' в работе · бюджет кампаний: ' + money(budget) + '</div></div><div class="tools">' +
      '<input class="input" id="cq" placeholder="Поиск по ФИО" value="' + esc(F.q) + '">' +
      '<select class="input" id="co">' + okrugOptions(F.okrug, { empty: 'Все округа' }) + '</select>' +
      '<select class="input" id="cs"><option value="">Все статусы</option>' + CRM.CAND_STATUSES.map(function (s) { return '<option' + (s === F.status ? ' selected' : '') + '>' + s + '</option>'; }).join('') + '</select>' +
      (canAdd ? '<button class="btn primary" id="cAdd">' + icon('plus') + 'Кандидат</button>' : '') + '</div></div>' +
      (list.length ? '<div class="grid cands">' + list.map(function (c) {
        var st = c.status === 'Отказ' ? 'bad' : c.status === 'Зарегистрирован' || c.status === 'Выдвинут' ? 'ok' : '';
        return '<div class="card cand" data-c="' + c.id + '"><div class="ph" data-ph="' + (c.hasPhoto ? c.id : '') + '">' + (c.hasPhoto ? '' : esc(initials(c.fio))) + '</div>' +
          '<b>' + esc(c.fio) + '</b><div class="sub">' + esc(okrugName(c.okrug)) + '</div>' +
          '<div class="tags"><span class="pill ' + st + '">' + esc(c.status) + '</span>' + (c.budget ? '<span class="pill">' + money(c.budget) + '</span>' : '') + '</div>' +
          (c.description ? '<div class="desc">' + esc(c.description) + '</div>' : '') + '</div>';
      }).join('') + '</div>' : '<div class="card empty">Кандидатов пока нет.' + (canAdd ? ' Добавьте первого кнопкой «Кандидат».' : '') + '</div>');
    var t; $('#cq').oninput = function (e) { clearTimeout(t); t = setTimeout(function () { F.q = e.target.value; render(); var i = $('#cq'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }, 250); };
    $('#co').onchange = function (e) { F.okrug = e.target.value; render(); };
    $('#cs').onchange = function (e) { F.status = e.target.value; render(); };
    if (canAdd) $('#cAdd').onclick = function () { editCandidate({ okrug: F.okrug || myOkrugs()[0], status: 'Найден' }); };
    $all('[data-c]', box).forEach(function (el) { el.onclick = function () { editCandidate(S.candidates.filter(function (c) { return c.id === el.dataset.c; })[0]); }; });
    loadPhotos(list.filter(function (c) { return c.hasPhoto; }).map(function (c) { return c.id; })).then(function () {
      $all('[data-ph]', box).forEach(function (el) { var id = el.dataset.ph; if (id && S.photos[id]) el.style.backgroundImage = 'url(' + S.photos[id] + ')'; });
    });
  }

  function loadPhotos(ids) {
    var need = ids.filter(function (id) { return !(id in S.photos); });
    if (!need.length) return Promise.resolve();
    return api('photos', { ids: need }).then(function (d) { need.forEach(function (id) { S.photos[id] = d[id] || ''; }); }).catch(function () { });
  }

  function resizePhoto(file) {
    return new Promise(function (res, rej) {
      var img = new Image(), url = URL.createObjectURL(file);
      img.onload = function () {
        var size = 360, c = document.createElement('canvas');
        var s = Math.min(img.width, img.height), sx = (img.width - s) / 2, sy = (img.height - s) / 2;
        c.width = c.height = size;
        c.getContext('2d').drawImage(img, sx, sy, s, s, 0, 0, size, size);
        URL.revokeObjectURL(url);
        var q = 0.8, d = c.toDataURL('image/jpeg', q);
        while (d.length > 45000 && q > 0.3) { q -= 0.1; d = c.toDataURL('image/jpeg', q); }
        res(d);
      };
      img.onerror = function () { rej(new Error('Не удалось открыть фото')); };
      img.src = url;
    });
  }

  function editCandidate(c) {
    var ro = c.id && !canEdit(c.okrug, 'candidates');
    var photo; // undefined — не менять
    var m = modal(c.id ? 'Кандидат' : 'Новый кандидат',
      '<form id="cF"><div class="photo-pick"><div class="ph" id="phPrev">' + (c.hasPhoto ? '' : 'нет фото') + '</div>' +
      (ro ? '' : '<div><label class="btn sm">Загрузить фото<input type="file" accept="image/*" id="phIn" hidden></label> ' + (c.hasPhoto ? '<button type="button" class="btn sm danger" id="phDel">Убрать</button>' : '') + '<div class="sub" style="margin-top:6px">Фото обрезается до квадрата 360×360</div></div>') + '</div>' +
      '<label class="f"><span>ФИО *</span><input class="input" name="fio" required value="' + esc(c.fio) + '"></label>' +
      '<div class="row2"><label class="f"><span>Избирательный округ</span><select class="input" name="okrug">' + okrugOptions(c.okrug, { all: ro }) + '</select></label>' +
      '<label class="f"><span>Статус</span><select class="input" name="status">' + CRM.CAND_STATUSES.map(function (s) { return '<option' + (s === c.status ? ' selected' : '') + '>' + s + '</option>'; }).join('') + '</select></label></div>' +
      '<div class="row2"><label class="f"><span>Телефон</span><input class="input" name="phone" type="tel" value="' + esc(c.phone) + '"></label>' +
      '<label class="f"><span>Предлагаемый бюджет кампании, ₽</span><input class="input" name="budget" inputmode="numeric" value="' + esc(c.budget) + '"></label></div>' +
      '<label class="f"><span>Описание: кто этот человек, чем полезен, опыт</span><textarea class="input" name="description" rows="5">' + esc(c.description) + '</textarea></label>' +
      (c.created ? '<div class="sub">Добавлен ' + dateRu(c.created) + (user(c.createdBy) ? ' · ' + esc(user(c.createdBy).name) : '') + '</div>' : '') + '</form>',
      ro ? '<button class="btn" data-c>Закрыть</button>' : (c.id ? '<button class="btn danger left" data-d>Удалить</button>' : '') + '<button class="btn" data-c>Отмена</button><button class="btn primary" data-s>Сохранить</button>');
    if (ro) $all('input,select,textarea', m.el).forEach(function (el) { el.disabled = true; });
    var prev = $('#phPrev', m.el);
    if (c.hasPhoto) loadPhotos([c.id]).then(function () { if (S.photos[c.id]) prev.style.backgroundImage = 'url(' + S.photos[c.id] + ')'; });
    var inp = $('#phIn', m.el);
    if (inp) inp.onchange = function () {
      if (!inp.files[0]) return;
      resizePhoto(inp.files[0]).then(function (d) { photo = d; prev.textContent = ''; prev.style.backgroundImage = 'url(' + d + ')'; }).catch(fail);
    };
    var del = $('#phDel', m.el);
    if (del) del.onclick = function () { photo = ''; prev.style.backgroundImage = ''; prev.textContent = 'нет фото'; };
    $('[data-c]', m.el).onclick = m.close;
    var d = $('[data-d]', m.el);
    if (d) d.onclick = function () {
      confirmBox('Удалить кандидата «' + c.fio + '»?', 'Удалить').then(function (y) {
        if (!y) return;
        api('remove', { entity: 'candidates', id: c.id }).then(function () { m.close(); toast('Удалено'); refresh(); }).catch(fail);
      });
    };
    var s = $('[data-s]', m.el);
    if (s) s.onclick = function () {
      var it = formData($('#cF', m.el)); it.id = c.id; if (photo !== undefined) it.photo = photo;
      busy(s, true);
      api('save', { entity: 'candidates', item: it }).then(function (rec) {
        if (photo !== undefined) S.photos[rec.id] = photo;
        m.close(); toast('Сохранено'); refresh();
      }).catch(function (e) { busy(s, false); fail(e); });
    };
  }



  /* ================= КАЛЕНДАРЬ iPhone (.ics) ================= */
  // Стандартный файл встречи: iPhone открывает его в приложении «Календарь», Mac — в Календаре macOS.
  function icsEsc(t) { return String(t == null ? '' : t).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1'); }
  function icsFold(line) { var out = [], i = 0; while (line.length - i > 60) { out.push((i ? ' ' : '') + line.slice(i, i + 60)); i += 60; } out.push((i ? ' ' : '') + line.slice(i)); return out.join('\r\n'); }
  function icsUtc(d) { return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, ''); }
  // ev: { uid, title, date: 'YYYY-MM-DD', time: 'HH:MM' | '', minutes, place, desc }
  function addToCalendar(ev) {
    var L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//CRM UAO 2027//RU', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'BEGIN:VEVENT',
      'UID:' + (ev.uid || Date.now()) + '@crm-yuao', 'DTSTAMP:' + icsUtc(new Date())];
    var p = ev.date.split('-').map(Number);
    if (ev.time) {
      var t = ev.time.split(':').map(Number);
      var start = new Date(Date.UTC(p[0], p[1] - 1, p[2], t[0] - 3, t[1] || 0)); // московское время = UTC+3
      L.push('DTSTART:' + icsUtc(start), 'DTEND:' + icsUtc(new Date(start.getTime() + (ev.minutes || 60) * 60000)));
      L.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + icsEsc(ev.title), 'TRIGGER:-PT1H', 'END:VALARM');
    } else {
      var next = new Date(Date.UTC(p[0], p[1] - 1, p[2] + 1)).toISOString().slice(0, 10).replace(/-/g, '');
      L.push('DTSTART;VALUE=DATE:' + ev.date.replace(/-/g, ''), 'DTEND;VALUE=DATE:' + next);
      L.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + icsEsc(ev.title), 'TRIGGER:-PT6H', 'END:VALARM');
    }
    L.push('SUMMARY:' + icsEsc(ev.title));
    if (ev.place) L.push('LOCATION:' + icsEsc(ev.place));
    if (ev.desc) L.push('DESCRIPTION:' + icsEsc(ev.desc));
    L.push('END:VEVENT', 'END:VCALENDAR');
    var ics = L.map(icsFold).join('\r\n') + '\r\n';
    var ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (ios) {
      // iPhone: файл отдаёт наш сервер по обычной https-ссылке — Календарь открывается из Safari, Chrome, Яндекса и мессенджеров
      if (!DEMO && S.token) {
        var b64 = btoa(unescape(encodeURIComponent(ics))).replace(/\+/g, '-').replace(/\//g, '_');
        location.href = CFG.API_URL + '?t=' + encodeURIComponent(S.token) + '&ics=' + encodeURIComponent(b64);
      } else location.href = 'data:text/calendar;charset=utf-8,' + encodeURIComponent(ics);
      return;
    }
    download((ev.title || 'встреча').replace(/[\\/:*?"<>|]/g, '').slice(0, 60) + '.ics', ics, 'text/calendar;charset=utf-8');
  }
  function calInterview(i) {
    return { uid: 'iv-' + i.id, title: 'Встреча с кандидатом: ' + i.fio, date: i.date, time: i.time, minutes: 60, place: i.place,
      desc: [okrugName(i.okrug), i.phone ? 'Телефон: ' + i.phone : '', i.interviewer ? 'Проводит: ' + i.interviewer : '', i.comment].filter(Boolean).join('\n') };
  }
  function calEvent(e) {
    return { uid: 'ev-' + e.id, title: (CRM.EVENT_TYPES[e.type] || 'Мероприятие') + (e.title ? ': ' + e.title : '') + ' (' + okrugName(e.okrug) + ')', date: e.date, time: '', place: e.address,
      desc: [okrugName(e.okrug), e.notes].filter(Boolean).join('\n') };
  }
  // После создания встречи — предложить сразу добавить её в календарь
  function offerCalendar(ev) {
    var m = modal('Сохранено', '<p style="margin:0">Добавить в «Календарь» на телефоне? Придёт напоминание' + (ev.time ? ' за час до встречи.' : ' накануне вечером.') + '</p>',
      '<button class="btn" data-c>Не нужно</button><button class="btn primary" data-cal>' + icon('calplus') + 'Добавить в календарь</button>');
    $('[data-c]', m.el).onclick = m.close;
    $('[data-cal]', m.el).onclick = function () { m.close(); addToCalendar(ev); };
  }

  /* ================= ВСТРЕЧИ С КАНДИДАТАМИ ================= */
  var IV_FILTERS = [['upcoming', 'Предстоящие'], ['await', 'Ждут отметки'], ['pass', 'Проходят'], ['fail', 'Не проходят'], ['noshow', 'Не пришли'], ['', 'Все']];
  function ivState(i) {
    if (i.attended === 'no') return 'noshow';
    if (i.attended === 'yes') return i.verdict || 'await';
    return i.date >= todayMsk() ? 'upcoming' : 'await';
  }
  function ivPill(i) {
    var st = ivState(i);
    return {
      upcoming: '<span class="pill">назначена</span>', noshow: '<span class="pill bad">не пришёл</span>',
      await: i.attended === 'yes' ? '<span class="pill warn">пришёл, нужна оценка</span>' : '<span class="pill warn">отметьте явку</span>',
      pass: '<span class="pill ok">проходит</span>', fail: '<span class="pill bad">не проходит</span>'
    }[st];
  }

  function viewInterviews(box) {
    var F = UI.ivF, all = S.interviews.filter(function (i) { return !F.okrug || i.okrug === F.okrug; });
    var cnt = {}; all.forEach(function (i) { var st = ivState(i); cnt[st] = (cnt[st] || 0) + 1; });
    var came = all.filter(function (i) { return i.attended === 'yes'; }).length;
    var list = all.filter(function (i) { return !F.status || ivState(i) === F.status; });
    var asc = F.status === 'upcoming';
    list.sort(function (a, b) { var x = a.date + (a.time || ''), y = b.date + (b.time || ''); return asc ? (x < y ? -1 : 1) : (x < y ? 1 : -1); });
    var canAdd = S.me.role !== 'member' && myOkrugs().length;
    var groups = {}, order = [];
    list.forEach(function (i) { if (!groups[i.date]) { groups[i.date] = []; order.push(i.date); } groups[i.date].push(i); });
    var WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
    var rows = order.map(function (d) {
      var wd = WD[new Date(d + 'T12:00:00Z').getUTCDay()];
      return '<tr class="day"><td colspan="5"><b>' + dateRu(d) + '</b> <span class="sub">' + wd + (d === todayMsk() ? ', сегодня' : '') + '</span></td></tr>' +
        groups[d].map(function (i) {
          var st = ivState(i), ed = canEdit(i.okrug, 'interviews'), act = '';
          if (ed && st === 'await' && i.attended !== 'yes') act = '<button class="btn sm" data-iv="' + i.id + '" data-set="attended:yes">' + icon('check') + 'Пришёл</button> <button class="btn sm" data-iv="' + i.id + '" data-set="attended:no">Не пришёл</button>';
          if (ed && st === 'await' && i.attended === 'yes') act = '<button class="btn sm" data-iv="' + i.id + '" data-set="verdict:pass">Проходит</button> <button class="btn sm danger" data-iv="' + i.id + '" data-set="verdict:fail">Не проходит</button>';
          if (ed && st === 'pass' && !i.candidateId) act = '<button class="btn sm primary" data-tocand="' + i.id + '">' + icon('usercheck') + 'В кандидаты</button>';
          if (st === 'pass' && i.candidateId) act = '<span class="sub">в списке кандидатов</span>';
          if (st === 'upcoming') act = '<button class="btn sm" data-cal="' + i.id + '" title="Добавить в календарь телефона">' + icon('calplus') + 'В календарь</button>';
          return '<tr class="click" data-i="' + i.id + '"><td class="nowrap num">' + esc(i.time || '') + '</td><td><b>' + esc(i.fio) + '</b>' + (i.phone ? '<div class="sub">' + esc(i.phone) + '</div>' : '') + '</td>' +
            '<td>' + esc(okrugName(i.okrug)) + (i.place ? '<div class="sub">' + esc(i.place) + '</div>' : '') + '</td><td>' + ivPill(i) + (i.interviewer ? '<div class="sub">проводит: ' + esc(i.interviewer) + '</div>' : '') + '</td><td class="nowrap">' + act + '</td></tr>';
        }).join('');
    }).join('');
    box.innerHTML = '<div class="head"><div><h1>Встречи с кандидатами</h1><div class="sub">Первичные встречи: явка и решение «проходит / не проходит» по критериям штаба</div></div><div class="tools">' +
      '<select class="input" id="io">' + okrugOptions(F.okrug, { empty: 'Все мои округа' }) + '</select>' +
      (canAdd ? '<button class="btn primary" id="iAdd">' + icon('plus') + 'Встреча</button>' : '') + '</div></div>' +
      '<div class="grid kpis k6">' +
      [['Назначено', cnt.upcoming || 0], ['Ждут отметки', cnt.await || 0], ['Пришли', came], ['Не пришли', cnt.noshow || 0], ['Проходят', cnt.pass || 0], ['Не проходят', cnt.fail || 0]].map(function (x) {
        return '<div class="card kpi"><div class="l">' + x[0] + '</div><div class="v">' + x[1] + '</div></div>';
      }).join('') + '</div>' +
      '<div class="tabs" role="tablist">' + IV_FILTERS.map(function (x) { return '<button role="tab" class="' + (F.status === x[0] ? 'on' : '') + '" data-ivf="' + x[0] + '">' + x[1] + (x[0] && cnt[x[0]] ? ' <span class="cnt">' + cnt[x[0]] + '</span>' : '') + '</button>'; }).join('') + '</div>' +
      (list.length ? '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Время</th><th>Кандидат</th><th>Округ и место</th><th>Статус</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>'
        : '<div class="card empty">Встреч нет.' + (canAdd ? ' Назначьте первую кнопкой «Встреча».' : '') + '</div>');
    $('#io').onchange = function (e) { F.okrug = e.target.value; render(); };
    $all('[data-ivf]', box).forEach(function (b) { b.onclick = function () { F.status = b.dataset.ivf; render(); }; });
    if (canAdd) $('#iAdd').onclick = function () { editInterview({ okrug: F.okrug || myOkrugs()[0], date: todayMsk(), interviewer: S.me.name }); };
    $all('tr[data-i]', box).forEach(function (tr) { tr.onclick = function (ev) { if (ev.target.closest('button')) return; editInterview(S.interviews.filter(function (i) { return i.id === tr.dataset.i; })[0]); }; });
    $all('[data-set]', box).forEach(function (b) {
      b.onclick = function () {
        var i = Object.assign({}, S.interviews.filter(function (x) { return x.id === b.dataset.iv; })[0]), kv = b.dataset.set.split(':');
        i[kv[0]] = kv[1]; b.disabled = true;
        api('save', { entity: 'interviews', item: i }).then(function () { toast('Отмечено'); refresh(); }).catch(function (e) { b.disabled = false; fail(e); });
      };
    });
    $all('[data-cal]', box).forEach(function (b) { b.onclick = function () { addToCalendar(calInterview(S.interviews.filter(function (x) { return x.id === b.dataset.cal; })[0])); }; });
    $all('[data-tocand]', box).forEach(function (b) { b.onclick = function () { ivToCandidate(S.interviews.filter(function (x) { return x.id === b.dataset.tocand; })[0], b); }; });
  }

  function ivToCandidate(i, btn) {
    if (btn) btn.disabled = true;
    api('save', { entity: 'candidates', item: { okrug: i.okrug, fio: i.fio, phone: i.phone, status: 'Найден', description: i.comment } }).then(function (c) {
      return api('save', { entity: 'interviews', item: Object.assign({}, i, { candidateId: c.id }) });
    }).then(function () { toast('Добавлен в кандидаты'); refresh(); }).catch(function (e) { if (btn) btn.disabled = false; fail(e); });
  }

  function editInterview(i) {
    var ro = i.id && !canEdit(i.okrug, 'interviews');
    var m = modal(i.id ? 'Встреча с кандидатом' : 'Новая встреча',
      '<form id="iF"><label class="f"><span>ФИО *</span><input class="input" name="fio" value="' + esc(i.fio) + '" required></label>' +
      '<div class="row2"><label class="f"><span>Телефон</span><input class="input" name="phone" type="tel" value="' + esc(i.phone) + '"></label>' +
      '<label class="f"><span>Округ</span><select class="input" name="okrug">' + okrugOptions(i.okrug, { all: ro }) + '</select></label></div>' +
      '<div class="row2"><label class="f"><span>Дата</span><input class="input" type="date" name="date" value="' + esc(i.date) + '" required></label>' +
      '<label class="f"><span>Время</span><input class="input" type="time" name="time" value="' + esc(i.time) + '"></label></div>' +
      '<div class="row2"><label class="f"><span>Место</span><input class="input" name="place" placeholder="Штаб, кафе, онлайн…" value="' + esc(i.place) + '"></label>' +
      '<label class="f"><span>Кто проводит</span><input class="input" name="interviewer" value="' + esc(i.interviewer) + '"></label></div>' +
      '<div class="row2"><label class="f"><span>Явка</span><select class="input" name="attended"><option value="">ещё не отмечено</option><option value="yes"' + (i.attended === 'yes' ? ' selected' : '') + '>пришёл</option><option value="no"' + (i.attended === 'no' ? ' selected' : '') + '>не пришёл</option></select></label>' +
      '<label class="f"><span>Итог по критериям</span><select class="input" name="verdict"><option value="">не оценён</option><option value="pass"' + (i.verdict === 'pass' ? ' selected' : '') + '>проходит</option><option value="fail"' + (i.verdict === 'fail' ? ' selected' : '') + '>не проходит</option></select></label></div>' +
      '<label class="f"><span>Комментарий: почему проходит или нет</span><textarea class="input" name="comment" rows="4">' + esc(i.comment) + '</textarea></label>' +
      '<input type="hidden" name="candidateId" value="' + esc(i.candidateId) + '"></form>',
      (i.id ? '<button class="btn' + (ro ? '' : '') + '" data-cal>' + icon('calplus') + 'В календарь</button>' : '') +
      (ro ? '<button class="btn" data-c>Закрыть</button>' : (i.id ? '<button class="btn danger left" data-d>Удалить</button>' : '') + '<button class="btn" data-c>Отмена</button><button class="btn primary" data-s>Сохранить</button>'));
    var f = $('#iF', m.el);
    var cb = $('[data-cal]', m.el); if (cb) cb.onclick = function () { addToCalendar(calInterview(Object.assign({}, i, formData(f)))); };
    if (ro) $all('input,select,textarea', m.el).forEach(function (el) { el.disabled = true; });
    var sync = function () { f.verdict.disabled = ro || f.attended.value !== 'yes'; if (f.attended.value !== 'yes') f.verdict.value = ''; };
    f.attended.onchange = sync; sync();
    $('[data-c]', m.el).onclick = m.close;
    var d = $('[data-d]', m.el);
    if (d) d.onclick = function () { confirmBox('Удалить встречу?', 'Удалить').then(function (y) { if (y) api('remove', { entity: 'interviews', id: i.id }).then(function () { m.close(); toast('Удалено'); refresh(); }).catch(fail); }); };
    var sv = $('[data-s]', m.el);
    if (sv) sv.onclick = function () {
      var it = formData(f); it.id = i.id; busy(sv, true);
      api('save', { entity: 'interviews', item: it }).then(function (rec) { m.close(); refresh(); if (!i.id) offerCalendar(calInterview(rec)); else toast('Сохранено'); }).catch(function (e) { busy(sv, false); fail(e); });
    };
  }

  /* ================= МЕДИА ================= */
  var MEDIA_STATUS = { plan: 'планируется', active: 'работает', stopped: 'не ведётся' };
  function districtOf(oid) { var o = okrug(oid); return o ? o.district : ''; }

  function viewMedia(box) {
    var F = UI.mdF, MP = CRM.MEDIA_PLAN, q = F.q.toLowerCase();
    var act = S.media.filter(function (x) { return x.status !== 'stopped'; });
    var sum = function (kind) { var l = act.filter(function (x) { return x.kind === kind; }); return { n: l.length, subs: l.reduce(function (a, x) { return a + (+x.subscribers || 0); }, 0) }; };
    var cc = sum('candidate'), dd = sum('district'), oo = sum('okrug');
    var withCh = {}; act.forEach(function (x) { if (x.kind === 'candidate' && x.candidateId) withCh[x.candidateId] = 1; });
    var noCh = S.candidates.filter(function (c) { return c.status !== 'Отказ' && !withCh[c.id]; }).length;
    var distCovered = {}; act.forEach(function (x) { if (x.kind === 'district') distCovered[districtOf(x.okrug)] = 1; });
    var list = S.media.filter(function (x) {
      return (!F.kind || x.kind === F.kind) && (!F.network || x.network === F.network) && (!F.okrug || x.okrug === F.okrug) &&
        (!q || (x.title + ' ' + x.url + ' ' + x.owner).toLowerCase().indexOf(q) >= 0);
    }).sort(function (a, b) { return (+b.subscribers || 0) - (+a.subscribers || 0); });
    var cand = function (id) { return S.candidates.filter(function (c) { return c.id === id; })[0]; };
    var kpi = function (l, v, of, sub, r) { return '<div class="card kpi"><div class="l">' + l + '</div><div class="v">' + v + (of != null ? ' <span class="muted">/ ' + of + '</span>' : '') + '</div>' + (sub ? '<div class="sub">' + sub + '</div>' : '') + (r != null ? '<div class="bar"><i style="width:' + Math.round(Math.min(1, r) * 100) + '%"></i></div>' : '') + '</div>'; };
    var where = function (x) { return x.kind === 'district' ? 'район ' + esc(districtOf(x.okrug)) : esc(okrugName(x.okrug)); };
    box.innerHTML = '<div class="head"><div><h1>Медиа</h1><div class="sub">Каналы кандидатов, округов и групп районов. План из презентации: старт после ' + dateRu(MP.start) + ', бюджет 0 ₽</div></div><div class="tools">' +
      '<input class="input" id="mq" placeholder="Название, ссылка" value="' + esc(F.q) + '">' +
      '<select class="input" id="mk"><option value="">Все типы</option>' + Object.keys(CRM.MEDIA_KINDS).map(function (k) { return '<option value="' + k + '"' + (k === F.kind ? ' selected' : '') + '>' + CRM.MEDIA_KINDS[k] + '</option>'; }).join('') + '</select>' +
      '<select class="input" id="mn"><option value="">Все соцсети</option>' + CRM.NETWORKS.map(function (n) { return '<option' + (n === F.network ? ' selected' : '') + '>' + n + '</option>'; }).join('') + '</select>' +
      '<select class="input" id="mo">' + okrugOptions(F.okrug, { empty: 'Все округа', all: true }) + '</select>' +
      (myOkrugs().length ? '<button class="btn primary" id="mAdd">' + icon('plus') + 'Канал</button>' : '') + '</div></div>' +
      '<div class="grid kpis k6">' +
      kpi('Каналы кандидатов', cc.n, MP.candidate.count, 'без канала: ' + noCh + ' канд.', cc.n / MP.candidate.count) +
      kpi('Подписчики кандидатов', fmt(cc.subs), fmt(MP.candidate.count * MP.candidate.subs), 'по ' + MP.candidate.subs + ' на канал', cc.subs / (MP.candidate.count * MP.candidate.subs)) +
      kpi('Группы районов', dd.n, MP.district.count, 'районов с группой: ' + Object.keys(distCovered).length, dd.n / MP.district.count) +
      kpi('Подписчики групп', fmt(dd.subs), fmt(MP.district.count * MP.district.subs), 'по ' + fmt(MP.district.subs) + ' на группу', dd.subs / (MP.district.count * MP.district.subs)) +
      kpi('Каналы округов', oo.n, null, fmt(oo.subs) + ' подписчиков', null) +
      kpi('Всего подписчиков', fmt(cc.subs + dd.subs + oo.subs), null, 'в работающих каналах', null) +
      '</div>' +
      (list.length ? '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Канал</th><th>Тип</th><th>Соцсеть</th><th>Где</th><th class="num">Подписчики</th><th>Статус</th></tr></thead><tbody>' +
        list.map(function (x) {
          var c = x.candidateId && cand(x.candidateId);
          return '<tr class="click" data-m="' + x.id + '"><td><b>' + esc(x.title || x.url) + '</b>' + (x.url ? ' <a href="' + esc(/^https?:/.test(x.url) ? x.url : 'https://' + x.url) + '" target="_blank" rel="noopener" class="ext" aria-label="Открыть канал">' + icon('link') + '</a>' : '') + (x.owner ? '<div class="sub">ведёт: ' + esc(x.owner) + '</div>' : '') + '</td>' +
            '<td>' + CRM.MEDIA_KINDS[x.kind] + (c ? '<div class="sub">' + esc(c.fio) + '</div>' : '') + '</td><td>' + esc(x.network) + '</td><td>' + where(x) + '</td>' +
            '<td class="num">' + (x.subscribers ? fmt(x.subscribers) : '—') + '</td><td><span class="pill ' + (x.status === 'active' ? 'ok' : x.status === 'stopped' ? 'bad' : '') + '">' + MEDIA_STATUS[x.status] + '</span></td></tr>';
        }).join('') + '</tbody></table></div>' : '<div class="card empty">Каналов пока нет.</div>');
    var t; $('#mq').oninput = function (e) { clearTimeout(t); t = setTimeout(function () { F.q = e.target.value; render(); var i = $('#mq'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }, 250); };
    $('#mk').onchange = function (e) { F.kind = e.target.value; render(); };
    $('#mn').onchange = function (e) { F.network = e.target.value; render(); };
    $('#mo').onchange = function (e) { F.okrug = e.target.value; render(); };
    if ($('#mAdd')) $('#mAdd').onclick = function () { editMedia({ kind: F.kind || 'candidate', network: F.network || 'Telegram', okrug: (myOkrugs().indexOf(F.okrug) >= 0 ? F.okrug : myOkrugs()[0]), status: 'active', started: todayMsk() }); };
    $all('tr[data-m]', box).forEach(function (tr) { tr.onclick = function (ev) { if (ev.target.closest('a')) return; editMedia(S.media.filter(function (x) { return x.id === tr.dataset.m; })[0]); }; });
  }

  function editMedia(x) {
    var ro = x.id && !canEdit(x.okrug);
    var m = modal(x.id ? 'Канал' : 'Новый канал',
      '<form id="mF"><div class="row2"><label class="f"><span>Тип канала</span><select class="input" name="kind">' + Object.keys(CRM.MEDIA_KINDS).map(function (k) { return '<option value="' + k + '"' + (k === x.kind ? ' selected' : '') + '>' + CRM.MEDIA_KINDS[k] + '</option>'; }).join('') + '</select></label>' +
      '<label class="f"><span>Соцсеть</span><select class="input" name="network">' + CRM.NETWORKS.map(function (n) { return '<option' + (n === x.network ? ' selected' : '') + '>' + n + '</option>'; }).join('') + '</select></label></div>' +
      '<label class="f"><span>Название</span><input class="input" name="title" value="' + esc(x.title) + '" placeholder="Чертаново Южное: новости района"></label>' +
      '<label class="f"><span>Ссылка</span><input class="input" name="url" inputmode="url" value="' + esc(x.url) + '" placeholder="https://t.me/…"></label>' +
      '<label class="f"><span id="okrLbl">Округ</span><select class="input" name="okrug">' + okrugOptions(x.okrug, { all: ro }) + '</select></label>' +
      '<label class="f" id="candBox"><span>Кандидат</span><select class="input" name="candidateId"></select></label>' +
      '<div class="row2"><label class="f"><span>Подписчиков сейчас</span><input class="input" name="subscribers" type="number" min="0" value="' + esc(x.subscribers) + '"></label>' +
      '<label class="f"><span>Статус</span><select class="input" name="status">' + Object.keys(MEDIA_STATUS).map(function (k) { return '<option value="' + k + '"' + (k === x.status ? ' selected' : '') + '>' + MEDIA_STATUS[k] + '</option>'; }).join('') + '</select></label></div>' +
      '<div class="row2"><label class="f"><span>Кто ведёт</span><input class="input" name="owner" value="' + esc(x.owner) + '"></label>' +
      '<label class="f"><span>Дата запуска</span><input class="input" type="date" name="started" value="' + esc(x.started) + '"></label></div>' +
      '<label class="f"><span>Заметки</span><textarea class="input" name="notes">' + esc(x.notes) + '</textarea></label></form>',
      ro ? '<button class="btn" data-c>Закрыть</button>' : (x.id ? '<button class="btn danger left" data-d>Удалить</button>' : '') + '<button class="btn" data-c>Отмена</button><button class="btn primary" data-s>Сохранить</button>');
    var f = $('#mF', m.el);
    var sync = function () {
      var k = f.kind.value;
      $('#candBox', m.el).style.display = k === 'candidate' ? '' : 'none';
      $('#okrLbl', m.el).textContent = k === 'district' ? 'Район (выберите любой его округ)' : 'Округ';
      var list = S.candidates.filter(function (c) { return c.okrug === f.okrug.value && c.status !== 'Отказ'; });
      f.candidateId.innerHTML = '<option value="">— выберите —</option>' + list.map(function (c) { return '<option value="' + c.id + '"' + (c.id === x.candidateId ? ' selected' : '') + '>' + esc(c.fio) + '</option>'; }).join('');
    };
    f.kind.onchange = sync; f.okrug.onchange = sync; sync();
    if (ro) $all('input,select,textarea', m.el).forEach(function (el) { el.disabled = true; });
    $('[data-c]', m.el).onclick = m.close;
    var d = $('[data-d]', m.el);
    if (d) d.onclick = function () { confirmBox('Удалить канал из базы?', 'Удалить').then(function (y) { if (y) api('remove', { entity: 'media', id: x.id }).then(function () { m.close(); toast('Удалено'); refresh(); }).catch(fail); }); };
    var sv = $('[data-s]', m.el);
    if (sv) sv.onclick = function () {
      var it = formData(f); it.id = x.id; busy(sv, true);
      api('save', { entity: 'media', item: it }).then(function () { m.close(); toast('Сохранено'); refresh(); }).catch(function (e) { busy(sv, false); fail(e); });
    };
  }


  /* ================= УИК ================= */
  function normQ(x) { return String(x || '').toLowerCase().replace(/ё/g, 'е').replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim(); }
  function viewUik(box) {
    var F = UI.uikF;
    box.innerHTML = '<div class="head"><div><h1>Избирательные участки (УИК)</h1><div class="sub">Выборы в Госдуму 18–20 сентября 2026 года, данные Мосгоризбиркома. Участок каждого дома определён по его координатам.</div></div><div class="tools">' +
      '<input class="input" id="uq" placeholder="Номер УИК или адрес дома" value="' + esc(F.q) + '" style="min-width:240px">' +
      '<select class="input" id="ud"><option value="">Все районы</option>' + Object.keys(CRM.ZONES).map(function () { return ''; }).join('') + '</select>' +
      '<select class="input" id="uo">' + okrugOptions(F.okrug, { empty: 'Все округа', all: true }) + '</select>' +
      '</div></div><div id="uikBox"><div class="card empty">Загрузка…</div></div>';
    loadUik().then(function (d) {
      var dists = []; d.uiks.forEach(function (u) { if (dists.indexOf(u.district) < 0) dists.push(u.district); }); dists.sort();
      $('#ud').innerHTML = '<option value="">Все районы</option>' + dists.map(function (x) { return '<option' + (x === F.district ? ' selected' : '') + '>' + esc(x) + '</option>'; }).join('');
      var draw = function () {
        var q = normQ(F.q), qn = /^\d+$/.test(q) ? +q : null, houseHits = [];
        if (q && qn == null && q.length >= 3) {
          var toks = q.split(' ');
          houseHits = d.houses.filter(function (h) {
            var st = normQ(h[4]), hn = normQ(h[5]).replace(/\s/g, '');
            return toks.every(function (t) { return /^\d/.test(t) ? hn === t || hn.indexOf(t + 'к') === 0 || hn.indexOf(t + 'с') === 0 || hn.indexOf(t + '/') === 0 : st.indexOf(t) >= 0; });
          }).slice(0, 40);
        }
        var list = d.uiks.filter(function (u) {
          if (F.district && u.district !== F.district) return false;
          if (F.okrug && !u.okrugs[F.okrug]) return false;
          if (qn != null) return String(u.number).indexOf(String(qn)) === 0;
          if (q && qn == null) return houseHits.length ? houseHits.some(function (h) { return h[2] === u.number; }) : normQ(u.address + ' ' + u.place).indexOf(q) >= 0;
          return true;
        });
        var hh = houseHits.length ? '<div class="card" style="margin-bottom:var(--s4)"><h3>Дома по запросу</h3><div class="tbl-wrap" style="box-shadow:none"><table class="tbl"><tbody>' + houseHits.map(function (h) {
          return '<tr><td>' + esc(h[4]) + ', ' + esc(h[5]) + '</td><td><b>УИК № ' + (h[2] || '—') + '</b></td><td><span class="dot" style="background:' + okrColor(h[3]) + '"></span> ' + esc(okrugName(h[3])) + '</td></tr>';
        }).join('') + '</tbody></table></div></div>' : '';
        $('#uikBox').innerHTML = hh + '<div class="sub" style="margin-bottom:var(--s2)">Участков: ' + list.length + ' из ' + d.uiks.length + ', домов в базе: ' + fmt(d.houses.length) + '</div>' +
          '<div class="tbl-wrap"><table class="tbl"><thead><tr><th class="num">УИК</th><th>Район</th><th>Избирательный округ</th><th>Помещение для голосования</th><th class="num">Домов</th></tr></thead><tbody>' +
          list.map(function (u) {
            var ok = Object.keys(u.okrugs).sort(function (a, b) { return u.okrugs[b] - u.okrugs[a]; });
            return '<tr class="click" data-u="' + u.number + '"><td class="num"><b>' + u.number + '</b></td><td>' + esc(u.district) + '</td><td>' +
              (ok.map(function (id) { return '<span class="dot" style="background:' + okrColor(id) + '"></span> ' + esc(okrugName(id)) + (ok.length > 1 ? ' <span class="sub">' + u.okrugs[id] + ' д.</span>' : ''); }).join('<br>') || '—') + '</td>' +
              '<td>' + esc(u.place) + '<div class="sub">' + esc(u.address) + (u.phone ? ', ' + esc(u.phone) : '') + '</div></td><td class="num">' + u.houses + '</td></tr>';
          }).join('') + '</tbody></table></div>';
        $all('tr[data-u]', box).forEach(function (tr) { tr.onclick = function () { uikModal(S.uikBy[tr.dataset.u]); }; });
      };
      var t; $('#uq').oninput = function (e) { clearTimeout(t); t = setTimeout(function () { F.q = e.target.value; draw(); }, 250); };
      $('#ud').onchange = function (e) { F.district = e.target.value; draw(); };
      $('#uo').onchange = function (e) { F.okrug = e.target.value; draw(); };
      draw();
    }).catch(function (e) { $('#uikBox').innerHTML = '<div class="card empty">' + esc(e.message) + '</div>'; });
  }

  function uikModal(u) {
    var hs = S.uik.houses.filter(function (h) { return h[2] === u.number; }).sort(function (a, b) { return (a[4] + a[5]).localeCompare(b[4] + b[5], 'ru', { numeric: true }); });
    var byStreet = {}; hs.forEach(function (h) { (byStreet[h[4]] = byStreet[h[4]] || []).push(h[5]); });
    modal('УИК № ' + u.number, '<div class="okr-info">' + uikPopup(u).replace(/<br>/g, '<div class="sub"></div>') + '</div>' +
      '<h3 style="margin-top:var(--s4)">Дома участка</h3>' + Object.keys(byStreet).sort().map(function (st) { return '<p class="small" style="margin:0 0 var(--s2)"><b>' + esc(st) + ':</b> ' + byStreet[st].map(esc).join(', ') + '</p>'; }).join('') +
      '<p class="sub">Список собран по домам с адресом в OpenStreetMap; нежилые строения без адреса не показаны.</p>', null, true);
  }

  /* ================= МЕРОПРИЯТИЯ ================= */
  function viewEvents(box) {
    var F = UI.evF;
    var list = S.events.filter(function (e) {
      return (!F.month || e.date.slice(0, 7) === F.month) && (!F.okrug || e.okrug === F.okrug) && (!F.status || e.status === F.status);
    }).sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; });
    var done = list.filter(function (e) { return e.status === 'done'; });
    var sum = { meet: 0, act: 0, c: 0 }; done.forEach(function (e) { if (e.type === 'meet') sum.meet++; if (e.type === 'act') sum.act++; sum.c += +e.contacts || 0; });
    var p = F.month ? planOf(F.month) : null, n = F.okrug ? 1 : myOkrugs().length;
    box.innerHTML = '<div class="head"><div><h1>Мероприятия</h1><div class="sub">Проведено: встреч ' + sum.meet + (p ? ' из ' + p.meetings * n : '') + ', акций ' + sum.act + (p ? ' из ' + p.actions * n : '') + ' · собрано контактов ' + fmt(sum.c) + '</div></div><div class="tools">' +
      monthSelect('em', F.month, true) +
      '<select class="input" id="eo">' + okrugOptions(F.okrug, { empty: 'Все мои округа' }) + '</select>' +
      '<select class="input" id="es"><option value="">Все</option><option value="planned"' + (F.status === 'planned' ? ' selected' : '') + '>Запланированы</option><option value="done"' + (F.status === 'done' ? ' selected' : '') + '>Проведены</option></select>' +
      (myOkrugs().length ? '<button class="btn primary" id="eAdd">' + icon('plus') + 'Мероприятие</button>' : '') + '</div></div>' +
      (list.length ? '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Дата</th><th>Тип</th><th>Мероприятие</th><th>Округ</th><th class="num">Контакты</th><th>Статус</th></tr></thead><tbody>' +
        list.map(function (e) {
          return '<tr class="click" data-e="' + e.id + '"><td class="nowrap">' + dateRu(e.date) + '</td><td>' + CRM.EVENT_TYPES[e.type] + '</td><td><b>' + esc(e.title || '—') + '</b>' + (e.address ? '<div class="sub">' + esc(e.address) + '</div>' : '') + '</td>' +
            '<td>' + esc(okrugName(e.okrug)) + '</td><td class="num">' + (e.contacts || '') + '</td><td>' +
            (e.status === 'done' ? '<span class="pill ok">проведено</span>' : '<span class="pill">план</span>' + (canEdit(e.okrug) ? ' <button class="btn sm" data-done="' + e.id + '">' + icon('check') + 'Провели</button>' : '')) + '</td></tr>';
        }).join('') + '</tbody></table></div>' : '<div class="card empty">Мероприятий за выбранный период нет.</div>');
    $('#em').onchange = function (e) { F.month = e.target.value; render(); };
    $('#eo').onchange = function (e) { F.okrug = e.target.value; render(); };
    $('#es').onchange = function (e) { F.status = e.target.value; render(); };
    var add = $('#eAdd'); if (add) add.onclick = function () { editEvent({ okrug: F.okrug || myOkrugs()[0], date: todayMsk(), type: 'meet', status: 'planned' }); };
    $all('tr[data-e]', box).forEach(function (tr) { tr.onclick = function (ev) { if (ev.target.dataset.done) return; editEvent(S.events.filter(function (e) { return e.id === tr.dataset.e; })[0]); }; });
    $all('[data-done]', box).forEach(function (b) {
      b.onclick = function () { var e = S.events.filter(function (x) { return x.id === b.dataset.done; })[0]; editEvent(Object.assign({}, e, { status: 'done' })); };
    });
  }

  function editEvent(e) {
    var ro = e.id && !canEdit(e.okrug);
    var m = modal(e.id ? 'Мероприятие' : 'Новое мероприятие',
      '<form id="eF"><div class="row2"><label class="f"><span>Тип</span><select class="input" name="type">' + Object.keys(CRM.EVENT_TYPES).map(function (k) { return '<option value="' + k + '"' + (k === e.type ? ' selected' : '') + '>' + CRM.EVENT_TYPES[k] + '</option>'; }).join('') + '</select></label>' +
      '<label class="f"><span>Дата</span><input class="input" type="date" name="date" value="' + esc(e.date) + '" required></label></div>' +
      '<label class="f"><span>Название</span><input class="input" name="title" placeholder="Встреча во дворе, пикет у метро…" value="' + esc(e.title) + '"></label>' +
      '<label class="f"><span>Округ</span><select class="input" name="okrug">' + okrugOptions(e.okrug, { all: ro }) + '</select></label>' +
      '<label class="f"><span>Адрес / место</span><input class="input" name="address" value="' + esc(e.address) + '"></label>' +
      '<div class="row2"><label class="f"><span>Статус</span><select class="input" name="status"><option value="planned">Запланировано</option><option value="done"' + (e.status === 'done' ? ' selected' : '') + '>Проведено</option></select></label>' +
      '<label class="f"><span>Собрано контактов</span><input class="input" name="contacts" type="number" min="0" value="' + esc(e.contacts) + '"></label></div>' +
      '<label class="f"><span>Заметки, итоги</span><textarea class="input" name="notes">' + esc(e.notes) + '</textarea></label>' +
      '<p class="sub" style="margin:0">План: встреча ≈ 15 контактов, акция ≈ 10. Сами контакты вносите в раздел КМБ — в план идут именно они.</p></form>',
      (e.id ? '<button class="btn" data-cal>' + icon('calplus') + 'В календарь</button>' : '') +
      (ro ? '<button class="btn" data-c>Закрыть</button>' : (e.id ? '<button class="btn danger left" data-d>Удалить</button>' : '') + '<button class="btn" data-c>Отмена</button><button class="btn primary" data-s>Сохранить</button>'));
    if (ro) $all('input,select,textarea', m.el).forEach(function (el) { el.disabled = true; });
    $('[data-c]', m.el).onclick = m.close;
    var cb = $('[data-cal]', m.el); if (cb) cb.onclick = function () { addToCalendar(calEvent(Object.assign({}, e, formData($('#eF', m.el))))); };
    var d = $('[data-d]', m.el);
    if (d) d.onclick = function () {
      confirmBox('Удалить мероприятие?', 'Удалить').then(function (y) {
        if (y) api('remove', { entity: 'events', id: e.id }).then(function () { m.close(); toast('Удалено'); refresh(); }).catch(fail);
      });
    };
    var s = $('[data-s]', m.el);
    if (s) s.onclick = function () {
      var it = formData($('#eF', m.el)); it.id = e.id; busy(s, true);
      api('save', { entity: 'events', item: it }).then(function (rec) { m.close(); refresh(); if (!e.id && rec.status !== 'done') offerCalendar(calEvent(rec)); else toast('Сохранено'); }).catch(function (er) { busy(s, false); fail(er); });
    };
  }

  /* ================= КМБ ================= */
  var SOURCES = ['Встреча', 'Акция', 'Обход', 'Телефон', 'Онлайн', 'Личный контакт', 'Другое'];
  var KMB_PAGE = 100;

  function viewKmb(box) {
    var F = UI.kmbF;
    box.innerHTML = '<div class="head"><div><h1>КМБ — контактно-мобилизационная база</h1><div class="sub" id="kmbSum">Загрузка…</div></div><div class="tools">' +
      '<input class="input" id="kq" placeholder="ФИО, телефон, адрес" value="' + esc(F.q) + '">' +
      '<select class="input" id="ko">' + okrugOptions(F.okrug, { empty: 'Все мои округа' }) + '</select>' +
      (myOkrugs().length ? '<button class="btn" id="kImp">' + icon('upload') + 'Импорт</button><button class="btn" id="kExp">' + icon('download') + 'CSV</button><button class="btn primary" id="kAdd">' + icon('plus') + 'Контакт</button>' : '') +
      '</div></div><div id="kmbList"><div class="card empty">Загрузка…</div></div>';
    var t;
    $('#kq').oninput = function (e) { clearTimeout(t); t = setTimeout(function () { F.q = e.target.value; F.offset = 0; loadKmb(); }, 300); };
    $('#ko').onchange = function (e) { F.okrug = e.target.value; F.offset = 0; loadKmb(); };
    if ($('#kAdd')) {
      $('#kAdd').onclick = function () { editKmb({ okrug: F.okrug || myOkrugs()[0], date: todayMsk(), consent: '1', source: 'Встреча' }); };
      $('#kImp').onclick = importKmb;
      $('#kExp').onclick = exportKmb;
    }
    loadKmb();
  }

  function loadKmb() {
    var F = UI.kmbF;
    return api('kmbList', { q: F.q, okrug: F.okrug, offset: F.offset, limit: KMB_PAGE }).then(function (d) {
      var box = $('#kmbList'); if (!box) return;
      $('#kmbSum').textContent = 'Найдено контактов: ' + fmt(d.total) + '. Только с согласием на обработку персональных данных.';
      if (!d.items.length) { box.innerHTML = '<div class="card empty">Контактов не найдено.</div>'; return; }
      box.innerHTML = '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>ФИО</th><th>Телефон</th><th>Адрес</th><th>Округ</th><th>Источник</th><th>Дата</th><th></th></tr></thead><tbody>' +
        d.items.map(function (k) {
          return '<tr class="click" data-k="' + k.id + '"><td><b>' + esc(k.fio || '—') + '</b>' + (k.tags ? '<div class="sub">' + esc(k.tags) + '</div>' : '') + '</td><td class="nowrap">' + esc(k.phone) + '</td><td>' + esc(k.address) + '</td>' +
            '<td>' + esc(okrugName(k.okrug)) + '</td><td>' + esc(k.source) + '</td><td class="nowrap">' + dateRu(k.date) + '</td><td>' + (k.consent ? '' : '<span class="pill warn" title="Нет отметки о согласии">без согласия</span>') + '</td></tr>';
        }).join('') + '</tbody></table></div>' +
        '<div style="display:flex;gap:8px;align-items:center;justify-content:flex-end;margin-top:10px"><span class="sub">' + (F.offset + 1) + '–' + Math.min(F.offset + KMB_PAGE, d.total) + ' из ' + fmt(d.total) + '</span>' +
        '<button class="btn icon-only" id="kPrev" aria-label="Назад"' + (F.offset ? '' : ' disabled') + '>' + icon('left') + '</button><button class="btn icon-only" id="kNext" aria-label="Вперёд"' + (F.offset + KMB_PAGE < d.total ? '' : ' disabled') + '>' + icon('right') + '</button></div>';
      $('#kPrev').onclick = function () { F.offset = Math.max(0, F.offset - KMB_PAGE); loadKmb(); };
      $('#kNext').onclick = function () { F.offset += KMB_PAGE; loadKmb(); };
      $all('tr[data-k]', box).forEach(function (tr) { tr.onclick = function () { editKmb(d.items.filter(function (k) { return k.id === tr.dataset.k; })[0]); }; });
    }).catch(fail);
  }

  function editKmb(k) {
    var evs = S.events.filter(function (e) { return e.okrug === k.okrug; }).sort(function (a, b) { return a.date < b.date ? 1 : -1; }).slice(0, 60);
    var m = modal(k.id ? 'Контакт' : 'Новый контакт',
      '<form id="kF"><label class="f"><span>ФИО</span><input class="input" name="fio" value="' + esc(k.fio) + '"></label>' +
      '<div class="row2"><label class="f"><span>Телефон</span><input class="input" name="phone" type="tel" value="' + esc(k.phone) + '"></label>' +
      '<label class="f"><span>Дата контакта</span><input class="input" name="date" type="date" value="' + esc(k.date) + '"></label></div>' +
      '<label class="f"><span>Адрес (улица, дом)</span><input class="input" name="address" value="' + esc(k.address) + '"></label>' +
      '<div class="row2"><label class="f"><span>Округ</span><select class="input" name="okrug">' + okrugOptions(k.okrug) + '</select></label>' +
      '<label class="f"><span>Источник</span><select class="input" name="source">' + SOURCES.map(function (s) { return '<option' + (s === k.source ? ' selected' : '') + '>' + s + '</option>'; }).join('') + '</select></label></div>' +
      '<label class="f"><span>Мероприятие (необязательно)</span><select class="input" name="eventId"><option value="">—</option>' + evs.map(function (e) { return '<option value="' + e.id + '"' + (e.id === k.eventId ? ' selected' : '') + '>' + dateRu(e.date) + ' · ' + esc(e.title || CRM.EVENT_TYPES[e.type]) + '</option>'; }).join('') + '</select></label>' +
      '<label class="f"><span>Метки (через запятую)</span><input class="input" name="tags" placeholder="волонтёр, пенсионер, родитель" value="' + esc(k.tags) + '"></label>' +
      '<label class="f"><span>Комментарий</span><textarea class="input" name="comment">' + esc(k.comment) + '</textarea></label>' +
      '<label class="check"><input type="checkbox" name="consent"' + (k.consent ? ' checked' : '') + '> Получено согласие на обработку персональных данных</label></form>',
      (k.id ? '<button class="btn danger left" data-d>Удалить</button>' : '') + '<button class="btn" data-c>Отмена</button><button class="btn primary" data-s>Сохранить</button>');
    $('[data-c]', m.el).onclick = m.close;
    var d = $('[data-d]', m.el);
    if (d) d.onclick = function () {
      confirmBox('Удалить контакт из КМБ?', 'Удалить').then(function (y) {
        if (y) api('remove', { entity: 'kmb', id: k.id }).then(function () { m.close(); toast('Удалено'); refresh(); }).catch(fail);
      });
    };
    $('[data-s]', m.el).onclick = function (ev) {
      var it = formData($('#kF', m.el)); it.id = k.id; busy(ev.target, true);
      api('save', { entity: 'kmb', item: it }).then(function () { m.close(); toast('Сохранено'); refresh(); }).catch(function (er) { busy(ev.target, false); fail(er); });
    };
  }

  function importKmb() {
    var m = modal('Импорт контактов',
      '<p class="small" style="margin-top:0">Скопируйте строки из Excel или Google Таблицы и вставьте ниже. Порядок колонок: <b>ФИО · телефон · адрес · комментарий</b>. Дубли по телефону пропускаются автоматически.</p>' +
      '<div class="row2"><label class="f"><span>Округ</span><select class="input" id="iO">' + okrugOptions(UI.kmbF.okrug || myOkrugs()[0]) + '</select></label>' +
      '<label class="f"><span>Источник</span><select class="input" id="iS">' + SOURCES.map(function (s) { return '<option>' + s + '</option>'; }).join('') + '</select></label></div>' +
      '<label class="f"><span>Дата контактов</span><input class="input" type="date" id="iD" value="' + todayMsk() + '"></label>' +
      '<label class="f"><span>Строки</span><textarea class="input" id="iT" rows="10" placeholder="Иванов Иван Иванович\t+7 999 123-45-67\tул. Подольских Курсантов, 4"></textarea></label>' +
      '<label class="check"><input type="checkbox" id="iC" checked> У всех контактов есть согласие на обработку персональных данных</label><div class="sub" id="iInfo"></div>',
      '<button class="btn" data-c>Отмена</button><button class="btn primary" data-s>Импортировать</button>', true);
    var parse = function () {
      return $('#iT', m.el).value.split(/\r?\n/).map(function (l) { return l.split(/\t|;/); }).filter(function (c) { return c.join('').trim(); }).map(function (c) {
        return { fio: (c[0] || '').trim(), phone: (c[1] || '').trim(), address: (c[2] || '').trim(), comment: (c[3] || '').trim(), okrug: $('#iO', m.el).value, source: $('#iS', m.el).value, date: $('#iD', m.el).value, consent: $('#iC', m.el).checked };
      });
    };
    $('#iT', m.el).oninput = function () { $('#iInfo', m.el).textContent = 'Строк к импорту: ' + parse().length; };
    $('[data-c]', m.el).onclick = m.close;
    $('[data-s]', m.el).onclick = function (ev) {
      var items = parse(); if (!items.length) return toast('Вставьте строки', true);
      busy(ev.target, true);
      api('kmbBulk', { items: items }).then(function (r) {
        m.close();
        var msg = 'Добавлено: ' + r.added + (r.skipped.length ? ', пропущено: ' + r.skipped.length : '');
        if (r.skipped.length) modal('Итог импорта', '<p>' + msg + '</p><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Строка</th><th>Причина</th></tr></thead><tbody>' + r.skipped.slice(0, 200).map(function (s) { return '<tr><td>' + s.row + '</td><td>' + esc(s.reason) + '</td></tr>'; }).join('') + '</tbody></table></div>');
        else toast(msg);
        refresh();
      }).catch(function (e) { busy(ev.target, false); fail(e); });
    };
  }

  function csvCell(v) { v = String(v == null ? '' : v); return /[";\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
  function download(name, text, type) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: type }));
    a.download = name; document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  function exportKmb() {
    var F = UI.kmbF;
    api('kmbList', { q: F.q, okrug: F.okrug, offset: 0, limit: 5000 }).then(function (d) {
      var head = ['ФИО', 'Телефон', 'Адрес', 'Округ', 'Источник', 'Дата', 'Метки', 'Комментарий', 'Согласие'];
      var lines = [head.join(';')].concat(d.items.map(function (k) { return [k.fio, k.phone, k.address, okrugName(k.okrug), k.source, k.date, k.tags, k.comment, k.consent ? 'да' : 'нет'].map(csvCell).join(';'); }));
      download('КМБ_' + todayMsk() + '.csv', '﻿' + lines.join('\r\n'), 'text/csv;charset=utf-8');
      if (d.total > d.items.length) toast('Выгружено ' + d.items.length + ' из ' + d.total + ' — сузьте фильтр', true);
    }).catch(fail);
  }

  /* ================= КОМАНДА ================= */
  // Кто кого может менять: руководитель — всех; координатор — только стажёров своей зоны
  function canManageTeam() { return S.me.role === 'admin' || S.me.role === 'coord'; }
  function canEditUser(u) { return S.me.role === 'admin' || (S.me.role === 'coord' && u.role === 'intern' && u.zone === S.me.zone); }

  function viewTeam(box) {
    var adm = isAdmin(), coord = S.me.role === 'coord', manage = canManageTeam();
    var order = { admin: 0, coord: 1, intern: 2, member: 3 };
    var list = S.users.slice().sort(function (a, b) { return order[a.role] - order[b.role] || (a.zone || '').localeCompare(b.zone || '') || a.name.localeCompare(b.name); });
    var place = function (u) { return u.role === 'coord' ? u.zone + ' · ' + CRM.ZONES[u.zone] : u.okrug ? okrugName(u.okrug) : 'Весь ЮАО'; };
    var cnt = function (r) { return S.users.filter(function (u) { return u.role === r && u.active; }).length; };
    var mine = coord ? S.users.filter(function (u) { return canEditUser(u) && u.active; }).length : 0;
    box.innerHTML = '<div class="head"><div><h1>Команда</h1><div class="sub">Координаторов: ' + cnt('coord') + ' из 8, стажёров: ' + cnt('intern') + ' из 33' +
      (coord ? '. В вашей зоне ' + S.me.zone + ' стажёров: ' + mine : '') + '</div></div><div class="tools">' +
      (adm && S.credUrl ? '<a class="btn" href="' + esc(S.credUrl) + '" target="_blank" rel="noopener">' + icon('link') + 'Все логины и пароли</a>' : '') +
      (manage ? '<button class="btn primary" id="uAdd">' + icon('plus') + (coord ? 'Выдать доступ стажёру' : 'Выдать доступ') + '</button>' : '') + '</div></div>' +
      (adm ? '<p class="sub" style="margin:0 0 var(--s3)">Каждый выданный логин и пароль (и вами, и координаторами) записывается в Google Таблицу на лист «Логины и пароли» — его видите только вы. Если сотрудник сменит пароль сам, там будет пометка.</p>' : '') +
      (coord ? '<p class="sub" style="margin:0 0 var(--s3)">Вы можете выдавать доступ стажёрам округов своей зоны, сбрасывать им пароль, отключать и удалять их. Нажмите на своего стажёра в списке, чтобы изменить.</p>' : '') +
      '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Имя</th><th>Роль</th><th>Зона / округ</th><th>Телефон</th>' + (manage ? '<th>Логин</th><th>Последний вход</th>' : '') + '</tr></thead><tbody>' +
      list.map(function (u) {
        var ed = canEditUser(u);
        return '<tr' + (ed ? ' class="click" data-u="' + u.id + '"' : '') + (u.active ? '' : ' style="opacity:.5"') + '><td><b>' + esc(u.name) + '</b>' + (u.active ? '' : ' <span class="pill">отключён</span>') + '</td><td>' + CRM.ROLES[u.role] + '</td><td>' + esc(place(u)) + '</td><td class="nowrap">' + esc(u.phone) + '</td>' +
          (manage ? '<td>' + esc(u.login || '') + '</td><td class="nowrap sub">' + (u.login ? (u.lastLogin ? dateRu(u.lastLogin) + ' ' + u.lastLogin.slice(11, 16) : 'не входил') : '') + '</td>' : '') + '</tr>';
      }).join('') + '</tbody></table></div>';
    if (manage) {
      $('#uAdd').onclick = function () { editUser({ role: 'intern', active: true, okrug: coord ? myOkrugs()[0] : '' }); };
      $all('tr[data-u]', box).forEach(function (tr) { tr.onclick = function () { editUser(user(tr.dataset.u)); }; });
    }
  }

  var TR = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ы: 'y', э: 'e', ю: 'yu', я: 'ya', ь: '', ъ: '' };
  function translit(s) { return String(s).toLowerCase().split('').map(function (c) { return c in TR ? TR[c] : /[a-z0-9]/.test(c) ? c : c === ' ' ? '.' : ''; }).join('').replace(/\.+/g, '.').replace(/^\.|\.$/g, ''); }
  function genPassword() {
    var ch = 'abcdefghjkmnpqrstuvwxyz23456789', out = '', a = new Uint32Array(10);
    crypto.getRandomValues(a);
    for (var i = 0; i < 10; i++) out += ch[a[i] % ch.length];
    return out;
  }

  function editUser(u, presetPw) {
    var isNew = !u.id, pw = presetPw || (isNew ? genPassword() : '');
    var m = modal(isNew ? 'Новый доступ' : 'Доступ: ' + u.name,
      '<form id="uF"><label class="f"><span>Имя и фамилия</span><input class="input" name="name" value="' + esc(u.name) + '" required></label>' +
      '<div class="row2"><label class="f"><span>Роль</span><select class="input" name="role"' + (S.me.role === 'coord' ? ' disabled' : '') + '>' + Object.keys(CRM.ROLES).filter(function (r) {
        if (S.me.role === 'coord') return r === 'intern';
        return r !== 'member' || u.role === 'member'; // «Участник команды» больше не выдаётся
      }).map(function (r) { return '<option value="' + r + '"' + (r === u.role ? ' selected' : '') + '>' + CRM.ROLES[r] + '</option>'; }).join('') + '</select></label>' +
      '<label class="f"><span>Телефон</span><input class="input" name="phone" type="tel" value="' + esc(u.phone) + '"></label></div>' +
      '<label class="f" id="fZone"><span>Зона координатора</span><select class="input" name="zone">' + Object.keys(CRM.ZONES).map(function (z) { return '<option value="' + z + '"' + (z === u.zone ? ' selected' : '') + '>' + z + ' · ' + CRM.ZONES[z] + '</option>'; }).join('') + '</select></label>' +
      '<label class="f" id="fOkr"><span>Избирательный округ</span><select class="input" name="okrug">' + okrugOptions(u.okrug, { all: S.me.role !== 'coord' }) + '</select></label>' +
      '<div class="row2"><label class="f"><span>Логин</span><input class="input" name="login" autocapitalize="none" value="' + esc(u.login) + '"></label>' +
      '<label class="f"><span>' + (isNew ? 'Пароль' : 'Новый пароль (пусто — не менять)') + '</span><div style="display:flex;gap:6px"><input class="input" name="password" value="' + pw + '"><button type="button" class="btn icon-only" id="gen" aria-label="Сгенерировать пароль" title="Сгенерировать пароль">' + icon('refresh') + '</button></div></label></div>' +
      '<label class="check"><input type="checkbox" name="active"' + (u.active ? ' checked' : '') + '> Доступ включён</label>' +
      '<p class="sub" style="margin:0">' + (S.me.role === 'coord' ? 'Стажёр видит и ведёт только свой округ.' : 'Стажёр видит и ведёт только свой округ, координатор — свою зону и может выдавать доступ своим стажёрам, руководитель — всё.') + '</p></form>',
      (!isNew && u.id !== S.me.id ? '<button class="btn danger left" data-d>Удалить</button>' : '') + '<button class="btn" data-c>Отмена</button><button class="btn primary" data-s>Сохранить</button>');
    var f = $('#uF', m.el);
    var sync = function () {
      var r = f.role.value;
      $('#fZone', m.el).style.display = r === 'coord' ? '' : 'none';
      $('#fOkr', m.el).style.display = r === 'intern' || r === 'member' ? '' : 'none';
    };
    f.role.onchange = sync; sync();
    if (isNew) f.name.oninput = function () { if (!f.login.dataset.touched) f.login.value = translit(f.name.value).slice(0, 32); };
    f.login.oninput = function () { f.login.dataset.touched = 1; };
    $('#gen', m.el).onclick = function () { f.password.value = genPassword(); };
    $('[data-c]', m.el).onclick = m.close;
    var d = $('[data-d]', m.el);
    if (d) d.onclick = function () {
      confirmBox('Удалить доступ «' + u.name + '»? Записи, которые он внёс, останутся.', 'Удалить').then(function (y) {
        if (y) api('userDelete', { id: u.id }).then(function () { m.close(); toast('Удалено'); refresh(); }).catch(fail);
      });
    };
    $('[data-s]', m.el).onclick = function () {
      var it = formData(f); it.id = u.id;
      it.login = String(it.login || '').trim().toLowerCase();
      // Быстрая проверка на месте — чтобы не ждать сервер ради очевидных ошибок
      var err = !/^[a-z0-9._-]{2,32}$/.test(it.login) ? 'Логин: 2–32 символа, латиница, цифры, точка, дефис'
        : !String(it.name || '').trim() ? 'Укажите имя'
        : S.users.some(function (x) { return x.login && x.login.toLowerCase() === it.login && x.id !== u.id; }) ? 'Такой логин уже занят'
        : (isNew && !it.password) ? 'Задайте пароль'
        : (it.password && String(it.password).length < 6) ? 'Пароль — минимум 6 символов' : '';
      if (err) return toast(err, true);
      m.close(); // окно закрывается сразу, сохранение идёт в фоне
      var c = null, statusEl = null;
      if (it.password) {
        var text = 'CRM кампании ЮАО\nСайт: ' + location.origin + location.pathname + '\nЛогин: ' + it.login + '\nПароль: ' + it.password;
        c = modal('Доступ для ' + it.name, '<p style="margin-top:0">Передайте эти данные лично. Логин и пароль также запишутся в Google Таблицу на лист «Логины и пароли».</p><div class="cred">' + esc(text) + '</div>' +
          '<p class="sub" id="uStatus" style="margin:0">Сохраняем на сервере…</p>',
          '<button class="btn" data-c>Закрыть</button><button class="btn primary" data-copy>Скопировать</button>');
        statusEl = $('#uStatus', c.el);
        $('[data-c]', c.el).onclick = c.close;
        $('[data-copy]', c.el).onclick = function () { navigator.clipboard.writeText(text).then(function () { toast('Скопировано'); }, function () { toast('Выделите текст и скопируйте вручную', true); }); };
      } else toast('Сохраняем…');
      api('userSave', { item: it }).then(function (saved) {
        var i = S.users.findIndex(function (x) { return x.id === saved.id; });
        if (i >= 0) S.users[i] = saved; else S.users.push(saved);
        if (statusEl) { statusEl.textContent = 'Сохранено. Сотрудник уже может войти.'; statusEl.style.color = 'var(--ok-ink)'; } else toast('Сохранено');
        if (route() === 'team') render();
        refresh();
      }).catch(function (e) {
        if (statusEl) {
          statusEl.innerHTML = '<span style="color:var(--bad-ink)">Не сохранилось: ' + esc(e.message) + '</span> <button class="btn sm" data-fix>Исправить</button>';
          $('[data-fix]', c.el).onclick = function () { c.close(); editUser(Object.assign({}, u, it, { active: !!it.active }), it.password); };
        } else { fail(e); editUser(Object.assign({}, u, it, { active: !!it.active })); }
      });
    };
  }

  /* ================= ПЛАН KPI ================= */
  function viewPlan(box) {
    var n = S.okrugs.length;
    box.innerHTML = '<div class="head"><div><h1>План KPI</h1><div class="sub">Нагрузка на один избирательный округ в месяц (из презентации, слайд 6). Встреча ≈ 15 контактов, акция ≈ 10.</div></div><div class="tools"><button class="btn" id="pRow">' + icon('plus') + 'Месяц</button><button class="btn primary" id="pSave">Сохранить план</button></div></div>' +
      '<div class="tbl-wrap"><table class="tbl" id="pT"><thead><tr><th>Месяц</th><th class="num">Встреч</th><th class="num">Акций</th><th class="num">КМБ</th><th class="num">КМБ по ЮАО (×' + n + ')</th><th></th></tr></thead><tbody>' +
      S.plan.map(planRow).join('') + '</tbody></table></div>' +
      '<p class="sub">Итого по ЮАО: встреч ' + fmt(S.plan.reduce(function (s, p) { return s + +p.meetings; }, 0) * n) + ', акций ' + fmt(S.plan.reduce(function (s, p) { return s + +p.actions; }, 0) * n) + ', КМБ ' + fmt(S.plan.reduce(function (s, p) { return s + +p.kmb; }, 0) * n) + '.</p>';
    function planRow(p) {
      return '<tr><td><input class="input" type="month" data-f="month" value="' + esc(p.month) + '"></td><td><input class="input num" type="number" min="0" data-f="meetings" value="' + esc(p.meetings) + '"></td>' +
        '<td><input class="input num" type="number" min="0" data-f="actions" value="' + esc(p.actions) + '"></td><td><input class="input num" type="number" min="0" data-f="kmb" value="' + esc(p.kmb) + '"></td>' +
        '<td class="num muted">' + fmt(+p.kmb * n) + '</td><td><button class="btn icon-only danger" data-del aria-label="Удалить месяц">' + icon('x') + '</button></td></tr>';
    }
    var bindDel = function () { $all('[data-del]', box).forEach(function (b) { b.onclick = function () { b.closest('tr').remove(); }; }); };
    bindDel();
    $('#pRow').onclick = function () { $('#pT tbody').insertAdjacentHTML('beforeend', planRow({ month: '', meetings: 0, actions: 0, kmb: 0 })); bindDel(); };
    $('#pSave').onclick = function (ev) {
      var rows = $all('#pT tbody tr', box).map(function (tr) { var o = {}; $all('[data-f]', tr).forEach(function (i) { o[i.dataset.f] = i.value; }); return o; });
      busy(ev.target, true);
      api('planSave', { rows: rows }).then(function () { toast('План сохранён'); refresh(); }).catch(function (e) { busy(ev.target, false); fail(e); });
    };
  }

  /* ================= РЕЗЕРВ ================= */
  function viewBackup(box) {
    box.innerHTML = '<div class="head"><div><h1>Резервные копии</h1><div class="sub">Как защищены данные</div></div></div>' +
      '<div class="grid two" style="margin-bottom:14px">' +
      '<div class="card"><h2>1. Основное хранилище</h2><p class="small">' + (DEMO ? 'Сейчас демо-режим: данные только в этом браузере. Подключите Google Таблицу по инструкции — тогда они будут на сервере.' : 'Все данные лежат в Google Таблице, отдельно от сайта. Обновления сайта их не затрагивают. У Таблицы есть своя история версий: Файл → История версий.') + '</p></div>' +
      '<div class="card"><h2>2. Ночные копии таблицы</h2><p class="small">Каждую ночь в 3:00 сервер сам делает полную копию Таблицы в папку «CRM ЮАО — резервные копии» на Google Диске и хранит последние 60.</p>' +
      (DEMO ? '' : '<button class="btn" id="bNow">Сделать копию сейчас</button> <button class="btn" id="bList">Показать копии</button><div id="bOut" style="margin-top:10px"></div>') + '</div>' +
      '<div class="card"><h2>3. Файл на ваш компьютер</h2><p class="small">Полная выгрузка всех разделов (включая фото и пароли в зашифрованном виде) одним файлом. Храните его в надёжном месте — в нём персональные данные КМБ.</p><button class="btn primary" id="bExp">Скачать копию (.json)</button></div>' +
      '<div class="card"><h2>4. Восстановление</h2><p class="small">Заменяет все данные содержимым файла копии. Перед восстановлением сделайте свежую копию.</p><label class="btn danger">Восстановить из файла<input type="file" accept=".json,application/json" id="bImp" hidden></label></div>' +
      '</div>' +
      (DEMO ? '<div class="card" style="margin-bottom:14px"><h2>Демо-данные</h2><p class="small">Заполнить систему вымышленными стажёрами, кандидатами, мероприятиями и контактами, чтобы посмотреть карту и сводку в работе.</p><button class="btn" id="dFill">Заполнить демо-данными</button> <button class="btn danger" id="dWipe">Очистить всё</button></div>' : '') +
      '<div class="card"><h2>Журнал действий</h2><div id="logBox" class="sub">Загрузка…</div></div>';
    $('#bExp').onclick = function () {
      api('exportAll').then(function (d) { download('CRM_ЮАО_копия_' + todayMsk() + '.json', JSON.stringify(d), 'application/json'); toast('Файл скачан'); }).catch(fail);
    };
    $('#bImp').onchange = function (e) {
      var file = e.target.files[0]; if (!file) return;
      file.text().then(function (t) {
        var data = JSON.parse(t);
        return confirmBox('Заменить ВСЕ текущие данные копией от ' + dateRu(data.exported) + '? После этого всем нужно будет войти заново.', 'Восстановить').then(function (y) {
          if (!y) return;
          return api('importAll', { data: data }).then(function () { toast('Восстановлено'); logout(true); });
        });
      }).catch(function (er) { fail(er.message.indexOf('JSON') >= 0 ? new Error('Файл повреждён или это не копия CRM') : er); });
    };
    if ($('#bNow')) {
      $('#bNow').onclick = function (ev) { busy(ev.target, true); api('backupNow').then(function (r) { busy(ev.target, false); toast('Копия создана: ' + r.name); }).catch(function (e) { busy(ev.target, false); fail(e); }); };
      $('#bList').onclick = function () {
        api('backups').then(function (l) {
          $('#bOut').innerHTML = l.length ? l.slice(0, 15).map(function (b) { return '<div class="small"><a href="' + esc(b.url) + '" target="_blank" rel="noopener">' + esc(b.name) + '</a></div>'; }).join('') + (l.length > 15 ? '<div class="sub">и ещё ' + (l.length - 15) + '</div>' : '') : '<span class="sub">Копий пока нет</span>';
        }).catch(fail);
      };
    }
    if ($('#dFill')) {
      $('#dFill').onclick = function () { fillDemo(); UI.month = curMonth(); toast('Демо-данные добавлены'); refresh(); };
      $('#dWipe').onclick = function () { confirmBox('Стереть все демо-данные?', 'Стереть').then(function (y) { if (y) { demoStore.wipe(); CRM.createAdmin(demoStore, 'admin', 'admin123'); logout(true); } }); };
    }
    api('log').then(function (l) {
      $('#logBox').innerHTML = l.length ? '<div class="tbl-wrap" style="max-height:360px;overflow:auto;box-shadow:none"><table class="tbl"><tbody>' + l.map(function (x) {
        return '<tr><td class="nowrap">' + dateRu(x.ts) + ' ' + String(x.ts).slice(11, 16) + '</td><td>' + esc(x.user) + '</td><td>' + esc(x.action) + '</td><td class="sub">' + esc(x.details) + '</td></tr>';
      }).join('') + '</tbody></table></div>' : 'Пусто';
    }).catch(function () { });
  }

  function fillDemo() {
    var S2 = demoStore, rnd = function (n) { return Math.floor(Math.random() * n); };
    var F = ['Иванов', 'Смирнова', 'Кузнецов', 'Попова', 'Волков', 'Соколова', 'Лебедев', 'Козлова', 'Новиков', 'Морозова', 'Петров', 'Орлова', 'Зайцев', 'Павлова', 'Семёнов', 'Голубева'];
    var N = ['Алексей', 'Мария', 'Дмитрий', 'Анна', 'Сергей', 'Екатерина', 'Андрей', 'Ольга', 'Илья', 'Наталья'];
    var name = function () { return F[rnd(F.length)] + ' ' + N[rnd(N.length)]; };
    var okrs = S2.rows('Okrugs'), cm = curMonth(), months = [cm];
    var pm = new Date(cm + '-01'); pm.setMonth(pm.getMonth() - 1); months.unshift(pm.toISOString().slice(0, 7));
    var now = new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 19);
    Object.keys(CRM.ZONES).forEach(function (z, i) { var salt = 'demo'; S2.insert('Users', { id: S2.uuid(), login: 'k' + (i + 1), name: name(), role: 'coord', zone: z, okrug: '', phone: '+7 900 000-00-0' + i, active: '1', salt: salt, hash: CRM._hash(salt, 'demo123'), created: now, lastLogin: '' }); });
    var c = [], e = [], k = [], ph = 100000000;
    okrs.forEach(function (o, idx) {
      var skill = Math.random();
      if (skill > 0.12) S2.insert('Users', { id: S2.uuid(), login: 'st' + (idx + 1), name: name(), role: 'intern', zone: o.zone, okrug: o.id, phone: '+7 901 000-00-' + (10 + idx), active: '1', salt: 'demo', hash: CRM._hash('demo', 'demo123'), created: now, lastLogin: '' });
      var nc = Math.min(+o.mandates, Math.round(skill * (+o.mandates + 1)));
      for (var i = 0; i < nc; i++) c.push({ id: S2.uuid(), okrug: o.id, fio: name() + 'ович', description: 'Житель района, активист домового чата.', budget: String(20000 + rnd(40) * 1000), phone: '', status: CRM.CAND_STATUSES[rnd(4)], hasPhoto: '', created: now, createdBy: '', updated: now });
      months.forEach(function (m) {
        var last = m === cm ? +todayMsk().slice(8, 10) : 28;
        var nm = Math.round(skill * 4), na = Math.round(skill * 3);
        for (var j = 0; j < nm + na; j++) e.push({ id: S2.uuid(), okrug: o.id, type: j < nm ? 'meet' : 'act', date: m + '-' + ('0' + (1 + rnd(last))).slice(-2), title: j < nm ? 'Встреча с жителями' : 'Пикет у метро', address: '', contacts: String(5 + rnd(15)), status: 'done', notes: '', created: now, createdBy: '', updated: now });
        var nk = Math.round(skill * 80 * (m === cm ? +todayMsk().slice(8, 10) / 30 : 1));
        for (var q = 0; q < nk; q++) k.push({ id: S2.uuid(), okrug: o.id, fio: name(), phone: '+7 9' + (ph++), address: '', source: 'Встреча', eventId: '', consent: '1', tags: '', comment: '', date: m + '-' + ('0' + (1 + rnd(last))).slice(-2), created: now, createdBy: '' });
      });
    });
    S2.insertMany('Candidates', c); S2.insertMany('Events', e); S2.insertMany('Kmb', k);
  }

  /* ================= ПРОФИЛЬ ================= */
  function viewProfile(box) {
    box.innerHTML = '<div class="head"><div><h1>Профиль</h1></div></div><div class="grid two">' +
      '<div class="card"><h2>' + esc(S.me.name) + '</h2><p class="small">Роль: <b>' + CRM.ROLES[S.me.role] + '</b><br>Логин: <b>' + esc(S.me.login) + '</b>' +
      (S.me.zone ? '<br>Зона: ' + S.me.zone + ' · ' + CRM.ZONES[S.me.zone] : '') + (S.me.okrug ? '<br>Округ: ' + esc(okrugName(S.me.okrug)) : '') + '</p>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" id="theme">Тема: ' + ({ light: 'светлая', dark: 'тёмная' }[lsGet('crm-theme')] || 'как в системе') + '</button><button class="btn danger" id="out">' + icon('logout') + 'Выйти</button></div></div>' +
      '<form class="card" id="pwF"><h2>Сменить пароль</h2><label class="f"><span>Текущий пароль</span><div class="pw"><input class="input" type="password" name="old" autocomplete="current-password"><button type="button" class="pw-eye" aria-label="Показать пароль" title="Показать пароль">' + icon('eye') + '</button></div></label>' +
      '<label class="f"><span>Новый пароль (от 6 символов)</span><div class="pw"><input class="input" type="password" name="password" autocomplete="new-password"><button type="button" class="pw-eye" aria-label="Показать пароль" title="Показать пароль">' + icon('eye') + '</button></div></label><button class="btn primary">Сменить</button></form></div>';
    $('#out').onclick = function () { logout(); };
    $('#theme').onclick = function () {
      var order = ['', 'light', 'dark'], cur = lsGet('crm-theme'), next = order[(order.indexOf(cur) + 1) % 3];
      lsSet('crm-theme', next); applyTheme(); render();
    };
    $('#pwF').onsubmit = function (e) {
      e.preventDefault(); var f = formData(e.target), b = $('button', e.target); busy(b, true);
      api('changePassword', f).then(function () { busy(b, false); e.target.reset(); toast('Пароль изменён'); }).catch(function (er) { busy(b, false); fail(er); });
    };
  }

  function applyTheme() { var t = lsGet('crm-theme'); if (t) document.documentElement.setAttribute('data-theme', t); else document.documentElement.removeAttribute('data-theme'); }

  // Кнопка «глаз» в полях пароля: показать / скрыть
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('.pw-eye'); if (!b) return;
    var inp = b.parentNode.querySelector('input'), show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    b.innerHTML = icon(show ? 'eyeoff' : 'eye');
    b.setAttribute('aria-label', show ? 'Скрыть пароль' : 'Показать пароль'); b.title = b.getAttribute('aria-label');
    inp.focus();
  });

  /* ---------- старт ---------- */
  applyTheme();
  if (S.token) load(); else renderLogin();
})();
