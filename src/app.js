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
    trackOn: true,
    mapStyle: 'streets', markerSize: 'normal', labelMode: 'auto',
    performance: 'auto', contrast: false, wideMap: false, showRoutes: false
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
    cacheAge: null,
    inFlight: null, lastDemoTick: null, tileErrors: 0
  };

  var COLORS = { moving: '#087f5b', idle: '#b76a08', offline: '#64748b' };
  var LABELS = { moving: 'متحركة', idle: 'متوقفة', offline: 'غير متصلة' };
  var HOUR = 3600 * 1000;
  var themeChoice = 'light';
  var focusReturn = null;
  var listRows = {};
  var MODES = { balanced: 'متوازن', strong: 'أداء قوي', lite: 'خفيف', ultra: 'توفير فائق' };
  var MAP_NAMES = { streets: 'شوارع واضحة', calm: 'أبيض هادئ', night: 'خريطة ليلية', none: 'بلا خلفية' };

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
  var map, tileLayer, busLayer, myLayer, routeLayer, histLayer, stLayer;
  var markers = {};
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
    map.on('zoomend moveend', function() {
      state.cardMode = cardModeForZoom(map.getZoom());
      renderMarkers(); updateMapCount();
    });
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
    var filter = style === 'night' ? 'invert(1) hue-rotate(180deg) brightness(.84) contrast(1.05) saturate(.55)' :
      style === 'calm' ? 'grayscale(.92) saturate(.2) brightness(1.03) contrast(.94)' : 'none';
    if (cfg.contrast) filter = (filter === 'none' ? '' : filter + ' ') + 'contrast(1.12)';
    pane.style.filter = filter;
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
        var mk = L.marker([lat,lon], {icon:L.divIcon({html:html,className:'bus-marker',iconSize:[0,0],iconAnchor:[0,0]}), title:title, alt:title, keyboard:true});
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
        mk = L.marker([b.lat,b.lon], {icon:ic,title:title,alt:title,riseOnHover:true,keyboard:true});
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
      if(fallback) {state.hist={};state.alertFired={};}
      state.mode = 'live'; state.cacheAge = null; state.buses = buses; state.byId={};
      buses.forEach(function(b){state.byId[b.id]=b;});
      state.lastUpdate=Date.now(); state.lastError=null;
      setStatus('live','مباشر · حقيقي'); $('demoBar').classList.add('hidden'); updateChrome();
      fillLineFilter(); buses.forEach(pushHistory); saveCache(); renderAll(); renderHistory(); checkProximity();
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
    renderStats(); renderChips(); renderList(); renderMarkers(); updateSubtitle();
  }

  /* ---------- 11. بطاقة التفاصيل ---------- */
  function selectBus(id, fly) {
    var b = state.byId[id];
    if (!b) return;
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
    var eta = dist != null ? fmtEta(dist, b.speed) : null;
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
        '<canvas id="miniTrack" width="520" height="192"></canvas>' +
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
    toast('جارٍ تحديد موقعك…');
    navigator.geolocation.getCurrentPosition(function (p) {
      state.myPos = [p.coords.latitude, p.coords.longitude];
      state.sort = 'dist';
      $('sortSel').value = 'dist';
      renderMyPos();
      goTo(state.myPos,15);
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
    if (state.mode !== 'live' || (!state.myPos && !cfg.station)) return;
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
    document.querySelector('meta[name="theme-color"]').content=actual==='dark'?'#111821':'#f7f9fc';
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
    if(!historyEnabled())state.hist={};
    if(map){map.options.inertia=canAnimate();map.options.fadeAnimation=canAnimate();map.options.zoomAnimation=canAnimate();setTiles();state.cardMode=cardModeForZoom(map.getZoom());renderMarkers();renderHistory();if(state.selected)renderDetail();}
    saveCfg();renderDisplayControls();restartTimer();
    setTimeout(updateChrome,40);
  }
  function openDisplay() {renderDisplayControls();openModal('displayModal');}
  function toggleTheme() {setTheme(document.documentElement.dataset.theme==='dark'?'light':'dark');}
  function toggleFocus() {cfg.wideMap=!cfg.wideMap;applyDisplay();}
  function openSidebar() {
    if(window.innerWidth>=1000 && cfg.wideMap){cfg.wideMap=false;applyDisplay();}
    $('sidebar').classList.add('open');$('backdrop').classList.add('show');document.body.classList.add('sidebar-open');
    $('btnMenu').setAttribute('aria-expanded','true');renderList();
  }
  function closeSidebar() {$('sidebar').classList.remove('open');$('backdrop').classList.remove('show');document.body.classList.remove('sidebar-open');$('btnMenu').setAttribute('aria-expanded','false');}
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
    $('btnMenu').onclick=openSidebar;$('btnFleetDock').onclick=openSidebar;$('btnCloseSb').onclick=closeSidebar;$('backdrop').onclick=closeSidebar;
    $('btnRefresh').onclick=function(){refresh(true);};$('btnSettings').onclick=openSettings;$('btnDemoSetup').onclick=openSettings;$('btnTheme').onclick=toggleTheme;
    ['btnDisplay','btnMapDisplay','btnDisplayDock','performanceBadge'].forEach(function(id){$(id).onclick=openDisplay;});
    ['btnNear','btnMapLocate','btnLocateDock'].forEach(function(id){$(id).onclick=locateMe;});
    ['btnFit','btnMapFit','btnFitDock'].forEach(function(id){$(id).onclick=fitBuses;});
    $('btnFocus').onclick=toggleFocus;$('btnWideMap').onclick=toggleFocus;
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
    $('logSearch').oninput=function(e){state.logQuery=e.target.value;renderLog();};
    $('logFilters').onclick=function(e){var b=e.target.closest('[data-lf]');if(b){state.logFilter=b.dataset.lf;renderLog();}};
    $('btnClearLog').onclick=function(){state.log=[];saveLog();renderLog();toast('تم مسح السجل','ok');};
    $('btnExportLog').onclick=function(){download('msila-log-'+Date.now()+'.txt',state.log.map(function(r){return new Date(r.t).toISOString()+' ['+r.level+'] '+r.msg;}).join('\n'));};
    $('btnUseDefaultToken').onclick=function(){$('fToken').value='';toast('مُسح الحقل. اضغط حفظ الاتصال لتطبيق التغيير.');};
    $('btnUseCurrentView').onclick=function(){var c=map.getCenter();$('fLat').value=c.lat.toFixed(5);$('fLon').value=c.lng.toFixed(5);$('fZoom').value=map.getZoom();toast('نُسخ مركز الخريطة الحالي إلى الحقول');};
    $('btnSaveCfg').onclick=function(){if(state.inFlight){toast('انتظر اكتمال التحديث الجاري ثم احفظ الاتصال','warn');return;}if(!readSettings())return;applyCfg();closeModal('settingsModal');toast('حُفظت إعدادات الاتصال محليًا','ok');log('info','حُفظت إعدادات الاتصال محليًا');state.mode='boot';refresh(true);};
    $('btnTest').onclick=testConnection;
    document.querySelectorAll('[data-theme-choice]').forEach(function(b){b.onclick=function(){setTheme(b.dataset.themeChoice);};});
    document.querySelectorAll('[data-map-style]').forEach(function(b){b.onclick=function(){cfg.mapStyle=b.dataset.mapStyle;if(effectivePerformance()==='ultra'&&cfg.mapStyle!=='none'){cfg.performance='lite';toast('فُعّل الوضع الخفيف لإعادة صور الخريطة');}applyDisplay();};});
    document.querySelectorAll('[data-performance-choice]').forEach(function(b){b.onclick=function(){cfg.performance=b.dataset.performanceChoice;applyDisplay();};});
    $('fMarkerSize').onchange=function(e){cfg.markerSize=e.target.value;applyDisplay();};$('fLabelMode').onchange=function(e){cfg.labelMode=e.target.value;applyDisplay();};
    $('fContrast').onchange=function(e){cfg.contrast=e.target.checked;applyDisplay();};$('fRoutes').onchange=function(e){cfg.showRoutes=e.target.checked;applyDisplay();};
    $('btnResetDisplay').onclick=function(){['mapStyle','markerSize','labelMode','performance','contrast','wideMap','showRoutes','cardsOn'].forEach(function(k){cfg[k]=DEFAULTS[k];});setTheme('light');applyDisplay();toast('استُعيد العرض الافتراضي؛ لم تتغير بيانات الاتصال','ok');};
    $('btnStPick').onclick=function(){var c=map.getCenter();$('fStLat').value=c.lat.toFixed(5);$('fStLon').value=c.lng.toFixed(5);toast('نُسخ مركز الخريطة');};
    $('btnStClear').onclick=function(){cfg.station=null;saveCfg();state.alertFired={};renderStation();closeModal('stationModal');toast('أُلغيت محطة التنبيه','ok');};
    $('btnStSave').onclick=function(){var la=parseFloat($('fStLat').value),lo=parseFloat($('fStLon').value);if(!validPosition(la,lo)){toast('إحداثيات المحطة غير صالحة','err');return;}cfg.station={lat:la,lon:lo,name:$('fStName').value.trim()||'محطة التنبيه',radius:Math.min(3000,Math.max(50,parseInt($('fStRad').value,10)||300))};saveCfg();state.alertFired={};renderStation();closeModal('stationModal');goTo([la,lo],15);toast(state.mode==='live'?'حُفظت محطة التنبيه':'حُفظت المحطة؛ التنبيهات تعمل مع البيانات الحقيقية فقط','ok',4500);};
    document.querySelectorAll('[data-close]').forEach(function(b){b.onclick=function(){closeModal(b.dataset.close);};});
    document.querySelectorAll('.modal').forEach(function(m){m.onclick=function(e){if(e.target===m)closeModal(m.id);};});
    document.addEventListener('keydown',function(e){
      var modal=document.querySelector('.modal:not(.hidden)');
      if(e.key==='Escape'){if(modal)closeModal(modal.id);else{closeDetail();closeSidebar();}return;}
      if(modal&&e.key==='Tab'){
        var items=Array.from(modal.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),summary,a[href]')).filter(function(el){return el.getClientRects().length;});
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
    initMap();wire();renderStation();
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
