#!/usr/bin/env python3
"""Collect live M'sila bus positions and infer provisional stop locations.

The API token is read only from BUS_TRACKING_TOKEN. Raw API IDs are never
written to disk; short one-way fingerprints are stored only in ignored local
analysis/private logs and are excluded from every public report.
"""
from __future__ import annotations
import concurrent.futures, datetime as dt, hashlib, json, math, os, re, time, urllib.error, urllib.request
from pathlib import Path
from zoneinfo import ZoneInfo

BASE = 'https://msilabus.malimspotter.dz'
TZ = ZoneInfo('Africa/Algiers')
REQUESTED_START = dt.datetime.fromisoformat('2026-10-28T15:12:49+01:00')
TARGET_END = dt.datetime.fromisoformat('2026-10-28T16:12:49+01:00')
INTERVAL = 3.0
MIN_DWELL = 9.0
RADIUS_M = 65.0
MAX_GAP_S = 20.0
OUT = Path(__file__).resolve().parents[1] / 'analysis' / 'private'
OUT.mkdir(parents=True, exist_ok=True)
VISITS_FILE = OUT / 'stop_visits.jsonl'
PROGRESS_FILE = OUT / 'observation_progress.json'
TOKEN = os.environ.get('BUS_TRACKING_TOKEN', '')
if not TOKEN:
    raise SystemExit('BUS_TRACKING_TOKEN is required')


def now_local(): return dt.datetime.now(TZ)
def iso(t): return t.astimezone(TZ).isoformat(timespec='seconds')
def haversine(a, b):
    r=6371000.0; p1,p2=math.radians(a[0]),math.radians(b[0]); dp=math.radians(b[0]-a[0]); dl=math.radians(b[1]-a[1])
    h=math.sin(dp/2)**2+math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2
    return 2*r*math.asin(math.sqrt(min(1.0,h)))
def parse_time(v):
    if not v: return None
    try:
        x=dt.datetime.fromisoformat(str(v).replace('Z','+00:00'))
        return x if x.tzinfo else x.replace(tzinfo=dt.timezone.utc)
    except Exception: return None
def suffix_group(device):
    # The user's convention is the numeric segment after the final slash.
    for field in ('uniqueId','name','id'):
        v=device.get(field)
        m=re.search(r'/\s*(\d+)\s*$', str(v or ''))
        if m: return m.group(1)
    return 'غير مصنف'
def get_json(path):
    req=urllib.request.Request(BASE+path, headers={'Accept':'application/json','Authorization':'Bearer '+TOKEN,'User-Agent':'MsilaBusTracker-observation/1.0'})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read().decode('utf-8'))
def write_progress(obj):
    tmp=PROGRESS_FILE.with_suffix('.tmp')
    tmp.write_text(json.dumps(obj,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    tmp.replace(PROGRESS_FILE)

actual_start=now_local()
manifest={'requested_start':iso(REQUESTED_START),'actual_start':iso(actual_start),'target_end':iso(TARGET_END),'interval_requested_seconds':INTERVAL,'minimum_dwell_seconds':MIN_DWELL,'cluster_radius_m':RADIUS_M,'maximum_sample_gap_seconds':MAX_GAP_S,'status':'running','successful_cycles':0,'failed_cycles':0,'first_success':None,'last_success':None,'mean_actual_cadence_seconds':None,'max_actual_cadence_seconds':None,'device_count_first_success':None,'groups_seen':[],'estimated_expected_cycles':0,'estimated_missed_cycles':0}
write_progress(manifest)
active={}
last_success_mono=None
cadences=[]
cycle=0
next_due=time.monotonic()
with VISITS_FILE.open('a',encoding='utf-8') as visits_out, concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
    while now_local() < TARGET_END:
        delay=next_due-time.monotonic()
        if delay>0: time.sleep(delay)
        cycle_started=time.monotonic(); captured=now_local(); cycle+=1
        fdev=pool.submit(get_json,'/api/devices'); fpos=pool.submit(get_json,'/api/positions')
        try:
            devices=fdev.result(timeout=12); positions=fpos.result(timeout=12)
            if not isinstance(devices,list) or not isinstance(positions,list): raise ValueError('unexpected response')
            pos_by={}
            for p in positions:
                if not isinstance(p,dict) or p.get('deviceId') is None: continue
                try: lat=float(p.get('latitude')); lon=float(p.get('longitude'))
                except (TypeError,ValueError): continue
                if not (-90<=lat<=90 and -180<=lon<=180) or (lat==0 and lon==0): continue
                old=pos_by.get(p['deviceId'])
                t=parse_time(p.get('fixTime') or p.get('deviceTime') or p.get('serverTime'))
                ot=parse_time((old or {}).get('fixTime') or (old or {}).get('deviceTime') or (old or {}).get('serverTime'))
                if old is None or (t or dt.datetime.min.replace(tzinfo=dt.timezone.utc)) >= (ot or dt.datetime.min.replace(tzinfo=dt.timezone.utc)):
                    pos_by[p['deviceId']]=p
            seen_groups=set()
            for d in devices:
                p=pos_by.get(d.get('id'))
                if not p: continue
                try: lat=float(p.get('latitude')); lon=float(p.get('longitude'))
                except (TypeError,ValueError): continue
                grp=suffix_group(d); seen_groups.add(grp)
                key=hashlib.sha256(str(d.get('id','')).encode()).hexdigest()[:16]
                speed=float(p.get('speed') or 0)*3.6
                fix=parse_time(p.get('fixTime') or p.get('deviceTime') or p.get('serverTime'))
                age=(captured.astimezone(dt.timezone.utc)-fix).total_seconds() if fix else None
                state=active.get(key)
                gap=(captured-state['last']).total_seconds() if state else 0.0
                if state and gap <= MAX_GAP_S and haversine((state['lat'],state['lon']),(lat,lon)) <= RADIUS_M and speed <= 7.0 and (age is None or age <= 300):
                    state['max_gap_seconds']=max(state.get('max_gap_seconds',0),gap)
                    state['sumlat']+=lat; state['sumlon']+=lon; state['n']+=1; state['last']=captured
                    state['lat']=state['sumlat']/state['n']; state['lon']=state['sumlon']/state['n']
                    state['groups'].add(grp)
                    if not state['confirmed'] and (captured-state['start']).total_seconds() >= MIN_DWELL and state['n']>=4:
                        state['confirmed']=True
                    if state['confirmed']:
                        state['max_duration']=(captured-state['start']).total_seconds()
                else:
                    if state and state['confirmed']:
                        rec={'group':state['group'],'groups_observed':sorted(state['groups']),'lat':round(state['lat'],6),'lon':round(state['lon'],6),'arrival':iso(state['start']),'departure':iso(state['last']),'dwell_seconds':round((state['last']-state['start']).total_seconds(),1),'samples':state['n'],'max_gap_seconds':round(state.get('max_gap_seconds',0),1),'device_fingerprint':key}
                        visits_out.write(json.dumps(rec,ensure_ascii=False)+'\n'); visits_out.flush()
                    active[key]={'group':grp,'groups':{grp},'start':captured,'last':captured,'lat':lat,'lon':lon,'sumlat':lat,'sumlon':lon,'n':1,'confirmed':False,'max_duration':0,'max_gap_seconds':0}
            manifest['successful_cycles']+=1
            if manifest['first_success'] is None:
                manifest['first_success']=iso(captured); manifest['device_count_first_success']=len(devices)
            manifest['last_success']=iso(captured); manifest['groups_seen']=sorted(seen_groups)
            if last_success_mono is not None: cadences.append(cycle_started-last_success_mono)
            last_success_mono=cycle_started
        except Exception as e:
            manifest['failed_cycles']+=1
            # Do not retain error bodies or identifiers; record only exception class.
            manifest['last_error_type']=type(e).__name__
        manifest['elapsed_wall_seconds']=round((now_local()-actual_start).total_seconds(),1)
        manifest['mean_actual_cadence_seconds']=round(sum(cadences)/len(cadences),3) if cadences else None
        manifest['max_actual_cadence_seconds']=round(max(cadences),3) if cadences else None
        if cycle%20==0:
            expected_slots=max(0,math.floor(manifest['elapsed_wall_seconds']/INTERVAL)+1)
            manifest['estimated_expected_cycles']=expected_slots
            manifest['estimated_missed_cycles']=max(0,expected_slots-manifest['successful_cycles'])
            write_progress(manifest)
            print(f"{iso(now_local())} cycles={cycle} ok={manifest['successful_cycles']} failed={manifest['failed_cycles']} devices={manifest['device_count_first_success']}",flush=True)
        next_due += INTERVAL
        if next_due < time.monotonic()-INTERVAL: next_due=time.monotonic()+INTERVAL
    end_capture=now_local()
    for key,state in active.items():
        if state['confirmed']:
            rec={'group':state['group'],'groups_observed':sorted(state['groups']),'lat':round(state['lat'],6),'lon':round(state['lon'],6),'arrival':iso(state['start']),'departure':iso(state['last']),'dwell_seconds':round((state['last']-state['start']).total_seconds(),1),'samples':state['n'],'max_gap_seconds':round(state.get('max_gap_seconds',0),1),'device_fingerprint':key}
            visits_out.write(json.dumps(rec,ensure_ascii=False)+'\n')
manifest['status']='complete'; manifest['actual_end']=iso(end_capture); manifest['successful_cycles']=manifest.get('successful_cycles',0); manifest['failed_cycles']=manifest.get('failed_cycles',0)
manifest['mean_actual_cadence_seconds']=round(sum(cadences)/len(cadences),3) if cadences else None
manifest['max_actual_cadence_seconds']=round(max(cadences),3) if cadences else None
manifest['coverage_seconds']=round((end_capture-actual_start).total_seconds(),1)
manifest['requested_window_seconds']=3600
manifest['coverage_gap_from_requested_start_seconds']=max(0,round((actual_start-REQUESTED_START).total_seconds(),1))
manifest['status_note']='Only confirmed dwell clusters will be proposed as virtual/expected stop points; not official stations.'
write_progress(manifest)
print('OBSERVATION_FINISHED',json.dumps({k:manifest.get(k) for k in ('actual_start','actual_end','coverage_seconds','successful_cycles','failed_cycles','mean_actual_cadence_seconds','device_count_first_success','status')},ensure_ascii=False),flush=True)
