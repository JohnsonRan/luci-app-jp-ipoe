#!/usr/bin/env python3
"""Real-kernel allocator checks (Linux root, iproute2, nft, Python 3).

sudo python3 tests/snat-collision.py
sudo python3 tests/snat-collision.py --scenario cross-block
sudo python3 tests/snat-collision.py --scenario time-wait
sudo python3 tests/snat-collision.py --helper /path/to/old/helper --scenario time-wait

Default: an occupied preferred port must fall back inside its legal block.
Cross-block: explicitly demonstrate the accepted limitation (one-shot failure
with space in another block), NOT a whole-pool allocation guarantee.
Configuration helpers are stubbed; generated rules and TCP/UDP/ICMP use the real
kernel. TCP/UDP mappings survive reservation hot updates and rejected batches.
The TIME_WAIT fixture pins its isolated entry with IPS_FIXED_TIMEOUT, preventing
sequence-dependent kernel eviction from making the collision nondeterministic.
Two temporary namespaces isolate all traffic, routes, sysctls and firewall rules.
"""
import argparse
import json
import os
from pathlib import Path
import re
import selectors
import shutil
import signal
import subprocess
import sys
import uuid

ROOT = Path(__file__).resolve().parents[1]
PORTSETS = '40000-40005 41000-41005'
RESERVED = [40003, 41003]
ALLOWED = [p for p in list(range(40000, 40006)) + list(range(41000, 41006))
           if p not in RESERVED]


def command(*args, input=None):
    return subprocess.run(args, input=input, text=True, capture_output=True,
                          check=True, timeout=20).stdout


def generate(source, reserved):
    source = re.sub(r'^\. .*$', '', source, flags=re.MULTILINE)
    marker = '\ncase "$1" in'
    if marker not in source:
        raise RuntimeError('helper entry point changed; update test adapter')
    mocks = r'''
append() { local old; eval "old=\"\${$1-}\""; eval "$1=\"\$old\${old:+\${3:- }}\$2\""; }
list_contains() { local value; eval "value=\"\${$1-}\""; case " $value " in *" $2 "*) return 0;; *) return 1;; esac; }
jp_forward_select() { return 0; }
nft() { cat; }
'''
    batch = command('sh', '-s', input='set -eu\n' + source.split(marker)[0] + mocks +
                    "\nload_reserved_ports() { DONT_SNAT_TO='%s'; }\n" % ' '.join(map(str, reserved)) +
                    "apply_rules test e0 203.0.113.1 '%s'\n" % PORTSETS)
    # Stable seed only for comparing an old jhash implementation across reloads.
    return re.sub(r'(jhash[^\n]*?mod \d+) map', r'\1 seed 0x12345678 map', batch)


SERVER = r'''
import selectors, socket, struct
sel = selectors.DefaultSelector()
held = []
for kind in ('tcp', 'udp', 'icmp'):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM if kind == 'tcp' else
                      socket.SOCK_DGRAM if kind == 'udp' else socket.SOCK_RAW,
                      socket.IPPROTO_ICMP if kind == 'icmp' else 0)
    s.bind(('0.0.0.0', 0 if kind == 'icmp' else 8000))
    if kind == 'tcp': s.listen(64)
    else: s.setsockopt(socket.IPPROTO_IP, 8, 1)  # Linux IP_PKTINFO: reply from the queried address
    sel.register(s, selectors.EVENT_READ, kind)
    held.append(s)
def checksum(b):
    if len(b) % 2: b += b'\0'
    v = sum(struct.unpack('!%dH' % (len(b)//2), b))
    while v >> 16: v = (v & 65535) + (v >> 16)
    return (~v) & 65535
print('READY', flush=True)
while True:
    for key, _ in sel.select():
        s, kind = key.fileobj, key.data
        if kind == 'tcp':
            c, peer = s.accept()
            c.sendall((str(peer[1])+'\n').encode())
            sel.register(c, selectors.EVENT_READ, 'stream')
        elif kind == 'stream':
            if s.recv(32): s.sendall((str(s.getpeername()[1])+'\n').encode())
            else: sel.unregister(s); s.close()
        elif kind == 'udp':
            _, info, _, peer = s.recvmsg(2048, 128)
            s.sendmsg([(str(peer[1])+'\n').encode()], info, 0, peer)
        else:
            data, info, _, peer = s.recvmsg(2048, 128)
            data = data[(data[0] & 15)*4:]
            if data[0] != 8: continue
            _, _, _, ident, seq = struct.unpack('!BBHHH', data[:8])
            reply = struct.pack('!BBHHH', 0, 0, 0, ident, seq) + str(ident).encode()
            reply = reply[:2] + struct.pack('!H', checksum(reply)) + reply[4:]
            s.sendmsg([reply], info, 0, peer)
'''

CLIENT = r'''
import errno, json, socket, struct, subprocess, sys, time
cfg = json.loads(sys.argv[1])
proto, scenario, allowed = cfg['protocol'], cfg['scenario'], cfg['allowed']
held = []
def apply(batch):
    p = subprocess.run(['nft', '-f', '-'], input=batch, text=True, capture_output=True)
    if p.returncode: raise RuntimeError(p.stderr)
def checksum(b):
    if len(b) % 2: b += b'\0'
    v = sum(struct.unpack('!%dH' % (len(b)//2), b))
    while v >> 16: v = (v & 65535) + (v >> 16)
    return (~v) & 65535

def exchange(s, ident, initial=False):
    if proto == 'tcp':
        if not initial: s.sendall(b'?')
        data = s.recv(32)
    elif proto == 'udp':
        s.send(b'?'); data = s.recv(32)
    else:
        request = struct.pack('!BBHHH', 8, 0, 0, ident, 1) + b'jp-ipoe-test'
        request = request[:2] + struct.pack('!H', checksum(request)) + request[4:]
        s.send(request)
        while True:
            packet = s.recv(2048); packet = packet[(packet[0] & 15)*4:]
            if packet[0] == 0 and struct.unpack('!H', packet[4:6])[0] == ident:
                data = packet[8:]; break
    value = int(data)
    if value not in allowed: raise RuntimeError('forbidden/reserved NAT port: '+str(value))
    return value

def dial(port, destination='203.0.113.2', holder=False, timeout=2):
    kind = socket.SOCK_STREAM if proto == 'tcp' else socket.SOCK_DGRAM if proto == 'udp' else socket.SOCK_RAW
    s = socket.socket(socket.AF_INET, kind, socket.IPPROTO_ICMP if proto == 'icmp' else 0)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.settimeout(timeout)
    s.bind(('192.0.2.2' if holder else '192.0.2.1', 0 if proto == 'icmp' else port))
    held.append(s)
    s.connect((destination, 0 if proto == 'icmp' else 8000))
    return s, exchange(s, port, initial=True)

def pin_time_wait(port):
    # Confirm real TIME_WAIT, then prevent sequence-dependent NAT reclamation.
    # NETLINK_NETFILTER avoids an optional conntrack CLI; only this netns changes.
    def attrs(raw):
        result, pos = {}, 0
        while pos + 4 <= len(raw):
            size, kind = struct.unpack_from('=HH', raw, pos)
            if size < 4: raise RuntimeError('invalid netlink attribute')
            result[kind & 0x3fff] = raw[pos+4:pos+size]
            pos += (size+3) & ~3
        return result
    with socket.socket(socket.AF_NETLINK, socket.SOCK_RAW, 12) as nl:
        nl.settimeout(2)
        nl.bind((0, 0))
        nl.sendto(struct.pack('=IHHII', 20, 0x101, 0x301, 1, 0) + b'\x02\0\0\0', (0, 0))
        while True:
            data = nl.recv(65536)
            pos = 0
            while pos + 16 <= len(data):
                size, kind = struct.unpack_from('=IH', data, pos)
                msg = data[pos+16:pos+size]; pos += (size+3) & ~3
                if kind == 3: return False
                if kind == 2: raise RuntimeError('conntrack netlink error: '+str(msg))
                a = attrs(msg[4:])
                orig = attrs(a.get(1, b'')); ip = attrs(orig.get(1, b''))
                ports = attrs(orig.get(2, b''))
                tcp = attrs(attrs(a.get(4, b'')).get(1, b''))
                if (ip.get(1) == socket.inet_aton('192.0.2.2') and
                    ip.get(2) == socket.inet_aton('203.0.113.2') and
                    # TCP_CONNTRACK_TIME_WAIT is 7 (socket TCP_TIME_WAIT is 6).
                    ports.get(2) == struct.pack('!H', port) and tcp.get(1) == b'\x07'):
                    status = struct.unpack('!I', a[3])[0]
                    if status & (1 << 10): return True  # IPS_FIXED_TIMEOUT
                    # Preserve the original tuple/status; do not forge TCP state.
                    body = (b'\x02\0\0\0' + struct.pack('=HH', len(a[1])+4, 0x8001) + a[1] +
                            struct.pack('=HH', 8, 3) + struct.pack('!I', status | (1 << 10)))
                    with socket.socket(socket.AF_NETLINK, socket.SOCK_RAW, 12) as update:
                        update.settimeout(2)
                        update.bind((0, 0))
                        update.sendto(struct.pack('=IHHII', 16+len(body), 0x100, 5, 1, 0) + body, (0, 0))
                        ack = update.recv(65536)
                        if (len(ack) < 20 or struct.unpack_from('=H', ack, 4)[0] != 2 or
                            struct.unpack_from('=i', ack, 16)[0] != 0):
                            raise RuntimeError('failed to pin isolated TIME_WAIT entry')
                    return False  # Verify the flag in a fresh dump before proceeding.

_, preferred = dial(31000, destination='203.0.113.3')
# Find its maximal contiguous legal block, without assuming source-port preservation.
lo = hi = preferred
while lo-1 in allowed: lo -= 1
while hi+1 in allowed: hi += 1
free = next(p for p in allowed if p != preferred and
            ((lo <= p <= hi) if scenario != 'cross-block' else not lo <= p <= hi))
holders = []
for port in allowed:
    if port == free: continue
    s, mapped = dial(port, holder=True)
    if mapped != port: raise RuntimeError('fixture failed to occupy port '+str(port))
    holders.append((s, port))
if scenario == 'time-wait':
    old = next(s for s, p in holders if p == preferred)
    old.shutdown(socket.SHUT_WR)
    if old.recv(32) != b'': raise RuntimeError('holder close did not complete')
    holders = [(s, p) for s, p in holders if p != preferred]
    deadline = time.monotonic() + 2
    while not pin_time_wait(preferred):
        if time.monotonic() >= deadline: raise RuntimeError('pinned conntrack TIME_WAIT was not observed')
        time.sleep(0.01)
    old.close()
    print('CONFIRMED: preferred port '+str(preferred)+' is held by pinned conntrack TIME_WAIT', flush=True)
# New allocator restarts at the same block; old jhash retains the fixture seed.
# Existing probe/holder conntrack entries deliberately remain live.
apply(cfg['batch'])
print(json.dumps({'protocol': proto, 'scenario': scenario, 'preferred': preferred,
                  'only_free': free}), flush=True)
try:
    # Cross-block checks a single attempt, before TCP's first 1-second retransmit.
    live, mapped = dial(31000, timeout=0.35 if scenario == 'cross-block' else 2)
except OSError as exc:
    # nf_hook_slow returns EPERM for NF_DROP; local UDP/raw sends expose it
    # synchronously, while TCP connect waits for a reply and times out.
    expected_drop = isinstance(exc, TimeoutError) or (proto in ('udp', 'icmp') and exc.errno == errno.EPERM)
    if scenario == 'cross-block' and expected_drop:
        print('KNOWN LIMIT: selected block full; other-block free port not searched', flush=True)
        sys.exit(0)
    print('FAIL: occupied preferred port did not fall back: '+str(exc), flush=True)
    sys.exit(1)
if mapped != free: raise RuntimeError('did not use the only free legal port')
print('PASS: real '+proto+' collision fallback to '+str(mapped), flush=True)
if scenario == 'cross-block':
    print('PASS: this attempt also crossed blocks', flush=True)
    sys.exit(0)

# Remove and restore a reservation, merging/splitting blocks without renumbering
# existing NAT mappings. No conntrack deletions or interface restarts are used.
for batch in (cfg['expanded'], cfg['batch']):
    apply(batch)
    if exchange(live, 31000) != mapped: raise RuntimeError('hot update changed live mapping')
    for sock, port in holders:
        if exchange(sock, port) != port: raise RuntimeError('hot update changed holder mapping')
print('PASS: reservation removal/addition preserved established '+proto+' traffic', flush=True)
before = subprocess.check_output(['nft', '-j', 'list', 'table', 'inet', 'jpipoe_test'])
bad = subprocess.run(['nft', '-f', '-'], input=cfg['batch']+'invalid nft statement\n',
                     text=True, capture_output=True)
if bad.returncode == 0: raise RuntimeError('invalid transaction accepted')
after = subprocess.check_output(['nft', '-j', 'list', 'table', 'inet', 'jpipoe_test'])
if before != after: raise RuntimeError('failed transaction changed live rules')
if exchange(live, 31000) != mapped: raise RuntimeError('failed batch interrupted traffic')
print('PASS: rejected transaction left rules and '+proto+' connection intact', flush=True)
'''


def test(protocol, scenario, batch, expanded):
    prefix = 'jpct-' + uuid.uuid4().hex[:8]
    router, server = prefix + '-r', prefix + '-s'
    owned, process = [], None
    try:
        for ns in (router, server):
            command('ip', 'netns', 'add', ns); owned.append(ns)
            command('ip', '-n', ns, 'link', 'set', 'lo', 'up')
        command('ip', '-n', router, 'link', 'add', 'e0', 'type', 'veth',
                'peer', 'name', 'e0', 'netns', server)
        for ns, address in ((router, '203.0.113.1/24'), (server, '203.0.113.2/24')):
            command('ip', '-n', ns, 'addr', 'add', address, 'dev', 'e0')
            command('ip', '-n', ns, 'link', 'set', 'e0', 'up')
        command('ip', '-n', server, 'addr', 'add', '203.0.113.3/24', 'dev', 'e0')
        for ip in ('192.0.2.1', '192.0.2.2'):
            command('ip', '-n', router, 'addr', 'add', ip+'/32', 'dev', 'lo')
        command('ip', 'netns', 'exec', server, 'sh', '-c',
                'echo 1 > /proc/sys/net/ipv4/icmp_echo_ignore_all')
        # Pin fixture holders BEFORE the production table, on a separate source
        # address. This models pre-existing conntrack mappings independently of
        # whether the allocator chooses to preserve a legal source port.
        command('ip', 'netns', 'exec', router, 'nft', '-f', '-', input='''
table inet holders {
 chain srcnat {
  type nat hook postrouting priority -1; policy accept;
  ip saddr 192.0.2.2 ip protocol tcp snat ip to 203.0.113.1 : tcp sport
  ip saddr 192.0.2.2 ip protocol udp snat ip to 203.0.113.1 : udp sport
''' + ''.join('  ip saddr 192.0.2.2 ip protocol icmp icmp id %d snat ip to 203.0.113.1 : %d\n' % (p, p) for p in ALLOWED) + '''
 }
}
''')
        command('ip', 'netns', 'exec', router, 'nft', '-f', '-', input=batch)
        process = subprocess.Popen(['ip', 'netns', 'exec', server, sys.executable,
                                    '-u', '-c', SERVER], stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, text=True)
        with selectors.DefaultSelector() as ready:
            ready.register(process.stdout, selectors.EVENT_READ)
            if not ready.select(5) or process.stdout.readline().strip() != 'READY':
                raise RuntimeError('isolated responder failed to start')
        cfg = dict(protocol=protocol, scenario=scenario, allowed=ALLOWED,
                   batch=batch, expanded=expanded)
        result = subprocess.run(['ip', 'netns', 'exec', router, sys.executable,
                                 '-u', '-c', CLIENT, json.dumps(cfg)],
                                text=True, capture_output=True, timeout=30)
        print(result.stdout, end=''); print(result.stderr, end='', file=sys.stderr)
        return result.returncode
    finally:
        if process is not None:
            process.terminate()
            try: process.wait(timeout=3)
            except subprocess.TimeoutExpired: process.kill(); process.wait()
        for ns in reversed(owned): command('ip', 'netns', 'delete', ns)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--helper', type=Path, default=ROOT/'root/usr/libexec/jp-ipoe-map-nft')
    parser.add_argument('--protocol', choices=['tcp', 'udp', 'icmp', 'all'], default='all')
    parser.add_argument('--scenario', choices=['within-block', 'cross-block', 'time-wait'], default='within-block')
    args = parser.parse_args()
    if sys.platform != 'linux' or os.geteuid() != 0:
        parser.error('run as root on Linux; network namespaces are required')
    for tool in ('ip', 'nft', 'sh'):
        if not shutil.which(tool): parser.error('missing tool: '+tool)
    signal.signal(signal.SIGTERM, lambda signum, _: sys.exit(128+signum))
    source = args.helper.read_text()
    batch, expanded = generate(source, RESERVED), generate(source, RESERVED[1:])
    if args.scenario == 'time-wait' and args.protocol not in ('tcp', 'all'):
        parser.error('TIME_WAIT scenario requires TCP')
    protocols = ['tcp'] if args.scenario == 'time-wait' else (['tcp', 'udp', 'icmp'] if args.protocol == 'all' else [args.protocol])
    for proto in protocols:
        result = test(proto, args.scenario, batch, expanded)
        if result: return result
    return 0


if __name__ == '__main__':
    try: sys.exit(main())
    except (RuntimeError, subprocess.SubprocessError) as error:
        print('ERROR:', error, file=sys.stderr)
        if isinstance(error, subprocess.CalledProcessError): print(error.stderr, file=sys.stderr)
        sys.exit(2)
