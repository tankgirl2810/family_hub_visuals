"""Builds lib/seq-transit.js, the timetable the Brisbane transit visual runs from.

Translink publishes South East Queensland's whole timetable as GTFS (a 35 MB zip), far too big for a
browser. This keeps only trains and ferries and packs them small:

  stations   each station once: name and position
  segments   the track or river between two neighbouring stations, as a simplified line
  patterns   a run of stations with the minutes between them; many trips share one
  trips      for each service: its trips' patterns and start times
  days       which services run on each date the timetable covers
  bus        buses in greater Brisbane, more simply: each route's path, and for a typical weekday,
             Saturday and Sunday, each trip's path, start and running time (a bus moves along its
             path at an even pace; the full bus timetable would be far too big)

Run it again when Translink's timetable changes (it covers about two months at a time). Python 3, no
packages needed:

    python tools/build-transit.py                  # downloads the latest timetable
    python tools/build-transit.py SEQ_GTFS.zip     # or uses one you already have

Data: Translink, Creative Commons Attribution 4.0 (data.qld.gov.au). The visual shows that credit.
"""
import csv, io, json, math, sys, urllib.request, zipfile
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

FEED = 'https://gtfsrt.api.translink.com.au/GTFS/SEQ_GTFS.zip'
OUT = Path(__file__).resolve().parent.parent / 'lib' / 'seq-transit.js'
MODES = {'2': 'rail', '4': 'ferry'}            # GTFS route types kept
SIMPLIFY = 0.00025                             # how far (degrees, about 25 m) a line may stray when simplified
BUS_SIMPLIFY = 0.0012                          # the same for bus routes (about 120 m, a pixel or so on the map)
BUS_AREA = (152.75, -27.75, 153.30, -27.20)    # buses kept: routes passing through this box (west, south, east, north)

# the lines, as Translink names them, by the station at the far end; each one's stations are found by
# following the track from there to Central. One is picked as "line of the day".
LINES = [
    ('Airport', 'Domestic Airport station'),
    ('Beenleigh', 'Beenleigh station'),
    ('Caboolture', 'Caboolture station'),
    ('Cleveland', 'Cleveland station'),
    ('Doomben', 'Doomben station'),
    ('Ferny Grove', 'Ferny Grove station'),
    ('Gold Coast', 'Varsity Lakes station'),
    ('Ipswich/Rosewood', 'Rosewood station'),
    ('Redcliffe Peninsula', 'Kippa-Ring station'),
    ('Shorncliffe', 'Shorncliffe station'),
    ('Springfield', 'Springfield Central station'),
    ('Sunshine Coast', 'Nambour station'),
]
CITY = 'Central station'


def table(z, name):
    with z.open(name) as f:
        yield from csv.DictReader(io.TextIOWrapper(f, encoding='utf-8-sig'))


def secs(hms):
    h, m, s = hms.split(':')
    return int(h) * 3600 + int(m) * 60 + int(s)


def simplify(pts, tol):
    """Douglas-Peucker: drop points that sit within tol of the line through their neighbours."""
    if len(pts) < 3:
        return pts
    keep, stack = {0, len(pts) - 1}, [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        (ax, ay), (bx, by) = pts[a], pts[b]
        dx, dy, best, far = bx - ax, by - ay, -1, None
        d2 = dx * dx + dy * dy or 1e-18
        for i in range(a + 1, b):
            px, py = pts[i]
            t = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / d2))
            d = math.hypot(px - ax - t * dx, py - ay - t * dy)
            if d > best:
                best, far = d, i
        if far is not None and best > tol:
            keep.add(far); stack += [(a, far), (far, b)]
    return [pts[i] for i in sorted(keep)]


d8 = lambda s: date(int(s[:4]), int(s[4:6]), int(s[6:]))


def running(z, wanted):
    """which of the wanted services run on each date: the weekly calendar, then the one-off changes"""
    runs = defaultdict(set)
    for c in table(z, 'calendar.txt'):
        if c['service_id'] not in wanted:
            continue
        d, end = d8(c['start_date']), d8(c['end_date'])
        while d <= end:
            if c[['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'][d.weekday()]] == '1':
                runs[d.strftime('%Y%m%d')].add(c['service_id'])
            d += timedelta(days=1)
    for c in table(z, 'calendar_dates.txt'):
        if c['service_id'] in wanted:
            (runs[c['date']].add if c['exception_type'] == '1' else runs[c['date']].discard)(c['service_id'])
    return runs


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else None
    if src:
        z = zipfile.ZipFile(src)
    else:
        print('downloading', FEED)
        z = zipfile.ZipFile(io.BytesIO(urllib.request.urlopen(FEED, timeout=120).read()))

    routes = {r['route_id']: MODES[r['route_type']] for r in table(z, 'routes.txt') if r['route_type'] in MODES}
    trips = {t['trip_id']: t for t in table(z, 'trips.txt') if t['route_id'] in routes}
    print(len(trips), 'train and ferry trips')
    feed = next(table(z, 'feed_info.txt'))

    # buses: a typical weekday (the first Wednesday), Saturday and Sunday in the timetable
    bus_routes = {r['route_id'] for r in table(z, 'routes.txt') if r['route_type'] == '3'}
    all_bus = {t['trip_id']: t for t in table(z, 'trips.txt') if t['route_id'] in bus_routes}
    bus_runs = running(z, {t['service_id'] for t in all_bus.values()})
    bus_days, d = {}, d8(feed['feed_start_date'])
    while len(bus_days) < 3 and d <= d8(feed['feed_end_date']):
        kind = {2: 'wk', 5: 'sa', 6: 'su'}.get(d.weekday())
        if kind and kind not in bus_days and bus_runs.get(d.strftime('%Y%m%d')):
            bus_days[kind] = d.strftime('%Y%m%d')
        d += timedelta(days=1)
    bus_trips = {tid: t for tid, t in all_bus.items() if any(t['service_id'] in bus_runs[k] for k in bus_days.values())}
    print(len(bus_trips), 'bus trips on', bus_days)

    # every stop belongs to a station (its parent); a stop with no parent is its own station
    stops = {s['stop_id']: s for s in table(z, 'stops.txt')}
    station_of = lambda sid: stops[sid]['parent_station'] or sid

    # the stops of every kept trip, in order (stop_times is large, so read it once, keeping only those)
    # (for a bus, only when it leaves its first stop and reaches its last)
    calls, bus_span = defaultdict(list), {}
    for r in table(z, 'stop_times.txt'):
        if r['trip_id'] in trips:
            calls[r['trip_id']].append((int(r['stop_sequence']), station_of(r['stop_id']), secs(r['arrival_time']), secs(r['departure_time'])))
        elif r['trip_id'] in bus_trips:
            n, sp = int(r['stop_sequence']), bus_span.setdefault(r['trip_id'], [1e9, 0, -1, 0])
            if n < sp[0]: sp[0], sp[1] = n, secs(r['departure_time'])
            if n > sp[2]: sp[2], sp[3] = n, secs(r['arrival_time'])

    # only the shapes those trips use
    shape_ids = {t['shape_id'] for t in trips.values()} | {t['shape_id'] for t in bus_trips.values()}
    shapes = defaultdict(list)
    for r in table(z, 'shapes.txt'):
        if r['shape_id'] in shape_ids:
            shapes[r['shape_id']].append((int(r['shape_pt_sequence']), float(r['shape_pt_lon']), float(r['shape_pt_lat'])))
    for k in shapes:
        shapes[k] = [(x, y) for _, x, y in sorted(shapes[k])]

    station_ix, station_list = {}, []
    def station(sid):
        if sid not in station_ix:
            s = stops[sid]
            station_ix[sid] = len(station_list)
            station_list.append([s['stop_name'], round(float(s['stop_lon']), 5), round(float(s['stop_lat']), 5)])
        return station_ix[sid]

    def cut(shape, a, b):
        """the part of a shape between the points nearest stations a and b"""
        near = lambda p: min(range(len(shape)), key=lambda i: (shape[i][0] - p[1]) ** 2 + (shape[i][1] - p[2]) ** 2)
        pa, pb = station_list[a], station_list[b]
        i, j = near(pa), near(pb)
        part = shape[i:j + 1] if i <= j else shape[j:i + 1][::-1]
        return [(pa[1], pa[2])] + part[1:-1] + [(pb[1], pb[2])]

    segments, segment_ix = [], {}
    def segment(a, b, mode, shape):
        key = (min(a, b), max(a, b))
        if key not in segment_ix:
            pts = cut(shape, key[0], key[1]) if shape else [tuple(station_list[key[0]][1:]), tuple(station_list[key[1]][1:])]
            pts = simplify(pts, SIMPLIFY)
            segment_ix[key] = len(segments)
            segments.append({'a': key[0], 'b': key[1], 'm': mode, 'p': [round(v, 5) for p in pts for v in p]})

    services, service_ix = [], {}
    patterns, pattern_ix, trip_rows = [], {}, []
    for tid, t in trips.items():
        st = sorted(calls.get(tid, []))
        st = [c for n, c in enumerate(st) if n == 0 or c[1] != st[n - 1][1]]   # drop a repeated call at the same station
        if len(st) < 2:
            continue
        mode, shape = routes[t['route_id']], shapes.get(t['shape_id'])
        ids = [station(c[1]) for c in st]
        for a, b in zip(ids, ids[1:]):
            segment(a, b, mode, shape)
        t0 = st[0][3]
        times = [v for c in st for v in (c[2] - t0, c[3] - t0)][1:-1]          # departure, then arrival and departure at each stop, then arrival
        key = (mode, tuple(ids), tuple(times))
        if key not in pattern_ix:
            pattern_ix[key] = len(patterns)
            patterns.append({'m': 0 if mode == 'rail' else 1, 's': ids, 't': [v // 15 for v in times]})   # in quarter minutes
        if t['service_id'] not in service_ix:
            service_ix[t['service_id']] = len(services); services.append(t['service_id'])
        trip_rows.append([pattern_ix[key], service_ix[t['service_id']], t0 // 15])
    trip_rows.sort(key=lambda r: (r[1], r[2]))

    # which services run on each date
    runs = defaultdict(set)
    for k, v in running(z, set(service_ix)).items():
        runs[k] = {service_ix[x] for x in v}
    days = {k: sorted(v) for k, v in sorted(runs.items()) if v}

    # each line's stations: the stopping-all-stations run from its far end to Central, taken from the
    # timetable (the run between the two with the most stations in it)
    by_name = {st[0]: i for i, st in enumerate(station_list)}
    lines = []
    for name, end_name in LINES:
        a, b, best = by_name.get(end_name), by_name.get(CITY), []
        for p in patterns:
            if p['m'] == 0 and a in p['s'] and b in p['s']:
                i, j = p['s'].index(a), p['s'].index(b)
                run = p['s'][i:j + 1] if i < j else p['s'][j:i + 1][::-1]
                if len(run) > len(best):
                    best = run
        if best:
            lines.append([name, best])
        else:
            print('  line skipped, no train runs from', end_name, 'to', CITY)

    # bus paths: each route shape that passes through the area, simplified, as whole 1/10000 degrees
    # stored as steps from the point before (smaller to write down)
    w, so, e, n = BUS_AREA
    paths, path_ix = [], {}
    def bus_path(shape_id):
        if shape_id not in path_ix:
            pts = shapes.get(shape_id)
            if not pts or not any(w < x < e and so < y < n for x, y in pts):
                path_ix[shape_id] = None
            else:
                flat, px, py = [], 0, 0
                for x, y in simplify(pts, BUS_SIMPLIFY):
                    ix, iy = round(x * 1e4), round(y * 1e4); flat += [ix - px, iy - py]; px, py = ix, iy
                path_ix[shape_id] = len(paths); paths.append(flat)
        return path_ix[shape_id]
    bus = {'paths': paths}
    for kind, day in bus_days.items():
        rows = []
        for tid, t in bus_trips.items():
            if t['service_id'] in bus_runs[day] and tid in bus_span:
                pi = bus_path(t['shape_id'])
                if pi is not None:
                    start, end = bus_span[tid][1] // 60, bus_span[tid][3] // 60
                    rows.append((start, pi, max(1, end - start)))
        rows.sort()
        # per trip: path, minutes since the previous trip's start, minutes it runs for
        bus[kind] = [v for k, r in enumerate(rows) for v in (r[1], r[0] - (rows[k - 1][0] if k else 0), r[2])]
        print(f'  buses, {kind} ({day}): {len(rows)} trips')
    print(f'  {len(paths)} bus paths')

    data = {
        'source': 'Translink GTFS, CC BY 4.0', 'from': feed['feed_start_date'], 'to': feed['feed_end_date'],
        'stations': [[n.replace(' station', '').replace(' ferry terminal', ''), x, y] for n, x, y in station_list],
        'segments': [[s['a'], s['b'], 0 if s['m'] == 'rail' else 1, s['p']] for s in segments],
        'patterns': [[p['m'], p['s'], p['t']] for p in patterns],
        # per service: pattern, then minutes... (quarter minutes) since the previous trip's start, for each trip
        'trips': [[v for k, r in enumerate(rows) for v in (r[0], r[2] - (rows[k - 1][2] if k else 0))]
                  for svc in range(len(services)) for rows in [[r for r in trip_rows if r[1] == svc]]],
        'days': days, 'lines': lines, 'bus': bus,
    }
    OUT.write_text(
        '// Brisbane trains, buses and ferries timetable, made by tools/build-transit.py from Translink\'s GTFS feed.\n'
        '// Data: Translink, Creative Commons Attribution 4.0. Do not edit by hand: run the script again.\n'
        'window.SEQ_TRANSIT = ' + json.dumps(data, separators=(',', ':')) + ';\n', encoding='utf-8', newline='\n')
    print(f'{len(station_list)} stations, {len(segments)} segments, {len(patterns)} patterns, {len(trip_rows)} trips, '
          f'{len(days)} days, {len(lines)} lines -> {OUT} ({OUT.stat().st_size // 1024} KB)')


if __name__ == '__main__':
    main()
