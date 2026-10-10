"""Runs an interactive Claude Code session in a hidden pseudo-terminal so the channel can be tested
end to end without anyone at the keyboard.

  python qa/pty-session.py --cwd DIR --log FILE [--batch JSON] [--wait SECONDS] -- <claude args...>

Accepts the folder-trust and development-channel dialogs, waits for the input prompt, optionally
POSTs a batch to the Table Talk server, then saves the rendered screen when --wait runs out.
Needs pywinpty and pyte (pip install pywinpty pyte).
"""
import argparse, json, re, threading, time, urllib.request

import pyte
from winpty import PtyProcess

ap = argparse.ArgumentParser()
ap.add_argument('--cwd', required=True)
ap.add_argument('--log', required=True)
ap.add_argument('--batch')
ap.add_argument('--port', default='8796')
ap.add_argument('--wait', type=float, default=90)
ap.add_argument('rest', nargs=argparse.REMAINDER)
a = ap.parse_args()
args = [x for x in a.rest if x != '--']

ROWS, COLS = 60, 160
screen = pyte.HistoryScreen(COLS, ROWS, history=5000)
stream = pyte.Stream(screen)
lock = threading.Lock()
proc = PtyProcess.spawn(['claude', *args], cwd=a.cwd, dimensions=(ROWS, COLS))


def reader():
    while proc.isalive():
        try:
            chunk = proc.read(4096)
        except EOFError:
            break
        with lock:
            stream.feed(chunk)


threading.Thread(target=reader, daemon=True).start()


def lines():
    with lock:
        return [l.rstrip() for l in screen.display]


def text():
    return '\n'.join(lines())


def choose(option, tries=8):
    """Move the ❯ marker onto the option matching `option`, then press Enter."""
    for _ in range(tries):
        sel = next((l for l in lines() if '❯' in l), '')
        if re.search(option, sel, re.I):
            proc.write('\r')
            return True
        proc.write('\x1b[B')  # down
        time.sleep(0.4)
    return False


steps = []
start = time.time()
ready = False
while time.time() - start < 120 and not ready:
    t = text()
    if re.search(r'Yes, I trust this folder', t) and 'trust' not in steps:
        steps.append('trust'); choose(r'Yes, I trust'); time.sleep(1.5); continue
    if re.search(r'I am using this for local development', t) and 'dev' not in steps:
        steps.append('dev'); choose(r'local development'); time.sleep(1.5); continue
    if re.search(r'^\s*❯\s*$', t, re.M) or re.search(r'\? for shortcuts', t):
        ready = True
    time.sleep(0.5)

time.sleep(4)
result = {'ready': ready, 'steps': steps, 'startup': text()}
if a.batch:
    req = urllib.request.Request(f'http://127.0.0.1:{a.port}/batch', data=a.batch.encode(),
                                 headers={'content-type': 'application/json', 'origin': 'http://localhost:30000'})
    try:
        result['post'] = json.loads(urllib.request.urlopen(req, timeout=10).read())
    except Exception as e:
        result['post'] = repr(e)

time.sleep(a.wait)
with lock:
    history = [''.join(c.data for c in row.values()).rstrip() if isinstance(row, dict) else str(row)
               for row in list(screen.history.top)]
result['final'] = '\n'.join([*history, text()])
open(a.log, 'w', encoding='utf-8').write(json.dumps(result, indent=1, ensure_ascii=False))
proc.write('\x03'); time.sleep(0.6); proc.write('\x03'); time.sleep(1.5)
try:
    proc.terminate(force=True)
except Exception:
    pass
print(json.dumps({k: result[k] for k in ('ready', 'steps', 'post') if k in result}))
