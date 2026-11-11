#!/usr/bin/env python3
"""Печатает суть отчёта о сбое macOS (.ips) аннотациями GitHub Actions."""
import json, sys

path = sys.argv[1]
with open(path, encoding="utf-8", errors="replace") as fh:
    header = fh.readline()
    body = json.loads(fh.read())

def ann(title, msg):
    print(f"::error title={title}::{msg}".replace("\n", " "))

ann("crash", f"{json.loads(header).get('app_name')} — {path.rsplit('/', 1)[-1]}")
ann("exception", json.dumps(body.get("exception", {}), ensure_ascii=False))
if body.get("termination"):
    ann("termination", json.dumps(body["termination"], ensure_ascii=False)[:600])
for k in ("asi", "lastExceptionBacktrace"):
    if k in body:
        ann(k, json.dumps(body[k], ensure_ascii=False)[:900])
imgs = body.get("usedImages", [])
t = body.get("threads", [])[body.get("faultingThread", 0)]
for i, fr in enumerate(t.get("frames", [])[:22]):
    img = imgs[fr.get("imageIndex", 0)].get("name", "?") if imgs else "?"
    ann(f"frame {i}", f"{img}  {fr.get('symbol', '?')}")
