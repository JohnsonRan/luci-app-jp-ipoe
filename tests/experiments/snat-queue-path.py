#!/usr/bin/env python3
"""Isolated feasibility experiment, NOT a deployable allocator.

sudo uv run --no-project --offline --python /usr/bin/python3 tests/experiments/snat-queue-path.py

Reuses the real TCP collision fixture, with its first block full and a known
free port in another block. A two-request NFQUEUE worker picks those KNOWN test
ports, not ports discovered from conntrack. No production script is modified.
Default: queue / one-shot map / native NAT data path with fail-closed exit.
Add --fallback to test an earlier queue hook backed by the production segmented
rules: absent consumer, overflow, explicit timeout verdict, and pending exit.
A stuck consumer has NO automatic packet deadline; this experiment does not
implement a watchdog. No general allocator, UDP/ICMP or hot-update guarantee.
"""
import argparse
import os
from pathlib import Path
import runpy
import signal
import subprocess
import sys

WORKER = r'''
import threading
ready, finished = threading.Event(), threading.Event()
worker_errors, decisions = [], []
def q_attr(kind, payload):
    size = len(payload) + 4
    return struct.pack('=HH', size, kind) + payload + b'\0' * ((-size) % 4)
def q_message(kind, flags, payload, queue=123):
    body = struct.pack('!BBH', socket.AF_INET, 0, queue) + payload
    return struct.pack('=IHHII', 16+len(body), kind, flags, 1, 0) + body
def q_open(maxlen=128, fail_open=False, conntrack=False, queue=123):
    nl = socket.socket(socket.AF_NETLINK, socket.SOCK_RAW, 12)
    try:
        nl.settimeout(3)
        nl.bind((0, 0))
        # CMD_BIND, COPY_PACKET, QUEUE_MAXLEN, MASK, FLAGS.
        config = q_attr(1, struct.pack('!BBH', 1, 0, socket.AF_INET))
        config += q_attr(2, struct.pack('!IB', 128, 2))
        config += q_attr(3, struct.pack('!I', maxlen))
        config += q_attr(4, struct.pack('!I', 1 | (2 if conntrack else 0)))
        config += q_attr(5, struct.pack('!I', int(fail_open) | (2 if conntrack else 0)))
        nl.sendto(q_message(0x302, 5, config, queue), (0, 0))
        ack = nl.recv(65536)
        if len(ack) < 20 or struct.unpack_from('=H', ack, 4)[0] != 2:
            raise RuntimeError('missing queue configuration ACK')
        if struct.unpack_from('=i', ack, 16)[0] != 0:
            raise RuntimeError('queue configuration rejected')
        return nl
    except BaseException:
        nl.close()
        raise

def q_receive(nl, details=False):
    data = nl.recv(65536)
    if len(data) < 20 or struct.unpack_from('=H', data, 4)[0] != 0x300:
        raise RuntimeError('expected queued packet')
    total = struct.unpack_from('=I', data)[0]
    if total != len(data): raise RuntimeError('unexpected queue message framing')
    a, pos = {}, 20
    while pos + 4 <= total:
        size, kind = struct.unpack_from('=HH', data, pos)
        if size < 4 or pos + size > total: raise RuntimeError('invalid queue attribute')
        a[kind & 0x3fff] = data[pos+4:pos+size]
        pos += (size+3) & ~3
    packet_id = struct.unpack_from('!I', a[1])[0]
    return (packet_id, a) if details else (packet_id, a[10])

def q_verdict(nl, packet_id, verdict, queue=123):
    nl.sendto(q_message(0x301, 1, q_attr(2, struct.pack('!II', verdict, packet_id)), queue), (0, 0))

def queue_worker():
    try:
        with q_open(fail_open=(q_resume_verdict == 1)) as nl:
            ready.set()
            while len(decisions) < 2:
                packet_id, packet = q_receive(nl)
                if len(packet) < 24 or packet[0] >> 4 != 4 or packet[9] != 6:
                    raise RuntimeError('expected IPv4 TCP test packet')
                ihl = (packet[0] & 15) * 4
                if ihl < 20 or len(packet) < ihl + 4: raise RuntimeError('short TCP header')
                src, dst = socket.inet_ntoa(packet[12:16]), socket.inet_ntoa(packet[16:20])
                sport, dport = struct.unpack_from('!HH', packet, ihl)
                if src != '192.0.2.1' or dst not in ('203.0.113.2', '203.0.113.3'):
                    raise RuntimeError('unexpected test tuple')
                first, end = min(allowed), min(allowed)
                while end + 1 in allowed: end += 1
                # Controlled fixture oracle, deliberately NOT a general allocator.
                port = first if dst == '203.0.113.3' else next(p for p in allowed if p > end)
                key = f'{src} . {dst} . {sport} . {dport}'
                apply(f'add element inet jpipoe_test picks {{ {key} : {port} }}\n')
                decisions.append(port)
                # REPEAT at NAT hook, or ACCEPT before the subsequent NAT hook.
                q_verdict(nl, packet_id, q_resume_verdict)
    except BaseException as exc:
        worker_errors.append(str(exc))
    finally:
        ready.set()
        finished.set()
threading.Thread(target=queue_worker, daemon=True).start()
if not ready.wait(3) or worker_errors:
    raise RuntimeError('queue startup failed: '+str(worker_errors))
'''

SUCCESS = r'''
if scenario == 'cross-block':
    if not finished.wait(3) or worker_errors:
        raise RuntimeError('queue worker failed: '+str(worker_errors))
    if len(decisions) != 2: raise RuntimeError('unexpected number of queued connections')
    state = json.loads(subprocess.check_output(['nft', '-j', 'list', 'map', 'inet', 'jpipoe_test', 'picks']))
    maps = [e['map'] for e in state['nftables'] if 'map' in e]
    if len(maps) != 1 or maps[0].get('elem'):
        raise RuntimeError('allocation map was not consumed')
    if exchange(live, 31000) != mapped:
        raise RuntimeError('existing connection failed after queue worker exited')
    try:
        # Use the probe endpoint: unlike the collision target, its pool has space.
        dial(31001, destination='203.0.113.3', timeout=0.35)
    except TimeoutError:
        pass
    else:
        raise RuntimeError('new connection bypassed the absent allocator')
    if exchange(live, 31000) != mapped:
        raise RuntimeError('failed new connection damaged the old one')
    print('PASS: two first packets queued; one-shot selections consumed', flush=True)
    print('PASS: allocator exit fails closed for new connections; existing TCP still works', flush=True)
    print('SCOPE: controlled port choices only, not a complete allocator', flush=True)
    sys.exit(0)
'''


FAULTS = r'''
if scenario == 'cross-block':
    import errno, select
    if not finished.wait(3) or worker_errors or len(decisions) != 2:
        raise RuntimeError('controlled allocation worker failed: '+str(worker_errors))
    def map_empty():
        state = json.loads(subprocess.check_output(['nft', '-j', 'list', 'map', 'inet', 'jpipoe_test', 'picks']))
        maps = [e['map'] for e in state['nftables'] if 'map' in e]
        if len(maps) != 1 or maps[0].get('elem'): raise RuntimeError('stale allocation token')
    def old_flow_works():
        if exchange(live, 31000) != mapped: raise RuntimeError('old flow mapping changed')
    def pending_connect(port):
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        held.append(s)
        s.bind(('192.0.2.1', port))
        s.setblocking(False)
        if s.connect_ex(('203.0.113.3', 8000)) != errno.EINPROGRESS:
            raise RuntimeError('expected asynchronous TCP connect')
        return s
    def finish_connect(s, port):
        if not select.select([], [s], [], 2)[1] or s.getsockopt(socket.SOL_SOCKET, socket.SO_ERROR):
            raise RuntimeError('pending TCP connect failed')
        s.settimeout(2)
        return exchange(s, port, initial=True)
    def queue_count():
        rows = [line.split() for line in open('/proc/net/netfilter/nfnetlink_queue')]
        return next((int(row[2]) for row in rows if int(row[0]) == 123), 0)
    map_empty()
    old_flow_works()
    absent, absent_port = dial(31001, destination='203.0.113.3')
    print('PASS: absent consumer bypasses queue into legal segmented SNAT', flush=True)
    with q_open(maxlen=1, fail_open=True) as nl:
        pending = pending_connect(31002)
        packet_id, _ = q_receive(nl)
        if queue_count() != 1: raise RuntimeError('queue was not filled')
        start = time.monotonic()
        overflow, overflow_port = dial(31003, destination='203.0.113.3', timeout=0.35)
        if queue_count() != 1: raise RuntimeError('overflow test lost the held packet')
        print('PASS: full queue falls back; first packet remains queued', flush=True)
        old_flow_works()
        # No kernel packet deadline: an alive but stuck consumer holds this SYN.
        if select.select([], [pending], [], max(0, 0.25-(time.monotonic()-start)))[1]:
            raise RuntimeError('held SYN escaped before an explicit verdict')
        q_verdict(nl, packet_id, 1)  # responsive allocator's timeout action, NOT automatic
        timeout_port = finish_connect(pending, 31002)
        if queue_count() != 0: raise RuntimeError('timeout verdict left a queued packet')
        print('PASS: explicit timeout ACCEPT resumes held SYN through segmented SNAT', flush=True)
        print('BOUNDARY: stuck consumer needs an external recovery mechanism; no automatic deadline', flush=True)
    # Exiting with a non-empty queue drops the held SYN. TCP must retransmit.
    with q_open(maxlen=1, fail_open=True) as nl:
        crashed = pending_connect(31004)
        q_receive(nl)
        if queue_count() != 1: raise RuntimeError('exit test did not hold a SYN')
        start = time.monotonic()
    crash_port = finish_connect(crashed, 31004)
    if time.monotonic() - start < 0.5:
        raise RuntimeError('exit test did not demonstrate TCP retransmission delay')
    print('PASS: pending consumer exit drops first SYN; TCP retries via fallback', flush=True)
    # Stale or faulty allocation values cannot take a reserved/out-of-pool port.
    for sport, bad in ((31005, reserved[0]), (31006, 1000)):
        key = f'192.0.2.1 . 203.0.113.3 . {sport} . 8000'
        apply(f'add element inet jpipoe_test picks {{ {key} : {bad} }}\n')
        dial(sport, destination='203.0.113.3')
        map_empty()
    print('PASS: reserved/out-of-pool selections rejected and consumed before fallback', flush=True)
    old_flow_works()
    for sock, port in holders:
        if exchange(sock, port) != port: raise RuntimeError('fault test damaged existing holder')
    print('PASS: existing TCP mappings and traffic preserved across all faults', flush=True)
    print('SCOPE: TCP data-path experiment, no general allocator or watchdog; fallback retains segment limits', flush=True)
    sys.exit(0)
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fallback', action='store_true', help='test early queue plus current segmented fallback')
    args = parser.parse_args()
    if sys.platform != 'linux' or os.geteuid() != 0:
        raise RuntimeError('Linux root and temporary network namespaces are required')
    signal.signal(signal.SIGTERM, lambda signum, _: sys.exit(128 + signum))
    fixture = runpy.run_path(str(Path(__file__).resolve().parents[1] / 'snat-collision.py'))
    client = fixture['CLIENT']
    needle = "_, preferred = dial(31000, destination='203.0.113.3')"
    if client.count(needle) != 1: raise RuntimeError('fixture probe changed')
    prefix = f"q_resume_verdict = {1 if args.fallback else 4}\nreserved = {fixture['RESERVED']!r}\n"
    client = client.replace(needle, prefix + WORKER + '\n' + needle)
    old_success = "if scenario == 'cross-block':\n    print('PASS: this attempt also crossed blocks', flush=True)\n    sys.exit(0)"
    if client.count(old_success) != 1: raise RuntimeError('fixture success branch changed')
    client = client.replace(old_success, FAULTS if args.fallback else SUCCESS)
    old_failure = "print('KNOWN LIMIT: selected block full; other-block free port not searched', flush=True)\n        sys.exit(0)"
    if client.count(old_failure) != 1: raise RuntimeError('fixture limitation branch changed')
    client = client.replace(old_failure, "print('FAIL: queue path did not reach the free port', flush=True)\n        sys.exit(1)")
    fixture['test'].__globals__['CLIENT'] = client
    key = 'ct original ip saddr . ct original ip daddr . ct original proto-src . ct original proto-dst'
    ports = ', '.join(map(str, fixture['ALLOWED']))
    batch = f'''add table inet jpipoe_test
delete table inet jpipoe_test
table inet jpipoe_test {{
 map picks {{ type ipv4_addr . ipv4_addr . inet_service . inet_service : inet_service; flags dynamic; size 128; }}
 chain srcnat {{
  type nat hook postrouting priority 0; policy accept;
  ip protocol tcp oifname e0 tcp sport set {key} map @picks tcp sport {{ {ports} }} delete @picks {{ {key} : tcp sport }} snat ip to 203.0.113.1 : tcp sport
  ip protocol tcp oifname e0 queue num 123
 }}
}}
'''
    if args.fallback:
        source = (fixture['ROOT'] / 'root/usr/libexec/jp-ipoe-map-nft').read_text()
        batch = fixture['generate'](source, fixture['RESERVED'])
        # Only the fixture client is queued; independently pinned holders bypass it.
        # Insert cleanup first, then the valid-selection rule ahead of cleanup.
        batch += f'''
add map inet jpipoe_test picks {{ type ipv4_addr . ipv4_addr . inet_service . inet_service : inet_service; flags dynamic; size 128; }}
insert rule inet jpipoe_test srcnat ip protocol tcp oifname e0 delete @picks {{ {key} : tcp sport }}
insert rule inet jpipoe_test srcnat ip protocol tcp oifname e0 tcp sport set {key} map @picks tcp sport {{ {ports} }} delete @picks {{ {key} : tcp sport }} snat ip to 203.0.113.1 : tcp sport
add chain inet jpipoe_test prealloc {{ type filter hook postrouting priority -2; policy accept; }}
add rule inet jpipoe_test prealloc ip protocol tcp ip saddr 192.0.2.1 oifname e0 ct status & confirmed == 0 queue num 123 bypass
'''
    return fixture['test']('tcp', 'cross-block', batch, batch)


if __name__ == '__main__':
    try: sys.exit(main())
    except (RuntimeError, subprocess.CalledProcessError) as exc:
        print('ERROR:', getattr(exc, 'stderr', None) or str(exc), file=sys.stderr)
        sys.exit(1)
