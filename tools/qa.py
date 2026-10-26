from playwright.sync_api import sync_playwright
from pathlib import Path
import json, base64, time

OUT=Path('/workspace/msila-bus-tracker-v4-checks')
OUT.mkdir(exist_ok=True)
URL='http://127.0.0.1:9034/'
PIXEL=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4//8/AwAI/AL+X4lGAAAAAElFTkSuQmCC')
results=[]
INIT="""Object.defineProperty(navigator,'hardwareConcurrency',{get:()=>8});Object.defineProperty(navigator,'deviceMemory',{get:()=>8});window.__qaIntervals=new Map();const si=window.setInterval.bind(window),ci=window.clearInterval.bind(window);window.setInterval=function(fn,ms,...rest){let id=si(fn,ms,...rest);window.__qaIntervals.set(id,ms);return id};window.clearInterval=function(id){window.__qaIntervals.delete(id);ci(id)};"""

def setup(browser, width, height, cfg=None):
    ctx=browser.new_context(viewport={'width':width,'height':height},device_scale_factor=1,service_workers='block')
    ctx.add_init_script(INIT)
    if cfg is not None:
        ctx.add_init_script('localStorage.setItem("msila_tracker_cfg_v1",'+json.dumps(json.dumps(cfg))+');')
    ctx.route('https://tile.openstreetmap.org/**',lambda route:route.fulfill(status=200,content_type='image/png',body=PIXEL))
    p=ctx.new_page()
    errors=[]
    p.on('pageerror',lambda e:errors.append(str(e)))
    return ctx,p,errors

def pref(p, attr, value):
    p.locator(f'[{attr}="{value}"]').click()
    p.wait_for_timeout(80)

def selected(p,attr,value):
    assert p.locator(f'[{attr}="{value}"]').get_attribute('aria-pressed')=='true'

def geometry(p):
    return p.evaluate('''() => {let chrome=document.querySelector('#appChrome').getBoundingClientRect(),map=document.querySelector('#stage').getBoundingClientRect();return {width:innerWidth,chromeBottom:chrome.bottom,mapTop:map.top,mapWidth:map.width,docWidth:document.documentElement.scrollWidth,bodyWidth:document.body.scrollWidth,headerWidth:document.querySelector('#topbar').scrollWidth,sidebarRight:document.querySelector('#sidebar').getBoundingClientRect().right}}''')

with sync_playwright() as play:
    b=play.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
    for w,h,name in [(1440,900,'desktop'),(1024,720,'laptop'),(768,1024,'tablet'),(390,844,'phone'),(320,740,'narrow'),(844,390,'landscape')]:
        ctx,p,errors=setup(b,w,h)
        p.goto(URL,wait_until='networkidle')
        p.wait_for_function("document.querySelector('#fleetCount').textContent==='14'")
        assert p.locator('body').get_attribute('data-source')=='demo'
        assert p.locator('html').get_attribute('data-performance')=='strong'
        assert 1000 in p.evaluate('Array.from(window.__qaIntervals.values())')
        assert 'ليست' in p.locator('#demoTxt').inner_text()
        g=geometry(p)
        assert g['mapTop']>=g['chromeBottom']-1,g
        assert g['docWidth']<=w and g['bodyWidth']<=w,g
        assert g['headerWidth']<=w,g
        p.screenshot(path=str(OUT/f'{name}-layout.png'))
        p.locator('#btnMapDisplay').click()
        p.wait_for_function("!document.querySelector('#displayModal').classList.contains('hidden')")
        pref(p,'data-theme-choice','dark')
        assert p.locator('html').get_attribute('data-theme')=='dark'
        pref(p,'data-map-style','night')
        assert 'invert' in p.locator('.leaflet-tile-pane').get_attribute('style')
        pref(p,'data-performance-choice','lite')
        assert p.locator('html').get_attribute('data-performance')=='lite'
        intervals=p.evaluate('Array.from(window.__qaIntervals.values())')
        assert 30000 in intervals and 5000 in intervals,intervals
        pref(p,'data-performance-choice','ultra')
        assert p.locator('html').get_attribute('data-performance')=='ultra'
        assert p.locator('.leaflet-tile').count()==0
        assert 60000 in p.evaluate('Array.from(window.__qaIntervals.values())')
        selected(p,'data-map-style','none')
        pref(p,'data-map-style','calm')
        assert p.locator('html').get_attribute('data-performance')=='lite'
        p.locator('#fMarkerSize').select_option('large')
        p.locator('#fLabelMode').select_option('full')
        p.locator('label:has(#fContrast)').click()
        assert p.locator('html').get_attribute('data-marker-size')=='large'
        assert p.locator('html').get_attribute('data-contrast')=='strong'
        p.locator('#displayModal [data-close]').last.click()
        if w<1000:p.locator('#btnFleetDock').click()
        p.locator('#search').fill('04/H015')
        p.wait_for_timeout(80)
        assert p.locator('.busrow').count()==1
        assert p.locator('#listCount').inner_text()=='1 حافلة'
        p.locator('#btnFit').click()
        p.wait_for_timeout(100)
        assert p.locator('.bus-marker').count()==1
        p.locator('.busrow').click()
        assert p.locator('#detail').is_visible()
        assert not p.locator('#miniTrack').count()
        assert 'معطّل' in p.locator('#detail').inner_text()
        p.locator('#btnCloseDetail').click()
        if w<1000:p.locator('#btnFleetDock').click()
        p.locator('#search').fill('')
        if w<1000:p.locator('#btnCloseSb').click()
        p.locator('#btnMapDisplay').click()
        pref(p,'data-performance-choice','balanced')
        p.locator('#btnResetDisplay').click()
        assert p.locator('html').get_attribute('data-theme')=='light'
        assert p.locator('html').get_attribute('data-marker-size')=='normal'
        assert p.locator('html').get_attribute('data-performance')=='strong'
        pref(p,'data-performance-choice','strong')
        assert json.loads(p.evaluate('localStorage.getItem("msila_tracker_cfg_v1")'))['performance']=='strong'
        p.locator('#displayModal [data-close]').last.click()
        assert not errors,errors
        results.append({'viewport':name,'size':[w,h],'geometry':g,'passed':True,'errors':errors})
        print('PASS',name,flush=True)
        ctx.close()

    # Synthetic live API only. No external connection or real credentials are used.
    cfg={'server':'https://test.invalid','token':'test-only-local-value','refreshMs':12000,'performance':'balanced','mapStyle':'streets'}
    ctx,p,errors=setup(b,1440,900,cfg)
    now='2026-10-26T12:27:00Z'
    live={'fail':False}
    def api(route):
        if live['fail']:route.abort();return
        path=route.request.url.split('/api/')[-1]
        if path=='devices':data=[{'id':1,'name':'TEST-01','status':'online'},{'id':2,'name':'TEST-02','status':'offline'}]
        elif path=='positions':
            now_iso=p.evaluate('new Date().toISOString()')
            data=[{'deviceId':1,'latitude':35.7039,'longitude':4.5306,'speed':10,'course':90,'fixTime':now_iso},{'deviceId':2,'latitude':35.7070,'longitude':4.5350,'speed':0,'fixTime':now_iso}]
        else:data={'version':'test'}
        route.fulfill(status=200,content_type='application/json',body=json.dumps(data))
    ctx.route('https://test.invalid/**',api)
    p.goto(URL,wait_until='networkidle')
    p.wait_for_function("document.body.dataset.source==='live'")
    assert p.locator('#fleetCount').inner_text()=='2'
    p.locator('[data-id="d1"]').click()
    assert '18.5 كم/س' in p.locator('#detail').inner_text()
    assert p.locator('#miniTrack').count()==1
    p.locator('#btnCloseDetail').click()
    p.locator('#btnMapDisplay').click()
    pref(p,'data-map-style','night');pref(p,'data-theme-choice','dark');pref(p,'data-performance-choice','lite')
    p.locator('#btnResetDisplay').click()
    assert p.evaluate("JSON.parse(localStorage.getItem('msila_tracker_cfg_v1')).token==='test-only-local-value'")
    assert p.locator('body').get_attribute('data-source')=='live'
    p.locator('#displayModal [data-close]').last.click()
    p.locator('#search').fill('TEST-02');p.locator('#btnFit').click()
    p.wait_for_timeout(600)
    assert p.locator('.bus-marker').count()==1
    p.locator('#search').fill('')
    live['fail']=True
    p.locator('#btnRefresh').click()
    p.wait_for_function("document.body.dataset.source==='cache'")
    assert 'ليست مواقع مباشرة' in p.locator('#demoTxt').inner_text()
    assert p.locator('#sbOffline .sv').inner_text()=='2'
    assert not errors,errors
    results.append({'synthetic_live_cache':True,'speed_conversion':True,'display_does_not_modify_credentials':True,'errors':errors})
    print('PASS synthetic live/cache and credential isolation',flush=True)
    ctx.close()
    b.close()
(OUT/'qa-results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2))
print('ALL QA PASSED',flush=True)
