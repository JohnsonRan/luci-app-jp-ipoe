#!/usr/bin/env python3
"""Isolated real-occupancy TCP prototype checks and bounded timing comparison.

sudo uv run --no-project --offline --python /usr/bin/python3 tests/experiments/snat-queue-allocator.py

Requires Linux root, ip, nft, Python and libnftables. Does NOT install a daemon,
modify production scripts or touch live router traffic. TCP/IPv4/zone0 only.
The child chooses ports from real conntrack queries, not a fixture free-port
oracle. Native bypass can still race choices; no whole-pool success guarantee.
"""
import argparse
import json
import os
from pathlib import Path
import platform
import runpy
import signal
import sys

HERE = Path(__file__).resolve().parent
f = runpy.run_path(str(HERE.parent/'snat-collision.py'))
g = f['test'].__globals__
source = (f['ROOT']/'root/usr/libexec/jp-ipoe-map-nft').read_text()
original = f['CLIENT']
preamble = f"\nsys.path.insert(0, {str(HERE)!r})\nimport snat_queue_allocator as prototype\n"
prefix = original.split("\n_, preferred = dial(31000, destination='203.0.113.3')")[0] + preamble


def batch(reserved=None):
    reserved = g['RESERVED'] if reserved is None else reserved
    text = f['generate'](source, reserved)
    legal = ', '.join(str(p) for p in g['ALLOWED'] if p not in reserved)
    key = 'ct original ip saddr . ct original ip daddr . ct original proto-src . ct original proto-dst'
    return text + f'''
add map inet jpipoe_test picks {{ type ipv4_addr . ipv4_addr . inet_service . inet_service : inet_service; flags dynamic,timeout; timeout 100ms; size 4096; }}
insert rule inet jpipoe_test srcnat ip protocol tcp oifname e0 delete @picks {{ {key} : tcp sport }}
insert rule inet jpipoe_test srcnat ip protocol tcp oifname e0 tcp sport set {key} map @picks tcp sport {{ {legal} }} delete @picks {{ {key} : tcp sport }} snat ip to 203.0.113.1 : tcp sport
add chain inet jpipoe_test prealloc {{ type filter hook postrouting priority -2; policy accept; }}
add rule inet jpipoe_test prealloc ip protocol tcp ip saddr 192.0.2.1 oifname e0 ct status & confirmed == 0 queue num 123 bypass
'''


def run(client, scenario, rules=None, expanded=None):
    g['CLIENT'] = client
    rules = batch() if rules is None else rules
    if f['test']('tcp', scenario, rules, expanded or rules):
        raise RuntimeError('isolated allocator case failed: '+scenario)


finish = r'''
expected_results = 1 if scenario == 'time-wait' else 2
deadline = time.monotonic()+1
while len(allocator.results) < expected_results and not allocator.failure and time.monotonic() < deadline:
    time.sleep(0.005)
if allocator.failure or len(allocator.results) != expected_results:
    raise RuntimeError('worker failure: '+str(allocator.failure))
if any(x['outcome'] != 'selected' for x in allocator.results):
    raise RuntimeError('selection fell back: '+str(allocator.results))
if scenario == 'time-wait' and allocator.results[-1]['queries'] < 3:
    raise RuntimeError('TIME_WAIT candidate was not inspected before selecting the free port')
print('PASS: queried real occupancy, selected the only free legal port; no nft subprocess', flush=True)
print('MEASURE '+json.dumps({'scenario': scenario, 'elapsed_us': elapsed,
    'queries': allocator.results[-1]['queries']}), flush=True)
allocator.close()
if exchange(live, 31000) != mapped:
    raise RuntimeError('worker exit damaged existing TCP')
print('PASS: worker exit preserved established mapping', flush=True)
'''


def collisions(scenarios=('within-block', 'cross-block', 'time-wait')):
    needle = "_, preferred = dial(31000, destination='203.0.113.3')"
    client = original.replace(needle, preamble + '\nallocator = prototype.Allocator(allowed)\n' + needle)
    # Reset only this scenario's cursor, so it must inspect the pinned lowest
    # port rather than accidentally skipping it after the initial probe.
    client = client.replace("apply(cfg['batch'])", "apply(cfg['batch'])\nif scenario == 'time-wait':\n    allocator.close()\n    allocator = prototype.Allocator(allowed)")
    call = "live, mapped = dial(31000, timeout=0.35 if scenario == 'cross-block' else 2)"
    assert client.count(call) == 1
    client = client.replace(call, 'start = time.perf_counter_ns()\n    '+call+'\n    elapsed = (time.perf_counter_ns()-start)/1000')
    old_failure = "print('KNOWN LIMIT: selected block full; other-block free port not searched', flush=True)\n        sys.exit(0)"
    client = client.replace(old_failure, "raise RuntimeError('actual selector failed to cross blocks: '+str(allocator.failure)+' '+str(allocator.results))")
    marker = "if scenario == 'cross-block':\n    print('PASS: this attempt also crossed blocks', flush=True)\n    sys.exit(0)"
    assert client.count(marker) == 1
    client = client.replace(marker, finish + '\nsys.exit(0)')
    for scenario in scenarios:
        run(client, scenario)


SAFETY = prefix + r'''
import concurrent.futures, os, signal
for invalid in ([0], [65536], [True], ['80'], []):
    try: prototype.Allocator(invalid)
    except ValueError: pass
    else: raise RuntimeError('invalid pool accepted')
# Unknown query errors are never interpreted as free candidates.
class BrokenCT:
    def lookup(self, *args): raise OSError(1, 'simulated failed inspection')
try: prototype.Picker(sorted(allowed), '203.0.113.1', BrokenCT()).choose(
    ('192.0.2.1','203.0.113.2',22000,8000), time.monotonic()+1)
except OSError: pass
else: raise RuntimeError('query failure guessed a free port')
print('PASS: configured-port and unknown-inspection guards', flush=True)
with prototype.Allocator(allowed) as allocator:
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        flows = list(pool.map(lambda p: dial(p), range(22000,22008)))
    mapped_ports = [port for _, port in flows]
    if len(set(mapped_ports)) != len(mapped_ports):
        raise RuntimeError('concurrent endpoint allocations reused a port')
    deadline = time.monotonic()+1
    while len(allocator.results) < 8 and time.monotonic() < deadline: time.sleep(0.005)
    if allocator.failure or len(allocator.results) != 8 or any(x['outcome'] != 'selected' for x in allocator.results):
        raise RuntimeError('concurrent selection failed: '+str(allocator.results))
    print('PASS: eight concurrent TCP connections received distinct legal ports', flush=True)
for sock, port in flows:
    if exchange(sock, 0) != port: raise RuntimeError('exit changed existing mapping')
# Introduce a new reservation without releasing established conntrack mappings.
# Selection is stopped for the ruleset/allowed snapshot change, not silently stale.
apply(cfg['expanded'])
with prototype.Allocator(allowed, reserved=[min(allowed)]) as allocator:
    fresh, mapped = dial(23000, destination='203.0.113.3')
    if mapped == min(allowed): raise RuntimeError('new reservation allocated')
    for sock, port in flows:
        if exchange(sock, 0) != port: raise RuntimeError('reservation reload broke existing flow')
print('PASS: coordinated reservation update kept old flows and excluded newly reserved port', flush=True)
# Freeze the actual consumer process. The external monitor must kill it.
with prototype.Allocator(allowed, reserved=[min(allowed)]) as allocator:
    os.kill(allocator.process.pid, signal.SIGSTOP)
    start = time.monotonic()
    recovered, mapped = dial(23001, destination='203.0.113.3', timeout=3)
    if not allocator.failure or 'watchdog timeout' not in allocator.failure:
        raise RuntimeError('external watchdog did not recover stopped consumer')
    if allocator.process.is_alive(): raise RuntimeError('stopped consumer still alive')
    if time.monotonic()-start < 0.5: raise RuntimeError('held SYN drop/retry was not observed')
    for sock, port in flows:
        if exchange(sock, 0) != port: raise RuntimeError('watchdog damaged existing TCP')
print('PASS: watchdog killed stopped consumer; held SYN retried through native bypass', flush=True)
print('BOUNDARY: watchdog recovery is not zero-loss; an in-flight SYN can be dropped', flush=True)
'''

PENDING = prefix + r'''
# Hold confirmations at a second queue AFTER SNAT. Cycling another endpoint
# wraps the allocator cursor; its lease must protect the first unconfirmed port.
import select
helpers = prototype.queue_helpers()
gate = helpers['q_open'](fail_open=True, conntrack=True, queue=124)
# NAT chains share the kernel SNAT hook; use 200, after SNAT (100) but
# before conntrack confirmation, rather than relying on the table's priority.
apply("""add chain inet jpipoe_test gate { type filter hook postrouting priority 200; policy accept; }
add rule inet jpipoe_test gate ip daddr 203.0.113.2 ct status & confirmed == 0 queue num 124 bypass
""")
def pending(port):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    held.append(s); s.bind(('192.0.2.1', port)); s.setblocking(False)
    if s.connect_ex(('203.0.113.2',8000)) != errno.EINPROGRESS:
        raise RuntimeError('expected pending TCP connect')
    packet_id, packet = helpers['q_receive'](gate)
    translated = struct.unpack_from('!H', packet, (packet[0]&15)*4)[0]
    if translated not in allowed: raise RuntimeError('gate did not run after SNAT')
    return s, packet_id, translated
with prototype.Allocator(allowed) as allocator:
    first, first_id, first_port = pending(24000)
    ct = prototype.Conntrack()
    if ct.lookup('203.0.113.2', '203.0.113.1', 8000, first_port, time.monotonic()+1) is not None:
        raise RuntimeError('gate did not hold an unconfirmed entry')
    ct.close()
    for i in range(len(allowed)-1): dial(24100+i, destination='203.0.113.3')
    second, second_id, second_port = pending(24001)
    if first_port == second_port: raise RuntimeError('pending lease was reused')
    for sock, packet_id, port in ((first,first_id,first_port),(second,second_id,second_port)):
        helpers['q_verdict'](gate, packet_id, 1, queue=124)
        if not select.select([], [sock], [], 1)[1] or sock.getsockopt(socket.SOL_SOCKET,socket.SO_ERROR):
            raise RuntimeError('delayed confirmation failed')
        sock.settimeout(1)
        observed = exchange(sock, 0, initial=True)
        if observed != port:
            raise RuntimeError('pending mapping changed: expected='+str(port)+' observed='+str(observed)+' first/second='+str((first_port,second_port))+' selections='+str(allocator.results))
    deadline = time.monotonic()+1
    while len(allocator.results) < len(allowed)+1 and time.monotonic() < deadline: time.sleep(0.005)
    if (allocator.failure or len(allocator.results) != len(allowed)+1 or
            any(x['outcome'] != 'selected' for x in allocator.results) or
            allocator.results[0]['port'] != first_port or allocator.results[-1]['port'] != second_port):
        raise RuntimeError('pending test used fallback or a different selection: '+str(allocator.results))
gate.close()
print('PASS: real delayed confirmation plus cursor wrap did not reuse a pending port', flush=True)
'''

PERF = prefix + r'''
import statistics
allocator = prototype.Allocator(allowed) if scenario == 'allocator' else None
allowed = set(allowed)
latencies = []
for i in range(85):
    start = time.perf_counter_ns()
    live, mapped = dial(25000+i)
    if i >= 5: latencies.append((time.perf_counter_ns()-start)/1000)
if allocator:
    deadline = time.monotonic()+1
    while len(allocator.results) < 85 and time.monotonic() < deadline: time.sleep(0.005)
    if allocator.failure or len(allocator.results) != 85:
        raise RuntimeError('performance worker failed: '+str(allocator.failure))
    selected = sum(x['outcome']=='selected' for x in allocator.results)
    outcomes = [x['outcome'] for x in allocator.results if x['outcome'] != 'selected']
    processing = statistics.median(x['elapsed_us'] for x in allocator.results)
    allocator.close()
else: selected, processing, outcomes = 0, None, []
print('MEASURE '+json.dumps({'scenario': scenario, 'samples': len(latencies),
    'p50_us': statistics.median(latencies), 'p95_us': sorted(latencies)[75],
    'selected_including_warmup': selected, 'fallbacks': outcomes,
    'worker_p50_us': processing}), flush=True)
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--case', choices=('all','collisions','within-block','cross-block','time-wait','safety','pending','perf'), default='all')
    args = parser.parse_args()
    if sys.platform != 'linux' or os.geteuid() != 0:
        parser.error('Linux root required; uses isolated namespaces')
    signal.signal(signal.SIGTERM, lambda signum, _: sys.exit(128+signum))
    print('ENV '+json.dumps({'kernel':platform.release(), 'python':platform.python_version()}), flush=True)
    if args.case in ('all','collisions'): collisions()
    if args.case in ('within-block','cross-block','time-wait'): collisions((args.case,))
    if args.case in ('all','pending'): run(PENDING, 'pending')
    if args.case in ('all','safety'):
        run(SAFETY, 'safety', expanded=batch(g['RESERVED']+[min(g['ALLOWED'])]))
    if args.case in ('all','perf'):
        g['PORTSETS'] = ' '.join(f'{i*1024+224}-{i*1024+239}' for i in range(1,64))
        g['RESERVED'] = [1248,1249]
        g['ALLOWED'] = [p for i in range(1,64) for p in range(i*1024+224,i*1024+240) if p not in g['RESERVED']]
        for trial in range(3):
            for mode in (('native','allocator') if trial%2 == 0 else ('allocator','native')):
                rules = batch() if mode == 'allocator' else f['generate'](source,g['RESERVED'])
                run(PERF, mode, rules)
    print('DONE: isolated prototype checks passed; namespaces cleaned', flush=True)


if __name__ == '__main__':
    try: main()
    except Exception as exc:
        print('ERROR:', str(exc), file=sys.stderr)
        raise
