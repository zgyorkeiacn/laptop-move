// Laptop mover page. It talks only to its own server on 127.0.0.1 (every call carries the key the page came with) and
// holds no move logic: the server runs the engine and streams its events. The password is read from its field, sent
// once in the body of the pack or restore call, and the field is cleared at once; it is never stored by the page.
(function () {
  'use strict';
  var KEY = (document.querySelector('meta[name="lm-key"]') || {}).content || '';
  var $ = function (id) { return document.getElementById(id); };
  var S = { state: null, sel: null, selFile: null, selName: null, disc: null, dry: null, dryOpts: null, pack: null, restore: null, rsMan: null, ticks: {}, jobs: {}, finished: {}, ended: false };

  // ---- helpers ----------------------------------------------------------------------------------------------------
  function el(tag, attrs) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), v);
      else if (v === true) e.setAttribute(k, '');
      else e.setAttribute(k, String(v));
    });
    for (var i = 2; i < arguments.length; i++) add(e, arguments[i]);
    return e;
  }
  function add(e, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { add(e, x); }); return; }
    e.append(c instanceof Node ? c : String(c));
  }
  function clear(e) { while (e.firstChild) e.removeChild(e.firstChild); return e; }
  function tag(cls, text) { return el('span', { class: 'tag ' + cls, text: text }); }
  function bytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    var u = ['KB', 'MB', 'GB', 'TB'], i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
    return (n >= 100 ? Math.round(n) : n.toFixed(1)) + ' ' + u[i];
  }
  function mins(s) {
    s = Number(s) || 0;
    if (s < 90) return 'about 1 min';
    var m = Math.round(s / 60);
    return m < 90 ? 'about ' + m + ' min' : 'about ' + (m / 60).toFixed(1) + ' h';
  }
  function say(id, text, bad) { var e = $(id); if (!e) return; e.textContent = text || ''; e.classList.toggle('bad', !!bad); }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  function setBar(bar, pct) {
    if (!bar) return;
    pct = Math.max(0, Math.min(100, Math.round(pct)));
    var i = bar.querySelector('i');
    if (i) i.style.width = pct + '%';
    bar.setAttribute('aria-valuenow', String(pct));
  }
  function api(name, body) {
    var init = body === undefined ? { headers: { 'X-LM-Key': KEY } } : { method: 'POST', headers: { 'X-LM-Key': KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    return fetch('/api/' + name, init).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (j) {
        if (!r.ok) throw new Error((j && j.error) || ('the mover answered ' + r.status));
        return j;
      });
    });
  }
  function errText(e) { return String((e && e.message) || e); }

  // ---- screens and navigation ---------------------------------------------------------------------------------------
  var GROUPS = [
    ['Part 1: scan and choose', ['start', 'scan', 'apps', 'folders', 'repos', 'settings', 'byhand']],
    ['Part 2: dry run and pack', ['dryrun', 'password', 'packing']],
    ['Part 3 and 4: upload and restore', ['upload', 'restore', 'restoring', 'report']],
    ['Guide', ['tutorial', 'instructions', 'help']],
  ];
  var arts = [].slice.call(document.querySelectorAll('article[data-screen]'));
  var byId = {};
  arts.forEach(function (a) { byId[a.getAttribute('data-screen')] = a; });
  var toc = $('toc');
  GROUPS.forEach(function (g) {
    toc.appendChild(el('h2', { text: g[0] }));
    g[1].forEach(function (id) {
      toc.appendChild(el('button', { type: 'button', 'data-go': id, 'data-toc': id }, byId[id].getAttribute('data-title'), el('span', { class: 'st', id: 'st-' + id })));
    });
  });
  // a help link to the guide on every screen
  arts.forEach(function (a) {
    var topic = a.getAttribute('data-help') || 'start';
    var link = el('a', { class: 'help', href: '/guide/' + topic, target: '_blank', rel: 'noopener', 'data-helplink': topic }, 'Help: open the guide');
    var bar = a.querySelector('.sbar');
    if (bar) bar.appendChild(link); else a.insertBefore(el('p', null, link), a.firstChild);
  });
  function mark(id, text) { var s = $('st-' + id); if (s) s.textContent = text || ''; }
  function show(id) {
    if (!byId[id]) id = 'start';
    arts.forEach(function (a) { a.classList.toggle('hide', a !== byId[id]); });
    [].forEach.call(document.querySelectorAll('[data-toc]'), function (b) { var on = b.getAttribute('data-toc') === id; b.classList.toggle('on', on); b.setAttribute('aria-current', on ? 'page' : 'false'); });
    document.title = 'Laptop mover: ' + byId[id].getAttribute('data-title');
    document.body.setAttribute('data-now', id);
    if (history.replaceState) history.replaceState(null, '', '#' + id);
    var r = RENDER[id]; if (r) r();
    window.scrollTo(0, 0);
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-go]');
    if (b) { e.preventDefault(); show(b.getAttribute('data-go')); }
  });

  // ---- the selection --------------------------------------------------------------------------------------------
  function emptySelection() { return { savedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), folders: [], applications: [], settings: [], questions: [], comments: {}, commentLabels: {} }; }
  function ensureSel() { if (!S.sel) { S.sel = emptySelection(); S.selName = 'new selection'; } return S.sel; }
  function setSelection(r) { S.sel = r.json; S.selFile = r.file || null; S.selName = r.name || (r.file ? r.file.split('\\').pop() : 'selection'); renderSelInfo(); }
  var pushTimer = null;
  function selChanged() { if (pushTimer) clearTimeout(pushTimer); pushTimer = setTimeout(pushSel, 400); }
  function pushSel() {
    if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
    if (!S.sel) return Promise.resolve();
    return api('selection/set', { json: S.sel });
  }
  var LOOSE = /\(loose files[^)]*\)\s*$/i;
  function lc(s) { return String(s || '').toLowerCase(); }
  function findFolder(p) { var k = lc(p); return (S.sel ? S.sel.folders : []).filter(function (f) { return lc(f.path) === k; })[0] || null; }
  function setFolder(p, on, mode) {
    var s = ensureSel(), f = findFolder(p);
    if (on && !f) s.folders.push({ path: p, mode: mode });
    if (on && f) f.mode = mode;
    if (!on && f) s.folders.splice(s.folders.indexOf(f), 1);
    selChanged();
  }
  function renderSelInfo() {
    var info = $('selinfo');
    if (!S.sel) { info.textContent = 'No selection is loaded yet. Load one, import one, or scan and choose to build a new one.'; return; }
    var a = (S.sel.applications || []).length, st = (S.sel.settings || []).length;
    clear(info);
    add(info, [el('strong', { text: S.selName || 'selection' }), S.selFile ? ' (' + S.selFile + ')' : ' (not saved yet)', ': ', plural(S.sel.folders.length, 'folder row'), ', ', plural(a, 'application'), ', ', plural(st, 'setting'), S.sel.savedAt ? '. Saved ' + S.sel.savedAt + '.' : '.']);
    if ($('savefile') && !$('savefile').value && S.selFile) $('savefile').value = S.selFile;
  }

  // ---- state ----------------------------------------------------------------------------------------------------
  function loadState() {
    return api('state').then(function (st) {
      S.state = st;
      $('who').textContent = (st.env.user || 'you') + ' on ' + (st.env.computer || 'this computer') + (st.mode === 'new' ? ', new laptop' : ', old laptop') + ' (127.0.0.1 only)';
      if (!st.sevenZip.ok) { $('szcard').classList.remove('hide'); $('sztext').textContent = st.sevenZip.why || 'not found.'; }
      if (st.selectionError) say('selstat', 'The selection could not be read: ' + st.selectionError, true);
      clear($('selcands'));
      var have = (st.candidates || []).filter(function (c) { return c.exists; });
      if (have.length) add($('selcands'), ['Found: ', have.map(function (c) { return el('button', { class: 'btn ghost sm', type: 'button', onclick: function () { $('selfile').value = c.file; loadSel(c.file); } }, c.file); })]);
      $('wifinote').textContent = st.wifiStep;
      $('printernote').textContent = st.printerStep;
      if (!$('outdir').value) $('outdir').value = st.defaults.out || '';
      if (!$('rsfrom').value) $('rsfrom').value = st.defaults.from || '';
      if (!$('rswork').value) $('rswork').value = st.defaults.work || '';
      if (st.scanRoots && !$('scanroots').value) $('scanroots').value = st.scanRoots.join('; ');
      $('oldnote').classList.toggle('hide', st.mode === 'new');
      if (st.manifest) S.rsMan = st.manifest;
      $('pwlen').textContent = 'At least ' + st.minPassword + ' characters';
      if (st.job) S.jobs[st.job.kind] = st.job;
      return st;
    });
  }
  function loadSelectionNow() {
    return api('selection').then(function (r) { if (r.json) { setSelection(r); if (!$('selfile').value && r.file) $('selfile').value = r.file; } else renderSelInfo(); });
  }
  function loadSel(file) {
    say('selstat', 'loading');
    return api('selection/load', { file: file }).then(function (r) { setSelection({ file: r.file, json: r.json }); say('selstat', 'loaded'); }, function (e) { say('selstat', errText(e), true); });
  }
  $('selload').addEventListener('click', function () { var f = $('selfile').value.trim(); if (!f) { say('selstat', 'name the file first', true); return; } loadSel(f); });
  $('selpick').addEventListener('change', function () {
    var f = this.files && this.files[0];
    if (!f) return;
    var rd = new FileReader();
    rd.onload = function () {
      var json;
      try { json = JSON.parse(String(rd.result).replace(/^﻿/, '')); } catch (e) { say('selstat', 'that file is not JSON', true); return; }
      api('selection/import', { name: f.name, json: json }).then(function (r) { setSelection(r); say('selstat', 'imported (save it to keep it)'); }, function (e) { say('selstat', errText(e), true); });
    };
    rd.readAsText(f);
    this.value = '';
  });
  $('selnew').addEventListener('click', function () {
    api('selection/import', { name: 'new selection', json: emptySelection() }).then(function (r) { setSelection(r); say('selstat', 'empty selection started: scan, then tick what moves'); }, function (e) { say('selstat', errText(e), true); });
  });

  // ---- jobs and the event stream ---------------------------------------------------------------------------------
  var HANDLERS = {};
  function onJob(j) {
    if (!j) return;
    S.jobs[j.kind] = j;
    var h = HANDLERS[j.kind];
    if (j.state !== 'running' && !S.finished[j.id]) { S.finished[j.id] = true; if (h && h.finish) h.finish(j); }
    else if (h && h.update) h.update(j);
  }
  function onEvent(kind, ev) {
    var j = S.jobs[kind];
    if (j && ev.type === 'progress') j.progress = ev;
    else if (j) j.events.push(ev);
    var h = HANDLERS[kind]; if (h && h.event) h.event(ev);
  }
  var es = null, esFails = 0;
  function connect() {
    if (S.ended) return;
    es = new EventSource('/api/events?k=' + encodeURIComponent(KEY));
    es.onmessage = function (m) {
      esFails = 0;
      var msg; try { msg = JSON.parse(m.data); } catch (e) { return; }
      if (msg.type === 'hello') { if (msg.job) onJob(msg.job); }
      else if (msg.type === 'job') onJob(msg.job);
      else if (msg.type === 'event') onEvent(msg.kind, msg.event);
      else if (msg.type === 'end') ended();
    };
    es.onerror = function () { if (++esFails > 5) ended(); };
  }
  // a fallback for a missed message: while a job runs, ask for it now and then
  setInterval(function () {
    if (S.ended) return;
    var running = Object.keys(S.jobs).some(function (k) { return S.jobs[k].state === 'running'; });
    if (running) api('job').then(function (r) { if (r.job && r.job.state !== 'running') onJob(r.job); }, function () {});
  }, 2000);
  function ended() {
    if (S.ended) return;
    S.ended = true;
    if (es) es.close();
    $('ended').classList.remove('hide');
    [].forEach.call(document.querySelectorAll('button'), function (b) { if (!b.hasAttribute('data-go') && !b.hasAttribute('data-toc')) b.disabled = true; });
  }
  $('end').addEventListener('click', function () {
    api('end', {}).then(ended, function (e) { alert(errText(e)); });
  });
  function start(kind, body) {
    return api(kind, body).then(function (j) { S.jobs[kind] = j; delete S.finished[j.id]; var h = HANDLERS[kind]; if (h && h.begin) h.begin(j); return j; });
  }

  // ---- scan --------------------------------------------------------------------------------------------------------
  $('scango').addEventListener('click', function () {
    var roots = $('scanroots').value.split(/[;\n]/).map(function (s) { return s.trim(); }).filter(Boolean);
    say('scanstat', 'scanning');
    start('discover', { roots: roots, apps: $('scanapps').checked }).catch(function (e) { say('scanstat', errText(e), true); });
  });
  HANDLERS.discover = {
    begin: function () { $('scanbar').classList.add('busy'); $('scantext').textContent = 'Scanning folders, applications, repositories and settings'; clear($('scannotes')); },
    event: function (ev) {
      if (ev.type === 'progress' && ev.total) { $('scanbar').classList.remove('busy'); setBar($('scanbar'), ev.done / ev.total * 100); }
      if (ev.text) $('scantext').textContent = ev.text;
    },
    finish: function (j) {
      $('scanbar').classList.remove('busy');
      if (j.state === 'failed') { say('scanstat', j.error, true); return; }
      S.disc = j.result;
      setBar($('scanbar'), 100);
      var f = S.disc.found, repos = f.filter(function (x) { return x.kind === 'repo'; }).length;
      $('scantext').textContent = 'Scan finished: ' + plural(f.length - repos, 'folder') + ', ' + plural(repos, 'repository', 'repositories') + ', ' + plural(S.disc.apps.length, 'application') + ', ' + plural(S.disc.settings.filter(function (s) { return s.present; }).length, 'setting') + ' found';
      say('scanstat', 'done');
      mark('scan', 'done');
      clear($('scannotes'));
      if (S.disc.notes.length) add($('scannotes'), el('ul', null, S.disc.notes.map(function (n) { return el('li', { text: n }); })));
    },
  };

  // ---- choose: folders and repositories --------------------------------------------------------------------------
  var MODES = ['copy whole', 'clone again + bundle/dirty', 'clone again', 'by hand'];
  function rowsOf(kindWanted) {
    var map = {}, list = [];
    function put(r) { var k = lc(r.path); if (map[k]) { Object.keys(r).forEach(function (x) { if (r[x] != null && r[x] !== '' && map[k][x] == null) map[k][x] = r[x]; }); return; } map[k] = r; list.push(r); }
    (S.disc ? S.disc.found : []).forEach(function (f) { put({ path: f.path, kind: f.kind, remote: f.remote, client: f.client, secret: f.secret, mode: f.mode, note: f.note }); });
    (S.sel ? S.sel.folders : []).forEach(function (f) {
      var k = lc(f.path);
      if (map[k]) return;
      var kind = LOOSE.test(f.path) ? 'loose' : /clone/i.test(f.mode) ? 'repo' : 'folder';
      put({ path: f.path, kind: kind, remote: null, client: null, secret: null, mode: f.mode, note: 'from the selection' });
    });
    return list.filter(function (r) { return kindWanted === 'repo' ? r.kind === 'repo' : r.kind !== 'repo'; });
  }
  function modeSelect(row, current) {
    var opts = MODES.slice();
    if (current && opts.indexOf(current) < 0) opts.push(current);
    var s = el('select', { class: 'mode', 'aria-label': 'How ' + row.path + ' moves' });
    opts.forEach(function (m) { s.appendChild(el('option', { value: m, selected: m === current }, m)); });
    return s;
  }
  function stateTags(r) {
    var t = [];
    if (r.secret) t.push(tag('bad', 'secrets'));
    if (r.client) t.push(tag('warn', r.remote ? 'client, has remote' : 'client'));
    else if (r.remote === true) t.push(tag('ok', 'has remote'));
    else if (r.remote === false && r.kind === 'repo') t.push(tag('ok', 'no remote'));
    if (r.remote == null && r.client == null) t.push(tag('grey', 'not scanned'));
    return t;
  }
  function renderPaths(kind, bodyId, sumId, filterId) {
    var body = clear($(bodyId)), rows = rowsOf(kind);
    if (!rows.length) { body.appendChild(el('tr', null, el('td', { colspan: kind === 'repo' ? 5 : 4, text: S.sel || S.disc ? 'Nothing here yet.' : 'Scan this laptop or load a selection first.' }))); }
    rows.forEach(function (r) {
      var sf = findFolder(r.path), mode = sf ? sf.mode : r.mode || 'copy whole';
      var box = el('input', { type: 'checkbox', checked: !!sf, 'aria-label': 'Move ' + r.path });
      var sel = modeSelect(r, mode);
      box.addEventListener('change', function () { setFolder(r.path, box.checked, sel.value); sums(); });
      sel.addEventListener('change', function () { if (box.checked) setFolder(r.path, true, sel.value); });
      var cells = [el('td', null, box), el('td', { class: 'path' }, el('code', { text: r.path }))];
      if (kind === 'repo') cells.push(el('td', null, stateTags(r)));
      else cells.push(el('td', null, sel));
      if (kind === 'repo') cells.push(el('td', null, sel)); else if (r.secret || r.client) cells[1].appendChild(el('div', null, stateTags(r)));
      cells.push(el('td', { class: 'small', text: r.note || '' }));
      body.appendChild(el('tr', { 'data-filter': lc(r.path) }, cells));
    });
    filterRows(filterId, bodyId);
    sums();
  }
  function filterRows(filterId, bodyId) {
    var q = lc($(filterId).value).trim();
    [].forEach.call($(bodyId).querySelectorAll('tr[data-filter]'), function (tr) { tr.classList.toggle('hide', !!q && tr.getAttribute('data-filter').indexOf(q) < 0); });
  }
  [['folderfilter', 'folderrows'], ['repofilter', 'reporows'], ['appfilter', 'approws']].forEach(function (p) { $(p[0]).addEventListener('input', function () { filterRows(p[0], p[1]); }); });
  function sums() {
    var n = function (bodyId) { return $(bodyId).querySelectorAll('input[type=checkbox]:checked').length; };
    $('foldersum').textContent = 'Selected: ' + plural(n('folderrows'), 'folder');
    $('reposum').textContent = 'Selected: ' + plural(n('reporows'), 'repository', 'repositories');
    $('appsum').textContent = 'Selected: ' + plural(n('approws'), 'application');
    $('setsum').textContent = 'Selected: ' + plural($('setrows').querySelectorAll('input[type=checkbox]:checked').length, 'setting');
  }

  // ---- choose: applications ---------------------------------------------------------------------------------------
  var ROUTES = {
    winget: ['winget', 'Installed by winget from the recorded package id'],
    download: ['vendor download', 'Downloaded from the vendor, run only if the signature is valid and matches the recorded publisher'],
    npm: ['npm', 'Installed again with npm'],
    playwright: ['Playwright', 'Its browsers are downloaded again'],
    company: ['Software Center', 'Listed only: you install it from Software Center'],
  };
  function appKey(a) { return lc(a.wingetId || a.name); }
  function renderApps() {
    var body = clear($('approws')), map = {}, list = [];
    function put(a) { var k = appKey(a); if (!k || map[k]) return; map[k] = a; list.push(a); }
    (S.sel ? S.sel.applications || [] : []).forEach(put);
    (S.disc ? S.disc.apps : []).forEach(put);
    if (!list.length) body.appendChild(el('tr', null, el('td', { colspan: 4, text: S.disc ? 'No applications found.' : 'Scan this laptop (with winget) or load a selection first.' })));
    var chosen = {};
    (S.sel ? S.sel.applications || [] : []).forEach(function (a) { chosen[appKey(a)] = true; });
    list.forEach(function (a) {
      var src = lc(a.source || (a.wingetId ? 'winget' : 'download')), route = ROUTES[src] || [src || 'by hand', 'Listed for you to install by hand'];
      var box = el('input', { type: 'checkbox', checked: !!chosen[appKey(a)], 'aria-label': 'Move ' + a.name });
      box.addEventListener('change', function () {
        var s = ensureSel(), k = appKey(a);
        s.applications = (s.applications || []).filter(function (x) { return appKey(x) !== k; });
        if (box.checked) s.applications.push({ name: a.name, wingetId: a.wingetId || '', source: a.source || (a.wingetId ? 'winget' : '') });
        selChanged(); sums();
      });
      body.appendChild(el('tr', { 'data-filter': lc(a.name + ' ' + (a.wingetId || '')) }, el('td', null, box), el('td', null, a.name, a.wingetId && a.wingetId !== a.name ? el('div', { class: 'small', text: a.wingetId }) : null), el('td', null, tag('pp', route[0])), el('td', { class: 'small', text: route[1] })));
    });
    filterRows('appfilter', 'approws');
    sums();
  }

  // ---- choose: settings -------------------------------------------------------------------------------------------
  function renderSettings() {
    var box = clear($('setrows')), map = {}, list = [];
    function put(s) { var k = lc(s.app); if (map[k]) { if (s.present != null) map[k].present = s.present; return; } map[k] = { app: s.app, how: s.how, present: s.present }; list.push(map[k]); }
    (S.sel ? S.sel.settings || [] : []).forEach(put);
    ((S.state && S.state.knownSettings) || []).forEach(put);
    (S.disc ? S.disc.settings : []).forEach(put);
    var chosen = {};
    (S.sel ? S.sel.settings || [] : []).forEach(function (s) { chosen[lc(s.app)] = s.how; });
    list.forEach(function (s) {
      var cb = el('input', { type: 'checkbox', checked: lc(s.app) in chosen, 'aria-label': s.app });
      cb.addEventListener('change', function () {
        var sel = ensureSel();
        sel.settings = (sel.settings || []).filter(function (x) { return lc(x.app) !== lc(s.app); });
        if (cb.checked) sel.settings.push({ app: s.app, how: s.how });
        selChanged(); sums();
      });
      box.appendChild(el('label', { class: 'pick' }, cb, ' ', el('strong', { text: s.app }), s.present === false ? ' ' : null, s.present === false ? tag('grey', 'not found here') : null, el('div', { class: 'small', text: s.how })));
    });
    sums();
  }

  // ---- by hand ------------------------------------------------------------------------------------------------------
  var COMMON_SECRETS = [
    ['.env and .env.* files', 'secrets in plain text'],
    ['.npmrc with tokens', 'registry tokens'],
    ['.ssh folder', 'private keys'],
    ['Cloud CLI credentials', 'access keys'],
    ['Browser saved logins', 'passwords and cookies: sign in and let the browser sync'],
    ['Password manager vault', 'export it from its own app'],
  ];
  function renderByHand() {
    var body = clear($('byhandrows')), rows = [], seen = {};
    function put(item, why) { var k = lc(item); if (seen[k]) return; seen[k] = true; rows.push([item, why]); }
    if (S.dry) S.dry.plan.byHand.forEach(function (b) { put(b.path, b.why + (b.group === 'client' ? ' (client)' : '')); });
    (S.sel ? S.sel.folders : []).forEach(function (f) { if (/hand/i.test(f.mode)) put(f.path, 'marked by hand in the selection'); });
    (S.disc ? S.disc.found : []).forEach(function (f) { if (f.secret) put(f.path, f.secret); });
    COMMON_SECRETS.forEach(function (c) { put(c[0], c[1]); });
    if (S.state) { put('Printers', S.state.printerStep); put('Wi-Fi', S.state.wifiStep); }
    rows.forEach(function (r) {
      var k = lc(r[0]);
      var cb = el('input', { type: 'checkbox', checked: !!S.ticks[k], 'aria-label': 'Done: ' + r[0] });
      cb.addEventListener('change', function () { S.ticks[k] = cb.checked; });
      body.appendChild(el('tr', null, el('td', { class: 'path' }, el('code', { text: r[0] })), el('td', { class: 'small', text: r[1] }), el('td', null, cb)));
    });
    $('byhandsrc').textContent = S.dry ? 'The list holds what the dry run found in your chosen folders, then the usual places for secrets.' : 'Run the dry run to add the files it finds in your chosen folders.';
    if (!$('savefile').value) $('savefile').placeholder = 'empty: your Downloads folder, laptop-move-selection.json';
  }
  $('savego').addEventListener('click', function () {
    if (!S.sel) { say('savestat', 'there is no selection to save yet', true); return; }
    var file = $('savefile').value.trim(), body = { json: S.sel };
    if (file) body.file = file;
    say('savestat', 'saving');
    api('selection/save', body).then(function (r) {
      setSelection({ file: r.file, json: r.json });
      $('savefile').value = r.file;
      say('savestat', 'saved to ' + r.file + (r.backup ? ' (the old one kept as ' + r.backup.split('\\').pop() + ')' : ''));
    }, function (e) { say('savestat', errText(e), true); });
  });

  // ---- dry run -----------------------------------------------------------------------------------------------------
  $('drygo').addEventListener('click', function () {
    var o = { out: $('outdir').value.trim(), volume: $('volume').value.trim(), clientData: $('clientdata').checked };
    say('drystat', 'running');
    S.dryOpts = null;
    pushSel().then(function () { return start('dryrun', o); }).then(function () { S.dryOpts = o; }, function (e) { say('drystat', errText(e), true); });
  });
  HANDLERS.dryrun = {
    begin: function () { $('drybar').classList.remove('hide'); $('drybar').classList.add('bar', 'busy'); clear($('dryout')); },
    event: function (ev) { if (ev.text) say('drystat', ev.text); },
    finish: function (j) {
      $('drybar').classList.add('hide');
      if (j.state === 'failed') { say('drystat', j.error, true); S.dry = null; return; }
      S.dry = j.result;
      say('drystat', j.result.problems.length ? 'finished, with problems to fix' : 'finished: ready to pack', !!j.result.problems.length);
      mark('dryrun', j.result.problems.length ? 'fix' : 'done');
      renderDry();
    },
  };
  function renderDry() {
    var box = clear($('dryout'));
    if (!S.dry) return;
    var p = S.dry.plan, t = p.totals, hasClient = t.client.bytes > 0 || t.client.files > 0 || p.repos.some(function (r) { return r.client && r.mode === 'bundle'; });
    if (S.dry.problems.length) box.appendChild(el('div', { class: 'card bad' }, el('strong', { text: 'Fix these before packing:' }), el('ul', null, S.dry.problems.map(function (x) { return el('li', { text: x }); }))));
    box.appendChild(el('p', { class: 'small' }, 'Output folder: ', el('code', { text: S.dry.out })));
    var rows = [el('tr', null, el('th', { text: 'What' }), el('th', { class: 'num', text: 'Size' }), el('th', { class: 'num', text: 'Parts' }), el('th', { text: 'Where it goes' }))];
    rows.push(el('tr', null, el('td', { text: 'Data part' }), el('td', { class: 'num', text: bytes(t.dataEstimate.archive) }), el('td', { class: 'num', text: String(t.dataEstimate.parts) }), el('td', { text: 'encrypted 7-Zip volumes of ' + bytes(p.volumeBytes) + ' each (' + plural(t.data.files, 'file') + ', ' + bytes(t.data.bytes) + ' before packing)' })));
    if (hasClient) rows.push(el('tr', null, el('td', { text: 'Client part' }), el('td', { class: 'num', text: bytes(t.clientEstimate.archive) }), el('td', { class: 'num', text: String(t.clientEstimate.parts) }), el('td', null, 'client-*.7z.*, encrypted, ', el('strong', { text: 'Accenture OneDrive only' }))));
    rows.push(el('tr', null, el('td', { text: 'Kit zip' }), el('td', { class: 'num', text: 'small' }), el('td', { class: 'num', text: '1' }), el('td', { text: 'plain zip: the mover, the manifest, a README and node.exe' })));
    box.appendChild(el('table', null, rows));
    var e = t.dataEstimate, c = t.clientEstimate;
    box.appendChild(el('p', { text: 'Time: ' + mins(e.packSeconds + (hasClient ? c.packSeconds : 0)) + ' to pack, ' + mins(e.unpackSeconds + (hasClient ? c.unpackSeconds : 0)) + ' to unpack on the new laptop. Upload at 10 MB/s: ' + mins(e.uploadSeconds + (hasClient ? c.uploadSeconds : 0)) + '; it depends on the network.' }));
    if (hasClient) box.appendChild(el('p', { class: 'card purple' }, 'The client part belongs on your ', el('strong', { text: 'Accenture OneDrive only' }), ', never on a client\'s OneDrive or a personal drive.'));
    if (p.pushFirst.length) box.appendChild(el('div', { class: 'card warn' }, el('strong', { text: 'Push first: ' }), 'these client repositories have local work that does not go into the bundle. Push it, then run the dry run again.', el('ul', null, p.pushFirst.map(function (x) { return el('li', null, el('code', { text: x.path }), ': ' + [x.unpushed ? plural(x.unpushed, 'unpushed commit') : '', x.stashes ? plural(x.stashes, 'stash', 'stashes') : '', x.dirty ? plural(x.dirty, 'uncommitted file') : ''].filter(Boolean).join(', ')); }))));
    var byKind = {};
    p.apps.forEach(function (a) { (byKind[a.kind] = byKind[a.kind] || []).push(a.name); });
    var kinds = Object.keys(byKind);
    box.appendChild(el('h4', { text: 'Applications, by route' }));
    box.appendChild(kinds.length ? el('table', null, el('tr', null, el('th', { text: 'Route' }), el('th', { text: 'Apps' })), kinds.map(function (k) { return el('tr', null, el('td', null, tag('pp', (ROUTES[k] || [k])[0])), el('td', { text: byKind[k].join(', ') })); })) : el('p', { class: 'small', text: 'No applications chosen.' }));
    box.appendChild(el('details', null, el('summary', { text: 'Folders and files (' + p.units.length + ')' }), el('div', { class: 'tablewrap' }, el('table', null, el('tr', null, el('th', { text: 'Path' }), el('th', { text: 'Kind' }), el('th', { text: 'Part' }), el('th', { class: 'num', text: 'Files' }), el('th', { class: 'num', text: 'Size' })), p.units.map(function (u) { return el('tr', null, el('td', { class: 'path', text: u.path }), el('td', { text: u.app ? 'setting (' + u.app + ')' : u.kind }), el('td', null, u.group === 'client' ? tag('warn', 'client') : u.group === 'mixed' ? tag('warn', 'mixed') : tag('ok', 'data')), el('td', { class: 'num', text: u.fileCount == null ? '' : String(u.fileCount) }), el('td', { class: 'num', text: bytes(u.bytes) })); })))));
    box.appendChild(el('details', null, el('summary', { text: 'Repositories (' + p.repos.length + ')' }), el('div', { class: 'tablewrap' }, el('table', null, el('tr', null, el('th', { text: 'Repository' }), el('th', { text: 'How' }), el('th', { text: 'State' })), p.repos.map(function (r) { return el('tr', null, el('td', { class: 'path', text: r.path }), el('td', null, r.mode === 'clone' ? tag(r.client ? 'warn' : 'ok', r.client ? 'clone only (client)' : 'clone again') : tag('ok', 'clone + local work')), el('td', { class: 'small', text: [r.branch ? 'on ' + r.branch : 'detached', r.unpushed ? r.unpushed + ' unpushed' : '', r.stashes ? r.stashes + ' stashes' : '', r.dirty ? r.dirty + ' uncommitted' : '', r.worktree ? 'worktree' : '', r.note].filter(Boolean).join(', ') })); })))));
    if (p.warnings.length) box.appendChild(el('details', null, el('summary', { text: 'Warnings (' + p.warnings.length + ')' }), el('ul', null, p.warnings.map(function (x) { return el('li', { text: x }); }))));
    box.appendChild(el('details', null, el('summary', { text: 'Your own steps on the new laptop (' + p.userSteps.length + ')' }), el('ul', null, p.userSteps.map(function (x) { return el('li', { text: x }); }))));
    box.appendChild(el('details', null, el('summary', { text: 'The whole dry run as text' }), el('pre', { class: 'light', text: S.dry.text })));
  }

  // ---- password and pack --------------------------------------------------------------------------------------------
  function pwCheck() {
    var a = $('pw1').value, b = $('pw2').value, min = (S.state && S.state.minPassword) || 12;
    var len = a.length >= min, ascii = a.length > 0 && /^[\x20-\x7E]+$/.test(a), same = a.length > 0 && a === b;
    [['pwlen', len], ['pwascii', ascii], ['pwsame', same]].forEach(function (r) { $(r[0]).classList.toggle('ok', r[1]); $(r[0]).classList.toggle('no', !r[1]); });
    var ready = !!(S.dry && S.dryOpts && !S.dry.problems.length);
    $('pwnodry').classList.toggle('hide', ready);
    $('packgo').disabled = !(len && ascii && same && ready) || S.ended;
  }
  $('pw1').addEventListener('input', pwCheck);
  $('pw2').addEventListener('input', pwCheck);
  $('packgo').addEventListener('click', function () {
    var o = S.dryOpts;
    if (!o) return;
    var body = { out: o.out || S.dry.out, volume: o.volume, clientData: o.clientData, password: $('pw1').value, confirm: $('pw2').value };
    $('pw1').value = ''; $('pw2').value = ''; pwCheck();
    say('packstat', 'starting');
    pushSel().then(function () { return start('pack', body); }).then(function () { body = null; say('packstat', 'packing'); show('packing'); }, function (e) { body = null; say('packstat', errText(e), true); });
  });
  var PACK_PHASES = { scan: 'Reading the selection', settings: 'Settings', deps: 'Code dependencies', apps: 'Apps', repos: 'Bundles of local commits and stashes', lists: 'File lists', pack: '7-Zip', checksums: 'Checksums', kit: 'The kit zip' };
  function phaseList(boxId) {
    return {
      box: $(boxId), rows: {}, last: null,
      phase: function (name, text) {
        if (this.last && this.rows[this.last]) this.rows[this.last].state(tag('ok', 'done'));
        var r = this.rows[name];
        if (!r) {
          var st = el('td', null), tr = el('tr', null, el('td', { text: text || name }), st);
          this.box.appendChild(tr);
          r = this.rows[name] = { state: function (t) { clear(st).appendChild(t); } };
        }
        r.state(tag('pp', 'running'));
        this.last = name;
      },
      finish: function (ok) { if (this.last && this.rows[this.last]) this.rows[this.last].state(ok ? tag('ok', 'done') : tag('bad', 'failed')); },
      reset: function () { clear(this.box); this.rows = {}; this.last = null; },
    };
  }
  var packPhases = null;
  function packPhaseList() {
    if (!packPhases) { var t = el('tbody'); clear($('phases')).appendChild(el('table', null, el('thead', null, el('tr', null, el('th', { text: 'Step' }), el('th', { text: 'State' }))), t)); t.id = 'packphases'; packPhases = phaseList('packphases'); }
    return packPhases;
  }
  function logLine(boxId, ev) {
    var box = $(boxId), line = el('div', { class: ev.type === 'warn' ? 'w' : '' }, (ev.type === 'warn' ? 'warning: ' : '') + (ev.text || ''));
    box.appendChild(line);
    while (box.childNodes.length > 400) box.removeChild(box.firstChild);
    box.scrollTop = box.scrollHeight;
  }
  var partBars = {};
  function partBar(part) {
    if (!partBars[part]) {
      var pc = el('span', { text: '0%' }), bar = el('div', { class: 'bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0', 'aria-label': part }, el('i'));
      $('partbars').appendChild(el('div', { class: 'partrow' }, el('div', { class: 'lab' }, el('span', { text: part }), pc), bar));
      partBars[part] = { bar: bar, pc: pc };
    }
    return partBars[part];
  }
  HANDLERS.pack = {
    begin: function () { $('packidle').classList.add('hide'); packPhases = null; packPhaseList().reset(); clear($('partbars')); partBars = {}; clear($('packlog')); clear($('packdone')); $('packtext').textContent = ''; mark('packing', 'running'); },
    update: function () { $('packidle').classList.add('hide'); },
    event: function (ev) {
      $('packidle').classList.add('hide');
      if (ev.type === 'phase') packPhaseList().phase(ev.name, PACK_PHASES[ev.name] || ev.text);
      else if (ev.type === 'progress') {
        if (ev.part) { var b = partBar(ev.part); var pct = ev.total ? ev.done / ev.total * 100 : ev.done; setBar(b.bar, pct); b.pc.textContent = Math.round(pct) + '%'; }
        else $('packtext').textContent = (ev.text || '') + (ev.total ? ' (' + ev.done + ' of ' + ev.total + ')' : '');
      } else logLine('packlog', ev);
    },
    finish: function (j) {
      packPhaseList().finish(j.state === 'done');
      var box = clear($('packdone'));
      if (j.state === 'failed') { box.appendChild(el('div', { class: 'card bad' }, el('strong', { text: 'Packing stopped: ' }), j.error)); say('packstat', 'failed', true); mark('packing', 'failed'); return; }
      S.pack = j.result;
      Object.keys(partBars).forEach(function (k) { setBar(partBars[k].bar, 100); partBars[k].pc.textContent = '100%'; });
      say('packstat', 'done');
      mark('packing', 'done');
      box.appendChild(el('div', { class: 'card ok' }, el('strong', { text: 'Packed. ' }), plural(S.pack.parts.length, 'part') + ' and the kit zip are in ', el('code', { text: S.pack.out }), '.',
        el('div', { class: 'row' }, el('button', { class: 'btn sm', type: 'button', onclick: function () { openPath(S.pack.out, 'packstat2'); } }, 'Open the folder'), el('button', { class: 'btn ghost sm', type: 'button', onclick: function () { openPath(S.pack.report, 'packstat2'); } }, 'Open the pack report'), el('span', { class: 'status', id: 'packstat2', role: 'status' }))));
    },
  };
  function openPath(p, statId) { api('open', { path: p }).then(function () { say(statId, 'opened'); }, function (e) { say(statId, errText(e), true); }); }

  // ---- upload ------------------------------------------------------------------------------------------------------
  function renderUpload() {
    var box = clear($('uplist'));
    if (!S.pack) { box.appendChild(el('p', { class: 'small', text: 'Pack first: the files to upload show here.' })); return; }
    var data = S.pack.parts.filter(function (p) { return p.group !== 'client'; }), client = S.pack.parts.filter(function (p) { return p.group === 'client'; });
    var list = function (rows) { return el('table', null, el('tr', null, el('th', { text: 'File' }), el('th', { class: 'num', text: 'Size' })), rows.map(function (p) { return el('tr', null, el('td', { class: 'path', text: p.file }), el('td', { class: 'num', text: p.size == null ? '' : bytes(p.size) })); })); };
    box.appendChild(el('h4', { text: 'Upload these to your Accenture OneDrive' }));
    box.appendChild(list(data.concat([{ file: S.pack.kitZip.split('\\').pop(), size: null }, { file: 'SHA256SUMS.txt', size: null }, { file: 'manifest.json', size: null }])));
    if (client.length) { box.appendChild(el('h4', { text: 'The client part: Accenture OneDrive only' })); box.appendChild(list(client)); }
    box.appendChild(el('p', { class: 'small' }, 'All files are in ', el('code', { text: S.pack.out }), '.'));
  }

  // ---- restore -----------------------------------------------------------------------------------------------------
  function renderRestore() {
    var box = clear($('mfinfo')), m = S.rsMan;
    $('rspwrow').classList.toggle('hide', !!m && !m.encrypted);
    if (!m) return;
    box.appendChild(el('div', { class: 'card purple' }, el('strong', { text: 'The bundle: ' }), 'packed on ' + (m.host || 'the old laptop') + (m.createdAt ? ' at ' + m.createdAt : '') + ', ' + (m.encrypted ? 'encrypted' : 'not encrypted') + ', ' + plural(m.archives.reduce(function (s, a) { return s + a.parts; }, 0), 'part') + (m.hasClientPart ? ', with a client part' : '') + '.'));
  }
  function restoreBody() { return { from: $('rsfrom').value.trim() || undefined, work: $('rswork').value.trim() || undefined, skipApps: $('rsskipapps').checked, skipClient: $('rsskipclient').checked, overwrite: $('rsoverwrite').checked }; }
  $('rsdry').addEventListener('click', function () { say('rsdrystat', 'checking'); clear($('rsdryout')); start('restore-dryrun', restoreBody()).catch(function (e) { say('rsdrystat', errText(e), true); }); });
  HANDLERS['restore-dryrun'] = {
    finish: function (j) {
      var box = clear($('rsdryout'));
      if (j.state === 'failed') { say('rsdrystat', j.error, true); return; }
      S.rsMan = j.result.manifest;
      renderRestore();
      say('rsdrystat', j.result.problems.length ? 'problems found' : 'the bundle is complete', !!j.result.problems.length);
      if (j.result.problems.length) box.appendChild(el('div', { class: 'card bad' }, el('strong', { text: 'Fix these first:' }), el('ul', null, j.result.problems.map(function (x) { return el('li', { text: x }); }))));
      box.appendChild(el('details', null, el('summary', { text: 'What the restore would do' }), el('pre', { class: 'light', text: j.result.text })));
    },
  };
  $('rsgo').addEventListener('click', function () {
    if (!window.confirm('The restore writes the bundle\'s folders, settings and repositories on this laptop. Go on?')) return;
    var body = restoreBody();
    body.password = $('rspw').value;
    $('rspw').value = '';
    say('rsstat', 'starting');
    start('restore', body).then(function () { body = null; say('rsstat', 'restoring'); show('restoring'); }, function (e) { body = null; say('rsstat', errText(e), true); });
  });
  var RS_PHASES = { check: 'Check the checksums', '7zip': 'Check 7-Zip', unpack: 'Unpack the parts', apps: 'Install applications', repos: 'Clone repositories again', folders: 'Put folders and settings back', worktrees: 'Worktrees', links: 'Links and junctions', npm: 'npm ci', extensions: 'Editor extensions' };
  var rsPhases = phaseList('rsphases');
  HANDLERS.restore = {
    begin: function () { $('rsidle').classList.add('hide'); rsPhases.reset(); clear($('rslog')); setBar($('rsbar'), 0); mark('restoring', 'running'); },
    update: function () { $('rsidle').classList.add('hide'); },
    event: function (ev) {
      $('rsidle').classList.add('hide');
      if (ev.type === 'phase') rsPhases.phase(ev.name + (ev.name === 'extensions' ? ev.text : ''), RS_PHASES[ev.name] && ev.name !== 'extensions' ? RS_PHASES[ev.name] : ev.text);
      else if (ev.type === 'progress') { setBar($('rsbar'), ev.total ? ev.done / ev.total * 100 : ev.done); $('rstext').textContent = (ev.part ? ev.part + ': ' : '') + (ev.text || ''); }
      else logLine('rslog', ev);
    },
    finish: function (j) {
      rsPhases.finish(j.state === 'done');
      if (j.state === 'failed') { say('rsstat', j.error, true); $('rstext').textContent = 'The restore stopped: ' + j.error; mark('restoring', 'failed'); return; }
      setBar($('rsbar'), 100);
      S.restore = j.result;
      say('rsstat', 'done');
      mark('restoring', 'done');
      mark('report', 'ready');
      renderReport();
    },
  };

  // ---- report ------------------------------------------------------------------------------------------------------
  var SECTION_NAMES = { parts: 'Parts', apps: 'Applications', repos: 'Repositories', units: 'Folders and settings', links: 'Links and junctions', npm: 'npm ci', extensions: 'Editor extensions', conflicts: 'Files that already existed' };
  function verdict(status) {
    var s = lc(status);
    if (/fail|damag|missing|conflict|refus|error/.test(s)) return 'bad';
    if (/hand|skip|later|todo|warn|not in/.test(s)) return 'warn';
    return 'ok';
  }
  function renderReport() {
    var r = S.restore;
    $('repidle').classList.toggle('hide', !!r);
    $('repopen').disabled = !r || S.ended;
    var tags = clear($('reptags')), tables = clear($('reptables')), steps = clear($('repsteps'));
    if (!r) return;
    var n = { ok: 0, warn: 0, bad: 0 };
    Object.keys(r.sections).forEach(function (k) { r.sections[k].forEach(function (x) { n[verdict(x.status)]++; }); });
    add(tags, [tag('ok', n.ok + ' done'), ' ', tag('warn', n.warn + ' to do by hand'), ' ', tag('bad', n.bad + ' failed')]);
    Object.keys(r.sections).forEach(function (k) {
      var rows = r.sections[k];
      if (!rows.length) return;
      tables.appendChild(el('h4', { text: SECTION_NAMES[k] || k }));
      tables.appendChild(el('table', null, el('tr', null, el('th', { text: 'Item' }), el('th', { text: 'Result' }), el('th', { text: 'Detail' })), rows.map(function (x) { return el('tr', null, el('td', { class: 'path', text: x.name }), el('td', null, tag(verdict(x.status), x.status)), el('td', { class: 'small', text: x.detail })); })));
    });
    if (r.warnings.length) tables.appendChild(el('div', { class: 'card warn' }, el('strong', { text: 'Warnings' }), el('ul', null, r.warnings.map(function (x) { return el('li', { text: x }); }))));
    var us = S.rsMan && S.rsMan.userSteps || [];
    if (us.length) steps.appendChild(el('div', { class: 'card purple' }, el('h4', { text: 'Your own steps now' }), el('ul', null, us.map(function (x) { return el('li', { text: x }); }))));
  }
  $('repopen').addEventListener('click', function () { if (S.restore) openPath(S.restore.report, 'repstat'); });
  $('repprint').addEventListener('click', function () { window.print(); });

  // ---- renderers per screen, and the start ---------------------------------------------------------------------------
  var RENDER = {
    start: renderSelInfo,
    apps: renderApps,
    folders: function () { renderPaths('folder', 'folderrows', 'foldersum', 'folderfilter'); },
    repos: function () { renderPaths('repo', 'reporows', 'reposum', 'repofilter'); },
    settings: renderSettings,
    byhand: renderByHand,
    dryrun: renderDry,
    password: pwCheck,
    upload: renderUpload,
    restore: renderRestore,
    report: renderReport,
  };
  Promise.all([loadState(), loadSelectionNow()]).then(function (r) {
    var st = r[0];
    connect();
    var want = (location.hash || '').slice(1);
    show(byId[want] ? want : st.mode === 'new' ? 'restore' : 'start');
    if (st.job) onJob(st.job);
  }, function (e) {
    $('who').textContent = 'The mover did not answer: ' + errText(e);
    show('start');
  });
})();
