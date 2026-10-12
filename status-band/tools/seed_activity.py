"""Seed status-band's activity profile from past Claude Code transcripts.

Reads every transcript under ~/.claude/projects touched in the last 60 days, adds up each assistant
message's weighted tokens by the hour it happened in, and writes ~/.claude/status-band/activity/history.json.
The band learns from live use after that; `until` marks where the seed stops so the two never overlap.

Run with: python -I seed_activity.py
"""
import json
import os
import sys
import time
from collections import defaultdict
from datetime import datetime

HOME = os.path.expanduser('~')
PROJECTS = os.path.join(HOME, '.claude', 'projects')
OUT = os.path.join(HOME, '.claude', 'status-band', 'activity', 'history.json')
DAYS = 60


def units(u):
    # Roughly what a turn costs against the limit: cache reads are cheap, everything else full price.
    return (u.get('input_tokens') or 0) + (u.get('output_tokens') or 0) + (u.get('cache_creation_input_tokens') or 0) + 0.1 * (u.get('cache_read_input_tokens') or 0)


def main():
    now = time.time()
    since = now - DAYS * 86400
    until = int(now // 3600)
    hours = defaultdict(float)
    seen = set()
    files = 0
    for root, _, names in os.walk(PROJECTS):
        for name in names:
            if not name.endswith('.jsonl'):
                continue
            path = os.path.join(root, name)
            try:
                if os.path.getmtime(path) < since:
                    continue
                files += 1
                with open(path, encoding='utf-8', errors='replace') as f:
                    for line in f:
                        if '"assistant"' not in line or '"usage"' not in line:
                            continue
                        try:
                            d = json.loads(line)
                        except ValueError:
                            continue
                        if d.get('type') != 'assistant':
                            continue
                        msg = d.get('message') or {}
                        u = msg.get('usage') or {}
                        mid = msg.get('id') or d.get('uuid')
                        # One API response is written as several lines, one per content block: count it once.
                        if mid in seen:
                            continue
                        seen.add(mid)
                        ts = d.get('timestamp')
                        if not ts:
                            continue
                        t = datetime.fromisoformat(ts.replace('Z', '+00:00')).timestamp()
                        h = int(t // 3600)
                        if t < since or h >= until:
                            continue
                        v = units(u)
                        if v > 0:
                            hours[str(h)] += v
            except OSError:
                continue
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump({'source': 'transcripts', 'builtAt': int(now * 1000), 'until': until, 'hours': {k: round(v) for k, v in hours.items()}}, f)
    # A local hour-of-day summary, to check the profile looks like the person's day.
    hod = [0.0] * 24
    days = set()
    for k, v in hours.items():
        lt = time.localtime(int(k) * 3600)
        hod[lt.tm_hour] += v
        days.add((lt.tm_year, lt.tm_yday))
    top = max(hod) or 1
    print(f'{files} transcripts, {len(hours)} active hours over {len(days)} days -> {OUT}')
    for i, v in enumerate(hod):
        print(f'{i:02d}:00 {"#" * round(40 * v / top)}')


if __name__ == '__main__':
    sys.exit(main())
