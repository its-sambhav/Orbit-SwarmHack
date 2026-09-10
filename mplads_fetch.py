#!/usr/bin/env python3
"""Re-download every MPLADS dashboard table to CSV.

    python3 mplads_fetch.py [output_dir]

Why this exists: the dashboard's own export button serialises the *rendered*
HTML table, so it gives you only the handful of columns the page draws, only
for the house+tenure currently selected -- and the four big tables never finish
loading in a browser anyway (50-110MB in a single un-paginated response).
This talks to the endpoint behind the page instead.

    POST /rest/PreLoginDashboardData/getTilesReportData
    {"combo": "state,constituency,mp,house[,tenure]", "key": "<tile name>"}

No auth, no cookies, no captcha. 0 = All.
"""
import csv, json, os, shutil, subprocess, sys, time
from concurrent.futures import ThreadPoolExecutor

OUT = sys.argv[1] if len(sys.argv) > 1 else "."
BASE = "https://mplads.mospi.gov.in/rest/PreLoginDashboardData"

# The dashboard shows ONE of these at a time; default view is 18th Lok Sabha.
# Rajya Sabha (combo house=1) intentionally excluded - this project only
# covers 17th and 18th Lok Sabha.
SCOPES = [("0,0,0,2,7", "Lok Sabha",   "18th Lok Sabha"),
          ("0,0,0,2,5", "Lok Sabha",   "17th Lok Sabha")]

TILES = ["Allocated Limit for Hon'ble MPs",
         "Expenditure on Completed and On-going Works as on Date",
         "Works Recommended", "Works Completed", "Works Sanctioned",
         "Amount consented for Calamity"]

def slug(s):
    return "_".join("".join(c if c.isalnum() else " " for c in s).split()).lower()

def post(path, payload, dest=None, timeout=900):
    """curl, not urllib: this host's cert chain fails python's verifier."""
    cmd = ["curl", "-sS", "--max-time", str(timeout), f"{BASE}/{path}", "-X", "POST",
           "-H", "Content-Type: application/json; charset=utf-8",
           "-H", "Referer: https://mplads.mospi.gov.in/digigov/dashboard.html",
           "--data", json.dumps(payload)]
    if dest:
        cmd += ["-o", dest, "-w", "%{http_code}"]
    r = subprocess.run(cmd, capture_output=True)
    if r.returncode:
        raise RuntimeError(f"curl rc={r.returncode}: {r.stderr.decode()[:150]}")
    if dest:
        if r.stdout.decode().strip() != "200":
            raise RuntimeError(f"HTTP {r.stdout.decode().strip()}")
        return dest
    return json.loads(r.stdout.decode("latin-1"))     # server declares ISO-8859-1

def is_total(r):
    """Each payload ends with a grand-total row: every field blank but Total_Amt."""
    return r.get("Total_Amt") and not any(v for k, v in r.items() if k != "Total_Amt")

def grab(tile):
    tmp = os.path.join(OUT, f".{slug(tile)}.jsonl")
    cols, n, totals = {}, 0, []
    with open(tmp, "w", encoding="utf-8") as buf:
        for combo, house, tenure in SCOPES:
            raw = os.path.join(OUT, f".{slug(tile)}.{combo.replace(',','_')}.json")
            for attempt in (1, 2, 3, 4):
                try:
                    post("getTilesReportData", {"combo": combo, "key": tile}, raw); break
                except Exception as e:
                    print(f"  ! {tile[:30]:30} {tenure[:14]:14} try {attempt}: {e}", flush=True)
                    if attempt == 4: raw = None
                    else: time.sleep(20 * attempt)
            if not raw:
                continue
            with open(raw, "rb") as f:
                outer = json.loads(f.read().decode("latin-1"))
            got = 0
            for blob in outer.values():
                for r in (json.loads(blob) if isinstance(blob, str) else blob):
                    if is_total(r):
                        totals.append({"TABLE": slug(tile) + ".csv", "HOUSE": house,
                                       "TENURE": tenure, "TOTAL_AMT": r["Total_Amt"]})
                        continue
                    # NOTE: assign into new keys only. 4 of the 6 payloads carry
                    # their own TENURE (the "Elected/Nominated" column) -- writing
                    # to it would destroy Sitting MP vs Nominated Rajya Sabha.
                    r["SCOPE_HOUSE"], r["SCOPE_TENURE"] = house, tenure
                    cols.update(dict.fromkeys(r))
                    buf.write(json.dumps(r, ensure_ascii=False) + "\n")
                    got += 1
            n += got
            print(f"  {tile[:30]:30} {house[:5]}/{tenure[:14]:14} {got:>7,}", flush=True)
            os.remove(raw)

    if not n:
        os.remove(tmp); return tile, 0, totals
    order = ["SCOPE_HOUSE", "SCOPE_TENURE"] + [c for c in cols
                                               if c not in ("SCOPE_HOUSE", "SCOPE_TENURE")]
    path = os.path.join(OUT, slug(tile) + ".csv")
    with open(tmp, encoding="utf-8") as f, \
         open(path, "w", newline="", encoding="utf-8-sig") as g:   # BOM so Excel reads it
        w = csv.DictWriter(g, fieldnames=order, extrasaction="ignore")
        w.writeheader()
        for line in f:
            w.writerow(json.loads(line))
    os.remove(tmp)
    print(f"  == {slug(tile)}.csv  {n:,} rows x {len(order)} cols", flush=True)
    return tile, n, totals

def preflight():
    if sys.version_info < (3, 7):
        sys.exit(f"needs Python 3.7+ (relies on dict insertion order); found {sys.version.split()[0]}")
    if not shutil.which("curl"):
        sys.exit("needs the 'curl' binary on PATH.\n"
                 "  macOS / Windows 10+ : already installed\n"
                 "  debian / ubuntu     : sudo apt install curl\n"
                 "  fedora              : sudo dnf install curl")
    os.makedirs(OUT, exist_ok=True)
    try:
        post("getTilesData", {"uname": "0,0,0,2,7"})
    except Exception as e:
        sys.exit(f"cannot reach mplads.mospi.gov.in - check your connection or proxy\n  {e}")


if __name__ == "__main__":
    preflight()
    t0, grand = time.time(), []
    # 3 workers max: this origin resets connections under heavier parallel load.
    with ThreadPoolExecutor(max_workers=3) as ex:
        res = list(ex.map(grab, TILES))
    for _, _, t in res:
        grand += t
    with open(os.path.join(OUT, "_totals.csv"), "w", newline="", encoding="utf-8-sig") as g:
        w = csv.DictWriter(g, fieldnames=["TABLE", "HOUSE", "TENURE", "TOTAL_AMT"])
        w.writeheader(); w.writerows(grand)
    print(f"\n{sum(n for _, n, _ in res):,} rows in {time.time()-t0:.0f}s")
    for tile, n, _ in res:
        print(f"  {'OK ' if n else 'FAIL'} {slug(tile)+'.csv':52} {n:>9,}")
