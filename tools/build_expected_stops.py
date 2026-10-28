#!/usr/bin/env python3
"""Aggregate private dwell events into a complete public, group-only stop dataset."""
from __future__ import annotations
import datetime as dt, json, math
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
PRIVATE=ROOT/'analysis'/'private'
OUTPUT=ROOT/'expected_stops.json'
MERGE_RADIUS_M=100.0
MAX_SAMPLE_GAP_S=20.0
SEGMENTS=[('الرصد الأساسي',PRIVATE/'observation_progress.json',PRIVATE/'stop_visits.jsonl'),
          ('التمديد',PRIVATE/'extension'/'observation_progress.json',PRIVATE/'extension'/'stop_visits.jsonl')]

def distance(a,b):
    r=6371000.0;p1,p2=math.radians(a['lat']),math.radians(b['lat']);dp=math.radians(b['lat']-a['lat']);dl=math.radians(b['lon']-a['lon'])
    h=math.sin(dp/2)**2+math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2
    return 2*r*math.asin(math.sqrt(min(1.0,h)))
def parse_time(v):
    try:
        x=dt.datetime.fromisoformat(str(v).replace('Z','+00:00'))
        return x if x.tzinfo else x.replace(tzinfo=dt.timezone.utc)
    except Exception:return None
def sample_coverage(m):
    first=parse_time(m.get('first_success'));last=parse_time(m.get('last_success'))
    if first and last:return max(0.0,(last-first).total_seconds())
    return max(0.0,float(m.get('coverage_seconds') or 0))
def group_key(s):
    if s=='غير مصنف':return (2,0,s)
    if s.isdigit():return (0,int(s),s)
    return (1,0,s)

def main():
    manifests=[];visits=[];published_segments=[];unverified_gap_events=0;excluded_gap_events=0
    for label,mp,vp in SEGMENTS:
        if not mp.exists():continue
        m=json.loads(mp.read_text(encoding='utf-8'));manifests.append(m)
        if vp.exists():
            for line in vp.read_text(encoding='utf-8').splitlines():
                try:
                    item=json.loads(line);lat=float(item['lat']);lon=float(item['lon'])
                    if not(-90<=lat<=90 and -180<=lon<=180) or (lat==0 and lon==0):continue
                    dwell=max(0,float(item.get('dwell_seconds',0)));samples=max(0,int(item.get('samples',0)))
                    gap_raw=item.get('max_gap_seconds');gap=float(gap_raw) if gap_raw is not None else None
                    avg_gap=dwell/(samples-1) if samples>1 else 0
                    if (gap is not None and gap>MAX_SAMPLE_GAP_S) or (gap is None and avg_gap>MAX_SAMPLE_GAP_S):
                        excluded_gap_events+=1;continue
                    verified=gap is not None
                    if not verified:unverified_gap_events+=1
                    # Whitelist public-safe fields; all identifiers/fingerprints are discarded.
                    visits.append({'lat':lat,'lon':lon,'group':str(item.get('group','غير مصنف')),
                        'dwell_seconds':dwell,'samples':samples,'gap_verified':verified,
                        'arrival':item.get('arrival'),'departure':item.get('departure')})
                except (ValueError,KeyError,TypeError):continue
        published_segments.append({'name':label,'actual_start':m.get('actual_start'),'first_sample':m.get('first_success'),
            'last_sample':m.get('last_success'),'actual_end':m.get('actual_end'),'coverage_seconds':round(sample_coverage(m),1),
            'successful_cycles':m.get('successful_cycles',0),'failed_cycles':m.get('failed_cycles',0),
            'mean_actual_cadence_seconds':m.get('mean_actual_cadence_seconds'),'max_actual_cadence_seconds':m.get('max_actual_cadence_seconds'),
            'maximum_sample_gap_seconds':m.get('maximum_sample_gap_seconds')})
    if len(manifests)!=len(SEGMENTS):raise SystemExit('Refusing to publish: one or more observation segments are missing')
    if any(m.get('status')!='complete' for m in manifests):raise SystemExit('Refusing to publish: all observation segments must be complete')
    main_manifest=manifests[0];ext=manifests[1]
    # Keep every pair inside a cluster within the disclosed radius; avoid transitive chains.
    clusters=[]
    for v in visits:
        eligible=[c for c in clusters if all(distance(v,member)<=MERGE_RADIUS_M for member in c)]
        if eligible:
            def center_distance(c):
                center={'lat':sum(x['lat'] for x in c)/len(c),'lon':sum(x['lon'] for x in c)/len(c)}
                return distance(v,center)
            min(eligible,key=center_distance).append(v)
        else:clusters.append([v])
    points=[]
    for members in clusters:
        groups=sorted({v['group'] for v in members},key=group_key);dwells=sorted(v['dwell_seconds'] for v in members)
        verified=all(v['gap_verified'] for v in members)
        if len(members)>=5 and len(groups)>=2 and verified:confidence='مرتفعة'
        elif len(members)>=3 or len(groups)>=2:confidence='متوسطة'
        else:confidence='أولية'
        starts=[v['arrival'] for v in members if v.get('arrival')];ends=[v['departure'] for v in members if v.get('departure')]
        points.append({'lat':sum(v['lat'] for v in members)/len(members),'lon':sum(v['lon'] for v in members)/len(members),
            'groups':groups,'visits':len(members),'mean_dwell_seconds':round(sum(dwells)/len(dwells),1) if dwells else 0,
            'max_dwell_seconds':round(max(dwells) if dwells else 0,1),'confidence':confidence,
            'first_seen':min(starts) if starts else None,'last_seen':max(ends) if ends else None})
    points.sort(key=lambda p:(-p['visits'],-len(p['groups']),p['lat'],p['lon']))
    stops=[{'label':f'نقطة افتراضية {i:02d}','lat':round(p['lat'],5),'lon':round(p['lon'],5),'groups':p['groups'],
        'visits':p['visits'],'mean_dwell_seconds':p['mean_dwell_seconds'],'max_dwell_seconds':p['max_dwell_seconds'],
        'confidence':p['confidence'],'first_seen':p['first_seen'],'last_seen':p['last_seen']} for i,p in enumerate(points,1)]
    total_cycles=sum(int(m.get('successful_cycles',0)) for m in manifests);failed=sum(int(m.get('failed_cycles',0)) for m in manifests)
    coverage=sum(sample_coverage(m) for m in manifests)
    internal=sum(max(0,int(m.get('successful_cycles',0))-1) for m in manifests)
    weighted=sum(float(m.get('mean_actual_cadence_seconds') or 0)*max(0,int(m.get('successful_cycles',0))-1) for m in manifests)
    mean_cadence=weighted/internal if internal else None
    max_cadence=max([float(m.get('max_actual_cadence_seconds') or 0) for m in manifests] or [0])
    main_last=parse_time(main_manifest.get('last_success'));ext_first=parse_time(ext.get('first_success'))
    inter_gap=max(0,(ext_first-main_last).total_seconds()) if main_last and ext_first else None
    first=parse_time(main_manifest.get('first_success') or main_manifest.get('actual_start'));last=parse_time(ext.get('last_success'))
    span=(last-first).total_seconds() if first and last else coverage
    interval=float(main_manifest.get('interval_requested_seconds',3))
    expected=sum(math.floor(sample_coverage(m)/interval)+1 for m in manifests if int(m.get('successful_cycles',0))>0)
    summary={'requested_start':main_manifest.get('requested_start'),'actual_start':main_manifest.get('actual_start'),
        'first_success':main_manifest.get('first_success'),'last_success':ext.get('last_success'),
        'target_end':ext.get('target_end'),'actual_end':ext.get('actual_end'),
        'elapsed_span_seconds':round(span,1),'coverage_seconds':round(coverage,1),
        'coverage_gap_from_requested_start_seconds':main_manifest.get('coverage_gap_from_requested_start_seconds'),
        'inter_segment_gap_seconds':round(inter_gap,1) if inter_gap is not None else 0,
        'successful_cycles':total_cycles,'failed_cycles':failed,'estimated_expected_cycles':expected,
        'estimated_missed_cycles':max(0,expected-total_cycles-failed),'requested_interval_seconds':interval,
        'mean_actual_cadence_seconds':round(mean_cadence,3) if mean_cadence else None,
        'max_actual_cadence_seconds':round(max_cadence,3) if max_cadence else None,
        'device_count_first_success':main_manifest.get('device_count_first_success'),
        'segments':published_segments,'stop_confirmation_min_seconds':main_manifest.get('minimum_dwell_seconds',9),
        'stationary_radius_m':main_manifest.get('cluster_radius_m',65),'stop_merge_radius_m':MERGE_RADIUS_M,
        'maximum_consecutive_sample_gap_seconds':MAX_SAMPLE_GAP_S,'gap_guard_applied_segments':[s['name'] for s in published_segments if s.get('maximum_sample_gap_seconds') is not None],
        'unverified_gap_events':unverified_gap_events,'excluded_suspicious_gap_events':excluded_gap_events,
        'method':'اعتُبر الموقع توقفًا مرشحًا عند بقائه ضمن 65 م بسرعة منخفضة مدة 9 ثوانٍ على الأقل مع 4 عينات؛ واستُبعدت إشارات الموقع الأقدم من 5 دقائق، وجُمعت الزيارات ضمن 100 م. حدّ 20 ثانية بين العينات طُبّق في جزء التمديد فقط؛ الجزء الأساسي لا يسجل الفاصل الأقصى لكل زيارة، لذلك تظل بعض مدد التوقف تقديرية. جميع النقاط افتراضية وليست محطات رسمية.'}
    notice='هذه نقاط توقف افتراضية/متوقعة مستنتجة آليًا من الرصد وليست محطات رسمية؛ يُرجى التحقق منها ميدانيًا.'
    if unverified_gap_events:notice+=' بعض الزيارات من الجزء الأساسي لا تتوفر لها قياسات الفاصل الأقصى بين العينات.'
    output={'schema_version':1,'status':'complete','notice':notice,'observation':summary,'stops':stops}
    OUTPUT.write_text(json.dumps(output,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'output':str(OUTPUT),'stops':len(stops),'dwell_events':len(visits),'groups':sorted({g for s in stops for g in s['groups']},key=group_key),
        'successful_cycles':total_cycles,'failed_cycles':failed,'coverage_seconds':round(coverage,1),'elapsed_span_seconds':round(span,1),
        'inter_segment_gap_seconds':summary['inter_segment_gap_seconds'],'mean_actual_cadence_seconds':summary['mean_actual_cadence_seconds'],
        'max_actual_cadence_seconds':summary['max_actual_cadence_seconds'],'unverified_gap_events':unverified_gap_events,
        'excluded_suspicious_gap_events':excluded_gap_events},ensure_ascii=False))
if __name__=='__main__':main()
