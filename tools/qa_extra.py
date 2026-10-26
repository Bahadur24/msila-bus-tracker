from playwright.sync_api import sync_playwright
from pathlib import Path
import json,base64
OUT=Path('/workspace/msila-bus-tracker-v4-checks')
URL='http://127.0.0.1:9034/'
PIXEL=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4//8/AwAI/AL+X4lGAAAAAElFTkSuQmCC')
with sync_playwright() as pw:
    b=pw.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
    c=b.new_context(viewport={'width':1280,'height':800},service_workers='block')
    cfg={'server':'https://test.invalid','email':'qa@example.invalid','password':'not-a-real-secret','token':''}
    c.add_init_script('localStorage.setItem("msila_tracker_cfg_v1",'+json.dumps(json.dumps(cfg))+');')
    c.route('https://tile.openstreetmap.org/**',lambda r:r.fulfill(status=200,content_type='image/png',body=PIXEL))
    seen=[]
    def api(route):
        path=route.request.url.split('/api/')[-1]
        if path=='session':data={'id':7,'name':'Test user'}
        elif path=='devices':
            seen.append(route.request.headers.get('authorization') is None)
            data=[{'id':1,'name':'SESSION-TEST','status':'online'}]
        elif path=='positions':
            data=[{'deviceId':1,'latitude':35.7039,'longitude':4.5306,'speed':10,'fixTime':'2099-01-01T00:00:00Z'}]
        else:data={'version':'test'}
        route.fulfill(status=200,content_type='application/json',body=json.dumps(data))
    c.route('https://test.invalid/**',api)
    p=c.new_page();errors=[];p.on('pageerror',lambda e:errors.append(str(e)))
    p.goto(URL,wait_until='networkidle');p.wait_for_function("document.body.dataset.source==='live'")
    assert all(seen) and seen
    assert p.evaluate("JSON.parse(localStorage.getItem('msila_tracker_cfg_v1')).token===''"), 'User ID was used as token'
    assert not errors,errors
    print('PASS cookie-based Traccar session does not create a bearer token from user ID',flush=True)
    c.close()
    c=b.new_context(viewport={'width':390,'height':844},service_workers='block')
    c.add_init_script("Object.defineProperty(navigator,'deviceMemory',{get:()=>2});Object.defineProperty(navigator,'hardwareConcurrency',{get:()=>2});window.__intervals=new Map();const si=setInterval.bind(window),ci=clearInterval.bind(window);window.setInterval=(fn,ms,...a)=>{const id=si(fn,ms,...a);window.__intervals.set(id,ms);return id};window.clearInterval=id=>{window.__intervals.delete(id);ci(id)};")
    c.route('https://tile.openstreetmap.org/**',lambda r:r.fulfill(status=200,content_type='image/png',body=PIXEL))
    p=c.new_page();p.goto(URL,wait_until='networkidle');p.wait_for_function("document.querySelector('#fleetCount').textContent==='14'")
    assert p.locator('html').get_attribute('data-performance')=='lite'
    assert set(p.evaluate('Array.from(window.__intervals.values())'))=={30000,5000}
    p.evaluate("Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'))")
    assert p.evaluate('window.__intervals.size')==0
    p.evaluate("Object.defineProperty(document,'hidden',{configurable:true,get:()=>false});document.dispatchEvent(new Event('visibilitychange'))")
    assert set(p.evaluate('Array.from(window.__intervals.values())'))=={30000,5000}
    p.locator('#btnMapDisplay').click();p.locator('[data-map-style="night"]').click();p.locator('[data-theme-choice="dark"]').click();p.locator('#fMarkerSize').select_option('large')
    p.reload(wait_until='networkidle')
    assert p.locator('html').get_attribute('data-theme')=='dark'
    assert p.locator('html').get_attribute('data-marker-size')=='large'
    assert 'invert' in p.locator('.leaflet-tile-pane').get_attribute('style')
    p.locator('#btnMapDisplay').click();p.locator('#btnWideMap').click();p.locator('#displayModal [data-close]').last.click()
    assert p.locator('#btnFocus').get_attribute('aria-pressed')=='true'
    print('PASS automatic low-end mode, background pause/resume and preference persistence',flush=True)
    c.close()
    c=b.new_context(viewport={'width':1280,'height':800},service_workers='allow')
    c.route('https://tile.openstreetmap.org/**',lambda r:r.fulfill(status=200,content_type='image/png',body=PIXEL))
    p=c.new_page();errors=[];p.on('pageerror',lambda e:errors.append(str(e)))
    p.goto(URL,wait_until='networkidle')
    p.evaluate('navigator.serviceWorker.ready')
    p.wait_for_function("navigator.serviceWorker.controller!==null")
    cached=p.evaluate("caches.keys().then(keys=>caches.open(keys.find(k=>k.startsWith('msila-tracker-v4')))).then(c=>c.keys()).then(rs=>rs.map(r=>r.url))")
    assert len(cached)>=10 and all(x.startswith(URL) for x in cached),cached
    c.set_offline(True)
    p.reload(wait_until='domcontentloaded');p.wait_for_function("document.querySelector('#fleetCount').textContent==='14'")
    assert p.locator('body').get_attribute('data-source')=='demo'
    assert not errors,errors
    print('PASS offline public app shell and local route data; no external tiles/API in service-worker cache',flush=True)
    c.close();b.close()
(OUT/'qa-extra-results.json').write_text(json.dumps({'cookie_session':True,'auto_lite':True,'background_pause':True,'preferences_persist':True,'offline_app_shell':True},indent=2))
