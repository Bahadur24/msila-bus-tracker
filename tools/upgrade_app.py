from pathlib import Path
import re
source = Path('/workspace/msila-bus-tracker/src/app.js').read_text()
s = source

def replace(old, new):
    global s
    assert old in s, old[:120]
    s = s.replace(old, new, 1)

def block(start, end, text):
    global s
    a = s.index(start)
    b = s.index(end, a)
    s = s[:a] + text + '\n\n' + s[b:]

replace('منطق التطبيق (v3)', 'منطق التطبيق (v4)')
replace('    trackOn: true\n', "    trackOn: true,\n    mapStyle: 'streets', markerSize: 'normal', labelMode: 'auto',\n    performance: 'auto', contrast: false, wideMap: false, showRoutes: false\n")
replace('    cacheAge: null\n', '    cacheAge: null,\n    inFlight: null, lastDemoTick: null, tileErrors: 0\n')
replace("var COLORS = { moving: '#2ea043', idle: '#d29922', offline: '#e5534b' };", "var COLORS = { moving: '#087f5b', idle: '#b76a08', offline: '#64748b' };")
replace('  var HOUR = 3600 * 1000;', r'''  var HOUR = 3600 * 1000;
  var themeChoice = 'light';
  var focusReturn = null;
  var listRows = {};
  var MODES = { balanced: 'متوازن', lite: 'خفيف', ultra: 'توفير فائق' };
  var MAP_NAMES = { streets: 'شوارع واضحة', calm: 'أبيض هادئ', night: 'خريطة ليلية', none: 'بلا خلفية' };

  function effectivePerformance() {
    if (cfg.performance !== 'auto') return cfg.performance;
    var c = navigator.connection || {};
    return c.saveData || (navigator.deviceMemory && navigator.deviceMemory <= 4) ||
      (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4) ? 'lite' : 'balanced';
  }
  function effectiveRefreshMs() {
    var p = effectivePerformance();
    return Math.max(cfg.refreshMs, p === 'ultra' ? 60000 : p === 'lite' ? 30000 : 5000);
  }
  function demoInterval() {
    var p = effectivePerformance();
    return p === 'ultra' ? 10000 : p === 'lite' ? 5000 : 1500;
  }
  function effectiveMapStyle() { return effectivePerformance() === 'ultra' ? 'none' : cfg.mapStyle; }
  function canAnimate() { return effectivePerformance() === 'balanced' && !matchMedia('(prefers-reduced-motion: reduce)').matches; }
  function busSvg() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="3" width="14" height="16" rx="3"/><path d="M5 11h14M8 3v8m8-8v8M8 19v2m8-2v2M3 8v4m18-4v4M8 15h1m6 0h1"/></svg>';
  }
  function uiIcon(id) { return '<svg aria-hidden="true"><use href="#i-' + id + '"/></svg>'; }
  function goTo(pos, zoom) {
    if (canAnimate()) map.flyTo(pos, zoom, { duration: .5 });
    else map.setView(pos, zoom, { animate: false });
  }
''')
replace('      return out;\n', r'''      if (!['auto', 'balanced', 'lite', 'ultra'].includes(out.performance)) out.performance = 'auto';
      if (!['streets', 'calm', 'night', 'none'].includes(out.mapStyle)) out.mapStyle = 'streets';
      if (!['auto', 'full', 'compact'].includes(out.labelMode)) out.labelMode = 'auto';
      if (!['normal', 'large'].includes(out.markerSize)) out.markerSize = 'normal';
      out.refreshMs = Math.max(5000, Math.min(120000, Number(out.refreshMs) || 12000));
      return out;
''')
replace('    renderLog();\n  }\n  function saveCache', "    if (!$('logModal').classList.contains('hidden')) renderLog();\n  }\n  function saveCache")
replace('    if (!cfg.offlineCache) return;', "    if (!cfg.offlineCache || state.mode !== 'live') return;")
replace('      if (!o || !o.buses || !o.buses.length) return null;', "      if (!o || o.mode !== 'live' || !o.t || !Array.isArray(o.buses) || !o.buses.length) return null;\n      o.buses = o.buses.filter(function(b) { return !b.demo && String(b.id).indexOf('demo-') !== 0 && validPosition(b.lat,b.lon); });\n      if (!o.buses.length) return null;")
block('  /* ---------- 5. الخريطة ---------- */', '  /* ---------- 6. بطاقات الحافلات على الخريطة ---------- */', r'''  /* ---------- 5. الخريطة: only normal viewport tile requests, no prefetch ---------- */
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
        updateWhenZooming: false, keepBuffer: effectivePerformance() === 'balanced' ? 2 : 0
      });
      tileLayer.on('tileerror', function() {
        state.tileErrors++;
        if (state.tileErrors >= 2) $('tileError').classList.remove('hidden');
      });
      tileLayer.addTo(map);
    }
    if (tileLayer) tileLayer.options.keepBuffer = effectivePerformance() === 'balanced' ? 2 : 0;
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
        dashArray: forced ? null : '6 7', interactive: effectivePerformance() === 'balanced'})
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
    $('visibleCount').textContent = n + ' / ' + list.length + ' حافلة على الخريطة';
  }
  function validPosition(lat, lon) {
    return typeof lat === 'number' && typeof lon === 'number' && isFinite(lat) && isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);
  }
''')
block('  /* ---------- 6. بطاقات الحافلات على الخريطة ---------- */', '  function renderMyPos() {', r'''  /* ---------- 6. Clear, solid bus badges; filters affect map and list ---------- */
  function cardModeForZoom(z) {
    if (!cfg.cardsOn || z < 12) return 'dot';
    if (cfg.labelMode === 'full') return 'full';
    if (cfg.labelMode === 'compact' || effectivePerformance() !== 'balanced') return 'mini';
    return z >= 14 ? 'full' : 'mini';
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
    var w = (state.cardMode === 'mini' ? 99 : 132) * (cfg.markerSize === 'large' ? 1.2 : 1);
    var h = (state.cardMode === 'mini' ? 43 : 56) * (cfg.markerSize === 'large' ? 1.2 : 1);
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
        var p = mk.getLatLng(); if(p.lat !== b.lat || p.lng !== b.lon) mk.setLatLng([b.lat,b.lon]);
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
    Object.keys(markers).forEach(function(id) { if(!seen[id]) {busLayer.removeLayer(markers[id]);delete markers[id];} });
    updateMapCount();
  }
''')
replace('  function pushHistory(b) {\n', "  function pushHistory(b) {\n    if (effectivePerformance() !== 'balanced') return;\n")
replace('    if (!cfg.trackOn || !state.selected) return;', "    if (!cfg.trackOn || !state.selected || effectivePerformance() !== 'balanced') return;")
a = s.index('    routeLayer.clearLayers();', s.index('  function startDemo('))
b = s.index('    var buses = [];', a)
s = s[:a] + '    renderRoutes();\n\n' + s[b:]
replace("    state.mode = 'demo';\n", "    state.mode = 'demo';\n    state.lastDemoTick = null;\n    state.hist = {};\n")
replace("    setStatus('demo', 'وضع تجريبي');", "    setStatus('demo', 'محاكاة فقط');")
replace("    $('demoTxt').textContent = 'وضع تجريبي — لا اتصال بالخادم · ' + routes.length + ' مسارات حقيقية';", "    $('demoTxt').textContent = 'معاينة تجريبية — 14 حافلة محاكاة، وليست مواقع حقيقية. اربط خادمك لتفعيل التتبع.';\n    updateChrome();")
replace("    log('warn', 'تشغيل الوضع التجريبي — ' + routes.length + ' مسارًا حقيقيًا، ' + buses.length + ' حافلة محاكاة');", "    log('info', 'تشغيل معاينة ببيانات محاكاة على هندسات طرق OpenStreetMap؛ ليست خطوط نقل رسمية');")
replace("    if (state.mode !== 'demo') return;\n    var now = Date.now();", "    if (state.mode !== 'demo' || document.hidden) return;\n    var now = Date.now();\n    var elapsed = state.lastDemoTick ? Math.min(10, (now-state.lastDemoTick)/1000) : 1;\n    state.lastDemoTick = now;")
replace('      b.dist += (b.speed / 3.6) * 1.0;', '      b.dist += (b.speed / 3.6) * elapsed;')
replace('    renderStats();\n    updateSubtitle();', '    renderStats(); renderChips();\n    updateSubtitle();')
replace('      if (p.latitude === 0 && p.longitude === 0) return;', '      if (!validPosition(p.latitude, p.longitude)) return;')
replace("var spd = (p.speed != null) ? p.speed * 3.6 : 0;   // عقدة → كم/س", "var spd = (p.speed != null && isFinite(p.speed)) ? Math.max(0, p.speed * 1.852) : 0; // Traccar API: knots to km/h")
replace("state.buses = c.buses.map(function (b) { b.source = 'cache'; b.demo = false; return b; });", "state.buses = c.buses.map(function (b) { b.source = 'cache'; b.demo = false; b.offline = true; return b; });")
replace("      ' (' + state.buses.length + ' حافلة) · ' + reason;", "      ' (' + state.buses.length + ' حافلة). ليست مواقع مباشرة.';\n    updateChrome();")
block('  function refresh(manual) {', '  function loadRoutes() {', r'''  function refresh(manual) {
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
''')
replace("return fetch('msila_routes.json', { cache: 'no-cache' })", "return fetch('msila_routes.json')")
replace("log('info', 'حُمّلت ' + d.routes.length + ' مسارًا حقيقيًا من OpenStreetMap');", "log('info', 'حُمّلت ' + d.routes.length + ' هندسات طرق ثابتة من OpenStreetMap');")
replace("    $('statusTxt').textContent = txt;", "    $('statusTxt').textContent = txt;\n    document.body.dataset.source = kind;")
block('  function renderStats() {', '  function setBox(id, v) {', r'''  function renderStats() {
    var counts={moving:0,idle:0,offline:0}, sum=0,n=0,fastest=null;
    state.buses.forEach(function(b){var st=statusOf(b);counts[st]++;if(st!=='offline'){sum+=b.speed||0;n++;}if(!fastest||b.speed>fastest.speed)fastest=b;});
    setBox('sbTotal',state.buses.length);setBox('sbMoving',counts.moving);setBox('sbIdle',counts.idle);setBox('sbOffline',counts.offline);setBox('sbAvg',fmtNum(n?sum/n:0,1));
    setBox('sbFast',fastest?fmtNum(fastest.speed,0):'—');
    ['sbTotal','sbMoving','sbIdle','sbOffline'].forEach(function(id){$(id).setAttribute('aria-pressed',String(state.filter===$(id).dataset.f));});
    $('fleetCount').textContent=state.buses.length; $('dockCount').textContent=state.buses.length;
  }
''')
block('  function renderChips() {', '  function fillLineFilter() {', r'''  function renderChips() {
    var counts={all:state.buses.length,moving:0,idle:0,offline:0};
    state.buses.forEach(function(b){counts[statusOf(b)]++;});
    var defs=[['all','الكل'],['moving','متحركة'],['idle','متوقفة'],['offline','غير متصلة']];
    if(!$('chips').children.length) $('chips').innerHTML=defs.map(function(d){return '<button class="chip" data-f="'+d[0]+'">'+d[1]+' <span class="n"></span></button>';}).join('');
    $('chips').querySelectorAll('[data-f]').forEach(function(b){b.setAttribute('aria-pressed',String(b.dataset.f===state.filter));b.querySelector('.n').textContent=counts[b.dataset.f];});
  }
''')
block('  function renderList() {', '  function renderAll() {', r'''  function renderList() {
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
''')
replace("    if (fly) map.flyTo([b.lat, b.lon], Math.max(map.getZoom(), 15), { duration: 0.6 });", "    if (fly) goTo([b.lat,b.lon],Math.max(map.getZoom(),15));")
replace("'<span class=\"av\"><span class=\"brg\" style=\"transform:rotate(' + Math.round(b.brg || 0) + 'deg)\">➤</span></span>'", "'<span class=\"av\">' + busSvg() + '</span>'")
replace("'<span class=\"t\"><b>' + esc(b.name) + '</b>'", "'<span class=\"t\"><b><bdi dir=\"ltr\">' + esc(b.name) + '</bdi></b>'")
replace("dcell('الوقت المتوقع للوصول', eta ? eta : (b.speed < 1.5 ? 'متوقفة الآن' : 'غير متاح'))", "dcell('تقدير مباشر تقريبي، لا وقت وصول رسمي', b.demo || b.offline ? 'غير متاح' : eta ? eta : (b.speed < 1.5 ? 'متوقفة الآن' : 'غير متاح'))")
replace("dcell('السرعة الحالية', fmtNum(b.speed, 1)", "dcell(b.offline ? 'آخر سرعة مسجلة' : 'السرعة الحالية', fmtNum(b.speed, 1)")
# render historical canvas only on balanced mode
replace("      '<div class=\"trackbox\">' +\n", "      (effectivePerformance() === 'balanced' ? '<div class=\"trackbox\">' +\n")
replace("        '<div class=\"tracklist\" id=\"trackList\"></div>' +\n      '</div>' +", "        '<div class=\"tracklist\" id=\"trackList\"></div>' +\n      '</div>' : '<div class=\"note\">السجل التاريخي معطّل في الوضع الخفيف لتقليل استهلاك الجهاز.</div>') +")
replace("$('btnCenter').onclick = function () { map.flyTo([b.lat, b.lon], 16, { duration: 0.6 }); };", "$('btnCenter').onclick = function () { goTo([b.lat,b.lon],16); };")
replace("    var txt = '🚌 ' + b.name", "    var txt = (b.demo ? 'محاكاة — ليست بيانات حقيقية · ' : b.source === 'cache' ? 'موقع قديم محفوظ · ' : '') + b.name")
replace("      map.flyTo(state.myPos, 15, { duration: 0.7 });", "      goTo(state.myPos,15);")
replace('    if (!state.myPos && !cfg.station) return;', "    if (state.mode !== 'live' || (!state.myPos && !cfg.station)) return;")
replace("    state.buses.forEach(function (b) {\n      if (cfg.alertOn", "    state.buses.forEach(function (b) {\n      if (b.offline) return;\n      if (cfg.alertOn")
block('  /* ---------- 15. الإعدادات (واجهة) ---------- */', '  /* ---------- 16. محطة التنبيه (واجهة) ---------- */', r'''  /* ---------- 15. Settings and independent local display preferences ---------- */
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
    $('performanceSummary').textContent=(cfg.performance==='auto'?'المفعّل تلقائيًا: '+MODES[p]+'. ':'')+'تحديث البيانات الحقيقية كل '+Math.round(effectiveRefreshMs()/1000)+' ثانية، والمحاكاة كل '+(demoInterval()/1000)+' ثوانٍ. '+(p==='ultra'?'لا تُنزّل صور خريطة. ':p==='lite'?'بلا حركات أو سجل مسار تاريخي. ':'')+'تتوقف التحديثات والمحاكاة عند إخفاء الصفحة.';
    $('btnFocus').setAttribute('aria-pressed',String(cfg.wideMap));$('btnWideMap').setAttribute('aria-pressed',String(cfg.wideMap));
    $('btnWideMap').innerHTML=uiIcon('expand')+(cfg.wideMap?'إعادة قائمة الحافلات':'توسيع الخريطة');
    $('btnCards').setAttribute('aria-pressed',String(cfg.cardsOn));
  }
  function applyDisplay() {
    var p=effectivePerformance(),root=document.documentElement;
    root.dataset.performance=p;root.dataset.markerSize=cfg.markerSize;root.dataset.contrast=cfg.contrast?'strong':'normal';
    document.body.classList.toggle('focus-map',!!cfg.wideMap);
    if(p!=='balanced')state.hist={};
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
''')
replace("    $('stationModal').classList.remove('hidden');", "    openModal('stationModal');")
block('  /* ---------- 17. ربط الواجهة ---------- */', '  /* ---------- 18. الإقلاع ---------- */', r'''  /* ---------- 17. UI events ---------- */
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
''')
block('  function boot() {', "  if (document.readyState === 'loading')", r'''  function boot() {
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
''')
# Avoid emoji clutter in retained utility/detail strings (SVG icons are used instead).
replace('      var tok = r.data && (r.data.token || r.data.session || r.data.id);', '      var tok = r.data && (r.data.token || r.data.session);')
replace('      if (tok) { cfg.token = String(tok); saveCfg(); }', "      if (typeof tok === 'string' && tok) { cfg.token = tok; saveCfg(); }")
replace("    var extra = state.mode === 'cache' ? ' · مخزَّنة' : state.mode === 'demo' ? ' · تجريبي' : '';", "    var extra = state.mode === 'cache' ? ' · مخزَّنة' : state.mode === 'demo' ? ' · تجريبي' : state.mode === 'live' ? ' · مباشر' : '';")
replace("n + ' / ' + list.length + ' حافلة على الخريطة'", "n + ' من ' + list.length + ' حافلة على الخريطة'")
replace("var w = (state.cardMode === 'mini' ? 99 : 132)", "var w = (state.cardMode === 'mini' ? 116 : 150)")
replace("var h = (state.cardMode === 'mini' ? 43 : 56)", "var h = (state.cardMode === 'mini' ? 48 : 62)")
replace("    var conn = b.offline", "    var conn = b.demo ? 'محاكاة فقط — لا اتصال حقيقي بهذه الحافلة' : b.offline")
replace("'<button class=\"close\" id=\"btnCloseDetail\" aria-label=\"إغلاق\">✕</button>'", "'<button class=\"close\" id=\"btnCloseDetail\" aria-label=\"إغلاق التفاصيل\">' + uiIcon('close') + '</button>'")
replace("    $('btnCloseDetail').onclick = closeDetail;", "    $('btnCloseDetail').onclick = closeDetail;\n    if (effectivePerformance() !== 'balanced') { $('btnTrackTgl').disabled = true; $('btnTrackTgl').textContent = 'السجل موقوف'; }")
replace("    if (fly) goTo([b.lat,b.lon],Math.max(map.getZoom(),15));", "")
replace("    renderList(); renderMarkers(); renderHistory();\n  }\n\n  function renderDetail()", "    renderList(); renderMarkers(); renderHistory();\n    if (fly) focusBus(b,Math.max(map.getZoom(),15));\n  }\n\n  function focusBus(b,z) {\n    var target=[b.lat,b.lon];\n    if (innerWidth<1000 && !$('detail').classList.contains('hidden')) {\n      var stage=$('stage').getBoundingClientRect(),detail=$('detail').getBoundingClientRect(),size=map.getSize(),dx=0,dy=0;\n      if (innerWidth>innerHeight) dx=size.x/2-Math.max(70,(detail.left-stage.left)/2);\n      else dy=size.y/2-Math.max(45,(detail.top-stage.top)/2);\n      target=map.unproject(map.project(target,z).add([dx,dy]),z);\n    }\n    goTo(target,z);\n  }\n\n  function renderDetail()")
replace("$('btnCenter').onclick = function () { goTo([b.lat,b.lon],16); };", "$('btnCenter').onclick = function () { focusBus(b,16); };")
replace("    if (pts.length < 2) pts = [[b.lat, b.lon], [b.lat + 0.0005, b.lon + 0.0005]];", "    if (pts.length < 2) { ctx.beginPath(); ctx.arc(W/2,H/2,6,0,Math.PI*2); ctx.fillStyle=COLORS[statusOf(b)]; ctx.fill(); if ($('trackList')) $('trackList').textContent='لا توجد نقاط كافية لرسم المسار بعد.'; return; }")
s = re.sub('[\U0001F300-\U0001FAFF\u2600-\u27BF\ufe0f]', '', s)
Path('/workspace/msila-bus-tracker-v4/src/app.js').write_text(s)
print('Updated app.js:', len(s), 'characters')
