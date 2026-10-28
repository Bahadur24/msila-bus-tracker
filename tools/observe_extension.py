#!/usr/bin/env python3
"""Collect the final segment needed to complete one hour from first live sample."""
from __future__ import annotations
import concurrent.futures, datetime as dt, hashlib, json, math, os, re, time, urllib.request
from pathlib import Path
from zoneinfo import ZoneInfo
BASE='https://msilabus.malimspotter.dz'; TZ=ZoneInfo('Africa/Algiers')
END=dt.datetime.fromisoformat('2026-10-28T16:16:38+01:00'); INTERVAL=3.0; MIN_DWELL=9.0; RADIUS=65.0; MAX_GAP=20.0
OUT=Path(__file__).resolve().parents[1]/'analysis'/'private'/'extension'; OUT.mkdir(parents=True,exist_ok=True)
VFILE=OUT/'stop_visits.jsonl'; PFILE=OUT/'observation_progress.json'; TOKEN=os.environ.get('BUS_TRACKING_TOKEN','')
if not TOKEN: raise SystemExit('BUS_TRACKING_TOKEN is required')
def now(): return dt.datetime.now(TZ)
def iso(v): return v.astimezone(TZ).isoformat(timespec='seconds')
def dist(a,b):
 r=6371000.; p1,p2=math.radians(a[0]),math.radians(b[0]); dp=math.radians(b[0]-a[0]); dl=math.radians(b[1]-a[1]); h=math.sin(dp/2)**2+math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2; return 2*r*math.asin(math.sqrt(min(1.,h)))
def parse(v):
 try:
  if not v:return None
  t=dt.datetime.fromisoformat(str(v).replace('Z','+00:00')); return t if t.tzinfo else t.replace(tzinfo=dt.timezone.utc)
 except Exception:return None
def group(d):
 for k in ('uniqueId','name','id'):
  m=re.search(r'/\s*(\d+)\s*$',str(d.get(k) or ''))
  if m:return m.group(1)
 return 'غير مصنف'
def get(path):
 q=urllib.request.Request(BASE+path,headers={'Accept':'application/json','Authorization':'Bearer '+TOKEN,'User-Agent':'MsilaBusTracker-observation/1.0'})
 with urllib.request.urlopen(q,timeout=10) as r:return json.loads(r.read().decode())
def save(p):
 t=PFILE.with_suffix('.tmp'); t.write_text(json.dumps(p,ensure_ascii=False,indent=2)+'\n',encoding='utf-8'); t.replace(PFILE)
started=now(); info={'segment':'continuation','scheduled_start':'2026-10-28T16:12:49+01:00','actual_start':iso(started),'target_end':iso(END),'interval_requested_seconds':INTERVAL,'minimum_dwell_seconds':MIN_DWELL,'cluster_radius_m':RADIUS,'maximum_sample_gap_seconds':MAX_GAP,'status':'running','successful_cycles':0,'failed_cycles':0,'first_success':None,'last_success':None,'mean_actual_cadence_seconds':None,'max_actual_cadence_seconds':None}
save(info); active={}; intervals=[]; previous=None; due=time.monotonic(); n=0; end_failures=0
with VFILE.open('a',encoding='utf-8') as out, concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
 while True:
  wait=due-time.monotonic()
  if wait>0:time.sleep(wait)
  tick=time.monotonic(); t=now(); n+=1; cycle_ok=False
  a=pool.submit(get,'/api/devices'); b=pool.submit(get,'/api/positions')
  try:
   devices=a.result(timeout=12); positions=b.result(timeout=12)
   if not isinstance(devices,list) or not isinstance(positions,list):raise ValueError('response')
   by={}
   for p in positions:
    if not isinstance(p,dict) or p.get('deviceId') is None:continue
    try:la=float(p.get('latitude'));lo=float(p.get('longitude'))
    except (TypeError,ValueError):continue
    if not -90<=la<=90 or not -180<=lo<=180 or la==lo==0:continue
    old=by.get(p['deviceId']); pt=parse(p.get('fixTime') or p.get('deviceTime') or p.get('serverTime')); ot=parse((old or {}).get('fixTime') or (old or {}).get('deviceTime') or (old or {}).get('serverTime'))
    if old is None or (pt or dt.datetime.min.replace(tzinfo=dt.timezone.utc)) >= (ot or dt.datetime.min.replace(tzinfo=dt.timezone.utc)):by[p['deviceId']]=p
   for d in devices:
    p=by.get(d.get('id'))
    if not p:continue
    la=float(p['latitude']);lo=float(p['longitude']); speed=float(p.get('speed') or 0)*3.6; g=group(d); key=hashlib.sha256(str(d.get('id','')).encode()).hexdigest()[:16]; st=active.get(key); gap=(t-st['last']).total_seconds() if st else 0.0
    fix=parse(p.get('fixTime') or p.get('deviceTime') or p.get('serverTime')); age=(t.astimezone(dt.timezone.utc)-fix).total_seconds() if fix else None
    if st and gap<=MAX_GAP and dist((st['lat'],st['lon']),(la,lo))<=RADIUS and speed<=7 and (age is None or age<=300):
     st['sumlat']+=la;st['sumlon']+=lo;st['n']+=1;st['last']=t;st['lat']=st['sumlat']/st['n'];st['lon']=st['sumlon']/st['n'];st['groups'].add(g);st['max_gap_seconds']=max(st.get('max_gap_seconds',0),gap)
     if (t-st['start']).total_seconds()>=MIN_DWELL and st['n']>=4:st['confirmed']=True
    else:
     if st and st['confirmed']:
      out.write(json.dumps({'group':st['group'],'groups_observed':sorted(st['groups']),'lat':round(st['lat'],6),'lon':round(st['lon'],6),'arrival':iso(st['start']),'departure':iso(st['last']),'dwell_seconds':round((st['last']-st['start']).total_seconds(),1),'samples':st['n'],'max_gap_seconds':round(st.get('max_gap_seconds',0),1),'device_fingerprint':key},ensure_ascii=False)+'\n');out.flush()
     active[key]={'group':g,'groups':{g},'start':t,'last':t,'lat':la,'lon':lo,'sumlat':la,'sumlon':lo,'n':1,'confirmed':False,'max_gap_seconds':0}
   info['successful_cycles']+=1
   if info['first_success'] is None:info['first_success']=iso(t);info['device_count_first_success']=len(devices)
   info['last_success']=iso(t);cycle_ok=True
   if previous is not None:intervals.append(tick-previous)
   previous=tick
  except Exception as e:info['failed_cycles']+=1;info['last_error_type']=type(e).__name__
  info['mean_actual_cadence_seconds']=round(sum(intervals)/len(intervals),3) if intervals else None
  info['max_actual_cadence_seconds']=round(max(intervals),3) if intervals else None
  if n%10==0:save(info);print('extension cycles='+str(n)+' ok='+str(info['successful_cycles'])+' failed='+str(info['failed_cycles']),flush=True)
  if t>=END:
   if cycle_ok:break
   end_failures+=1
   if end_failures>=5:break
  due+=INTERVAL
  if due<time.monotonic()-INTERVAL:due=time.monotonic()+INTERVAL
 end=now()
 for key,st in active.items():
  if st['confirmed']:
   out.write(json.dumps({'group':st['group'],'groups_observed':sorted(st['groups']),'lat':round(st['lat'],6),'lon':round(st['lon'],6),'arrival':iso(st['start']),'departure':iso(st['last']),'dwell_seconds':round((st['last']-st['start']).total_seconds(),1),'samples':st['n'],'max_gap_seconds':round(st.get('max_gap_seconds',0),1),'device_fingerprint':key},ensure_ascii=False)+'\n')
 last_sample=parse(info.get('last_success'));reached=bool(last_sample and last_sample>=END)
 info['status']='complete' if reached else 'incomplete';info['requested_endpoint_sample_reached']=reached
 info['actual_end']=iso(end);info['coverage_seconds']=round((end-started).total_seconds(),1);save(info)
 print('EXTENSION_FINISHED',json.dumps({k:info.get(k) for k in ('status','requested_endpoint_sample_reached','actual_start','actual_end','last_success','coverage_seconds','successful_cycles','failed_cycles','mean_actual_cadence_seconds','max_actual_cadence_seconds')},ensure_ascii=False),flush=True)
