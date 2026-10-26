/* ============================================================
   تتبّع حافلات المسيلة — منطق التطبيق (v3)
   ============================================================ */
(function () {
  'use strict';

  /* ---------- 1. الثوابت والحالة ---------- */
  var LS_CFG = 'msila_tracker_cfg_v1';
  var LS_THEME = 'msila_tracker_theme_v1';
  var LS_LOG = 'msila_tracker_log_v1';
  var LS_CACHE = 'msila_tracker_cache_v1';

  /* No connection token is bundled; enter your own in Settings. */
  var DEFAULT_TOKEN = '';

  var DEFAULTS = {
    server: 'https://msilabus.malimspotter.dz',
    email: '', password: '', token: DEFAULT_TOKEN,
    refreshMs: 12000,
    center: [35.7039, 4.5306],
    zoom: 14,
    cardsOn: true,
    alertOn: false,
    alertRadius: 300,
    offlineCache: true,
    station: null,
    trackOn: true
  };

  var cfg = loadCfg();
  var state = {
    mode: 'boot',          // boot | live | demo | cache
    buses: [],
    byId: {},
    selected: null,
    filter: 'all',
    query: '',
    sort: 'name',
    lineFilter: 'all',
    myPos: null,
    lastUpdate: null,
    lastError: null,
    timer: null,
    tickTimer: null,
    routes: null,
    hist: {},
    alertFired: {},
    log: loadLog(),
    logFilter: 'all',
    logQuery: '',
    cardMode: 'full',
    showRoutes: false,
    cacheAge: null
  };

  var COLORS = { moving: '#2ea043', idle: '#d29922', offline: '#e5534b' };
  var LABELS = { moving: 'متحركة', idle: 'متوقفة', offline: 'غير متصلة' };
  var HOUR = 3600 * 1000;

  /* ---------- 2. أدوات مساعدة ---------- */
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function fmtTime(d) {
    if (!d) return '—';
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }
  function fmtAgo(ts) {
    if (!ts) return '—';
    var s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return 'قبل ' + s + ' ث';
    var m = Math.floor(s / 60);
    if (m < 60) return 'قبل ' + m + ' د';
    var h = Math.floor(m / 60);
    if (h < 24) return 'قبل ' + h + ' س';
    return 'قبل ' + Math.floor(h / 24) + ' ي';
  }
  function fmtNum(n, d) {
    if (n == null || isNaN(n)) return '—';
    return Number(n).toFixed(d == null ? 0 : d);
  }
  function haversine(a, b) {
    var R = 6371000, rad = Math.PI / 180;
    var dLat = (b[0] - a[0]) * rad, dLon = (b[1] - a[1]) * rad;
    var la1 = a[0] * rad, la2 = b[0] * rad;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function bearing(a, b) {
    var rad = Math.PI / 180;
    var y = Math.sin((b[1] - a[1]) * rad) * Math.cos(b[0] * rad);
    var x = Math.cos(a[0] * rad) * Math.sin(b[0] * rad) -
            Math.sin(a[0] * rad) * Math.cos(b[0] * rad) * Math.cos((b[1] - a[1]) * rad);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }
  function fmtDist(m) {
    if (m == null) return '—';
    if (m < 1000) return Math.round(m) + ' م';
    return (m / 1000).toFixed(m < 10000 ? 2 : 1) + ' كم';
  }
  function fmtEta(m, kmh) {
    if (m == null || m <= 60) return null;
    if (!kmh || kmh < 1.5) return null;
    var mins = (m / 1000) / kmh * 60;
    if (mins < 1) return 'أقل من دقيقة';
    if (mins > 180) return 'أكثر من 3 ساعات';
    return '~' + Math.round(mins) + ' دقيقة';
  }
  function compass(deg) {
    if (deg == null || isNaN(deg)) return '—';
    var dirs = ['شمال', 'شمال-شرق', 'شرق', 'جنوب-شرق', 'جنوب', 'جنوب-غرب', 'غرب', 'شمال-غرب'];
    return dirs[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
  }
  function lineOf(name) {
    var n = String(name || '').trim();
    if (n.indexOf('/') > 0) return n.split('/')[0].trim();
    var m = n.match(/^([Hh]\d+)/);
    if (m) return m[1].toUpperCase();
    return n;
  }
  function statusOf(b) {
    if (b.offline) return 'offline';
    if (b.speed != null && b.speed > 3) return 'moving';
    return 'idle';
  }

  /* ---------- 3. الإعدادات والسجل ---------- */
  function loadCfg() {
    try {
      var raw = localStorage.getItem(LS_CFG);
      if (!raw) return JSON.parse(JSON.stringify(DEFAULTS));
      var o = JSON.parse(raw);
      var out = JSON.parse(JSON.stringify(DEFAULTS));
      for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) out[k] = o[k];
      if (!Array.isArray(out.center) || out.center.length !== 2) out.center = DEFAULTS.center.slice();
      return out;
    } catch (e) { return JSON.parse(JSON.stringify(DEFAULTS)); }
  }
  function saveCfg() {
    try { localStorage.setItem(LS_CFG, JSON.stringify(cfg)); } catch (e) {}
  }
  function loadLog() {
    try {
      var raw = localStorage.getItem(LS_LOG);
      var a = raw ? JSON.parse(raw) : [];
      return Array.isArray(a) ? a.slice(-300) : [];
    } catch (e) { return []; }
  }
  function saveLog() {
    try { localStorage.setItem(LS_LOG, JSON.stringify(state.log.slice(-300))); } catch (e) {}
  }
  function log(level, msg) {
    state.log.push({ t: Date.now(), level: level, msg: String(msg) });
    if (state.log.length > 300) state.log = state.log.slice(-300);
    saveLog();
    renderLog();
  }
  function saveCache() {
    if (!cfg.offlineCache) return;
    try {
      localStorage.setItem(LS_CACHE, JSON.stringify({
        t: Date.now(),
        mode: state.mode,
        buses: state.buses.map(function (b) {
          return { id: b.id, name: b.name, uniqueId: b.uniqueId, route: b.route, line: b.line,
                   lat: b.lat, lon: b.lon, brg: b.brg, speed: b.speed, lastUpdate: b.lastUpdate,
                   offline: b.offline };
        })
      }));
    } catch (e) {}
  }
  function loadCache() {
    try {
      var raw = localStorage.getItem(LS_CACHE);
      if (!raw) return null;
      var o = JSON.parse(raw);
      if (!o || !o.buses || !o.buses.length) return null;
      return o;
    } catch (e) { return null; }
  }

  /* ---------- 4. التنبيهات والصوت ---------- */
  function toast(msg, kind, ms) {
    var el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.textContent = msg;
    $('toasts').appendChild(el);
    setTimeout(function () {
      el.style.transition = 'opacity .3s,transform .3s';
      el.style.opacity = '0'; el.style.transform = 'translateY(8px)';
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 320);
    }, ms || 3200);
  }

  var audioCtx = null;
  function beep(kind) {
    try {
      if (!audioCtx) {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        audioCtx = new AC();
      }
      if (audioCtx.state === 'suspended') audioCtx.resume();
      var t = audioCtx.currentTime;
      var seq = kind === 'station' ? [660, 880, 1320] : [880, 1180];
      seq.forEach(function (f, i) {
        var o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.type = 'sine';
        o.frequency.setValueAtTime(f, t + i * 0.17);
        g.gain.setValueAtTime(0.0001, t + i * 0.17);
        g.gain.exponentialRampToValueAtTime(0.22, t + i * 0.17 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.17 + 0.16);
        o.connect(g); g.connect(audioCtx.destination);
        o.start(t + i * 0.17); o.stop(t + i * 0.17 + 0.18);
      });
    } catch (e) {}
  }

  /* ---------- 5. الخريطة ---------- */
  var map, tileLayer, busLayer, myLayer, routeLayer, histLayer, stLayer;
  var markers = {};

  function initMap() {
    map = L.map('map', {
      center: cfg.center, zoom: cfg.zoom,
      zoomControl: true, attributionControl: true,
      preferCanvas: true, tap: true
    });
    setTiles();
    routeLayer = L.layerGroup().addTo(map);
    histLayer = L.layerGroup().addTo(map);
    busLayer = L.layerGroup().addTo(map);
    myLayer = L.layerGroup().addTo(map);
    stLayer = L.layerGroup().addTo(map);
    L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);
    map.on('zoomend', function () {
      var m = cardModeForZoom(map.getZoom());
      if (m !== state.cardMode) { state.cardMode = m; renderMarkers(); }
    });
  }
  function setTiles() {
    if (tileLayer) map.removeLayer(tileLayer);
    var dark = document.documentElement.getAttribute('data-theme') === 'dark';
    var url = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
    var attr = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
    tileLayer = L.tileLayer(url, { maxZoom: 19, attribution: attr, subdomains: 'abc' }).addTo(map);
    applyTileFilter(dark);
  }
  function applyTileFilter(dark) {
    var pane = map && map.getPane ? map.getPane('tilePane') : null;
    if (!pane) return;
    pane.style.filter = dark
      ? 'invert(1) hue-rotate(180deg) brightness(0.92) contrast(0.92) saturate(0.75)'
      : 'none';
  }

  /* ---------- 6. بطاقات الحافلات على الخريطة ---------- */
  function cardModeForZoom(z) {
    if (!cfg.cardsOn) return 'off';
    if (z >= 15) return 'full';
    if (z >= 13) return 'mini';
    return 'dot';
  }

  function arrowSvg(brg, size, color) {
    return '<svg class="arw" viewBox="0 0 24 24" width="' + size + '" height="' + size +
      '" style="transform:rotate(' + Math.round(brg || 0) + 'deg);color:' + color + '">' +
      '<path d="M12 1.8 L20.2 21.4 L12 16.9 L3.8 21.4 Z" fill="currentColor" ' +
      'stroke="rgba(0,0,0,.55)" stroke-width="1.2" stroke-linejoin="round"/></svg>';
  }

  function busIcon(b) {
    var st = statusOf(b), col = COLORS[st], sel = state.selected === b.id;
    var mode = state.cardMode, html;

    if (mode === 'off') {
      html = '<div class="bdot" style="--c:' + col + ';opacity:0"></div>';
    } else if (mode === 'dot' || b._dot) {
      html = '<div class="bdot' + (sel ? ' sel' : '') + '" style="--c:' + col + '"></div>';
    } else {
      var badge = b._mg ? '<span class="mg">+' + b._mg + '</span>' : '';
      if (mode === 'mini') {
        html = '<div class="bcard mini' + (sel ? ' sel' : '') + '" style="--c:' + col + '">' +
          arrowSvg(b.brg, 14, col) +
          '<span class="nm">' + esc(b.name) + '</span>' +
          '<span class="sp">' + fmtNum(b.speed, 0) + '</span>' + badge +
          '</div>';
      } else {
        html = '<div class="bcard' + (sel ? ' sel' : '') + '" style="--c:' + col + '">' +
          arrowSvg(b.brg, 15, col) +
          '<span class="nm">' + esc(b.name) + '</span>' +
          '<span class="sp">' + fmtNum(b.speed, 0) + '</span>' +
          '<span class="st">' + LABELS[st] + '</span>' + badge +
          '</div>';
      }
    }
    return L.divIcon({ html: html, className: 'bus-marker', iconSize: [0, 0], iconAnchor: [0, 0] });
  }

  function renderMarkers() {
    /* --- وضع النقاط: تجميع الحافلات المتقاربة في عنقود واحد لتجنّب الفوضى --- */
    if (state.cardMode === 'dot') {
      busLayer.clearLayers();
      markers = {};
      var lat0c = map.getCenter().lat, radc = Math.PI / 180;
      var mppc = 156543.034 * Math.cos(lat0c * radc) / Math.pow(2, map.getZoom());
      var cLat = (66 * mppc) / 111320;
      var cLon = (66 * mppc) / (111320 * Math.cos(lat0c * radc));
      var groups = {};
      state.buses.forEach(function (b) {
        var k = Math.round(b.lat / cLat) + '|' + Math.round(b.lon / cLon);
        (groups[k] = groups[k] || []).push(b);
      });
      Object.keys(groups).forEach(function (k) {
        var g = groups[k], lat = 0, lon = 0, mv = 0, idl = 0;
        g.forEach(function (b) {
          lat += b.lat; lon += b.lon;
          var st = statusOf(b);
          if (st === 'moving') mv++; else if (st === 'idle') idl++;
        });
        lat /= g.length; lon /= g.length;
        var col = mv ? COLORS.moving : (idl ? COLORS.idle : COLORS.offline);
        var n = g.length;
        var html = (n === 1)
          ? '<div class="bdot" style="--c:' + col + '"></div>'
          : '<div class="bcluster" style="--c:' + col + '">' + n + '</div>';
        var mk = L.marker([lat, lon], {
          icon: L.divIcon({ html: html, className: 'bus-marker', iconSize: [0, 0], iconAnchor: [0, 0] }),
          keyboard: false
        });
        if (n === 1) {
          var one = g[0];
          mk.on('click', function () { selectBus(one.id, true); });
          mk.bindTooltip('<b>' + esc(one.name) + '</b> \u00b7 ' + LABELS[statusOf(one)] +
            '<br>' + fmtNum(one.speed, 0) + ' \u0643\u0645/\u0633 \u2014 \u0627\u0636\u063a\u0637 \u0644\u0644\u062a\u0641\u0627\u0635\u064a\u0644',
            { direction: 'top', offset: [0, -10], className: 'bustip' });
        } else {
          var sum = 0, cnt = 0;
          g.forEach(function (b) { if (statusOf(b) !== 'offline') { sum += b.speed || 0; cnt++; } });
          mk.on('click', function () { map.flyTo([lat, lon], Math.min(19, map.getZoom() + 2), { duration: .6 }); });
          mk.bindTooltip(n + ' \u062d\u0627\u0641\u0644\u0629 \u00b7 \u0645\u062a\u0648\u0633\u0637 ' +
            fmtNum(cnt ? sum / cnt : 0, 0) + ' \u0643\u0645/\u0633 \u2014 \u0627\u0636\u063a\u0637 \u0644\u0644\u062a\u0642\u0631\u064a\u0628',
            { direction: 'top', offset: [0, -14], className: 'bustip' });
        }
        mk.addTo(busLayer);
      });
      return;
    }

    /* --- تفادي تراكب البطاقات: تُستبدل بطاقة الموقع الأقل أهمية بنقطة --- */
    /* المقارنة في فضاء البكسل بمقاس البطاقة الفعلي (مستطيل لا دائرة) */
    var CARD_W = state.cardMode === 'mini' ? 94 : 130;
    var CARD_H = state.cardMode === 'mini' ? 26 : 31;
    var kdx = CARD_W * 0.94, kdy = CARD_H * 0.94;

    function prio(b) {
      var s = statusOf(b);
      return s === 'moving' ? 2 : (s === 'idle' ? 1 : 0);
    }
    var order = state.buses.slice().sort(function (a, b) {
      var d = prio(b) - prio(a);
      return d !== 0 ? d : ((b.speed || 0) - (a.speed || 0));
    });
    var si = -1;
    order.forEach(function (b, i) { if (b.id === state.selected) si = i; });
    if (si > 0) order.unshift(order.splice(si, 1)[0]);

    var kept = [];
    state.buses.forEach(function (b) { b._dot = false; b._mg = 0; });
    order.forEach(function (b) {
      var p = map.latLngToContainerPoint([b.lat, b.lon]);
      var host = null;
      for (var i = 0; i < kept.length; i++) {
        if (Math.abs(p.x - kept[i].x) < kdx && Math.abs(p.y - kept[i].y) < kdy) {
          host = kept[i]; break;
        }
      }
      if (host) { b._dot = true; host.b._mg++; }
      else kept.push({ x: p.x, y: p.y, b: b });
    });

    var seen = {};
    state.buses.forEach(function (b) {
      seen[b.id] = 1;
      var ic = busIcon(b);
      var m = markers[b.id];
      if (!m) {
        m = L.marker([b.lat, b.lon], { icon: ic, title: b.name, riseOnHover: true, keyboard: false });
        m.on('click', function () { selectBus(b.id, true); });
        m.addTo(busLayer);
        markers[b.id] = m;
      } else {
        m.setLatLng([b.lat, b.lon]);
        m.setIcon(ic);
      }
      var st = statusOf(b);
      m.bindTooltip(
        '<b>' + esc(b.name) + '</b><br>' + LABELS[st] + ' · ' + fmtNum(b.speed, 0) + ' كم/س' +
        (b.route ? '<br>🛣️ ' + esc(b.route) : '') +
        (b.source === 'cache' ? '<br>💾 بيانات مخزَّنة' : ''),
        { direction: 'top', offset: [0, -12], className: 'bustip' }
      );
    });
    Object.keys(markers).forEach(function (id) {
      if (!seen[id]) { busLayer.removeLayer(markers[id]); delete markers[id]; }
    });
  }

  function renderMyPos() {
    myLayer.clearLayers();
    if (!state.myPos) return;
    L.marker(state.myPos, {
      icon: L.divIcon({ html: '<div class="me"></div>', className: 'mymark', iconSize: [18, 18], iconAnchor: [9, 9] }),
      title: 'موقعي'
    }).addTo(myLayer).bindTooltip('موقعك الحالي', { direction: 'top', offset: [0, -12] });
  }

  function renderStation() {
    stLayer.clearLayers();
    if (!cfg.station) return;
    var s = cfg.station;
    L.circle([s.lat, s.lon], {
      radius: s.radius || 300, color: COLORS.idle, weight: 1.5,
      opacity: .8, fillColor: COLORS.idle, fillOpacity: .12, interactive: false
    }).addTo(stLayer);
    L.marker([s.lat, s.lon], {
      icon: L.divIcon({ html: '<div class="stp">🚏</div>', className: 'stmark', iconSize: [22, 22], iconAnchor: [11, 11] }),
      title: s.name || 'محطة التنبيه'
    }).addTo(stLayer).bindTooltip('🚏 ' + esc(s.name || 'محطة التنبيه'), { direction: 'top', offset: [0, -14] });
  }

  /* ---------- 7. تتبّع المسار التاريخي ---------- */
  function pushHistory(b) {
    if (!state.hist[b.id]) state.hist[b.id] = [];
    var h = state.hist[b.id];
    var last = h[h.length - 1];
    if (!last || haversine([last.lat, last.lon], [b.lat, b.lon]) > 6) {
      h.push({ lat: b.lat, lon: b.lon, t: Date.now(), spd: b.speed });
    } else if (last) {
      last.t = Date.now(); last.spd = b.speed;
    }
    var cut = Date.now() - HOUR;
    while (h.length && h[0].t < cut) h.shift();
    if (h.length > 400) h.splice(0, h.length - 400);
  }

  function histOf(id) {
    var h = state.hist[id] || [];
    var cut = Date.now() - HOUR;
    return h.filter(function (p) { return p.t >= cut; });
  }

  function renderHistory() {
    histLayer.clearLayers();
    if (!cfg.trackOn || !state.selected) return;
    var h = histOf(state.selected);
    if (h.length < 2) return;
    var pts = h.map(function (p) { return [p.lat, p.lon]; });
    L.polyline(pts, { color: '#3b82f6', weight: 4, opacity: .35, interactive: false }).addTo(histLayer);
    L.polyline(pts, { color: '#8ab4ff', weight: 2, opacity: .85, dashArray: '7 6', interactive: false }).addTo(histLayer);
    L.circleMarker(pts[0], {
      radius: 5, color: '#8ab4ff', weight: 2, fillColor: '#0d1117', fillOpacity: 1, interactive: false
    }).addTo(histLayer);
  }

  /* ---------- 8. الوضع التجريبي ---------- */
  function buildPath(pts) {
    var cum = [0], tot = 0;
    for (var i = 1; i < pts.length; i++) { tot += haversine(pts[i - 1], pts[i]); cum.push(tot); }
    return { pts: pts, cum: cum, total: tot };
  }
  function pointAt(path, dist) {
    var total = path.total, pts = path.pts, cum = path.cum;
    if (total <= 0) return { lat: pts[0][0], lon: pts[0][1], brg: 0 };
    var d = ((dist % (2 * total)) + 2 * total) % (2 * total), rev = false;
    if (d > total) { d = 2 * total - d; rev = true; }
    var lo = 0, hi = cum.length - 1;
    while (lo < hi - 1) { var mid = (lo + hi) >> 1; if (cum[mid] <= d) lo = mid; else hi = mid; }
    var seg = (cum[hi] - cum[lo]) || 1, f = (d - cum[lo]) / seg;
    var a = pts[lo], b = pts[hi];
    var brg = bearing(a, b);
    if (rev) brg = (brg + 180) % 360;
    return { lat: a[0] + (b[0] - a[0]) * f, lon: a[1] + (b[1] - a[1]) * f, brg: brg };
  }
  function fallbackRoutes() {
    var c = cfg.center, pts = [];
    for (var i = 0; i <= 24; i++) {
      var a = (i / 24) * Math.PI * 2;
      pts.push([c[0] + Math.sin(a) * 0.012, c[1] + Math.cos(a) * 0.016]);
    }
    return { city: 'المسيلة', center: c, routes: [{ id: 'R1', name: 'مسار دائري', len: 3000, pts: pts }] };
  }

  var DEMO_NAMES = ['04/H015', '05/H003', '11/H018', '12/H005', '13/H002', '16/H007',
                    '17/H020', '18/H006', '475/10', '480/17', '486/12', '490/10',
                    '618/09', '651/04'];

  function startDemo(routesData) {
    state.mode = 'demo';
    state.routes = routesData;
    var routes = routesData.routes || [];
    if (!routes.length) routes = fallbackRoutes().routes;

    routeLayer.clearLayers();
    routes.forEach(function (r) {
      L.polyline(r.pts, {
        color: '#f0a020', weight: 2.5, opacity: 0.32, dashArray: '6 7', interactive: false
      }).addTo(routeLayer);
    });

    var buses = [];
    for (var i = 0; i < 14; i++) {
      var r = routes[i % routes.length];
      var path = buildPath(r.pts);
      var spd = 16 + ((i * 7) % 26);
      var nm = DEMO_NAMES[i % DEMO_NAMES.length];
      buses.push({
        id: 'demo-' + (i + 1),
        name: nm,
        uniqueId: 'ETUSM-' + pad(i + 1) + '-16',
        route: r.name,
        line: lineOf(nm),
        path: path,
        dist: (path.total * 2) * ((i * 0.137) % 1),
        speed: spd,
        baseSpeed: spd,
        lat: 0, lon: 0, brg: 0,
        offline: false,
        lastUpdate: Date.now(),
        demo: true
      });
    }
    state.buses = buses;
    state.byId = {};
    buses.forEach(function (b) { state.byId[b.id] = b; });
    tickDemo();
    state.lastUpdate = Date.now();
    state.lastError = null;
    setStatus('demo', 'وضع تجريبي');
    $('demoBar').classList.remove('hidden');
    $('demoBar').classList.remove('cache');
    $('demoTxt').textContent = 'وضع تجريبي — لا اتصال بالخادم · ' + routes.length + ' مسارات حقيقية';
    log('warn', 'تشغيل الوضع التجريبي — ' + routes.length + ' مسارًا حقيقيًا، ' + buses.length + ' حافلة محاكاة');
    fillLineFilter();
    renderAll();
  }

  function tickDemo() {
    if (state.mode !== 'demo') return;
    var now = Date.now();
    state.buses.forEach(function (b, i) {
      var wob = Math.sin(now / 9000 + i * 1.7) * 0.35 + Math.sin(now / 3100 + i) * 0.12;
      b.speed = Math.max(0, b.baseSpeed * (1 + wob));
      var stopPhase = (now / 1000 + i * 13) % 47;
      if (stopPhase < 3.2) b.speed = 0;
      b.dist += (b.speed / 3.6) * 1.0;
      var p = pointAt(b.path, b.dist);
      b.lat = p.lat; b.lon = p.lon; b.brg = p.brg;
      b.lastUpdate = now;
      b.offline = false;
      pushHistory(b);
    });
    state.lastUpdate = now;
    renderMarkers();
    renderList();
    renderStats();
    updateSubtitle();
    checkProximity();
    renderHistory();
    if (state.selected) renderDetail();
  }

  /* ---------- 9. عميل Traccar ---------- */
  function apiUrl(path) {
    var base = String(cfg.server || '').replace(/\/+$/, '');
    return base + path;
  }

  function fetchJson(url, opts, timeoutMs) {
    var ctrl = ('AbortController' in window) ? new AbortController() : null;
    var to = setTimeout(function () { if (ctrl) ctrl.abort(); }, timeoutMs || 15000);
    var o = opts || {};
    o.signal = ctrl ? ctrl.signal : undefined;
    return fetch(url, o).then(function (r) {
      clearTimeout(to);
      return r.text().then(function (txt) {
        var data = null;
        try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = null; }
        return { ok: r.ok, status: r.status, data: data, text: txt };
      });
    }).catch(function (e) {
      clearTimeout(to);
      throw e;
    });
  }

  function login() {
    if (cfg.token) return Promise.resolve(cfg.token);
    if (!cfg.email || !cfg.password) return Promise.reject(new Error('NO_CREDENTIALS'));
    var body = 'email=' + encodeURIComponent(cfg.email) + '&password=' + encodeURIComponent(cfg.password);
    return fetchJson(apiUrl('/api/session'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body,
      credentials: 'include'
    }, 15000).then(function (r) {
      if (!r.ok) throw new Error('AUTH_' + r.status);
      var tok = r.data && (r.data.token || r.data.session || r.data.id);
      if (tok) { cfg.token = String(tok); saveCfg(); }
      return cfg.token || null;
    });
  }

  function authHeaders() {
    var h = { 'Accept': 'application/json' };
    if (cfg.token) h['Authorization'] = 'Bearer ' + cfg.token;
    return h;
  }

  function normalizeDevices(devices, positions) {
    var posByDev = {};
    positions.forEach(function (p) {
      if (!p || p.deviceId == null) return;
      if (p.latitude === 0 && p.longitude === 0) return;   // إحداثيات غير صالحة (أجهزة بلا قفل GPS)
      var prev = posByDev[p.deviceId];
      var t = Date.parse(p.fixTime || p.deviceTime || p.serverTime || 0) || 0;
      var pt = prev ? (Date.parse(prev.fixTime || prev.deviceTime || prev.serverTime || 0) || 0) : -1;
      if (t >= pt) posByDev[p.deviceId] = p;
    });

    var buses = [];
    devices.forEach(function (d) {
      var p = posByDev[d.id];
      if (!p) return;
      var fix = p.fixTime || p.deviceTime || p.serverTime;
      var ts = fix ? Date.parse(fix) : null;
      var age = ts ? (Date.now() - ts) : null;
      var spd = (p.speed != null) ? p.speed * 3.6 : 0;   // عقدة → كم/س
      var nm = (d.name || d.uniqueId || ('جهاز ' + d.id)).trim();
      buses.push({
        id: 'd' + d.id,
        name: nm,
        uniqueId: d.uniqueId || '',
        route: (d.attributes && (d.attributes.route || d.attributes.line)) || '',
        line: lineOf(nm),
        phone: d.phone || '',
        lat: p.latitude, lon: p.longitude,
        brg: p.course != null ? p.course : 0,
        speed: spd,
        address: p.address || '',
        motion: !!(p.attributes && p.attributes.motion),
        lastUpdate: ts || Date.now(),
        offline: (d.status === 'offline') || (age != null && age > 300000),
        demo: false
      });
    });
    return buses;
  }

  function fetchLive() {
    return login().then(function () {
      return Promise.all([
        fetchJson(apiUrl('/api/devices'), { headers: authHeaders(), credentials: 'include' }, 15000),
        fetchJson(apiUrl('/api/positions'), { headers: authHeaders(), credentials: 'include' }, 15000)
      ]);
    }).then(function (res) {
      var dRes = res[0], pRes = res[1];
      if (dRes.status === 401 || pRes.status === 401) throw new Error('AUTH_401');
      if (!dRes.ok) throw new Error('DEVICES_' + dRes.status);
      var devices = Array.isArray(dRes.data) ? dRes.data : [];
      var positions = Array.isArray(pRes.data) ? pRes.data : [];
      var buses = normalizeDevices(devices, positions);
      if (!buses.length) throw new Error('EMPTY');
      return buses;
    });
  }

  function useCached(reason) {
    var c = loadCache();
    if (!cfg.offlineCache || !c) return false;
    state.mode = 'cache';
    state.cacheAge = Date.now() - c.t;
    state.buses = c.buses.map(function (b) { b.source = 'cache'; b.demo = false; return b; });
    state.byId = {};
    state.buses.forEach(function (b) { state.byId[b.id] = b; });
    state.lastUpdate = c.t;
    setStatus('cache', 'بيانات مخزَّنة');
    $('demoBar').classList.remove('hidden');
    $('demoBar').classList.add('cache');
    $('demoTxt').textContent = 'وضع بلا اتصال — آخر بيانات محفوظة ' + fmtAgo(c.t) +
      ' (' + state.buses.length + ' حافلة) · ' + reason;
    fillLineFilter();
    renderAll();
    log('warn', 'وضع بلا اتصال — عرض ' + state.buses.length + ' حافلة من الذاكرة (' + reason + ')');
    return true;
  }

  function refresh(manual) {
    if (state.mode === 'demo') {
      if (manual) {
        toast('جارٍ محاولة الاتصال بالخادم…');
        state.mode = 'boot';
        return refresh(false);
      }
      return Promise.resolve();
    }
    var btn = $('btnRefresh');
    btn.classList.add('spin');
    return fetchLive().then(function (buses) {
      var wasFallback = state.mode !== 'live';
      state.mode = 'live';
      state.cacheAge = null;
      state.buses = buses;
      state.byId = {};
      buses.forEach(function (b) { state.byId[b.id] = b; });
      state.lastUpdate = Date.now();
      state.lastError = null;
      setStatus('live', 'مباشر · حقيقي');
      $('demoBar').classList.add('hidden');
      fillLineFilter();
      buses.forEach(pushHistory);
      saveCache();
      renderAll();
      renderHistory();
      if (state.selected && state.byId[state.selected]) renderDetail();
      else if (state.selected) closeDetail();
      if (manual || wasFallback) {
        toast('✅ بيانات حقيقية — ' + buses.length + ' حافلة من الخادم', 'ok', 4000);
      }
      log('ok', 'تحديث ناجح من الخادم — ' + buses.length + ' حافلة حقيقية');
    }).catch(function (e) {
      var msg = String((e && e.message) || e);
      state.lastError = msg;
      var friendly = msg === 'NO_CREDENTIALS' ? 'لا توجد بيانات دخول'
        : msg === 'AUTH_401' ? 'رمز/جلسة غير صالحة (401)'
        : msg === 'EMPTY' ? 'الخادم لم يُعِد أي جهاز'
        : msg.indexOf('AUTH_') === 0 ? 'فشل تسجيل الدخول (' + msg + ')'
        : msg.indexOf('AbortError') >= 0 ? 'انتهت مهلة الاتصال'
        : 'تعذّر الوصول للخادم (' + msg + ')';

      if (msg === 'AUTH_401') { cfg.token = ''; saveCfg(); }
      log('warn', friendly + ' — الانتقال إلى وضع بديل');

      if (!useCached(friendly)) {
        if (state.mode !== 'demo') {
          loadRoutes().then(function (r) { startDemo(r); });
          toast(friendly + ' — شُغّل الوضع التجريبي', 'warn', 4600);
        }
      } else if (manual) {
        toast('تعذّر الاتصال — عُرضت آخر بيانات محفوظة', 'warn', 4200);
      }
    }).then(function () {
      btn.classList.remove('spin');
    });
  }

  function loadRoutes() {
    if (state.routes) return Promise.resolve(state.routes);
    return fetch('msila_routes.json', { cache: 'no-cache' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (d && d.routes && d.routes.length) {
          log('info', 'حُمّلت ' + d.routes.length + ' مسارًا حقيقيًا من OpenStreetMap');
          return d;
        }
        log('warn', 'تعذّر تحميل ملف المسارات — استخدام مسار احتياطي');
        return fallbackRoutes();
      })
      .catch(function () {
        log('warn', 'تعذّر تحميل ملف المسارات — استخدام مسار احتياطي');
        return fallbackRoutes();
      });
  }

  /* ---------- 10. العرض ---------- */
  function setStatus(kind, txt) {
    var p = $('statusPill');
    p.className = 'pill ' + (kind === 'live' ? 'live' : kind === 'demo' ? 'demo' : kind === 'cache' ? 'cache' : kind === 'err' ? 'err' : '');
    $('statusTxt').textContent = txt;
  }
  function updateSubtitle() {
    var n = state.buses.length;
    var t = state.lastUpdate ? fmtTime(new Date(state.lastUpdate)) : '—';
    var extra = state.mode === 'cache' ? ' · مخزَّنة' : state.mode === 'demo' ? ' · تجريبي' : '';
    $('subtitle').textContent = n + ' حافلة · آخر تحديث ' + t + extra;
  }

  function renderStats() {
    var total = state.buses.length, mv = 0, idl = 0, off = 0, sum = 0, cnt = 0, fastest = null;
    state.buses.forEach(function (b) {
      var s = statusOf(b);
      if (s === 'moving') mv++; else if (s === 'idle') idl++; else off++;
      if (s !== 'offline' && b.speed != null) { sum += b.speed; cnt++; }
      if (s === 'moving' && (!fastest || b.speed > fastest.speed)) fastest = b;
    });
    var avg = cnt ? sum / cnt : 0;

    setBox('sbTotal', total);
    setBox('sbMoving', mv);
    setBox('sbIdle', idl);
    setBox('sbOffline', off);
    setBox('sbAvg', fmtNum(avg, 1));
    var fb = $('sbFast');
    if (fastest) {
      fb.querySelector('.sv').textContent = fmtNum(fastest.speed, 0) + ' كم/س';
      fb.querySelector('.sk').textContent = '⚡ ' + fastest.name;
    } else {
      fb.querySelector('.sv').textContent = '—';
      fb.querySelector('.sk').textContent = '⚡ أسرع حافلة';
    }

    $('stats').innerHTML =
      cell('acc', '🚌', 'الإجمالي', total) +
      cell('ok', '🟢', 'متحركة', mv) +
      cell('warn', '🟡', 'متوقفة', idl) +
      cell('bad', '🔴', 'غير متصلة', off) +
      cell('info', '📈', 'متوسط السرعة', fmtNum(avg, 1) + '<small style="font-size:11px;font-weight:600"> كم/س</small>') +
      cell('acc', '⚡', 'أسرع حافلة', fastest ? fmtNum(fastest.speed, 0) + '<small style="font-size:11px;font-weight:600"> كم/س</small>' : '—') +
      (state.myPos ? '<div class="stat" style="grid-column:1/-1"><span class="k">📍 موقعي محدَّد</span>' +
        '<span class="v" style="font-size:13px">' + fmtNum(state.myPos[0], 4) + ', ' + fmtNum(state.myPos[1], 4) + '</span></div>' : '');

    ['sbTotal', 'sbMoving', 'sbIdle', 'sbOffline'].forEach(function (id) {
      var el = $(id);
      el.setAttribute('aria-pressed', String(state.filter === el.getAttribute('data-f')));
    });
    $('sbAvg').setAttribute('aria-pressed', 'false');
    fb.setAttribute('aria-pressed', 'false');
  }
  function setBox(id, v) {
    var el = $(id);
    if (el) el.querySelector('.sv').textContent = v;
  }
  function cell(cls, ic, k, v) {
    return '<div class="stat ' + cls + '"><span class="k">' + ic + ' ' + k + '</span><span class="v">' + v + '</span></div>';
  }

  function renderChips() {
    var c = { all: state.buses.length, moving: 0, idle: 0, offline: 0 };
    state.buses.forEach(function (b) { c[statusOf(b)]++; });
    var defs = [['all', 'الكل'], ['moving', 'متحركة'], ['idle', 'متوقفة'], ['offline', 'غير متصلة']];
    $('chips').innerHTML = defs.map(function (d) {
      return '<button class="chip" data-f="' + d[0] + '" aria-pressed="' + (state.filter === d[0]) + '">' +
        d[1] + ' <span class="n">' + c[d[0]] + '</span></button>';
    }).join('');
  }

  function fillLineFilter() {
    var lines = {};
    state.buses.forEach(function (b) { if (b.line) lines[b.line] = (lines[b.line] || 0) + 1; });
    var keys = Object.keys(lines).sort(function (a, b) {
      return String(a).localeCompare(String(b), 'ar', { numeric: true });
    });
    if (state.lineFilter !== 'all' && !lines[state.lineFilter]) state.lineFilter = 'all';
    $('lineSel').innerHTML = '<option value="all">كل الخطوط (' + state.buses.length + ')</option>' +
      keys.map(function (k) {
        return '<option value="' + esc(k) + '"' + (state.lineFilter === k ? ' selected' : '') + '>' +
          esc(k) + ' (' + lines[k] + ')</option>';
      }).join('');
  }

  function visibleBuses() {
    var q = state.query.trim().toLowerCase();
    var list = state.buses.filter(function (b) {
      if (state.filter !== 'all' && statusOf(b) !== state.filter) return false;
      if (state.lineFilter !== 'all' && b.line !== state.lineFilter) return false;
      if (!q) return true;
      return (b.name + ' ' + (b.uniqueId || '') + ' ' + (b.route || '') + ' ' + (b.line || '') + ' ' + (b.phone || ''))
        .toLowerCase().indexOf(q) >= 0;
    });
    if (state.sort === 'speed') list.sort(function (a, b) { return (b.speed || 0) - (a.speed || 0); });
    else if (state.sort === 'recent') list.sort(function (a, b) { return (b.lastUpdate || 0) - (a.lastUpdate || 0); });
    else if (state.sort === 'line') list.sort(function (a, b) {
      var c = String(a.line).localeCompare(String(b.line), 'ar', { numeric: true });
      return c !== 0 ? c : String(a.name).localeCompare(String(b.name), 'ar', { numeric: true });
    });
    else if (state.sort === 'dist' && state.myPos) {
      list.sort(function (a, b) { return haversine(state.myPos, [a.lat, a.lon]) - haversine(state.myPos, [b.lat, b.lon]); });
    } else list.sort(function (a, b) { return String(a.name).localeCompare(String(b.name), 'ar', { numeric: true }); });
    return list;
  }

  function renderList() {
    var list = visibleBuses();
    if (!list.length) {
      $('buslist').innerHTML = '<div class="empty">لا توجد حافلات مطابقة.<br>جرّب تغيير التصفية أو البحث.</div>';
      return;
    }
    $('buslist').innerHTML = list.map(function (b) {
      var st = statusOf(b), col = COLORS[st];
      var dist = state.myPos ? haversine(state.myPos, [b.lat, b.lon]) : null;
      return '<button class="busrow' + (state.selected === b.id ? ' sel' : '') + '" data-id="' + esc(b.id) + '" style="--c:' + col + '">' +
        '<span class="av"><span class="brg" style="transform:rotate(' + Math.round(b.brg || 0) + 'deg)">➤</span></span>' +
        '<span class="mid"><span class="nm">' + esc(b.name) + '</span>' +
        '<span class="sub"><span style="color:' + col + '">● ' + LABELS[st] + '</span>' +
        '<span>' + fmtNum(b.brg, 0) + '° ' + compass(b.brg) + '</span>' +
        (dist != null ? '<span>📍 ' + fmtDist(dist) + '</span>' : '') +
        (b.line ? '<span>🛣️ ' + esc(b.line) + '</span>' : '') +
        '<span>🕒 ' + fmtAgo(b.lastUpdate) + '</span>' +
        (b.source === 'cache' ? '<span>💾</span>' : '') +
        '</span></span>' +
        '<span class="sp">' + fmtNum(b.speed, 0) + '<small>كم/س</small></span>' +
        '</button>';
    }).join('');
  }

  function renderAll() {
    renderStats(); renderChips(); renderList(); renderMarkers(); updateSubtitle();
  }

  /* ---------- 11. بطاقة التفاصيل ---------- */
  function selectBus(id, fly) {
    var b = state.byId[id];
    if (!b) return;
    state.selected = id;
    if (fly) map.flyTo([b.lat, b.lon], Math.max(map.getZoom(), 15), { duration: 0.6 });
    renderDetail();
    $('detail').classList.remove('hidden');
    renderList(); renderMarkers(); renderHistory();
  }

  function renderDetail() {
    var b = state.byId[state.selected];
    if (!b) { closeDetail(); return; }
    document.body.classList.add('has-detail');
    var st = statusOf(b), col = COLORS[st];
    var dist = state.myPos ? haversine(state.myPos, [b.lat, b.lon]) : null;
    var eta = dist != null ? fmtEta(dist, b.speed) : null;
    var h = histOf(b.id);
    var conn = b.offline
      ? '<span style="color:' + COLORS.offline + '">● غير متصلة</span> — آخر إشارة ' + fmtAgo(b.lastUpdate)
      : '<span style="color:' + COLORS.moving + '">● متصلة</span> — تحديث ' + fmtAgo(b.lastUpdate);

    $('detail').style.setProperty('--c', col);
    $('detail').innerHTML =
      '<div class="dh">' +
        '<span class="av"><span class="brg" style="transform:rotate(' + Math.round(b.brg || 0) + 'deg)">➤</span></span>' +
        '<span class="t"><b>' + esc(b.name) + '</b>' +
        '<small style="color:' + col + '">● ' + LABELS[st] + (b.line ? ' · الخط ' + esc(b.line) : '') +
        (b.demo ? ' · تجريبي' : '') + (b.source === 'cache' ? ' · مخزَّن' : '') + '</small></span>' +
        '<button class="close" id="btnCloseDetail" aria-label="إغلاق">✕</button>' +
      '</div>' +
      '<div class="dgrid">' +
        dcell('السرعة الحالية', fmtNum(b.speed, 1) + ' كم/س', false, true) +
        dcell('الاتجاه', fmtNum(b.brg, 0) + '° — ' + compass(b.brg)) +
        (dist != null ? dcell('المسافة مني', fmtDist(dist)) : dcell('المسافة مني', 'حدّد موقعك 📍')) +
        dcell('الوقت المتوقع للوصول', eta ? eta : (b.speed < 1.5 ? 'متوقفة الآن' : 'غير متاح')) +
        (b.route ? dcell('المسار / الخط', esc(b.route), true) : '') +
        dcell('حالة الاتصال', conn, true) +
        dcell('الإحداثيات', fmtNum(b.lat, 5) + ', ' + fmtNum(b.lon, 5), true) +
        (b.uniqueId ? dcell('المعرّف (IMEI/UID)', esc(b.uniqueId), true) : '') +
        (b.phone ? dcell('هاتف المركبة', esc(b.phone), true) : '') +
        (b.address ? dcell('العنوان', esc(b.address), true) : '') +
      '</div>' +
      '<div class="trackbox">' +
        '<h4>🛣️ المسار في آخر ساعة <span style="color:var(--muted);font-weight:600">(' + h.length + ' نقطة)</span></h4>' +
        '<canvas id="miniTrack" width="520" height="192"></canvas>' +
        '<div class="tracklist" id="trackList"></div>' +
      '</div>' +
      '<div class="btnrow">' +
        '<button class="btn" id="btnCenter">🎯 توسيط</button>' +
        '<button class="btn" id="btnTrackTgl">' + (cfg.trackOn ? '🚫 إخفاء المسار' : '🛣️ إظهار المسار') + '</button>' +
        '<button class="btn" id="btnShare">🔗 مشاركة</button>' +
        '<button class="btn ghost" id="btnCopy">📋 نسخ الإحداثيات</button>' +
      '</div>';

    $('btnCloseDetail').onclick = closeDetail;
    $('btnCenter').onclick = function () { map.flyTo([b.lat, b.lon], 16, { duration: 0.6 }); };
    $('btnTrackTgl').onclick = function () {
      cfg.trackOn = !cfg.trackOn; saveCfg();
      renderHistory(); renderDetail();
      toast(cfg.trackOn ? 'المسار التاريخي مُظهَر' : 'المسار التاريخي مخفي', 'ok', 2200);
    };
    $('btnShare').onclick = function () { shareBus(b); };
    $('btnCopy').onclick = function () { copyText(b.lat + ',' + b.lon, 'تم نسخ الإحداثيات'); };
    drawMiniTrack(b, h);
  }

  function dcell(k, v, full, accent) {
    return '<div class="dcell' + (full ? ' full' : '') + (accent ? ' accent' : '') + '">' +
      '<div class="k">' + k + '</div><div class="v">' + v + '</div></div>';
  }

  function drawMiniTrack(b, h) {
    var cv = $('miniTrack');
    if (!cv || !cv.getContext) return;
    var ctx = cv.getContext('2d');
    var W = cv.width, H = cv.height, P = 16;
    ctx.clearRect(0, 0, W, H);

    var pts = h.map(function (p) { return [p.lat, p.lon]; });
    if (pts.length < 2) pts = [[b.lat, b.lon], [b.lat + 0.0005, b.lon + 0.0005]];

    var la = pts.map(function (p) { return p[0]; }), lo = pts.map(function (p) { return p[1]; });
    var minLa = Math.min.apply(null, la), maxLa = Math.max.apply(null, la);
    var minLo = Math.min.apply(null, lo), maxLo = Math.max.apply(null, lo);
    var spanLa = Math.max(maxLa - minLa, 1e-5), spanLo = Math.max(maxLo - minLo, 1e-5);
    var sc = Math.min((W - P * 2) / spanLo, (H - P * 2) / spanLa);
    function X(p) { return P + (p[1] - minLo) * sc + (W - P * 2 - spanLo * sc) / 2; }
    function Y(p) { return H - P - (p[0] - minLa) * sc - (H - P * 2 - spanLa * sc) / 2; }

    ctx.strokeStyle = 'rgba(139,152,165,.18)';
    ctx.lineWidth = 1;
    for (var gx = 0; gx <= 4; gx++) {
      ctx.beginPath(); ctx.moveTo(P + gx * (W - P * 2) / 4, P); ctx.lineTo(P + gx * (W - P * 2) / 4, H - P); ctx.stroke();
    }
    for (var gy = 0; gy <= 3; gy++) {
      ctx.beginPath(); ctx.moveTo(P, P + gy * (H - P * 2) / 3); ctx.lineTo(W - P, P + gy * (H - P * 2) / 3); ctx.stroke();
    }

    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(59,130,246,.35)'; ctx.lineWidth = 7;
    ctx.beginPath(); pts.forEach(function (p, i) { i ? ctx.lineTo(X(p), Y(p)) : ctx.moveTo(X(p), Y(p)); }); ctx.stroke();
    ctx.strokeStyle = '#8ab4ff'; ctx.lineWidth = 2.5;
    ctx.setLineDash([7, 6]);
    ctx.beginPath(); pts.forEach(function (p, i) { i ? ctx.lineTo(X(p), Y(p)) : ctx.moveTo(X(p), Y(p)); }); ctx.stroke();
    ctx.setLineDash([]);

    pts.forEach(function (p, i) {
      var last = i === pts.length - 1;
      ctx.beginPath();
      ctx.arc(X(p), Y(p), last ? 6 : 3, 0, Math.PI * 2);
      ctx.fillStyle = last ? COLORS[statusOf(b)] : 'rgba(138,180,255,.65)';
      ctx.fill();
      if (last) { ctx.strokeStyle = '#0d1117'; ctx.lineWidth = 2; ctx.stroke(); }
    });

    var l2 = pts[pts.length - 1], l1 = pts[pts.length - 2] || l2;
    var ang = Math.atan2(Y(l2) - Y(l1), X(l2) - X(l1));
    ctx.save(); ctx.translate(X(l2), Y(l2)); ctx.rotate(ang);
    ctx.beginPath(); ctx.moveTo(20, 0); ctx.lineTo(9, -6); ctx.lineTo(9, 6); ctx.closePath();
    ctx.fillStyle = COLORS[statusOf(b)]; ctx.fill();
    ctx.restore();

    var tl = $('trackList');
    if (tl) {
      if (h.length >= 2) {
        var lastN = h.slice(-5).reverse();
        tl.innerHTML = lastN.map(function (p, i) {
          return '<div><span>' + (i === 0 ? '⏱️ الآن' : fmtAgo(p.t)) + '</span>' +
            '<span>' + fmtNum(p.spd, 0) + ' كم/س</span>' +
            '<span>' + fmtNum(p.lat, 4) + ', ' + fmtNum(p.lon, 4) + '</span></div>';
        }).join('');
      } else {
        tl.innerHTML = '<div><span>لا نقاط كافية بعد — انتظر تحديثات إضافية</span></div>';
      }
    }
  }

  function closeDetail() {
    document.body.classList.remove('has-detail');
    $('detail').classList.add('hidden');
    state.selected = null;
    renderList(); renderMarkers(); renderHistory();
  }

  function copyText(txt, okMsg) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(function () { toast(okMsg, 'ok'); },
        function () { toast(txt, 'ok', 5000); });
    } else { toast(txt, 'ok', 5000); }
  }

  function shareBus(b) {
    var u = location.origin + location.pathname + '?bus=' + encodeURIComponent(b.id);
    var txt = '🚌 ' + b.name + ' — ' + fmtNum(b.speed, 0) + ' كم/س · ' + LABELS[statusOf(b)] +
      ' · ' + b.lat.toFixed(5) + ',' + b.lon.toFixed(5) + '\n' + u;
    if (navigator.share) {
      navigator.share({ title: 'حافلة ' + b.name, text: txt, url: u }).catch(function () {});
    } else if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(function () { toast('تم نسخ رابط الحافلة 🔗', 'ok'); },
        function () { toast(u, 'ok', 6000); });
    } else { toast(u, 'ok', 6000); }
  }

  /* ---------- 12. الحافلات القريبة والتنبيهات ---------- */
  function locateMe() {
    if (!navigator.geolocation) { toast('متصفحك لا يدعم تحديد الموقع', 'err'); return; }
    toast('جارٍ تحديد موقعك…');
    navigator.geolocation.getCurrentPosition(function (p) {
      state.myPos = [p.coords.latitude, p.coords.longitude];
      state.sort = 'dist';
      $('sortSel').value = 'dist';
      renderMyPos();
      map.flyTo(state.myPos, 15, { duration: 0.7 });
      renderList(); renderStats();
      var near = visibleBuses().slice(0, 3);
      if (near.length) {
        var d = haversine(state.myPos, [near[0].lat, near[0].lon]);
        toast('أقرب حافلة: ' + near[0].name + ' — ' + fmtDist(d), 'ok', 4200);
      } else {
        toast('تم تحديد موقعك — لا حافلات في التصفية الحالية', 'ok', 3600);
      }
      log('ok', 'تم تحديد الموقع — ' + state.myPos[0].toFixed(5) + ', ' + state.myPos[1].toFixed(5));
    }, function (e) {
      var m = e.code === 1 ? 'تم رفض إذن الموقع' : 'تعذّر تحديد الموقع';
      toast(m, 'err'); log('err', m);
    }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 });
  }

  function checkProximity() {
    if (!state.myPos && !cfg.station) return;
    state.buses.forEach(function (b) {
      if (cfg.alertOn && state.myPos) {
        var d = haversine(state.myPos, [b.lat, b.lon]);
        var k = 'me:' + b.id;
        if (d <= cfg.alertRadius) {
          if (!state.alertFired[k] || Date.now() - state.alertFired[k] > 120000) {
            state.alertFired[k] = Date.now();
            beep('me');
            toast('🚌 ' + b.name + ' على بعد ' + fmtDist(d) + ' منك!', 'warn', 5000);
            log('warn', 'تنبيه اقتراب: ' + b.name + ' — ' + fmtDist(d));
          }
        } else if (state.alertFired[k] && d > cfg.alertRadius * 1.6) { delete state.alertFired[k]; }
      }
      if (cfg.station) {
        var ds = haversine([cfg.station.lat, cfg.station.lon], [b.lat, b.lon]);
        var ks = 'st:' + b.id;
        var rad = cfg.station.radius || 300;
        if (ds <= rad) {
          if (!state.alertFired[ks] || Date.now() - state.alertFired[ks] > 180000) {
            state.alertFired[ks] = Date.now();
            beep('station');
            toast('🚏 ' + b.name + ' وصلت محطة ' + (cfg.station.name || 'التنبيه') + ' (' + fmtDist(ds) + ')', 'warn', 6000);
            log('warn', 'تنبيه محطة: ' + b.name + ' — ' + fmtDist(ds) + ' من ' + (cfg.station.name || 'المحطة'));
          }
        } else if (state.alertFired[ks] && ds > rad * 1.6) { delete state.alertFired[ks]; }
      }
    });
  }

  /* ---------- 13. التصدير ---------- */
  function download(name, text, mime) {
    var blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 400);
  }
  function exportJson() {
    var data = {
      generated: new Date().toISOString(),
      mode: state.mode,
      server: cfg.server,
      count: state.buses.length,
      buses: state.buses.map(function (b) {
        return {
          name: b.name, uniqueId: b.uniqueId, line: b.line, route: b.route, phone: b.phone,
          lat: b.lat, lon: b.lon, speed_kmh: Number(fmtNum(b.speed, 2)),
          course: b.brg, compass: compass(b.brg), status: statusOf(b),
          lastUpdate: new Date(b.lastUpdate).toISOString()
        };
      })
    };
    download('msila-buses-' + Date.now() + '.json', JSON.stringify(data, null, 2), 'application/json');
    toast('تم تصدير JSON', 'ok');
  }
  function exportCsv() {
    var rows = [['الاسم', 'المعرّف', 'الخط', 'المسار', 'خط العرض', 'خط الطول',
      'السرعة (كم/س)', 'الاتجاه', 'جهة الاتجاه', 'الحالة', 'آخر تحديث']];
    state.buses.forEach(function (b) {
      rows.push([b.name, b.uniqueId || '', b.line || '', b.route || '', b.lat, b.lon,
        fmtNum(b.speed, 2), fmtNum(b.brg, 0), compass(b.brg), LABELS[statusOf(b)],
        new Date(b.lastUpdate).toISOString()]);
    });
    var csv = '\ufeff' + rows.map(function (r) {
      return r.map(function (c) { return '"' + String(c).replace(/"/g, '""') + '"'; }).join(',');
    }).join('\r\n');
    download('msila-buses-' + Date.now() + '.csv', csv, 'text/csv;charset=utf-8');
    toast('تم تصدير CSV', 'ok');
  }

  /* ---------- 14. السجل ---------- */
  function renderLog() {
    var counts = { all: state.log.length, info: 0, ok: 0, warn: 0, err: 0 };
    state.log.forEach(function (r) { if (counts[r.level] != null) counts[r.level]++; });
    var defs = [['all', 'الكل'], ['ok', 'نجاح'], ['info', 'معلومة'], ['warn', 'تحذير'], ['err', 'خطأ']];
    $('logFilters').innerHTML = defs.map(function (d) {
      return '<button class="chip" data-lf="' + d[0] + '" aria-pressed="' + (state.logFilter === d[0]) + '">' +
        d[1] + ' <span class="n">' + counts[d[0]] + '</span></button>';
    }).join('');
    var q = state.logQuery.trim().toLowerCase();
    var rows = state.log.filter(function (r) {
      if (state.logFilter !== 'all' && r.level !== state.logFilter) return false;
      if (q && r.msg.toLowerCase().indexOf(q) < 0) return false;
      return true;
    }).slice().reverse().slice(0, 200);
    $('logList').innerHTML = rows.length ? rows.map(function (r) {
      return '<div class="logrow ' + r.level + '"><span class="tm">' + fmtTime(new Date(r.t)) + '</span>' +
        '<span class="ms">' + esc(r.msg) + '</span></div>';
    }).join('') : '<div class="empty">لا توجد أحداث مطابقة.</div>';
  }

  /* ---------- 15. الإعدادات (واجهة) ---------- */
  function openSettings() {
    $('fServer').value = cfg.server;
    $('fEmail').value = cfg.email;
    $('fPass').value = cfg.password;
    $('fToken').value = cfg.token;
    $('fRefresh').value = Math.round(cfg.refreshMs / 1000);
    $('fZoom').value = cfg.zoom;
    $('fLat').value = cfg.center[0];
    $('fLon').value = cfg.center[1];
    $('fCards').checked = !!cfg.cardsOn;
    $('fAlert').checked = !!cfg.alertOn;
    $('fRadius').value = cfg.alertRadius;
    $('fOffline').checked = !!cfg.offlineCache;
    $('settingsModal').classList.remove('hidden');
  }
  function readSettings() {
    cfg.server = ($('fServer').value || DEFAULTS.server).trim().replace(/\/+$/, '');
    cfg.email = $('fEmail').value.trim();
    cfg.password = $('fPass').value;
    cfg.token = $('fToken').value.trim();
    var r = parseInt($('fRefresh').value, 10);
    cfg.refreshMs = Math.min(120000, Math.max(5000, (isNaN(r) ? 12 : r) * 1000));
    var z = parseInt($('fZoom').value, 10);
    cfg.zoom = Math.min(19, Math.max(8, isNaN(z) ? 14 : z));
    var la = parseFloat($('fLat').value), lo = parseFloat($('fLon').value);
    if (!isNaN(la) && !isNaN(lo)) cfg.center = [la, lo];
    cfg.cardsOn = $('fCards').checked;
    cfg.alertOn = $('fAlert').checked;
    var rad = parseInt($('fRadius').value, 10);
    cfg.alertRadius = Math.min(5000, Math.max(50, isNaN(rad) ? 300 : rad));
    cfg.offlineCache = $('fOffline').checked;
    saveCfg();
  }
  function applyCfg() {
    map.setView(cfg.center, cfg.zoom);
    state.cardMode = cardModeForZoom(map.getZoom());
    $('btnCards').setAttribute('aria-pressed', String(!!cfg.cardsOn));
    renderStation();
    renderMarkers();
    restartTimer();
  }
  function restartTimer() {
    if (state.timer) clearInterval(state.timer);
    state.timer = setInterval(function () { refresh(false); }, cfg.refreshMs);
  }

  /* ---------- 16. محطة التنبيه (واجهة) ---------- */
  function openStation() {
    $('stStatus').classList.add('hidden');
    if (cfg.station) {
      $('fStLat').value = cfg.station.lat;
      $('fStLon').value = cfg.station.lon;
      $('fStName').value = cfg.station.name || '';
      $('fStRad').value = cfg.station.radius || 300;
      $('stStatus').textContent = '✅ محطة مُعيَّنة حاليًا: ' +
        (cfg.station.name || (cfg.station.lat.toFixed(4) + ', ' + cfg.station.lon.toFixed(4)));
      $('stStatus').classList.remove('hidden');
    } else {
      var c = map.getCenter();
      $('fStLat').value = c.lat.toFixed(5);
      $('fStLon').value = c.lng.toFixed(5);
      $('fStName').value = '';
      $('fStRad').value = 300;
    }
    $('stationModal').classList.remove('hidden');
  }

  /* ---------- 17. ربط الواجهة ---------- */
  function wire() {
    $('btnMenu').onclick = function () { $('sidebar').classList.add('open'); $('backdrop').classList.add('show'); };
    $('btnCloseSb').onclick = closeSb;
    $('backdrop').onclick = closeSb;
    function closeSb() { $('sidebar').classList.remove('open'); $('backdrop').classList.remove('show'); }

    $('btnRefresh').onclick = function () { refresh(true); };
    $('btnSettings').onclick = openSettings;
    $('btnDemoSetup').onclick = openSettings;
    $('btnTheme').onclick = toggleTheme;
    $('btnLog').onclick = function () { renderLog(); $('logModal').classList.remove('hidden'); };
    $('btnNear').onclick = locateMe;
    $('btnStation').onclick = openStation;

    $('btnCards').onclick = function () {
      cfg.cardsOn = !cfg.cardsOn; saveCfg();
      state.cardMode = cardModeForZoom(map.getZoom());
      $('btnCards').setAttribute('aria-pressed', String(!!cfg.cardsOn));
      renderMarkers();
      toast(cfg.cardsOn
        ? 'بطاقات المعلومات ظاهرة على الخريطة 🏷️'
        : 'بطاقات المعلومات مخفية — النقاط فقط', 'ok', 2600);
    };

    $('btnFit').onclick = function () {
      if (!state.buses.length) return;
      try {
        var b = L.latLngBounds(state.buses.map(function (x) { return [x.lat, x.lon]; }));
        map.fitBounds(b.pad(0.15));
      } catch (e) {}
    };

    $('btnTrackAll').onclick = function () {
      if (!state.routes || !state.routes.routes) {
        toast('لا توجد مسارات محمّلة لعرضها', 'warn');
        return;
      }
      state.showRoutes = !state.showRoutes;
      routeLayer.clearLayers();
      if (state.showRoutes) {
        state.routes.routes.forEach(function (r) {
          L.polyline(r.pts, { color: '#f0a020', weight: 3, opacity: .5, dashArray: '6 7', interactive: false })
            .addTo(routeLayer).bindTooltip('🛣️ ' + esc(r.name), { sticky: true });
        });
        $('btnTrackAll').classList.add('primary');
        toast('عرض ' + state.routes.routes.length + ' مسارًا', 'ok', 2600);
      } else {
        $('btnTrackAll').classList.remove('primary');
        toast('إخفاء المسارات', 'ok', 2200);
      }
    };

    $('btnExportJson').onclick = exportJson;
    $('btnExportCsv').onclick = exportCsv;

    $('search').addEventListener('input', function (e) { state.query = e.target.value; renderList(); });
    $('chips').addEventListener('click', function (e) {
      var b = e.target.closest('[data-f]'); if (!b) return;
      state.filter = b.getAttribute('data-f'); renderChips(); renderList(); renderStats();
    });
    $('statbar').addEventListener('click', function (e) {
      var b = e.target.closest('[data-f]'); if (!b) return;
      state.filter = b.getAttribute('data-f'); renderChips(); renderList(); renderStats();
    });
    $('sortSel').addEventListener('change', function (e) { state.sort = e.target.value; renderList(); });
    $('lineSel').addEventListener('change', function (e) { state.lineFilter = e.target.value; renderList(); });
    $('buslist').addEventListener('click', function (e) {
      var b = e.target.closest('[data-id]'); if (!b) return;
      selectBus(b.getAttribute('data-id'), true);
      if (window.innerWidth < 900) closeSb();
    });

    $('logSearch').addEventListener('input', function (e) { state.logQuery = e.target.value; renderLog(); });
    $('logFilters').addEventListener('click', function (e) {
      var b = e.target.closest('[data-lf]'); if (!b) return;
      state.logFilter = b.getAttribute('data-lf'); renderLog();
    });
    $('btnClearLog').onclick = function () {
      state.log = []; saveLog(); renderLog(); toast('تم مسح السجل', 'ok');
    };
    $('btnExportLog').onclick = function () {
      var txt = state.log.map(function (r) {
        return new Date(r.t).toISOString() + ' [' + r.level + '] ' + r.msg;
      }).join('\n');
      download('msila-log-' + Date.now() + '.txt', txt);
      toast('تم تصدير السجل', 'ok');
    };

    $('btnUseDefaultToken').onclick = function () {
      $('fToken').value = DEFAULT_TOKEN;
      toast('تم مسح الرمز — اضغط «حفظ الإعدادات» لتطبيق التغيير', 'ok', 3600);
    };

    $('btnSaveCfg').onclick = function () {
      readSettings(); applyCfg();
      $('settingsModal').classList.add('hidden');
      toast('تم حفظ الإعدادات', 'ok');
      log('info', 'حُفظت الإعدادات — الخادم: ' + cfg.server);
      state.mode = 'boot'; state.routes = null;
      refresh(true);
    };

    $('btnTest').onclick = function () {
      readSettings();
      var btn = $('btnTest');
      btn.disabled = true; btn.textContent = '⏳ جارٍ الاختبار…';
      var t0 = Date.now();
      fetchJson(apiUrl('/api/server'), { headers: { 'Accept': 'application/json' } }, 12000)
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          var v = (r.data && r.data.version) || '؟';
          var ms = Date.now() - t0;
          return fetchJson(apiUrl('/api/devices'), { headers: authHeaders(), credentials: 'include' }, 15000)
            .then(function (d) {
              if (d.status === 401) {
                toast('⚠️ الخادم يستجيب (Traccar ' + v + ') لكن الرمز مرفوض (401)', 'warn', 6000);
                log('warn', 'اختبار الاتصال: الخادم يعمل لكن المصادقة فشلت');
              } else if (d.ok && Array.isArray(d.data)) {
                toast('✅ الاتصال ناجح — Traccar ' + v + ' · ' + d.data.length + ' جهازًا (' + ms + ' مللي)', 'ok', 6000);
                log('ok', 'اختبار الاتصال ناجح — Traccar ' + v + ' · ' + d.data.length + ' جهازًا');
              } else {
                toast('⚠️ الخادم يعمل (' + v + ') لكن الأجهزة رجعت HTTP ' + d.status, 'warn', 6000);
                log('warn', 'اختبار الاتصال: HTTP ' + d.status + ' على /api/devices');
              }
            });
        })
        .catch(function (e) {
          toast('❌ فشل الاتصال: ' + (e.message || e), 'err', 5000);
          log('err', 'اختبار الاتصال فشل: ' + (e.message || e));
        })
        .then(function () { btn.disabled = false; btn.textContent = '🔌 اختبار الاتصال'; });
    };

    $('btnStPick').onclick = function () {
      var c = map.getCenter();
      $('fStLat').value = c.lat.toFixed(5);
      $('fStLon').value = c.lng.toFixed(5);
      toast('تم التعيين من مركز الخريطة', 'ok', 2400);
    };
    $('btnStClear').onclick = function () {
      cfg.station = null; saveCfg();
      state.alertFired = {};
      renderStation();
      $('stationModal').classList.add('hidden');
      toast('تم إلغاء محطة التنبيه', 'ok');
      log('info', 'أُلغيت محطة التنبيه');
    };
    $('btnStSave').onclick = function () {
      var la = parseFloat($('fStLat').value), lo = parseFloat($('fStLon').value);
      if (isNaN(la) || isNaN(lo)) { toast('إحداثيات المحطة غير صالحة', 'err'); return; }
      var rad = parseInt($('fStRad').value, 10);
      cfg.station = {
        lat: la, lon: lo,
        name: ($('fStName').value || '').trim() || 'محطة التنبيه',
        radius: Math.min(3000, Math.max(50, isNaN(rad) ? 300 : rad))
      };
      saveCfg();
      state.alertFired = {};
      renderStation();
      $('stationModal').classList.add('hidden');
      map.flyTo([cfg.station.lat, cfg.station.lon], 15, { duration: .6 });
      toast('✅ محطة التنبيه محفوظة — سيصلك تنبيه عند دخول حافلة نطاق ' + cfg.station.radius + ' م', 'ok', 5000);
      log('ok', 'عُيِّنت محطة تنبيه: ' + cfg.station.name + ' (' + cfg.station.lat.toFixed(5) + ', ' + cfg.station.lon.toFixed(5) + ')');
    };

    document.querySelectorAll('[data-close]').forEach(function (b) {
      b.onclick = function () { $(b.getAttribute('data-close')).classList.add('hidden'); };
    });
    document.querySelectorAll('.modal').forEach(function (m) {
      m.addEventListener('click', function (e) { if (e.target === m) m.classList.add('hidden'); });
    });

    document.addEventListener('keydown', function (e) {
      var typing = /input|textarea|select/i.test(document.activeElement.tagName);
      if (e.key === 'Escape') {
        document.querySelectorAll('.modal').forEach(function (m) { m.classList.add('hidden'); });
        closeDetail(); closeSb();
      }
      if ((e.key === 'r' || e.key === 'R') && !typing) refresh(true);
      if ((e.key === 'c' || e.key === 'C') && !typing) $('btnCards').click();
    });

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { if (state.timer) clearInterval(state.timer); }
      else { restartTimer(); refresh(false); }
    });
  }

  function toggleTheme() {
    var cur = document.documentElement.getAttribute('data-theme');
    var next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem(LS_THEME, next); } catch (e) {}
    $('btnTheme').textContent = next === 'dark' ? '🌙' : '☀️';
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', next === 'dark' ? '#0d1117' : '#eef2f6');
    setTiles();
  }

  /* ---------- 18. الإقلاع ---------- */
  function openFromUrl() {
    var m = /[?&]bus=([^&]+)/.exec(location.search);
    if (!m) return false;
    var id = decodeURIComponent(m[1]);
    if (state.byId[id]) {
      setTimeout(function () { selectBus(id, true); toast('تم فتح الحافلة المُشارَكة', 'ok', 3200); }, 500);
      return true;
    }
    return false;
  }

  function boot() {
    var th = 'dark';
    try { th = localStorage.getItem(LS_THEME) || 'dark'; } catch (e) {}
    document.documentElement.setAttribute('data-theme', th);
    $('btnTheme').textContent = th === 'dark' ? '🌙' : '☀️';

    initMap();
    wire();
    renderLog();
    renderStation();
    log('info', 'بدء التشغيل — الخادم: ' + cfg.server);

    state.cardMode = cardModeForZoom(cfg.zoom);
    $('btnCards').setAttribute('aria-pressed', String(!!cfg.cardsOn));

    if (window.innerWidth >= 900) $('sidebar').classList.add('open');

    renderAll();

    refresh(false).then(function () {
      if (state.mode === 'boot') loadRoutes().then(function (r) { startDemo(r); });
      openFromUrl();
      if (state.mode === 'live') log('ok', 'بيانات حقيقية من الخادم — ' + state.buses.length + ' حافلة');
    });

    state.tickTimer = setInterval(tickDemo, 1000);

    if ('serviceWorker' in navigator) {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('sw.js').catch(function () {});
      });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
