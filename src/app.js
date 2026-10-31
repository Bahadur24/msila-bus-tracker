/* ============================================================
   تتبّع حافلات المسيلة — منطق التطبيق (v4)
   ============================================================ */
(function () {
  'use strict';

  /* ---------- 1. الثوابت والحالة ---------- */
  var LS_CFG = 'msila_tracker_cfg_v1';
  var LS_THEME = 'msila_tracker_theme_v1';
  var LS_LOG = 'msila_tracker_log_v1';
  var LS_CACHE = 'msila_tracker_cache_v1';
  var LS_HISTORY = 'msila_tracker_history_v1';
  var LS_STOP_PREFS = 'msila_tracker_stop_prefs_v1';

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
    favoriteAlerts: true,
    favoriteAlertRadius: 700,
    offlineCache: true,
    station: null,
    trackOn: true,
    mapStyle: 'streets', mapLook: 'classic', markerSize: 'normal', labelMode: 'auto',
    performance: 'auto', contrast: false, wideMap: false, showRoutes: false
  };

  var cfg = loadCfg();
  var state = {
    mode: 'boot',          // boot | live | demo | cache
    buses: [],
    byId: {},
    previousPositions: {},
    selected: null,
    filter: 'all',
    query: '',
    sort: 'name',
    lineFilter: 'all',
    myPos: null,
    nearbyDismissed: false,
    lastUpdate: null,
    lastError: null,
    timer: null,
    tickTimer: null,
    routes: null,
    hist: loadHistory(),
    replayIndex: null,
    replayTimer: null,
    historySavedUsable: false,
    alertFired: {},
    log: loadLog(),
    logFilter: 'all',
    logQuery: '',
    cardMode: 'full',
    showRoutes: false,
    cacheAge: null,
    inFlight: null, lastDemoTick: null, tileErrors: 0
  };
  state.historySavedUsable = Object.keys(state.hist).some(function(id) { return state.hist[id] && state.hist[id].length > 1; });

  var COLORS = { moving: '#087f5b', idle: '#b76a08', offline: '#64748b' };
  var LABELS = { moving: 'متحركة', idle: 'متوقفة', offline: 'غير متصلة' };
  var HOUR = 3600 * 1000;
  var themeChoice = 'light';
  var focusReturn = null;
  var listRows = {};
  var MODES = { balanced: 'متوازن', strong: 'أداء قوي', lite: 'خفيف', ultra: 'توفير فائق' };
  var MAP_NAMES = { streets: 'شوارع واضحة', calm: 'أبيض هادئ', night: 'خريطة ليلية', none: 'بلا خلفية' };
  var stopPreferences = loadStopPreferences();
  var stopFavorites = stopPreferences.favorites;
  var stopLabels = stopPreferences.labels;
  var observedStopMarkers = {};

  function effectivePerformance() {
    if (cfg.performance !== 'auto') return cfg.performance;
    var c = navigator.connection || {};
    var memory = Number(navigator.deviceMemory) || 0;
    var cores = Number(navigator.hardwareConcurrency) || 0;
    if (c.saveData || (memory && memory <= 4) || (cores && cores <= 4)) return 'lite';
    if (memory >= 8 && cores >= 8) return 'strong';
    return 'balanced';
  }
  function effectiveRefreshMs() {
    var p = effectivePerformance();
    return Math.max(cfg.refreshMs, p === 'ultra' ? 60000 : p === 'lite' ? 30000 : 5000);
  }
  function demoInterval() {
    var p = effectivePerformance();
    return p === 'ultra' ? 10000 : p === 'lite' ? 5000 : p === 'strong' ? 1000 : 1500;
  }
  function effectiveMapStyle() { return effectivePerformance() === 'ultra' ? 'none' : cfg.mapStyle; }
  function canAnimate() { var p = effectivePerformance(); return (p === 'balanced' || p === 'strong') && !matchMedia('(prefers-reduced-motion: reduce)').matches; }
  function historyEnabled() { var p = effectivePerformance(); return p === 'balanced' || p === 'strong'; }
  function busSvg() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="3" width="14" height="16" rx="3"/><path d="M5 11h14M8 3v8m8-8v8M8 19v2m8-2v2M3 8v4m18-4v4M8 15h1m6 0h1"/></svg>';
  }
  function uiIcon(id) { return '<svg aria-hidden="true"><use href="#i-' + id + '"/></svg>'; }
  function goTo(pos, zoom) {
    if (canAnimate()) map.flyTo(pos, zoom, { duration: .5 });
    else map.setView(pos, zoom, { animate: false });
  }


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
  function estimateBusToTarget(bus, target) {
    if (state.mode !== 'live' || bus.offline || !bus.courseKnown || !bus.lastUpdate || Date.now() - bus.lastUpdate > 120000 || bus.speed < 5) return null;
    var from = [bus.lat, bus.lon], dist = haversine(from, target), direction = bearing(from, target);
    var turn = Math.abs((((direction - bus.brg) + 540) % 360) - 180);
    if (turn > 60 || dist > 30000) return null;
    var mins = dist / (bus.speed * 1000 / 3600) / 60;
    if (mins > 120) return null;
    return { distance: dist, mins: mins };
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
      if (!['auto', 'balanced', 'strong', 'lite', 'ultra'].includes(out.performance)) out.performance = 'auto';
      if (!['streets', 'calm', 'night', 'none'].includes(out.mapStyle)) out.mapStyle = 'streets';
      if (!['classic', 'modern'].includes(out.mapLook)) out.mapLook = 'classic';
      if (!['auto', 'full', 'compact'].includes(out.labelMode)) out.labelMode = 'auto';
      if (!['normal', 'large'].includes(out.markerSize)) out.markerSize = 'normal';
      out.refreshMs = Math.max(5000, Math.min(120000, Number(out.refreshMs) || 12000));
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
    if (!$('logModal').classList.contains('hidden')) renderLog();
  }
  function saveCache() {
    if (!cfg.offlineCache || state.mode !== 'live') return;
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
      if (!o || o.mode !== 'live' || !o.t || !Array.isArray(o.buses) || !o.buses.length) return null;
      o.buses = o.buses.filter(function(b) { return !b.demo && String(b.id).indexOf('demo-') !== 0 && validPosition(b.lat,b.lon); });
      if (!o.buses.length) return null;
      return o;
    } catch (e) { return null; }
  }

  function loadHistory() {
    try {
      var raw = localStorage.getItem(LS_HISTORY), saved = raw ? JSON.parse(raw) : {}, clean = {}, cut = Date.now() - 3600000;
      Object.keys(saved || {}).forEach(function(id) {
        if (!Array.isArray(saved[id]) || String(id).indexOf('demo-') === 0) return;
        clean[id] = saved[id].filter(function(p) { return p && p.t >= cut && validPosition(p.lat, p.lon); }).slice(-180);
      });
      return clean;
    } catch (e) { return {}; }
  }
  function saveHistory() {
    try {
      var compact = {}, cut = Date.now() - HOUR;
      Object.keys(state.hist).forEach(function(id) {
        var points = (state.hist[id] || []).filter(function(p) { return p.t >= cut; }).slice(-180);
        if (points.length > 1) compact[id] = points;
      });
      localStorage.setItem(LS_HISTORY, JSON.stringify(compact));
    } catch (e) {}
  }
  function loadStopPreferences() {
    try {
      var p = JSON.parse(localStorage.getItem(LS_STOP_PREFS) || '{}'), labels = {};
      Object.keys(p.labels || {}).forEach(function(id) {
        var item = p.labels[id];
        if (/^observed-\d+$/.test(id) && item && typeof item.name === 'string') {
          labels[id] = { name: item.name.slice(0, 60), note: String(item.note || '').slice(0, 240) };
        }
      });
      return { favorites: Array.isArray(p.favorites) ? p.favorites.filter(function(id) { return /^observed-\d+$/.test(id); }) : [], labels: labels };
    } catch (e) { return { favorites: [], labels: {} }; }
  }
  function saveStopPreferences() {
    try { localStorage.setItem(LS_STOP_PREFS, JSON.stringify({ favorites: stopFavorites, labels: stopLabels })); } catch (e) {}
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

  /* ---------- 5. الخريطة: only normal viewport tile requests, no prefetch ---------- */
  var map, tileLayer, busLayer, myLayer, routeLayer, histLayer, stLayer, observedStopLayer, expectedStopLayer;
  var markers = {};
  var observedStopData = null, observedStopsVisible = true;
  var expectedStopData = null, expectedStopsVisible = true;
  var expectedStopQuery = '', selectedExpectedStop = null, onlyFavoriteStops = false;
  function initMap() {
    map = L.map('map', {
      center: cfg.center, zoom: cfg.zoom, minZoom: 8, maxZoom: 19,
      zoomControl: false, attributionControl: true, preferCanvas: true,
      zoomAnimation: canAnimate(), fadeAnimation: canAnimate(), markerZoomAnimation: canAnimate(), inertia: canAnimate()
    });
    map.attributionControl.addAttribution('&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors');
    L.control.zoom({position: 'bottomleft', zoomInTitle: 'تكبير الخريطة', zoomOutTitle: 'تصغير الخريطة'}).addTo(map);
    L.control.scale({imperial: false, position: 'bottomleft'}).addTo(map);
    routeLayer = L.layerGroup().addTo(map);
    histLayer = L.layerGroup().addTo(map);
    busLayer = L.layerGroup().addTo(map);
    myLayer = L.layerGroup().addTo(map);
    stLayer = L.layerGroup().addTo(map);
    map.createPane('observedStopsPane');
    map.getPane('observedStopsPane').style.zIndex = '630';
    observedStopLayer = L.layerGroup().addTo(map);
    map.createPane('expectedStopsPane');
    map.getPane('expectedStopsPane').style.zIndex = '620';
    expectedStopLayer = L.layerGroup().addTo(map);
    map.createPane('busesPane');
    map.getPane('busesPane').style.zIndex = '640';
    map.on('zoomend moveend', function() {
      state.cardMode = cardModeForZoom(map.getZoom());
      renderMarkers(); updateMapCount();
    });
    map.on('zoomend', renderExpectedStopMarkers);
    map.on('popupopen', function() { document.body.classList.add('map-popup-open'); });
    map.on('popupclose', function() { document.body.classList.remove('map-popup-open'); });
    setTiles();
  }
  function setTiles(force) {
    var style = effectiveMapStyle();
    var none = style === 'none';
    document.body.classList.toggle('map-no-tiles', none);
    $('noTilesNote').classList.toggle('hidden', !none);
    if (none) {
      if (tileLayer) { map.removeLayer(tileLayer); tileLayer = null; }
      $('tileError').classList.add('hidden');
    } else if (!tileLayer || force) {
      if (tileLayer) map.removeLayer(tileLayer);
      state.tileErrors = 0;
      $('tileError').classList.add('hidden');
      tileLayer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19, detectRetina: false, updateWhenIdle: true,
        updateWhenZooming: false, keepBuffer: effectivePerformance() === 'strong' ? 3 : effectivePerformance() === 'balanced' ? 2 : 0
      });
      tileLayer.on('tileerror', function() {
        state.tileErrors++;
        if (state.tileErrors >= 2) $('tileError').classList.remove('hidden');
      });
      tileLayer.addTo(map);
    }
    if (tileLayer) tileLayer.options.keepBuffer = effectivePerformance() === 'strong' ? 3 : effectivePerformance() === 'balanced' ? 2 : 0;
    applyTileFilter();
    $('mapStyleLabel').textContent = MAP_NAMES[style];
    renderRoutes();
  }
  function applyTileFilter() {
    if (!map) return;
    var style = effectiveMapStyle(), pane = map.getPane('tilePane');
    var modern = cfg.mapLook === 'modern';
    var filter = modern ?
      (style === 'night' ? 'invert(1) hue-rotate(180deg) brightness(.82) contrast(1.08) saturate(.45)' :
       style === 'calm' ? 'grayscale(.84) saturate(.16) brightness(1.06) contrast(.92)' :
       style === 'streets' ? 'grayscale(.38) saturate(.68) brightness(1.035) contrast(.97) hue-rotate(-3deg)' : 'none') :
      (style === 'night' ? 'invert(1) hue-rotate(180deg) brightness(.84) contrast(1.05) saturate(.55)' :
       style === 'calm' ? 'grayscale(.92) saturate(.2) brightness(1.03) contrast(.94)' : 'none');
    if (cfg.contrast) filter = (filter === 'none' ? '' : filter + ' ') + 'contrast(1.12)';
    pane.style.filter = filter;
    renderMapLookControl();
  }
  function renderMapLookControl() {
    var modern = cfg.mapLook === 'modern', button = $('btnMapLook');
    if (!button) return;
    var current = modern ? 'حديثة' : 'كلاسيكية', next = modern ? 'الكلاسيكية' : 'الحديثة';
    $('mapLookText').textContent = 'نسخة ' + current;
    button.setAttribute('aria-pressed', String(modern));
    button.setAttribute('aria-label', 'المظهر الحالي: ' + current + '. اضغط للتبديل إلى النسخة ' + next);
    button.title = 'المظهر الحالي: ' + current + ' — اضغط للتبديل إلى النسخة ' + next;
    document.documentElement.dataset.mapLook = modern ? 'modern' : 'classic';
  }
  function renderRoutes() {
    if (!routeLayer) return;
    routeLayer.clearLayers();
    var forced = effectiveMapStyle() === 'none';
    $('btnTrackAll').setAttribute('aria-pressed', String(cfg.showRoutes || forced));
    $('btnTrackAll').classList.toggle('primary', cfg.showRoutes || forced);
    $('btnTrackAll').disabled = forced;
    if (!state.routes || (!cfg.showRoutes && !forced)) return;
    var col = document.documentElement.dataset.theme === 'dark' ? '#c4a772' : '#9c7947';
    state.routes.routes.forEach(function(r) {
      L.polyline(r.pts, {color: col, weight: forced ? 3 : 2.5, opacity: forced ? .7 : .45,
        dashArray: forced ? null : '6 7', interactive: historyEnabled()})
        .addTo(routeLayer).bindTooltip('هندسة طريق: ' + esc(r.name), {sticky: true, className: 'bustip'});
    });
  }
  function fitBuses() {
    var list = visibleBuses();
    if (!list.length) { toast('لا توجد حافلات مطابقة لعرضها', 'warn'); return; }
    map.fitBounds(L.latLngBounds(list.map(function(b) { return [b.lat, b.lon]; })), {
      paddingTopLeft: [70, 110], paddingBottomRight: [65, window.innerWidth < 1000 ? 140 : 70],
      maxZoom: 16, animate: canAnimate()
    });
  }
  function updateMapCount() {
    var list = visibleBuses(), n = map ? list.filter(function(b) { return map.getBounds().contains([b.lat, b.lon]); }).length : 0;
    $('visibleCount').textContent = n + ' من ' + list.length + ' حافلة على الخريطة';
  }
  function validPosition(lat, lon) {
    return typeof lat === 'number' && typeof lon === 'number' && isFinite(lat) && isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);
  }

  function stopMarkerAnimation(mk) {
    if (mk && mk.__moveAnim) {
      cancelAnimationFrame(mk.__moveAnim.frame);
      mk.__moveAnim = null;
    }
    var el = mk && mk.getElement && mk.getElement();
    if (el) el.classList.remove('bus-marker-moving');
  }
  function moveMarkerTo(mk, lat, lon) {
    var from = mk.getLatLng();
    if (mk.__moveAnim && mk.__moveAnim.target.lat === lat && mk.__moveAnim.target.lon === lon) return;
    if (!mk.__moveAnim && from.lat === lat && from.lng === lon) return;
    if (effectivePerformance() !== 'strong' || !canAnimate() || !window.requestAnimationFrame) {
      stopMarkerAnimation(mk);
      mk.setLatLng([lat, lon]);
      return;
    }
    stopMarkerAnimation(mk);
    from = mk.getLatLng();
    if (from.lat === lat && from.lng === lon) return;
    var started = Date.now(), duration = 900, target = { lat: lat, lon: lon }, anim = { frame: 0 };
    var el = mk.getElement();
    if (el) el.classList.add('bus-marker-moving');
    anim.target = target;
    mk.__moveAnim = anim;
    function step() {
      if (!mk.__moveAnim || !mk._map) { stopMarkerAnimation(mk); return; }
      var t = Math.min(1, (Date.now() - started) / duration), eased = t * (2 - t);
      mk.setLatLng([from.lat + (target.lat - from.lat) * eased, from.lng + (target.lon - from.lng) * eased]);
      if (t < 1) anim.frame = requestAnimationFrame(step);
      else stopMarkerAnimation(mk);
    }
    anim.frame = requestAnimationFrame(step);
  }


  /* ---------- 6. Clear, solid bus badges; filters affect map and list ---------- */
  function cardModeForZoom(z) {
    var p = effectivePerformance();
    if (!cfg.cardsOn || z < 12) return 'dot';
    if (cfg.labelMode === 'full') return 'full';
    if (cfg.labelMode === 'compact' || p === 'lite' || p === 'ultra') return 'mini';
    return z >= (p === 'strong' ? 13 : 14) ? 'full' : 'mini';
  }
  function busIcon(b) {
    var st = statusOf(b), col = COLORS[st], sel = state.selected === b.id;
    var mode = sel ? 'full' : state.cardMode;
    var html;
    if (mode === 'dot' || b._dot) {
      html = '<div class="bus-dot' + (sel ? ' sel' : '') + '" style="--c:' + col + '">' + busSvg() + '</div>';
    } else {
      html = '<div class="bus-pin' + (mode === 'mini' ? ' compact' : '') + (sel ? ' sel' : '') + '" data-status="' + st + '" style="--c:' + col + '">' +
        '<span class="bus-symbol">' + busSvg() + '</span><span class="bus-label"><span class="bus-name"><bdi dir="ltr">' + esc(b.name) + '</bdi></span>' +
        '<span class="bus-meta"><span class="status-dot"></span><span>' + LABELS[st] + '</span>' +
        (st !== 'offline' ? '<span class="speed">' + fmtNum(b.speed, 0) + ' <small>كم/س</small></span>' : '') + '</span></span>' +
        '<span class="bus-direction"><svg viewBox="0 0 20 20" width="15" height="15" style="transform:rotate(' + Math.round(b.brg || 0) + 'deg)" aria-hidden="true"><path d="M10 2 17 17 10 13 3 17Z" fill="currentColor" stroke="white" stroke-width="1.4"/></svg></span>' +
        (b._mg ? '<span class="bus-stack">+' + b._mg + '</span>' : '') + '</div>';
    }
    return L.divIcon({html: html, className: 'bus-marker', iconSize: [0,0], iconAnchor: [0,0]});
  }
  function renderMarkers() {
    if (!map || !busLayer) return;
    var list = visibleBuses().filter(function(b) { return map.getBounds().pad(.15).contains([b.lat,b.lon]); });
    if (state.cardMode === 'dot') {
      Object.keys(markers).forEach(function(id) { stopMarkerAnimation(markers[id]); });
      busLayer.clearLayers(); markers = {};
      var groups = {}, size = 48;
      list.forEach(function(b) {
        var p = map.latLngToContainerPoint([b.lat,b.lon]);
        var key = Math.floor(p.x/size) + '|' + Math.floor(p.y/size);
        (groups[key] = groups[key] || []).push(b);
      });
      Object.keys(groups).forEach(function(key) {
        var g = groups[key], lat = 0, lon = 0;
        g.forEach(function(b) { lat += b.lat; lon += b.lon; }); lat /= g.length; lon /= g.length;
        var one = g[0], col = COLORS[statusOf(one)];
        var html = g.length === 1 ? '<div class="bus-dot" style="--c:' + col + '">' + busSvg() + '</div>' : '<div class="bcluster" style="--c:' + col + '">' + g.length + '</div>';
        var title = g.length === 1 ? one.name + '، ' + LABELS[statusOf(one)] : g.length + ' حافلات متقاربة؛ اضغط للتقريب';
        var mk = L.marker([lat,lon], {pane:'busesPane',icon:L.divIcon({html:html,className:'bus-marker',iconSize:[0,0],iconAnchor:[0,0]}), title:title, alt:title, keyboard:true});
        mk.on('click', function() { if (g.length === 1) selectBus(one.id,true); else goTo([lat,lon],Math.min(19,map.getZoom()+2)); });
        mk.bindTooltip(esc(title), {direction:'top',offset:[0,-20],className:'bustip'}).addTo(busLayer);
      });
      updateMapCount(); return;
    }
    var w = (state.cardMode === 'mini' ? 116 : 150) * (cfg.markerSize === 'large' ? 1.2 : 1);
    var h = (state.cardMode === 'mini' ? 48 : 62) * (cfg.markerSize === 'large' ? 1.2 : 1);
    var ordered = list.slice().sort(function(a,b) {
      if (a.id === state.selected) return -1; if (b.id === state.selected) return 1;
      return (statusOf(a)==='moving'?0:1) - (statusOf(b)==='moving'?0:1);
    });
    var kept = [];
    list.forEach(function(b) { b._dot = false; b._mg = 0; });
    ordered.forEach(function(b) {
      var p = map.latLngToContainerPoint([b.lat,b.lon]), host = null;
      for (var i=0; i<kept.length; i++) if(Math.abs(p.x-kept[i].x)<w && Math.abs(p.y-kept[i].y)<h) {host=kept[i];break;}
      if(host && b.id !== state.selected) {b._dot=true;host.b._mg++;} else kept.push({x:p.x,y:p.y,b:b});
    });
    var seen = {};
    list.forEach(function(b) {
      seen[b.id] = true;
      var ic = busIcon(b), mk = markers[b.id], title = b.name + '، ' + LABELS[statusOf(b)];
      if(!mk) {
        mk = L.marker([b.lat,b.lon], {pane:'busesPane',icon:ic,title:title,alt:title,riseOnHover:true,keyboard:true});
        mk.on('click',function(){selectBus(b.id,true);}); mk.addTo(busLayer); markers[b.id] = mk;
      } else {
        var p = mk.getLatLng(); if(p.lat !== b.lat || p.lng !== b.lon) moveMarkerTo(mk,b.lat,b.lon);
        if(mk.__html !== ic.options.html) mk.setIcon(ic);
      }
      mk.__html = ic.options.html;
      mk.setZIndexOffset(state.selected === b.id ? 10000 : b._dot ? 200 : 0);
      var tooltip = '<b><bdi dir="ltr">' + esc(b.name) + '</bdi></b> · ' + LABELS[statusOf(b)] +
        '<br>' + (b.offline ? 'آخر سرعة مسجلة: ' : '') + fmtNum(b.speed,0) + ' كم/س · ' + compass(b.brg) +
        (b.route ? '<br>' + esc(b.route) : '') + (b.demo ? '<br>حافلة محاكاة — ليست موقعًا حقيقيًا' : b.source==='cache' ? '<br>موقع قديم محفوظ' : '') +
        (b._mg ? '<br>توجد ' + b._mg + ' حافلات قريبة؛ كبّر الخريطة لإظهار أسمائها' : '');
      if(mk.__tip !== tooltip) { if(mk.getTooltip()) mk.setTooltipContent(tooltip); else mk.bindTooltip(tooltip,{direction:'top',offset:[0,-28],className:'bustip'}); mk.__tip=tooltip; }
    });
    Object.keys(markers).forEach(function(id) { if(!seen[id]) {stopMarkerAnimation(markers[id]);busLayer.removeLayer(markers[id]);delete markers[id];} });
    updateMapCount();
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
      icon: L.divIcon({ html: '<div class="stp"></div>', className: 'stmark', iconSize: [22, 22], iconAnchor: [11, 11] }),
      title: s.name || 'محطة التنبيه'
    }).addTo(stLayer).bindTooltip(' ' + esc(s.name || 'محطة التنبيه'), { direction: 'top', offset: [0, -14] });
  }

  function observedBusPhrase(count) {
    var n = Number(count) || 0;
    if (n === 1) return 'حافلة واحدة';
    if (n === 2) return 'حافلتان مختلفتان';
    if (n >= 3 && n <= 10) return fmtNum(n, 0) + ' حافلات مختلفة';
    return fmtNum(n, 0) + ' حافلة مختلفة';
  }

  function observedStopName(stop, index) {
    var saved = stopLabels[stop.id];
    return saved && saved.name ? saved.name : 'موقع توقف متكرر ' + (index + 1);
  }
  function estimatedBusToStop(stop) {
    if (state.mode !== 'live') return null;
    var target = [Number(stop.lat), Number(stop.lon)], best = null;
    state.buses.forEach(function(b) {
      var estimate = estimateBusToTarget(b, target);
      if (estimate && (!best || estimate.mins < best.mins)) best = { bus: b, distance: estimate.distance, mins: estimate.mins };
    });
    return best;
  }

  function observedStopPopup(stop, index) {
    var first = String(stop.first_seen || '').slice(11, 16);
    var last = String(stop.last_seen || '').slice(11, 16);
    var id = String(stop.id || ('observed-' + pad(index + 1)));
    var label = observedStopName(stop, index);
    var isFavorite = stopFavorites.indexOf(id) >= 0;
    var eta = estimatedBusToStop(stop);
    var etaHtml = eta ? '<div class="stop-eta"><b>تقدير تقريبي:</b> الحافلة <bdi dir="ltr">' + esc(eta.bus.name) + '</bdi> قد تصل خلال نحو ' + fmtNum(Math.max(1, Math.round(eta.mins)), 0) + ' د · ' + fmtDist(eta.distance) + ' بخط مستقيم.</div>' : '<div class="stop-eta muted">لا تتوفر الآن إشارة حديثة واتجاه واضح لحافلة متجهة هنا.</div>';
    var longNote = stop.long_dwell_note_ar ? '<div class="stop-caveat">' + esc(stop.long_dwell_note_ar) + '</div>' : '';
    var observation = observedStopData.observation;
    var dateLabel = String(observation.date || '').split('-').reverse().join('/');
    var gapCount = Array.isArray(observation.major_gaps) ? observation.major_gaps.length : 0;
    var failedCount = Number(observation.failed_polls) || 0;
    return '<div class="observed-stop-popup-content" dir="rtl">' +
      '<strong>' + esc(label) + '</strong>' +
      '<div>' + fmtNum(stop.stop_events, 0) + ' وقفة مرصودة من ' + observedBusPhrase(stop.bus_count) + '</div>' +
      '<div>وسيط الوقفة: ' + fmtNum(stop.median_dwell_minutes, 1) + ' د · أطول مكوث: ' + fmtNum(stop.longest_dwell_minutes, 1) + ' د</div>' +
      '<div>الإحداثيات: <bdi dir="ltr">' + Number(stop.lat).toFixed(5) + ', ' + Number(stop.lon).toFixed(5) + '</bdi></div>' +
      etaHtml +
      '<div class="stop-evidence">رصد يوم ' + esc(dateLabel) + ' من ' + esc(first) + ' إلى ' + esc(last) + ' بتوقيت الجزائر. إجمالي العينة: ' + fmtNum(observation.successful_snapshots, 0) + ' قراءة؛ فجوات الرصد الكبيرة: ' + fmtNum(gapCount, 0) + '، والقراءات الفاشلة: ' + fmtNum(failedCount, 0) + '.</div>' +
      '<div class="stop-caveat">تجمّع GPS مرصود وليس محطة رسمية. التقدير خط مستقيم بسرعة واتجاه اللحظة، ولا يراعي الطريق أو الازدحام؛ ليس موعدًا مضمونًا.</div>' +
      '<div class="stop-actions"><button type="button" class="btn sm ' + (isFavorite ? 'primary' : '') + '" data-stop-action="favorite" data-stop-id="' + esc(id) + '" aria-pressed="' + isFavorite + '">' + (isFavorite ? ('★ مفضّل' + (cfg.favoriteAlerts ? ' · تنبيه' : '')) : '☆ أضف للمفضلة') + '</button><button type="button" class="btn sm ghost" data-stop-action="edit" data-stop-id="' + esc(id) + '">تصحيح أو اقتراح اسم</button></div>' +
      longNote + '</div>';
  }

  function renderObservedStops() {
    renderObservedDirectory();
    if (!observedStopLayer) return;
    var openStopId = null;
    Object.keys(observedStopMarkers).some(function(id) {
      if (observedStopMarkers[id].isPopupOpen()) { openStopId = id; return true; }
      return false;
    });
    observedStopLayer.clearLayers();
    observedStopMarkers = {};
    if (!observedStopsVisible || !observedStopData || !Array.isArray(observedStopData.stops)) return;
    observedStopData.stops.forEach(function(stop, index) {
      if (!validPosition(Number(stop.lat), Number(stop.lon))) return;
      var id = String(stop.id || ('observed-' + pad(index + 1)));
      var label = observedStopName(stop, index), isFavorite = stopFavorites.indexOf(id) >= 0;
      var icon = L.divIcon({
        html: '<span class="obs-stop-pin' + (isFavorite ? ' is-favorite' : '') + '" aria-hidden="true"></span>',
        className: 'obs-stop-div', iconSize: [26, 28], iconAnchor: [13, 25]
      });
      var marker = L.marker([Number(stop.lat), Number(stop.lon)], {
        pane: 'observedStopsPane', icon: icon, title: label, alt: label, keyboard: true, riseOnHover: true
      });
      marker.bindTooltip(esc(label) + ' · ' + fmtNum(stop.stop_events, 0) + ' وقفة · ' + observedBusPhrase(stop.bus_count), {
        direction: 'top', offset: [0, -22], className: 'bustip'
      });
      marker.bindPopup(function() { return observedStopPopup(stop, index); }, { maxWidth: 300, className: 'observed-stop-popup' });
      marker.on('popupopen', function(event) {
        var root = event.popup.getElement();
        root.querySelectorAll('[data-stop-action]').forEach(function(button) {
          button.addEventListener('click', function() {
            if (button.dataset.stopAction === 'favorite') toggleStopFavorite(id);
            else openStopCorrection(id);
          });
        });
      });
      marker.addTo(observedStopLayer);
      observedStopMarkers[id] = marker;
    });
    if (openStopId && observedStopMarkers[openStopId]) observedStopMarkers[openStopId].openPopup();
  }

  function loadObservedStops() {
    var button = $('btnObservedStops');
    button.disabled = true;
    fetch('./data/observed_stops.json').then(function(response) {
      if (!response.ok) throw new Error('HTTP_' + response.status);
      return response.json();
    }).then(function(data) {
      if (!data || !data.observation || !Array.isArray(data.stops)) throw new Error('INVALID_STOP_DATA');
      observedStopData = data;
      button.disabled = false;
      button.setAttribute('aria-label', 'إظهار أو إخفاء مواقع التوقف المرصودة (' + data.stops.length + ')');
      button.title = 'إظهار أو إخفاء مواقع التوقف المرصودة (' + data.stops.length + ')';
      renderObservedStops(); renderNearby();
    }).catch(function() {
      log('warn', 'تعذّر تحميل مجموعة مواقع التوقف المرصودة');
    });
  }

  function toggleObservedStops() {
    if (!observedStopData) return;
    observedStopsVisible = !observedStopsVisible;
    $('btnObservedStops').setAttribute('aria-pressed', String(observedStopsVisible));
    renderObservedStops();
    if (observedStopsVisible && observedStopData.stops.length) {
      var bounds = L.latLngBounds(observedStopData.stops.map(function(stop) { return [Number(stop.lat), Number(stop.lon)]; }));
      map.fitBounds(bounds, { paddingTopLeft: [70, 90], paddingBottomRight: [70, 80], maxZoom: 14, animate: canAnimate() });
      toast('أُظهرت مواقع التوقف المتكرر المرصودة', 'ok', 3200);
    } else {
      toast('أُخفيت مواقع التوقف المرصودة', 'ok', 2600);
    }
  }

  function matchesExpectedStop(stop, group) {
    var groups = Array.isArray(stop.groups) ? stop.groups.map(String) : [];
    var query = expectedStopQuery.trim().toLowerCase();
    var searchText = String(stop.label || '') + ' ' + groups.map(function(g) { return 'مجموعة ' + g; }).join(' ');
    return (group === 'all' || groups.indexOf(group) >= 0) && (!query || searchText.toLowerCase().indexOf(query) >= 0);
  }
  function updateStopDirectoryCounts() {
    var expected = expectedStopData && Array.isArray(expectedStopData.stops) ? expectedStopData.stops.length : 0;
    var observed = observedStopData && Array.isArray(observedStopData.stops) ? observedStopData.stops.length : 0;
    $('stopTabCount').textContent = expected + observed;
    $('expectedTypeCount').textContent = expected; $('mapExpectedCount').textContent = expected;
    $('observedTypeCount').textContent = observed; $('mapObservedCount').textContent = observed;
  }
  function expectedStopPopup(stop, index) {
    var groups = Array.isArray(stop.groups) ? stop.groups : [];
    var visits = Number(stop.visits) || 0, dwell = Number(stop.mean_dwell_seconds) || 0;
    return '<div class="expected-popup-content" dir="rtl"><span class="popup-kicker">نقطة متوقعة / افتراضية</span><h3>' + esc(stop.label || ('نقطة متوقعة ' + (index + 1))) + '</h3>' +
      '<div class="stop-group-badges">' + groups.map(function(g) { return '<span>مجموعة ' + esc(g) + '</span>'; }).join('') + '</div>' +
      '<div class="popup-metrics"><div><b>' + visits + '</b><small>زيارات مرصودة</small></div><div><b>' + (dwell ? Math.round(dwell) + ' ث' : '—') + '</b><small>متوسط التوقف</small></div></div>' +
      (stop.confidence ? '<div class="popup-confidence">درجة الثقة <strong>' + esc(stop.confidence) + '</strong></div>' : '') +
      '<div class="stop-caveat">ليست محطة رسمية. تجمّع لإشارات توقف قد يمثل انتظارًا أو ازدحامًا، ولا يؤكد وجود موقف ركاب أو وقت وصول.</div></div>';
  }
  function openExpectedStop(stop, index) {
    if (!stop || !validPosition(Number(stop.lat), Number(stop.lon))) return;
    selectedExpectedStop = index;
    closeDetail(); if (innerWidth < 1000) closeSidebar();
    expectedStopsVisible = true;
    renderExpectedStops();
    map.setView([Number(stop.lat), Number(stop.lon)], Math.max(16, map.getZoom()), {animate: false});
    L.popup({className: 'expected-stop-popup', maxWidth: 290, minWidth: 240, offset: [0, -24], autoPan: true, autoPanPaddingTopLeft: [14, 18], autoPanPaddingBottomRight: [14, innerWidth < 1000 ? (innerHeight < 560 ? 75 : 100) : 24]})
      .setLatLng([Number(stop.lat), Number(stop.lon)]).setContent(expectedStopPopup(stop, index)).openOn(map);
  }
  function renderObservedDirectory() {
    var list = observedStopData && Array.isArray(observedStopData.stops) ? observedStopData.stops : [];
    updateStopDirectoryCounts();
    $('btnOnlyFavorites').setAttribute('aria-pressed', String(onlyFavoriteStops));
    var visible = list.map(function(stop, index) { return {stop:stop, index:index}; }).filter(function(item) {
      return !onlyFavoriteStops || stopFavorites.indexOf(String(item.stop.id)) >= 0;
    });
    $('observedStopList').innerHTML = visible.length ? visible.map(function(item) {
      var stop = item.stop, favorite = stopFavorites.indexOf(String(stop.id)) >= 0;
      return '<button class="observed-point" type="button" data-observed-id="' + esc(stop.id) + '"><span class="observed-point-icon">' + uiIcon('stop') + '</span><span class="ep-main"><span class="ep-title">' + esc(observedStopName(stop, item.index)) + '</span><span class="ep-meta">' + fmtNum(stop.stop_events, 0) + ' وقفة · ' + observedBusPhrase(stop.bus_count) + '</span></span><span class="favorite-indicator' + (favorite ? ' saved' : '') + '" aria-label="' + (favorite ? 'مفضل' : 'غير مفضل') + '">' + (favorite ? '★' : '☆') + '</span></button>';
    }).join('') : '<div class="empty">' + (onlyFavoriteStops ? 'لم تحفظ مواقع مفضلة بعد.<br>افتح موقعًا مرصودًا ثم اختر «أضف للمفضلة».' : 'جارٍ تحميل المواقع المرصودة…') + '</div>';
  }
  function openObservedStopFromDirectory(id) {
    var list = observedStopData && observedStopData.stops || [], stop = list.find(function(item) { return String(item.id) === id; });
    if (!stop) return;
    closeDetail(); if (innerWidth < 1000) closeSidebar();
    if (!observedStopsVisible) { observedStopsVisible = true; $('btnObservedStops').setAttribute('aria-pressed','true'); renderObservedStops(); }
    map.setView([Number(stop.lat),Number(stop.lon)], Math.max(15,map.getZoom()), {animate:false});
    if (observedStopMarkers[id]) observedStopMarkers[id].openPopup();
  }

  function renderExpectedStopMarkers() {
    if (!expectedStopLayer) return;
    expectedStopLayer.clearLayers();
    if (!expectedStopsVisible || !expectedStopData || !Array.isArray(expectedStopData.stops)) return;
    var selector = $('expectedGroupFilter');
    var selectedGroup = selector ? selector.value : 'all';
    var visible = expectedStopData.stops.map(function(stop,index) { return {stop:stop,index:index}; }).filter(function(item) {
      return matchesExpectedStop(item.stop, selectedGroup);
    });
    var points = [];
    visible.forEach(function(item) {
      var lat = Number(item.stop.lat), lon = Number(item.stop.lon);
      if (!validPosition(lat, lon)) return;
      points.push({ stop: item.stop, index: item.index, lat: lat, lon: lon, point: map.latLngToContainerPoint([lat, lon]) });
    });
    var clusters = [], radius = map.getZoom() < 14 ? 100 : map.getZoom() < 15 ? 78 : 54;
    points.forEach(function(item) {
      var host = null, nearest = radius;
      if (map.getZoom() < 16) clusters.forEach(function(cluster) {
        var dx = item.point.x - cluster.x, dy = item.point.y - cluster.y, distance = Math.sqrt(dx * dx + dy * dy);
        if (distance < nearest) { nearest = distance; host = cluster; }
      });
      if (host) {
        host.items.push(item); host.sumLat += item.lat; host.sumLon += item.lon;
        host.lat = host.sumLat / host.items.length; host.lon = host.sumLon / host.items.length;
        host.x = (host.x * (host.items.length - 1) + item.point.x) / host.items.length;
        host.y = (host.y * (host.items.length - 1) + item.point.y) / host.items.length;
      } else clusters.push({ items: [item], lat: item.lat, lon: item.lon, sumLat: item.lat, sumLon: item.lon, x: item.point.x, y: item.point.y });
    });
    clusters.forEach(function(cluster) {
      if (cluster.items.length > 1) {
        var count = cluster.items.length;
        var marker = L.marker([cluster.lat, cluster.lon], {
          pane: 'expectedStopsPane', title: count + ' مواقف حافلات متوقعة/افتراضية',
          icon: L.divIcon({ html: '<span class="ep-cluster" aria-hidden="true">' + uiIcon('bus-stop') + '<b>' + count + '</b></span>', className: 'expected-marker', iconSize: [44, 44], iconAnchor: [22, 22] })
        });
        marker.on('click', function() { goTo([cluster.lat, cluster.lon], Math.min(19, map.getZoom() + 2)); });
        marker.addTo(expectedStopLayer).bindTooltip(count + ' مواقف حافلات متوقعة/افتراضية — ليست محطات رسمية — اضغط للتقريب', { direction: 'top', offset: [0, -24], className: 'bustip' });
        return;
      }
      var item = cluster.items[0], stop = item.stop;
      var groupList = Array.isArray(stop.groups) ? stop.groups.map(function(group) { return 'مجموعة ' + esc(group); }) : [];
      var groups = groupList.length ? groupList.join('، ') : 'مجموعة غير محددة';
      var label = esc(stop.label || ('نقطة متوقعة ' + (item.index + 1)));
      var tip = '<b>' + label + '</b><br>موقف حافلة متوقع/افتراضي — ليس محطة رسمية<br>' + groups + '<br>' + (Number(stop.visits) || 0) + ' رصد' + (stop.confidence ? ' · ثقة ' + esc(stop.confidence) : '');
      var single = L.marker([item.lat, item.lon], {
        pane: 'expectedStopsPane', title: stop.label || 'موقف حافلة متوقع/افتراضي — ليس محطة رسمية',
        icon: L.divIcon({ html: '<span class="ep-waiting' + (selectedExpectedStop === item.index ? ' is-selected' : '') + '" aria-hidden="true">' + uiIcon('bus-stop') + '</span>', className: 'expected-marker', iconSize: [36, 40], iconAnchor: [18, 37] })
      });
      single.on('click', function() { openExpectedStop(stop, item.index); });
      single.addTo(expectedStopLayer).bindTooltip(tip, { direction: 'top', offset: [0, -34], className: 'bustip' });
    });
  }

  function renderExpectedStops() {
    var data = expectedStopData || {}, all = Array.isArray(data.stops) ? data.stops : [];
    var selector = $('expectedGroupFilter'), selectedGroup = selector ? selector.value : 'all', groupSet = {};
    all.forEach(function(stop) { (Array.isArray(stop.groups) ? stop.groups : []).forEach(function(group) { groupSet[String(group)] = true; }); });
    var groups = Object.keys(groupSet).sort(function(a, b) { return a.localeCompare(b, 'ar', { numeric: true }); });
    if (selector) {
      if (selectedGroup !== 'all' && !groupSet[selectedGroup]) selectedGroup = 'all';
      selector.innerHTML = '<option value="all">كل المجموعات</option>' + groups.map(function(group) {
        return '<option value="' + esc(group) + '"' + (selectedGroup === group ? ' selected' : '') + '>مجموعة ' + esc(group) + '</option>';
      }).join('');
      selector.value = selectedGroup;
    }
    var visible = all.map(function(stop, index) { return { stop: stop, index: index }; }).filter(function(item) {
      return matchesExpectedStop(item.stop, selectedGroup);
    });
    $('expectedStopCount').textContent = String(all.length);
    $('expectedResultCount').textContent = visible.length + ' من ' + all.length;
    $('btnExpectedMap').setAttribute('aria-pressed', String(expectedStopsVisible));
    updateStopDirectoryCounts();
    var note = $('expectedStopStatus'), meta = data.observation || {};
    if (data.status === 'complete') {
      var cadence = Number(meta.today_mean_actual_cadence_seconds != null ? meta.today_mean_actual_cadence_seconds : meta.mean_actual_cadence_seconds), maxCadence = Number(meta.today_max_actual_cadence_seconds != null ? meta.today_max_actual_cadence_seconds : meta.max_actual_cadence_seconds), requested = Number(meta.requested_interval_seconds);
      var message = all.length ? 'عُثر على ' + all.length + ' نقطة افتراضية مرشحة' : 'لم تُرصد نقاط تستوفي شروط الترشيح في نافذة الرصد';
      var successfulCycles = meta.today_successful_cycles != null ? meta.today_successful_cycles : meta.successful_cycles;
      var failedCycles = meta.today_failed_cycles != null ? meta.today_failed_cycles : meta.failed_cycles;
      var countsLowerBound = meta.today_cycle_counts_are_lower_bounds === true || meta.cycle_counts_are_lower_bounds === true;
      if (successfulCycles != null) message += ' · ' + (countsLowerBound ? 'على الأقل ' : '') + Number(successfulCycles).toLocaleString('en-US') + ' عينة ناجحة اليوم';
      if (Number(failedCycles) > 0) message += ' · ' + (countsLowerBound ? 'فشل على الأقل ' : 'فشل ') + Number(failedCycles).toLocaleString('en-US') + ' طلبات اليوم';
      if (isFinite(requested) && requested > 0) message += ' · الهدف كل ' + requested.toFixed(0) + ' ث';
      if (isFinite(cadence) && cadence > 0) message += ' · متوسط الفاصل المسجّل اليوم ' + cadence.toFixed(1) + ' ث';
      if (isFinite(maxCadence) && maxCadence > 0) message += ' · أكبر فاصل موثّق اليوم ' + maxCadence.toFixed(1) + ' ث';
      var coverageSeconds = Number(meta.today_coverage_seconds_lower_bound != null ? meta.today_coverage_seconds_lower_bound : (meta.coverage_seconds_lower_bound != null ? meta.coverage_seconds_lower_bound : meta.coverage_seconds));
      var coverageLowerBound = meta.today_coverage_is_lower_bound === true || meta.coverage_is_lower_bound === true;
      if (isFinite(coverageSeconds) && coverageSeconds >= 0) message += ' · تغطية اليوم ' + (coverageLowerBound ? 'لا تقل عن ' : '') + Math.round(coverageSeconds / 60) + ' د';
      if (Number(meta.today_coverage_gap_from_start_seconds) > 0) message += ' · تأخر بدء نافذة اليوم ' + Math.round(meta.today_coverage_gap_from_start_seconds) + ' ث';
      if (Number(meta.inter_segment_gap_seconds) > 0) message += ' · فجوة بين جزأي الرصد ' + Math.round(meta.inter_segment_gap_seconds) + ' ث';
      var minCoverageGap = Number(meta.maximum_coverage_gap_seconds_lower_bound), maxCoverageGap = Number(meta.maximum_coverage_gap_seconds_upper_bound);
      if (isFinite(minCoverageGap) && isFinite(maxCoverageGap) && maxCoverageGap > 0) message += ' · فجوة الاستئناف ' + Math.round(minCoverageGap) + (maxCoverageGap > minCoverageGap ? '–' + Math.round(maxCoverageGap) : '') + ' ث (تقديري)';
      note.textContent = message + '؛ النقاط متوقعة/افتراضية وليست محطات رسمية.';
      note.className = 'note ' + (all.length ? 'ok' : 'warn');
    } else if (data.status === 'collecting') {
      note.textContent = 'الرصد قيد التنفيذ؛ ستُحدَّث القائمة بعد تحليل التوقفات. لا توجد محطات رسمية مضافة هنا.';
      note.className = 'note warn';
    } else {
      note.textContent = 'ستُعرض هنا نقاط الوقوف المتوقعة بعد اكتمال الرصد. هذه نقاط افتراضية وليست محطات رسمية.';
      note.className = 'note warn';
    }
    $('expectedStopList').innerHTML = visible.length ? visible.map(function(item) {
      var stop = item.stop, groupList = Array.isArray(stop.groups) ? stop.groups.map(function(group) { return 'مجموعة ' + esc(group); }) : [], groupsText = groupList.length ? groupList.join('، ') : 'مجموعة غير محددة';
      var visits = Number(stop.visits) || 0, dwell = Number(stop.mean_dwell_seconds) || 0;
      var confidence = stop.confidence ? ' · ثقة ' + esc(stop.confidence) : '';
      return '<button type="button" class="expected-point" aria-pressed="' + (selectedExpectedStop === item.index) + '" data-stop-index="' + item.index + '"><span class="ep-icon" aria-hidden="true">' + uiIcon('bus-stop') + '</span><span class="ep-main"><span class="ep-title">' + esc(stop.label || ('نقطة متوقعة ' + (item.index + 1))) + '</span><span class="ep-meta">' + groupsText + ' · ' + visits + ' رصد' + (dwell ? ' · توقف متوسط ' + Math.round(dwell) + ' ث' : '') + confidence + '</span></span><span class="ep-chevron" aria-hidden="true">‹</span></button>';
    }).join('') : '<div class="empty">لا توجد نقاط ضمن هذه المجموعة.</div>';
    $('btnExpectedToggle').disabled = all.length === 0;
    $('btnExpectedShowAll').disabled = all.length === 0;
    $('btnExpectedToggle').textContent = expectedStopsVisible ? 'إخفاء النقاط' : 'إظهار النقاط';
    $('btnExpectedToggle').setAttribute('aria-pressed', String(expectedStopsVisible));
    renderExpectedStopMarkers();
  }

  function loadExpectedStops() {
    fetch('./expected_stops.json', { cache: 'no-store' }).then(function(response) {
      if (!response.ok) throw new Error('HTTP_' + response.status);
      return response.json();
    }).then(function(data) {
      if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.stops)) throw new Error('INVALID_EXPECTED_STOP_DATA');
      var safeStatuses = ['pending', 'collecting', 'complete'];
      data.status = safeStatuses.indexOf(data.status) >= 0 ? data.status : 'pending';
      data.observation = data.observation && typeof data.observation === 'object' && !Array.isArray(data.observation) ? data.observation : {};
      data.stops = data.stops.filter(function(stop) {
        if (!stop || typeof stop !== 'object' || stop.lat == null || stop.lon == null || !validPosition(Number(stop.lat), Number(stop.lon))) return false;
        stop.groups = Array.isArray(stop.groups) ? stop.groups.map(function(group) { return String(group).trim(); }).filter(function(group) { return /^[0-9]{1,4}$/.test(group); }) : [];
        return true;
      });
      expectedStopData = data;
      renderExpectedStops();
    }).catch(function() {
      expectedStopData = { status: 'pending', stops: [] };
      renderExpectedStops();
    });
  }

  function getObservedStop(id) {
    if (!observedStopData || !Array.isArray(observedStopData.stops)) return null;
    for (var i = 0; i < observedStopData.stops.length; i++) {
      var stop = observedStopData.stops[i];
      if (String(stop.id || ('observed-' + pad(i + 1))) === id) return { stop: stop, index: i };
    }
    return null;
  }
  function toggleStopFavorite(id) {
    var at = stopFavorites.indexOf(id);
    if (at >= 0) stopFavorites.splice(at, 1);
    else {
      stopFavorites.push(id);
      if (cfg.favoriteAlerts && 'Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission().then(function(permission) {
          if (permission === 'granted') toast('ستظهر تنبيهات الاقتراب ما دامت الصفحة مفتوحة.', 'ok');
        }).catch(function() {});
      }
    }
    Object.keys(state.alertFired).forEach(function(key) { if (key.indexOf('fav:' + id + ':') === 0) delete state.alertFired[key]; });
    saveStopPreferences(); renderObservedStops(); renderNearby();
    toast(at >= 0 ? 'أُزيل الموقع من المفضلة' : 'أُضيف الموقع إلى المفضلة', 'ok');
  }
  function openStopCorrection(id) {
    var found = getObservedStop(id);
    if (!found) return;
    var saved = stopLabels[id] || {};
    $('fCorrectionId').value = id;
    $('fCorrectionName').value = saved.name || '';
    $('fCorrectionNote').value = saved.note || '';
    $('stopCorrectionMeta').textContent = 'موقع GPS مرصود ' + (found.index + 1) + ' · ' + Number(found.stop.lat).toFixed(5) + ', ' + Number(found.stop.lon).toFixed(5);
    openModal('stopCorrectionModal');
  }
  function correctionText() {
    var found = getObservedStop($('fCorrectionId').value);
    if (!found) return '';
    return 'اقتراح اسم لموقع توقف GPS مرصود ' + (found.index + 1) + ': ' + $('fCorrectionName').value.trim() +
      ($('fCorrectionNote').value.trim() ? '\nملاحظة: ' + $('fCorrectionNote').value.trim() : '') +
      '\nالإحداثيات: ' + Number(found.stop.lat).toFixed(5) + ', ' + Number(found.stop.lon).toFixed(5);
  }
  function saveStopCorrection() {
    var id = $('fCorrectionId').value, name = $('fCorrectionName').value.trim();
    if (!getObservedStop(id) || !name) { toast('اكتب اسمًا مقترحًا أولًا', 'warn'); return; }
    stopLabels[id] = { name: name.slice(0, 60), note: $('fCorrectionNote').value.trim().slice(0, 240) };
    saveStopPreferences(); renderObservedStops(); renderNearby(); closeModal('stopCorrectionModal');
    toast('حُفظ الاسم على هذا الجهاز فقط', 'ok');
  }
  function renderNearby() {
    var panel = $('nearbyPanel');
    if (!state.myPos || state.nearbyDismissed) { panel.classList.add('hidden'); document.body.classList.remove('has-nearby'); return; }
    var closestBus = null, closestStop = null;
    if (state.mode === 'live') state.buses.forEach(function(b) {
      if (b.offline || !b.lastUpdate || Date.now() - b.lastUpdate > 180000) return;
      var d = haversine(state.myPos, [b.lat, b.lon]);
      if (!closestBus || d < closestBus.distance) closestBus = { bus: b, distance: d };
    });
    if (observedStopData && Array.isArray(observedStopData.stops)) observedStopData.stops.forEach(function(stop, index) {
      var d = haversine(state.myPos, [Number(stop.lat), Number(stop.lon)]);
      if (!closestStop || d < closestStop.distance) closestStop = { stop: stop, index: index, distance: d };
    });
    panel.classList.remove('hidden');
    document.body.classList.add('has-nearby');
    var busHtml = closestBus ? '<button class="nearby-row" type="button" data-near-bus="' + esc(closestBus.bus.id) + '"><span class="nearby-icon bus">' + busSvg() + '</span><span><small>أقرب حافلة حية</small><bdi dir="ltr">' + esc(closestBus.bus.name) + '</bdi><small>' + LABELS[statusOf(closestBus.bus)] + ' · ' + fmtAgo(closestBus.bus.lastUpdate) + '</small></span><strong>' + fmtDist(closestBus.distance) + '</strong></button>' : '<div class="nearby-empty">لا تتوفر حاليًا بيانات حافلات حية قريبة.</div>';
    var stopHtml = closestStop ? '<button class="nearby-row" type="button" data-near-stop="' + esc(String(closestStop.stop.id || ('observed-' + pad(closestStop.index + 1)))) + '"><span class="nearby-icon stop">' + uiIcon('stop') + '</span><span><small>أقرب موقع توقف مرصود</small><b>' + esc(observedStopName(closestStop.stop, closestStop.index)) + '</b><small>رصد GPS متكرر، ليس محطة رسمية</small></span><strong>' + fmtDist(closestStop.distance) + '</strong></button>' : '<div class="nearby-empty">مواقع التوقف المرصودة غير متاحة.</div>';
    panel.innerHTML = '<div class="nearby-heading"><div><span class="eyebrow">حسب موقعك الحالي</span><b>الأقرب إليك</b></div><button type="button" class="nearby-close" aria-label="إخفاء النتائج">×</button></div>' + busHtml + stopHtml + '<div class="nearby-foot">المسافات بخط مستقيم؛ مواقع التوقف مجموعات GPS غير رسمية.</div>';
    panel.querySelector('.nearby-close').onclick = function() { state.nearbyDismissed = true; panel.classList.add('hidden'); document.body.classList.remove('has-nearby'); };
    panel.querySelectorAll('[data-near-bus]').forEach(function(button) { button.onclick = function() { selectBus(button.dataset.nearBus, true); }; });
    panel.querySelectorAll('[data-near-stop]').forEach(function(button) { button.onclick = function() { focusObservedStop(button.dataset.nearStop); }; });
  }
  function focusObservedStop(id) {
    var found = getObservedStop(id);
    if (!found) return;
    if (!observedStopsVisible) { observedStopsVisible = true; $('btnObservedStops').setAttribute('aria-pressed', 'true'); renderObservedStops(); }
    goTo([Number(found.stop.lat), Number(found.stop.lon)], 16);
    setTimeout(function() { if (observedStopMarkers[id]) observedStopMarkers[id].openPopup(); }, 450);
  }

  /* ---------- 7. تتبّع المسار التاريخي ---------- */
  function pushHistory(b) {
    if (!historyEnabled()) return;
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

  function updateReplayControls(h) {
    var slider = $('historyScrub'), label = $('replayTime'), button = $('btnReplayPlay');
    if (!slider || !label || !button) return;
    slider.max = Math.max(0, h.length - 1);
    slider.disabled = h.length < 2;
    var index = state.replayIndex == null ? h.length - 1 : Math.min(state.replayIndex, h.length - 1);
    slider.value = Math.max(0, index);
    label.textContent = h.length ? (state.replayIndex == null ? 'مباشر · ' : 'إعادة · ') + fmtTime(new Date(h[index].t)) : 'بانتظار نقاط حركة';
    button.disabled = h.length < 2;
    button.textContent = state.replayTimer ? 'إيقاف' : (state.replayIndex == null ? '▶ تشغيل المسار' : '▶ إعادة التشغيل');
  }
  function setReplayIndex(index) {
    var h = state.selected ? histOf(state.selected) : [];
    if (!h.length) return;
    state.replayIndex = Math.max(0, Math.min(h.length - 1, Number(index) || 0));
    renderHistory(); updateReplayControls(h);
  }
  function toggleHistoryReplay() {
    var h = state.selected ? histOf(state.selected) : [];
    if (h.length < 2) { toast('اجمع نقاط حركة أكثر أولًا', 'warn'); return; }
    if (state.replayTimer) {
      clearInterval(state.replayTimer); state.replayTimer = null; updateReplayControls(h); return;
    }
    state.replayIndex = 0; setReplayIndex(0);
    state.replayTimer = setInterval(function() {
      var current = histOf(state.selected);
      if (state.replayIndex >= current.length - 1) {
        clearInterval(state.replayTimer); state.replayTimer = null; updateReplayControls(current); return;
      }
      setReplayIndex(state.replayIndex + 1);
    }, 650);
    updateReplayControls(h);
  }
  function stopHistoryReplay() {
    if (state.replayTimer) clearInterval(state.replayTimer);
    state.replayTimer = null; state.replayIndex = null;
  }

  function histOf(id) {
    var h = state.hist[id] || [];
    var cut = Date.now() - HOUR;
    return h.filter(function (p) { return p.t >= cut; });
  }

  function renderHistory() {
    histLayer.clearLayers();
    if (!cfg.trackOn || !state.selected || !historyEnabled()) return;
    var h = histOf(state.selected);
    if (h.length < 2) return;
    var pts = h.map(function (p) { return [p.lat, p.lon]; });
    L.polyline(pts, { color: '#3b82f6', weight: 4, opacity: .35, interactive: false }).addTo(histLayer);
    L.polyline(pts, { color: '#8ab4ff', weight: 2, opacity: .85, dashArray: '7 6', interactive: false }).addTo(histLayer);
    L.circleMarker(pts[0], {
      radius: 5, color: '#8ab4ff', weight: 2, fillColor: '#0d1117', fillOpacity: 1, interactive: false
    }).addTo(histLayer);
    if (state.replayIndex != null && h[state.replayIndex]) {
      var p = h[state.replayIndex];
      L.circleMarker([p.lat, p.lon], { radius: 9, color: '#fff', weight: 3, fillColor: '#e8892f', fillOpacity: 1, interactive: false })
        .addTo(histLayer).bindTooltip('إعادة الحركة · ' + fmtTime(new Date(p.t)), { permanent: false });
    }
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
    state.lastDemoTick = null;
    state.hist = {};
    state.routes = routesData;
    var routes = routesData.routes || [];
    if (!routes.length) routes = fallbackRoutes().routes;

    renderRoutes();

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
    setStatus('demo', 'محاكاة فقط');
    $('demoBar').classList.remove('hidden');
    $('demoBar').classList.remove('cache');
    $('demoTxt').textContent = 'معاينة تجريبية — 14 حافلة محاكاة، وليست مواقع حقيقية. اربط خادمك لتفعيل التتبع.';
    updateChrome();
    log('info', 'تشغيل معاينة ببيانات محاكاة على هندسات طرق OpenStreetMap؛ ليست خطوط نقل رسمية');
    fillLineFilter();
    renderAll();
  }

  function tickDemo() {
    if (state.mode !== 'demo' || document.hidden) return;
    var now = Date.now();
    var elapsed = state.lastDemoTick ? Math.min(10, (now-state.lastDemoTick)/1000) : 1;
    state.lastDemoTick = now;
    state.buses.forEach(function (b, i) {
      var wob = Math.sin(now / 9000 + i * 1.7) * 0.35 + Math.sin(now / 3100 + i) * 0.12;
      b.speed = Math.max(0, b.baseSpeed * (1 + wob));
      var stopPhase = (now / 1000 + i * 13) % 47;
      if (stopPhase < 3.2) b.speed = 0;
      b.dist += (b.speed / 3.6) * elapsed;
      var p = pointAt(b.path, b.dist);
      b.lat = p.lat; b.lon = p.lon; b.brg = p.brg;
      b.lastUpdate = now;
      b.offline = false;
      pushHistory(b);
    });
    state.lastUpdate = now;
    renderMarkers();
    renderList();
    renderStats(); renderChips();
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
      var tok = r.data && (r.data.token || r.data.session);
      if (typeof tok === 'string' && tok) { cfg.token = tok; saveCfg(); }
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
      if (!validPosition(p.latitude, p.longitude)) return;   // إحداثيات غير صالحة (أجهزة بلا قفل GPS)
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
      var spd = (p.speed != null && isFinite(p.speed)) ? Math.max(0, p.speed * 1.852) : 0; // Traccar API: knots to km/h
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
        courseKnown: p.course != null && isFinite(p.course),
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
    state.buses = c.buses.map(function (b) { b.source = 'cache'; b.demo = false; b.offline = true; return b; });
    state.byId = {};
    state.buses.forEach(function (b) { state.byId[b.id] = b; });
    state.lastUpdate = c.t;
    setStatus('cache', 'بيانات مخزَّنة');
    $('demoBar').classList.remove('hidden');
    $('demoBar').classList.add('cache');
    $('demoTxt').textContent = 'وضع بلا اتصال — آخر بيانات محفوظة ' + fmtAgo(c.t) +
      ' (' + state.buses.length + ' حافلة). ليست مواقع مباشرة.';
    updateChrome();
    fillLineFilter();
    renderAll();
    log('warn', 'وضع بلا اتصال — عرض ' + state.buses.length + ' حافلة من الذاكرة (' + reason + ')');
    return true;
  }

  function refresh(manual) {
    if (state.inFlight) return state.inFlight;
    var hasAuth = !!(cfg.token || (cfg.email && cfg.password));
    if (state.mode === 'demo' && !hasAuth) {
      if (manual) { tickDemo(); toast('حُدّثت المحاكاة. اربط بيانات الاتصال لرؤية الحافلات الحقيقية.'); }
      return Promise.resolve();
    }
    var btn = $('btnRefresh'); btn.classList.add('spin'); btn.setAttribute('aria-busy','true');
    state.inFlight = fetchLive().then(function(buses) {
      var fallback = state.mode !== 'live';
      if(fallback) {state.hist=loadHistory();state.alertFired={};}
      var previousPositions = {};
      if (!fallback) state.buses.forEach(function(old) { previousPositions[old.id] = { lat: old.lat, lon: old.lon, t: old.lastUpdate }; });
      state.previousPositions = previousPositions;
      state.mode = 'live'; state.cacheAge = null; state.buses = buses; state.byId={};
      buses.forEach(function(b){state.byId[b.id]=b;});
      state.lastUpdate=Date.now(); state.lastError=null;
      setStatus('live','مباشر · حقيقي'); $('demoBar').classList.add('hidden'); updateChrome();
      fillLineFilter(); buses.forEach(pushHistory); saveCache();
      var hasUsableHistory = Object.keys(state.hist).some(function(id) { return state.hist[id] && state.hist[id].length > 1; });
      if (Date.now() - (state.lastHistorySaved || 0) > 30000 || (!state.historySavedUsable && hasUsableHistory)) {
        saveHistory(); state.lastHistorySaved = Date.now(); state.historySavedUsable = hasUsableHistory;
      }
      renderAll(); renderHistory(); checkProximity();
      if(state.selected && state.byId[state.selected]) renderDetail(); else if(state.selected) closeDetail();
      if(manual || fallback) toast('بيانات حقيقية — ' + buses.length + ' حافلة من الخادم','ok');
      log('ok','تحديث ناجح من الخادم — ' + buses.length + ' حافلة حقيقية');
      if(!state.routes) loadRoutes().then(function(r){state.routes=r;renderRoutes();});
    }).catch(function(e) {
      var msg=String((e&&e.message)||e);
      var friendly=msg==='NO_CREDENTIALS'?'لم تُضبط بيانات الدخول بعد':msg.indexOf('AUTH_')===0?'لم يقبل الخادم بيانات الدخول':msg==='EMPTY'?'لم يُرجع الخادم مواقع حافلات صالحة':'تعذّر الاتصال بخادم التتبع';
      state.lastError=friendly;
      if(msg!=='NO_CREDENTIALS') log('warn',friendly);
      if(useCached(friendly)) {if(manual) toast('تعذّر الاتصال — عُرضت آخر بيانات حقيقية محفوظة','warn');return;}
      if(state.mode!=='demo') return loadRoutes().then(function(r){startDemo(r);if(hasAuth)toast(friendly+' — عُرضت محاكاة واضحة التمييز','warn',4500);});
    }).then(function(){btn.classList.remove('spin');btn.removeAttribute('aria-busy');state.inFlight=null;});
    return state.inFlight;
  }


  function loadRoutes() {
    if (state.routes) return Promise.resolve(state.routes);
    return fetch('msila_routes.json')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (d && d.routes && d.routes.length) {
          log('info', 'حُمّلت ' + d.routes.length + ' هندسات طرق ثابتة من OpenStreetMap');
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
    document.body.dataset.source = kind;
  }
  function updateSubtitle() {
    var n = state.buses.length;
    var t = state.lastUpdate ? fmtTime(new Date(state.lastUpdate)) : '—';
    var extra = state.mode === 'cache' ? ' · مخزَّنة' : state.mode === 'demo' ? ' · تجريبي' : state.mode === 'live' ? ' · مباشر' : '';
    $('subtitle').textContent = n + ' حافلة · آخر تحديث ' + t + extra;
  }

  function renderStats() {
    var counts={moving:0,idle:0,offline:0}, sum=0,n=0,fastest=null;
    state.buses.forEach(function(b){var st=statusOf(b);counts[st]++;if(st!=='offline'){sum+=b.speed||0;n++;}if(!fastest||b.speed>fastest.speed)fastest=b;});
    setBox('sbTotal',state.buses.length);setBox('sbMoving',counts.moving);setBox('sbIdle',counts.idle);setBox('sbOffline',counts.offline);setBox('sbAvg',fmtNum(n?sum/n:0,1));
    setBox('sbFast',fastest?fmtNum(fastest.speed,0):'—');
    ['sbTotal','sbMoving','sbIdle','sbOffline'].forEach(function(id){$(id).setAttribute('aria-pressed',String(state.filter===$(id).dataset.f));});
    $('fleetCount').textContent=state.buses.length; $('dockCount').textContent=state.buses.length;
  }


  function setBox(id, v) {
    var el = $(id);
    if (el) el.querySelector('.sv').textContent = v;
  }
  function cell(cls, ic, k, v) {
    return '<div class="stat ' + cls + '"><span class="k">' + ic + ' ' + k + '</span><span class="v">' + v + '</span></div>';
  }

  function renderChips() {
    var counts={all:state.buses.length,moving:0,idle:0,offline:0};
    state.buses.forEach(function(b){counts[statusOf(b)]++;});
    var defs=[['all','الكل'],['moving','متحركة'],['idle','متوقفة'],['offline','غير متصلة']];
    if(!$('chips').children.length) $('chips').innerHTML=defs.map(function(d){return '<button class="chip" data-f="'+d[0]+'">'+d[1]+' <span class="n"></span></button>';}).join('');
    $('chips').querySelectorAll('[data-f]').forEach(function(b){b.setAttribute('aria-pressed',String(b.dataset.f===state.filter));b.querySelector('.n').textContent=counts[b.dataset.f];});
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
    var list=visibleBuses(), el=$('buslist');
    $('listCount').textContent=list.length+' حافلة';
    if(window.innerWidth<1000 && !$('sidebar').classList.contains('open') && el.children.length && !state.selected) return;
    if(!list.length) {el.innerHTML='<div class="empty">لا توجد حافلات مطابقة.<br>جرّب تغيير التصفية أو البحث.</div>';listRows={};return;}
    var empty=el.querySelector('.empty');if(empty)empty.remove();
    var seen={};
    list.forEach(function(b,i){
      var st=statusOf(b),col=COLORS[st],dist=state.myPos?haversine(state.myPos,[b.lat,b.lon]):null;
      var row=listRows[b.id];
      if(!row){row=document.createElement('button');row.dataset.id=b.id;listRows[b.id]=row;}
      row.className='busrow'+(state.selected===b.id?' sel':'');row.style.setProperty('--c',col);
      row.setAttribute('aria-pressed',String(state.selected===b.id));
      row.setAttribute('aria-label',b.name+'، '+LABELS[st]+(b.demo?'، حافلة محاكاة':''));
      var html='<span class="av">'+busSvg()+'</span><span class="mid"><span class="nm"><bdi dir="ltr">'+esc(b.name)+'</bdi></span><span class="sub"><span style="color:'+col+'">● '+LABELS[st]+'</span>'+
        (dist!==null?'<span>'+fmtDist(dist)+'</span>':'<span>'+compass(b.brg)+'</span>')+(b.line?'<span>الخط '+esc(b.line)+'</span>':'')+'</span><span class="row-time">'+(b.demo?'محاكاة':b.source==='cache'?'موقع محفوظ · '+fmtAgo(b.lastUpdate):fmtAgo(b.lastUpdate))+'</span></span><span class="sp">'+(b.offline?'—':fmtNum(b.speed,0))+'<small>كم/س</small></span>';
      if(row.__html!==html){row.innerHTML=html;row.__html=html;}
      if(el.children[i]!==row)el.insertBefore(row,el.children[i]||null);
      seen[b.id]=true;
    });
    Object.keys(listRows).forEach(function(id){if(!seen[id]){listRows[id].remove();delete listRows[id];}});
  }


  function renderAll() {
    renderStats(); renderChips(); renderList(); renderMarkers(); updateSubtitle(); renderNearby();
  }

  /* ---------- 11. بطاقة التفاصيل ---------- */
  function selectBus(id, fly) {
    var b = state.byId[id];
    if (!b) return;
    if (state.selected !== id) stopHistoryReplay();
    state.selected = id;

    renderDetail();
    $('detail').classList.remove('hidden');
    renderList(); renderMarkers(); renderHistory();
    if (fly) focusBus(b,Math.max(map.getZoom(),15));
  }

  function focusBus(b,z) {
    var target=[b.lat,b.lon];
    if (innerWidth<1000 && !$('detail').classList.contains('hidden')) {
      var stage=$('stage').getBoundingClientRect(),detail=$('detail').getBoundingClientRect(),size=map.getSize(),dx=0,dy=0;
      if (innerWidth>innerHeight) dx=size.x/2-Math.max(70,(detail.left-stage.left)/2);
      else dy=size.y/2-Math.max(45,(detail.top-stage.top)/2);
      target=map.unproject(map.project(target,z).add([dx,dy]),z);
    }
    goTo(target,z);
  }

  function renderDetail() {
    var b = state.byId[state.selected];
    if (!b) { closeDetail(); return; }
    document.body.classList.add('has-detail');
    var st = statusOf(b), col = COLORS[st];
    var dist = state.myPos ? haversine(state.myPos, [b.lat, b.lon]) : null;
    var etaEstimate = state.myPos ? estimateBusToTarget(b, state.myPos) : null;
    var eta = etaEstimate ? (etaEstimate.mins < 1 ? 'أقل من دقيقة' : '~' + Math.round(etaEstimate.mins) + ' دقيقة') : null;
    var h = histOf(b.id);
    var conn = b.demo ? 'محاكاة فقط — لا اتصال حقيقي بهذه الحافلة' : b.offline
      ? '<span style="color:' + COLORS.offline + '">● غير متصلة</span> — آخر إشارة ' + fmtAgo(b.lastUpdate)
      : '<span style="color:' + COLORS.moving + '">● متصلة</span> — تحديث ' + fmtAgo(b.lastUpdate);

    $('detail').style.setProperty('--c', col);
    $('detail').innerHTML =
      '<div class="dh">' +
        '<span class="av">' + busSvg() + '</span>' +
        '<span class="t"><b><bdi dir="ltr">' + esc(b.name) + '</bdi></b>' +
        '<small style="color:' + col + '">● ' + LABELS[st] + (b.line ? ' · الخط ' + esc(b.line) : '') +
        (b.demo ? ' · تجريبي' : '') + (b.source === 'cache' ? ' · مخزَّن' : '') + '</small></span>' +
        '<button class="close" id="btnCloseDetail" aria-label="إغلاق التفاصيل">' + uiIcon('close') + '</button>' +
      '</div>' +
      '<div class="dgrid">' +
        dcell(b.offline ? 'آخر سرعة مسجلة' : 'السرعة الحالية', fmtNum(b.speed, 1) + ' كم/س', false, true) +
        dcell('الاتجاه', fmtNum(b.brg, 0) + '° — ' + compass(b.brg)) +
        (dist != null ? dcell('المسافة مني', fmtDist(dist)) : dcell('المسافة مني', 'حدّد موقعك ')) +
        dcell('تقدير مباشر تقريبي، لا وقت وصول رسمي', b.demo || b.offline ? 'غير متاح' : eta ? eta : (b.speed < 1.5 ? 'متوقفة الآن' : 'غير متاح')) +
        (b.route ? dcell('المسار / الخط', esc(b.route), true) : '') +
        dcell('حالة الاتصال', conn, true) +
        dcell('الإحداثيات', fmtNum(b.lat, 5) + ', ' + fmtNum(b.lon, 5), true) +
        (b.uniqueId ? dcell('المعرّف (IMEI/UID)', esc(b.uniqueId), true) : '') +
        (b.phone ? dcell('هاتف المركبة', esc(b.phone), true) : '') +
        (b.address ? dcell('العنوان', esc(b.address), true) : '') +
      '</div>' +
      (historyEnabled() ? '<div class="trackbox">' +
        '<h4> المسار في آخر ساعة <span style="color:var(--muted);font-weight:600">(' + h.length + ' نقطة)</span></h4>' +
        '<p class="hint">يسجل المسار منذ فتح الموقع فقط، ويُحفظ محليًا على هذا الجهاز لمدة ساعة؛ لا يرسل هذا السجل إلى الخادم.</p>' +
        '<canvas id="miniTrack" width="520" height="192"></canvas>' +
        '<div class="replay-controls"><button type="button" class="btn sm" id="btnReplayPlay">▶ تشغيل المسار</button><input id="historyScrub" type="range" min="0" max="' + Math.max(0, h.length - 1) + '" value="' + Math.max(0, state.replayIndex == null ? h.length - 1 : state.replayIndex) + '" aria-label="موضع إعادة تشغيل حركة الحافلة" ' + (h.length < 2 ? 'disabled' : '') + '><output id="replayTime">بانتظار نقاط حركة</output></div>' +
        '<div class="tracklist" id="trackList"></div>' +
      '</div>' : '<div class="note">السجل التاريخي معطّل في أوضاع توفير الطاقة.</div>') +
      '<div class="btnrow">' +
        '<button class="btn" id="btnCenter"> توسيط</button>' +
        '<button class="btn" id="btnTrackTgl">' + (cfg.trackOn ? ' إخفاء المسار' : ' إظهار المسار') + '</button>' +
        '<button class="btn" id="btnShare"> مشاركة</button>' +
        '<button class="btn ghost" id="btnCopy"> نسخ الإحداثيات</button>' +
      '</div>';

    $('btnCloseDetail').onclick = closeDetail;
    if (!historyEnabled()) { $('btnTrackTgl').disabled = true; $('btnTrackTgl').textContent = 'السجل موقوف'; }
    if (historyEnabled()) {
      $('historyScrub').oninput = function(e) { if (state.replayTimer) { clearInterval(state.replayTimer); state.replayTimer = null; } setReplayIndex(e.target.value); };
      $('btnReplayPlay').onclick = toggleHistoryReplay;
      updateReplayControls(h);
    }
    $('btnCenter').onclick = function () { focusBus(b,16); };
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
    if (pts.length < 2) { ctx.beginPath(); ctx.arc(W/2,H/2,6,0,Math.PI*2); ctx.fillStyle=COLORS[statusOf(b)]; ctx.fill(); if ($('trackList')) $('trackList').textContent='لا توجد نقاط كافية لرسم المسار بعد.'; return; }

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
          return '<div><span>' + (i === 0 ? '⏱ الآن' : fmtAgo(p.t)) + '</span>' +
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
    stopHistoryReplay();
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
    var txt = (b.demo ? 'محاكاة — ليست بيانات حقيقية · ' : b.source === 'cache' ? 'موقع قديم محفوظ · ' : '') + b.name + ' — ' + fmtNum(b.speed, 0) + ' كم/س · ' + LABELS[statusOf(b)] +
      ' · ' + b.lat.toFixed(5) + ',' + b.lon.toFixed(5) + '\n' + u;
    if (navigator.share) {
      navigator.share({ title: 'حافلة ' + b.name, text: txt, url: u }).catch(function () {});
    } else if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(function () { toast('تم نسخ رابط الحافلة ', 'ok'); },
        function () { toast(u, 'ok', 6000); });
    } else { toast(u, 'ok', 6000); }
  }

  /* ---------- 12. الحافلات القريبة والتنبيهات ---------- */
  function locateMe() {
    if (!navigator.geolocation) { toast('متصفحك لا يدعم تحديد الموقع', 'err'); return; }
    navigator.geolocation.getCurrentPosition(function (p) {
      state.myPos = [p.coords.latitude, p.coords.longitude];
      state.nearbyDismissed = false;
      state.sort = 'dist';
      $('sortSel').value = 'dist';
      renderMyPos();
      goTo(state.myPos,15);
      renderList(); renderStats(); renderNearby();
      log('ok', 'تم تحديد الموقع — ' + state.myPos[0].toFixed(5) + ', ' + state.myPos[1].toFixed(5));
    }, function (e) {
      var m = e.code === 1 ? 'تم رفض إذن الموقع' : 'تعذّر تحديد الموقع';
      toast(m, 'err'); log('err', m);
    }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 });
  }

  function checkProximity() {
    if (state.mode !== 'live' || (!state.myPos && !cfg.station && !(cfg.favoriteAlerts && stopFavorites.length))) return;
    state.buses.forEach(function (b) {
      if (b.offline) return;
      if (cfg.alertOn && state.myPos) {
        var d = haversine(state.myPos, [b.lat, b.lon]);
        var k = 'me:' + b.id;
        if (d <= cfg.alertRadius) {
          if (!state.alertFired[k] || Date.now() - state.alertFired[k] > 120000) {
            state.alertFired[k] = Date.now();
            beep('me');
            toast(' ' + b.name + ' على بعد ' + fmtDist(d) + ' منك!', 'warn', 5000);
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
            toast(' ' + b.name + ' وصلت محطة ' + (cfg.station.name || 'التنبيه') + ' (' + fmtDist(ds) + ')', 'warn', 6000);
            log('warn', 'تنبيه محطة: ' + b.name + ' — ' + fmtDist(ds) + ' من ' + (cfg.station.name || 'المحطة'));
          }
        } else if (state.alertFired[ks] && ds > rad * 1.6) { delete state.alertFired[ks]; }
      }
      if (cfg.favoriteAlerts && stopFavorites.length) {
        var previous = state.previousPositions[b.id] || null;
        stopFavorites.slice().forEach(function(id) {
          var found = getObservedStop(id);
          if (!found) return;
          var target = [Number(found.stop.lat), Number(found.stop.lon)], dFav = haversine(target, [b.lat, b.lon]);
          var previousDistance = previous ? haversine(target, [previous.lat, previous.lon]) : null;
          var approaching = previousDistance != null && previousDistance > dFav + 12 && !!estimateBusToTarget(b, target);
          var favKey = 'fav:' + id + ':' + b.id, radius = cfg.favoriteAlertRadius || 700;
          if (dFav <= radius && approaching && (!state.alertFired[favKey] || Date.now() - state.alertFired[favKey] > 300000)) {
            state.alertFired[favKey] = Date.now();
            var stopName = observedStopName(found.stop, found.index);
            beep('station');
            toast('الحافلة ' + b.name + ' تقترب من ' + stopName + ' · ' + fmtDist(dFav), 'warn', 6500);
            if ('Notification' in window && Notification.permission === 'granted') {
              try { new Notification('حافلة تقترب من موقعك المفضّل', { body: b.name + ' · ' + stopName + ' · ' + fmtDist(dFav) }); } catch (e) {}
            }
            log('warn', 'تنبيه مفضلة: ' + b.name + ' تقترب من ' + stopName + ' — ' + fmtDist(dFav));
          } else if (state.alertFired[favKey] && dFav > radius * 1.6) delete state.alertFired[favKey];
        });
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

  /* ---------- 15. Settings and independent local display preferences ---------- */
  function openModal(id) {
    focusReturn=document.activeElement;
    $(id).classList.remove('hidden');
    var close=$(id).querySelector('[data-close]');if(close)close.focus({preventScroll:true});
  }
  function closeModal(id) {
    $(id).classList.add('hidden');
    if(focusReturn && focusReturn.isConnected)focusReturn.focus({preventScroll:true});
  }
  function openSettings() {
    $('fServer').value=cfg.server;$('fEmail').value=cfg.email;$('fPass').value=cfg.password;$('fToken').value=cfg.token;
    $('fRefresh').value=Math.round(cfg.refreshMs/1000);$('fZoom').value=cfg.zoom;$('fLat').value=cfg.center[0];$('fLon').value=cfg.center[1];
    $('fCards').checked=!!cfg.cardsOn;$('fAlert').checked=!!cfg.alertOn;$('fRadius').value=cfg.alertRadius;$('fOffline').checked=!!cfg.offlineCache;
    $('fFavAlerts').checked=!!cfg.favoriteAlerts;$('fFavRadius').value=cfg.favoriteAlertRadius || 700;
    openModal('settingsModal');
  }
  function settingsCandidate() {
    var out=Object.assign({},cfg), url;
    try {
      url=new URL(($('fServer').value||DEFAULTS.server).trim());
      if(url.protocol!=='https:' && !(url.protocol==='http:' && /^(localhost|127\.0\.0\.1)$/.test(url.hostname)))throw Error();
      if(url.username||url.password||url.search||url.hash)throw Error();
    }catch(e){toast('أدخل رابط خادم HTTPS صحيحًا دون بيانات دخول أو معاملات ضمن الرابط','err');return null;}
    out.server=url.href.replace(/\/+$/,'');out.email=$('fEmail').value.trim();out.password=$('fPass').value;out.token=$('fToken').value.trim();
    out.refreshMs=Math.min(120000,Math.max(5000,(parseInt($('fRefresh').value,10)||12)*1000));
    out.zoom=Math.min(19,Math.max(8,parseInt($('fZoom').value,10)||14));
    var la=parseFloat($('fLat').value),lo=parseFloat($('fLon').value);
    if(!validPosition(la,lo)){toast('مركز الخريطة غير صالح','err');return null;}
    out.center=[la,lo];out.cardsOn=$('fCards').checked;out.alertOn=$('fAlert').checked;
    out.alertRadius=Math.min(5000,Math.max(50,parseInt($('fRadius').value,10)||300));out.offlineCache=$('fOffline').checked;
    out.favoriteAlerts=$('fFavAlerts').checked;out.favoriteAlertRadius=Math.min(5000,Math.max(100,parseInt($('fFavRadius').value,10)||700));
    return out;
  }
  function readSettings() {var out=settingsCandidate();if(!out)return false;cfg=out;saveCfg();return true;}
  function applyCfg() {
    map.setView(cfg.center,cfg.zoom,{animate:false});
    state.cardMode=cardModeForZoom(map.getZoom());$('btnCards').setAttribute('aria-pressed',String(cfg.cardsOn));
    renderStation();renderMarkers();restartTimer();
  }
  function restartTimer() {
    clearInterval(state.timer);clearInterval(state.tickTimer);state.timer=null;state.tickTimer=null;
    if(document.hidden)return;
    state.timer=setInterval(function(){refresh(false);},effectiveRefreshMs());
    state.lastDemoTick=Date.now();
    state.tickTimer=setInterval(tickDemo,demoInterval());
  }
  function updateChrome() {
    var h=$('appChrome').getBoundingClientRect().height;
    document.documentElement.style.setProperty('--chrome-height',h+'px');
    if(map)map.invalidateSize({animate:false,pan:false});
  }
  function setTheme(choice, persist) {
    themeChoice=['light','dark','system'].includes(choice)?choice:'light';
    var actual=themeChoice==='system'?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):themeChoice;
    document.documentElement.dataset.theme=actual;
    if(persist!==false)try{localStorage.setItem(LS_THEME,themeChoice);}catch(e){}
    $('btnTheme').innerHTML=uiIcon(actual==='dark'?'sun':'moon');
    $('btnTheme').setAttribute('aria-label',actual==='dark'?'التبديل إلى الوضع الفاتح':'التبديل إلى الوضع الداكن');
    document.querySelector('meta[name="theme-color"]').content=actual==='dark'?'#111d21':'#f3f6f5';
    if(map){renderRoutes();renderMarkers();}
    renderDisplayControls();
  }
  function renderDisplayControls() {
    document.querySelectorAll('[data-theme-choice]').forEach(function(b){b.setAttribute('aria-pressed',String(b.dataset.themeChoice===themeChoice));});
    document.querySelectorAll('[data-map-style]').forEach(function(b){b.setAttribute('aria-pressed',String(b.dataset.mapStyle===effectiveMapStyle()));});
    document.querySelectorAll('[data-performance-choice]').forEach(function(b){b.setAttribute('aria-pressed',String(b.dataset.performanceChoice===cfg.performance));});
    $('fMarkerSize').value=cfg.markerSize;$('fLabelMode').value=cfg.labelMode;$('fContrast').checked=cfg.contrast;
    $('fRoutes').checked=cfg.showRoutes||effectiveMapStyle()==='none';$('fRoutes').disabled=effectiveMapStyle()==='none';
    var p=effectivePerformance(),prefix=cfg.performance==='auto'?'تلقائي · ':'';
    $('performanceBadge').textContent=prefix+MODES[p];
    $('performanceSummary').textContent=(cfg.performance==='auto'?'المفعّل تلقائيًا: '+MODES[p]+'. ':'')+'تحديث البيانات الحقيقية كل '+Math.round(effectiveRefreshMs()/1000)+' ثانية، والمحاكاة كل '+(demoInterval()/1000)+' ثوانٍ. '+(p==='strong'?'حركة أكثر سلاسة للعلامات والخريطة، دون زيادة طلبات البيانات. ':p==='ultra'?'لا تُنزّل صور خريطة. ':p==='lite'?'بلا حركات أو سجل مسار تاريخي. ':'')+'تتوقف التحديثات والمحاكاة عند إخفاء الصفحة.';
    $('btnFocus').setAttribute('aria-pressed',String(cfg.wideMap));$('btnWideMap').setAttribute('aria-pressed',String(cfg.wideMap));
    $('btnWideMap').innerHTML=uiIcon('expand')+(cfg.wideMap?'إعادة قائمة الحافلات':'توسيع الخريطة');
    $('btnCards').setAttribute('aria-pressed',String(cfg.cardsOn));
  }
  function applyDisplay() {
    var p=effectivePerformance(),root=document.documentElement;
    root.dataset.performance=p;root.dataset.markerSize=cfg.markerSize;root.dataset.contrast=cfg.contrast?'strong':'normal';
    document.body.classList.toggle('focus-map',!!cfg.wideMap);
    if(!historyEnabled())state.hist={};else if(!Object.keys(state.hist).length)state.hist=loadHistory();
    if(map){map.options.inertia=canAnimate();map.options.fadeAnimation=canAnimate();map.options.zoomAnimation=canAnimate();setTiles();state.cardMode=cardModeForZoom(map.getZoom());renderMarkers();renderHistory();if(state.selected)renderDetail();}
    saveCfg();renderDisplayControls();restartTimer();
    setTimeout(updateChrome,40);
  }
  function openDisplay() {renderDisplayControls();openModal('displayModal');}
  function toggleTheme() {setTheme(document.documentElement.dataset.theme==='dark'?'light':'dark');}
  function toggleFocus() {cfg.wideMap=!cfg.wideMap;applyDisplay();}
  function setSidebarView(view) {
    var stops = view === 'stops';
    $('sidebar').dataset.view = stops ? 'stops' : 'fleet';
    $('fleetView').classList.toggle('hidden', stops); $('stopsView').classList.toggle('hidden', !stops);
    $('tabFleet').setAttribute('aria-selected', String(!stops)); $('tabStops').setAttribute('aria-selected', String(stops));
    $('tabFleet').tabIndex = stops ? -1 : 0; $('tabStops').tabIndex = stops ? 0 : -1;
    $('sidebarTitle').textContent = stops ? 'دليل نقاط الوقوف' : 'استكشف الحافلات';
    $('fleetCount').classList.toggle('hidden', stops);
    $('btnFleetDock').setAttribute('aria-pressed', String(!stops && $('sidebar').classList.contains('open')));
    $('btnStopsDock').setAttribute('aria-pressed', String(stops && $('sidebar').classList.contains('open')));
    if (!stops) renderList();
  }
  function setStopType(type) {
    var observed = type === 'observed';
    $('expectedStopsFold').classList.toggle('hidden', observed); $('observedDirectory').classList.toggle('hidden', !observed);
    $('typeExpected').setAttribute('aria-pressed', String(!observed)); $('typeObserved').setAttribute('aria-pressed', String(observed));
  }
  function openSidebar(view) {
    if (typeof view === 'string') setSidebarView(view);
    if(window.innerWidth>=1000 && cfg.wideMap){cfg.wideMap=false;applyDisplay();}
    $('sidebar').classList.add('open');$('backdrop').classList.add('show');document.body.classList.add('sidebar-open');
    $('btnMenu').setAttribute('aria-expanded','true');setSidebarView($('sidebar').dataset.view);renderList();
  }
  function closeSidebar() {$('sidebar').classList.remove('open');$('backdrop').classList.remove('show');document.body.classList.remove('sidebar-open');$('btnMenu').setAttribute('aria-expanded','false');$('btnFleetDock').setAttribute('aria-pressed','false');$('btnStopsDock').setAttribute('aria-pressed','false');}
  function filtersChanged() {
    if(state.selected && !visibleBuses().some(function(b){return b.id===state.selected;}))closeDetail();
    renderAll();
  }
  function testConnection() {
    var candidate=settingsCandidate();if(!candidate)return;
    var btn=$('btnTest');btn.disabled=true;btn.textContent='جارٍ الاختبار…';
    var base=candidate.server;
    fetchJson(base+'/api/server',{headers:{Accept:'application/json'}},12000).then(function(r){
      if(!r.ok)throw Error('SERVER');
      if(!candidate.token && !(candidate.email&&candidate.password)){toast('الخادم يستجيب. أضف رمزًا أو بيانات دخول لاختبار الأجهزة.','warn',5000);return null;}
      if(candidate.token)return candidate.token;
      return fetchJson(base+'/api/session',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'email='+encodeURIComponent(candidate.email)+'&password='+encodeURIComponent(candidate.password),credentials:'include'},15000).then(function(a){if(!a.ok)throw Error('AUTH');return a.data&&(a.data.token||a.data.session)||null;});
    }).then(function(token){
      if(!candidate.token && !(candidate.email&&candidate.password))return;
      var headers={Accept:'application/json'};if(token)headers.Authorization='Bearer '+token;
      return fetchJson(base+'/api/devices',{headers:headers,credentials:'include'},15000).then(function(r){if(!r.ok)throw Error('AUTH');if(!Array.isArray(r.data))throw Error('DATA');toast('الاتصال ناجح — '+r.data.length+' جهازًا. اضغط حفظ لتفعيل الاتصال.','ok',5000);log('ok','اختبار اتصال ناجح دون حفظ النموذج');});
    }).catch(function(e){toast(e.message==='AUTH'?'الخادم يستجيب لكنه لم يقبل بيانات الدخول.':'تعذّر الاختبار؛ تحقق من الرابط والإنترنت وسياسة CORS.','err',5000);log('warn','تعذّر اختبار الاتصال');}).then(function(){btn.disabled=false;btn.textContent='اختبار الاتصال';});
  }


  /* ---------- 16. محطة التنبيه (واجهة) ---------- */
  function openStation() {
    $('stStatus').classList.add('hidden');
    if (cfg.station) {
      $('fStLat').value = cfg.station.lat;
      $('fStLon').value = cfg.station.lon;
      $('fStName').value = cfg.station.name || '';
      $('fStRad').value = cfg.station.radius || 300;
      $('stStatus').textContent = ' محطة مُعيَّنة حاليًا: ' +
        (cfg.station.name || (cfg.station.lat.toFixed(4) + ', ' + cfg.station.lon.toFixed(4)));
      $('stStatus').classList.remove('hidden');
    } else {
      var c = map.getCenter();
      $('fStLat').value = c.lat.toFixed(5);
      $('fStLon').value = c.lng.toFixed(5);
      $('fStName').value = '';
      $('fStRad').value = 300;
    }
    openModal('stationModal');
  }

  /* ---------- 17. UI events ---------- */
  function wire() {
    $('btnMenu').onclick=function(){openSidebar();};$('btnFleetDock').onclick=function(){openSidebar('fleet');};$('btnStopsDock').onclick=function(){openSidebar('stops');};$('btnCloseSb').onclick=closeSidebar;$('backdrop').onclick=closeSidebar;
    $('tabFleet').onclick=function(){setSidebarView('fleet');};$('tabStops').onclick=function(){setSidebarView('stops');};
    document.querySelector('.sidebar-tabs').onkeydown=function(e){if(['ArrowLeft','ArrowRight','Home','End'].indexOf(e.key)<0)return;e.preventDefault();var tabs=['tabFleet','tabStops'],index=$('tabFleet').getAttribute('aria-selected')==='true'?0:1,rtl=document.documentElement.dir==='rtl',delta=(e.key==='ArrowLeft'?1:-1)*(rtl?1:-1),next=e.key==='Home'?0:e.key==='End'?tabs.length-1:(index+delta+tabs.length)%tabs.length;setSidebarView(next===1?'stops':'fleet');$(tabs[next]).focus();};
    $('typeExpected').onclick=function(){setStopType('expected');};$('typeObserved').onclick=function(){setStopType('observed');};
    $('btnOnlyFavorites').onclick=function(){onlyFavoriteStops=!onlyFavoriteStops;renderObservedDirectory();};
    $('observedStopList').onclick=function(e){var row=e.target.closest('[data-observed-id]');if(row)openObservedStopFromDirectory(row.dataset.observedId);};
    $('stopSearch').oninput=function(e){expectedStopQuery=e.target.value;renderExpectedStops();};
    $('btnExpectedMap').onclick=function(){expectedStopsVisible=!expectedStopsVisible;renderExpectedStops();};
    if(innerWidth<1000)$('mapLegend').open=false;
    $('btnRefresh').onclick=function(){refresh(true);};$('btnSettings').onclick=openSettings;$('btnDemoSetup').onclick=openSettings;$('btnTheme').onclick=toggleTheme;
    ['btnDisplay','btnMapDisplay','btnDisplayDock','performanceBadge'].forEach(function(id){$(id).onclick=openDisplay;});
    ['btnNear','btnMapLocate','btnLocateDock'].forEach(function(id){$(id).onclick=locateMe;});
    ['btnFit','btnMapFit','btnFitDock'].forEach(function(id){$(id).onclick=fitBuses;});
    $('btnObservedStops').onclick=toggleObservedStops;
    $('expectedGroupFilter').onchange=renderExpectedStops;
    $('btnExpectedToggle').onclick=function(){expectedStopsVisible=!expectedStopsVisible;renderExpectedStops();};
    $('btnExpectedShowAll').onclick=function(){
      expectedStopsVisible=true;$('expectedGroupFilter').value='all';renderExpectedStops();
      var stops=expectedStopData&&Array.isArray(expectedStopData.stops)?expectedStopData.stops:[];
      var points=stops.map(function(stop){return [Number(stop.lat),Number(stop.lon)];}).filter(function(point){return validPosition(point[0],point[1]);});
      if(points.length===1)goTo(points[0],16);
      else if(points.length>1)map.fitBounds(L.latLngBounds(points).pad(.18),{maxZoom:16,animate:canAnimate()});
      else toast('لا توجد نقاط متوقعة لعرضها بعد','warn',2800);
    };
    $('btnFocus').onclick=toggleFocus;$('btnWideMap').onclick=toggleFocus;
    $('btnMapLook').onclick=function(){cfg.mapLook=cfg.mapLook==='modern'?'classic':'modern';applyDisplay();toast(cfg.mapLook==='modern'?'فُعّل المظهر الحديث؛ يمكنك العودة إلى الكلاسيكي في أي وقت':'عادت ألوان الخريطة الكلاسيكية','ok');};
    $('btnRetryTiles').onclick=function(){setTiles(true);};
    $('btnFullscreen').disabled=!document.documentElement.requestFullscreen;
    $('btnFullscreen').onclick=function(){var job=document.fullscreenElement?document.exitFullscreen():document.documentElement.requestFullscreen();if(job&&job.catch)job.catch(function(){toast('ملء الشاشة غير متاح في هذا المتصفح','warn');});};
    document.addEventListener('fullscreenchange',function(){$('btnFullscreen').innerHTML=uiIcon('expand')+(document.fullscreenElement?'الخروج من ملء الشاشة':'ملء الشاشة');updateChrome();});
    $('btnLog').onclick=function(){renderLog();openModal('logModal');};$('btnStation').onclick=openStation;
    $('btnCards').onclick=function(){cfg.cardsOn=!cfg.cardsOn;saveCfg();state.cardMode=cardModeForZoom(map.getZoom());renderDisplayControls();renderMarkers();toast(cfg.cardsOn?'تفاصيل الحافلات ظاهرة':'رموز الحافلات فقط — لم تُخفَ مواقعها');};
    $('btnTrackAll').onclick=function(){cfg.showRoutes=!cfg.showRoutes;saveCfg();if(!state.routes)loadRoutes().then(function(r){state.routes=r;renderRoutes();});else renderRoutes();renderDisplayControls();};
    $('btnExportJson').onclick=exportJson;$('btnExportCsv').onclick=exportCsv;
    $('search').addEventListener('input',function(e){state.query=e.target.value;filtersChanged();});
    ['chips','statbar'].forEach(function(id){$(id).onclick=function(e){var b=e.target.closest('[data-f]');if(!b)return;state.filter=b.dataset.f;filtersChanged();};});
    $('sortSel').onchange=function(e){state.sort=e.target.value;if(state.sort==='dist'&&!state.myPos)toast('حدّد موقعك أولًا للترتيب حسب القرب');renderList();};
    $('lineSel').onchange=function(e){state.lineFilter=e.target.value;filtersChanged();};
    $('buslist').onclick=function(e){var row=e.target.closest('[data-id]');if(!row)return;selectBus(row.dataset.id,true);if(innerWidth<1000)closeSidebar();};
    $('expectedStopList').onclick=function(e){var row=e.target.closest('[data-stop-index]');if(!row||!expectedStopData)return;var index=Number(row.dataset.stopIndex);openExpectedStop(expectedStopData.stops[index],index);};
    $('logSearch').oninput=function(e){state.logQuery=e.target.value;renderLog();};
    $('logFilters').onclick=function(e){var b=e.target.closest('[data-lf]');if(b){state.logFilter=b.dataset.lf;renderLog();}};
    $('btnClearLog').onclick=function(){state.log=[];saveLog();renderLog();toast('تم مسح السجل','ok');};
    $('btnExportLog').onclick=function(){download('msila-log-'+Date.now()+'.txt',state.log.map(function(r){return new Date(r.t).toISOString()+' ['+r.level+'] '+r.msg;}).join('\n'));};
    $('btnUseDefaultToken').onclick=function(){$('fToken').value='';toast('مُسح الحقل. اضغط حفظ الاتصال لتطبيق التغيير.');};
    $('btnUseCurrentView').onclick=function(){var c=map.getCenter();$('fLat').value=c.lat.toFixed(5);$('fLon').value=c.lng.toFixed(5);$('fZoom').value=map.getZoom();toast('نُسخ مركز الخريطة الحالي إلى الحقول');};
    $('btnSaveCfg').onclick=function(){if(state.inFlight){toast('انتظر اكتمال التحديث الجاري ثم احفظ الاتصال','warn');return;}if(!readSettings())return;applyCfg();closeModal('settingsModal');toast('حُفظت إعدادات الاتصال محليًا','ok');log('info','حُفظت إعدادات الاتصال محليًا');state.mode='boot';refresh(true);};
    $('btnSaveCorrection').onclick=saveStopCorrection;
    $('btnCopyCorrection').onclick=function(){var text=correctionText();if(text)copyText(text,'نُسخ اقتراح الاسم');};
    $('btnTest').onclick=testConnection;
    document.querySelectorAll('[data-theme-choice]').forEach(function(b){b.onclick=function(){setTheme(b.dataset.themeChoice);};});
    document.querySelectorAll('[data-map-style]').forEach(function(b){b.onclick=function(){cfg.mapStyle=b.dataset.mapStyle;if(effectivePerformance()==='ultra'&&cfg.mapStyle!=='none'){cfg.performance='lite';toast('فُعّل الوضع الخفيف لإعادة صور الخريطة');}applyDisplay();};});
    document.querySelectorAll('[data-performance-choice]').forEach(function(b){b.onclick=function(){cfg.performance=b.dataset.performanceChoice;applyDisplay();};});
    $('fMarkerSize').onchange=function(e){cfg.markerSize=e.target.value;applyDisplay();};$('fLabelMode').onchange=function(e){cfg.labelMode=e.target.value;applyDisplay();};
    $('fContrast').onchange=function(e){cfg.contrast=e.target.checked;applyDisplay();};$('fRoutes').onchange=function(e){cfg.showRoutes=e.target.checked;applyDisplay();};
    $('btnResetDisplay').onclick=function(){['mapStyle','mapLook','markerSize','labelMode','performance','contrast','wideMap','showRoutes','cardsOn'].forEach(function(k){cfg[k]=DEFAULTS[k];});setTheme('light');applyDisplay();toast('استُعيد العرض الافتراضي؛ لم تتغير بيانات الاتصال','ok');};
    $('btnStPick').onclick=function(){var c=map.getCenter();$('fStLat').value=c.lat.toFixed(5);$('fStLon').value=c.lng.toFixed(5);toast('نُسخ مركز الخريطة');};
    $('btnStClear').onclick=function(){cfg.station=null;saveCfg();state.alertFired={};renderStation();closeModal('stationModal');toast('أُلغيت محطة التنبيه','ok');};
    $('btnStSave').onclick=function(){var la=parseFloat($('fStLat').value),lo=parseFloat($('fStLon').value);if(!validPosition(la,lo)){toast('إحداثيات المحطة غير صالحة','err');return;}cfg.station={lat:la,lon:lo,name:$('fStName').value.trim()||'محطة التنبيه',radius:Math.min(3000,Math.max(50,parseInt($('fStRad').value,10)||300))};saveCfg();state.alertFired={};renderStation();closeModal('stationModal');goTo([la,lo],15);toast(state.mode==='live'?'حُفظت محطة التنبيه':'حُفظت المحطة؛ التنبيهات تعمل مع البيانات الحقيقية فقط','ok',4500);};
    document.querySelectorAll('[data-close]').forEach(function(b){b.onclick=function(){closeModal(b.dataset.close);};});
    document.querySelectorAll('.modal').forEach(function(m){m.onclick=function(e){if(e.target===m)closeModal(m.id);};});
    document.addEventListener('keydown',function(e){
      var modal=document.querySelector('.modal:not(.hidden)');
      if(e.key==='Escape'){if(modal)closeModal(modal.id);else{closeDetail();closeSidebar();}return;}
      if(modal&&e.key==='Tab'){
        var items=Array.from(modal.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,a[href]')).filter(function(el){return el.getClientRects().length;});
        var first=items[0],last=items[items.length-1];
        if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}return;
      }
      var typing=/input|textarea|select/i.test(document.activeElement.tagName);
      if(!typing&&!modal){if(e.key.toLowerCase()==='r')refresh(true);if(e.key.toLowerCase()==='c')$('btnCards').click();}
    });
    document.addEventListener('visibilitychange',function(){restartTimer();if(!document.hidden){state.lastDemoTick=Date.now();if(state.mode==='demo')tickDemo();else refresh(false);}});
    window.addEventListener('resize',function(){updateChrome();if(innerWidth>=1000)closeSidebar();});
    window.addEventListener('online',function(){if(!document.hidden&&(cfg.token||(cfg.email&&cfg.password)))refresh(false);});
    var mq=matchMedia('(prefers-color-scheme: dark)');if(mq.addEventListener)mq.addEventListener('change',function(){if(themeChoice==='system')setTheme('system',false);});
    if(navigator.connection&&navigator.connection.addEventListener)navigator.connection.addEventListener('change',function(){if(cfg.performance==='auto')applyDisplay();});
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
    try{themeChoice=localStorage.getItem(LS_THEME)||'light';}catch(e){}
    setTheme(themeChoice,false);
    document.documentElement.dataset.performance=effectivePerformance();
    initMap();wire();renderStation();loadObservedStops();loadExpectedStops();
    if(window.ResizeObserver)new ResizeObserver(updateChrome).observe($('appChrome'));
    updateChrome();applyDisplay();renderAll();
    log('info','بدء تشغيل الواجهة — لم تُضمّن أي بيانات دخول في التطبيق');
    refresh(false).then(openFromUrl);
    if('serviceWorker' in navigator){
      var register=function(){navigator.serviceWorker.register('sw.js').catch(function(){});};
      if(document.readyState==='complete')register();else window.addEventListener('load',register,{once:true});
    }
  }


  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
