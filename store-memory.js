/* Хранилище для демо-режима в браузере (localStorage) и для тестов. */
function MemoryStore(persistKey) {
  var db = {};
  if (persistKey) { try { db = JSON.parse(localStorage.getItem(persistKey) || '{}'); } catch (e) { db = {}; } }
  function key(name) { return CRM.SCHEMA[name][0]; }
  function save() { if (persistKey) { try { localStorage.setItem(persistKey, JSON.stringify(db)); } catch (e) { } } }
  function t(name) { return (db[name] = db[name] || []); }
  function copy(o) { var r = {}; for (var k in o) r[k] = o[k] == null ? '' : String(o[k]); return r; }
  return {
    kind: 'demo',
    rows: function (n) { return t(n).map(copy); },
    insert: function (n, o) { t(n).push(copy(o)); save(); },
    insertMany: function (n, l) { l.forEach(function (o) { t(n).push(copy(o)); }); save(); },
    update: function (n, o) { var k = key(n), a = t(n); for (var i = 0; i < a.length; i++) if (a[i][k] === o[k]) { a[i] = copy(o); save(); return; } throw new Error('Запись не найдена'); },
    remove: function (n, id) { var k = key(n); db[n] = t(n).filter(function (o) { return o[k] !== id; }); save(); },
    removeWhere: function (n, p) { db[n] = t(n).filter(function (o) { return !p(copy(o)); }); save(); },
    replaceAll: function (n, l) { db[n] = l.map(copy); save(); },
    uuid: function () { return (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : require('crypto').randomUUID(); },
    lock: function (fn) { return fn(); },
    // Демо: файлы хранятся тут же, в памяти браузера
    saveFile: function (id, name, mime, base64) { (db._files = db._files || {})[id] = base64; save(); return id; },
    readFile: function (fid) { return (db._files || {})[fid] || ''; },
    deleteFile: function (fid) { if (db._files) { delete db._files[fid]; save(); } },
    wipe: function () { db = {}; save(); }
  };
}
if (typeof module !== 'undefined') module.exports = MemoryStore;
