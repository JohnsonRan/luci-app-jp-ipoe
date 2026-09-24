"""Isolated TCP/IPv4/zone-0 allocator prototype; NOT router/package code.

Used by snat-queue-allocator.py. Requires Linux root, Python and libnftables.
No CLI per connection, no conntrack mutation, no background occupancy estimate.
Only ENOENT from an exact reply-tuple query establishes an available candidate.
Queries are still snapshots: native bypass/custom rules can race allocation.
The kernel remains the final tuple arbiter; whole-pool success is not promised.
"""
import ctypes
import ctypes.util
import errno
import ipaddress
import multiprocessing
from pathlib import Path
import runpy
import socket
import struct
import sys
import threading
import time


def attributes(raw):
    result, pos = {}, 0
    while pos < len(raw):
        if pos + 4 > len(raw):
            raise ValueError('short netlink attribute')
        size, kind = struct.unpack_from('=HH', raw, pos)
        kind &= 0x3fff
        if size < 4 or pos + size > len(raw) or kind in result:
            raise ValueError('invalid/duplicate netlink attribute')
        result[kind] = raw[pos+4:pos+size]
        pos += (size + 3) & ~3
    return result


def attribute(kind, payload):
    size = len(payload) + 4
    return struct.pack('=HH', size, kind) + payload + b'\0' * ((-size) % 4)


def tuple_value(raw):
    parts = attributes(raw)
    ip, proto = attributes(parts[1]), attributes(parts[2])
    if proto[1] != b'\x06':
        raise ValueError('not a TCP tuple')
    return (socket.inet_ntoa(ip[1]), socket.inet_ntoa(ip[2]),
            struct.unpack('!H', proto[2])[0], struct.unpack('!H', proto[3])[0])


class Conntrack:
    def __init__(self):
        self.socket = socket.socket(socket.AF_NETLINK, socket.SOCK_RAW, 12)
        self.socket.bind((0, 0))
        self.sequence = 0
        self.queries = 0

    def lookup(self, remote, public, remote_port, port, deadline):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('conntrack query deadline')
        self.socket.settimeout(min(remaining, 0.02))
        ip = attribute(1, socket.inet_aton(remote)) + attribute(2, socket.inet_aton(public))
        proto = (attribute(1, b'\x06') + attribute(2, struct.pack('!H', remote_port)) +
                 attribute(3, struct.pack('!H', port)))
        reply = attribute(0x8001, ip) + attribute(0x8002, proto)
        body = b'\x02\0\0\0' + attribute(0x8002, reply)  # CTA_TUPLE_REPLY, default zone
        self.sequence += 1
        request = struct.pack('=IHHII', 16+len(body), 0x101, 1, self.sequence, 0) + body
        self.socket.sendto(request, (0, 0))
        self.queries += 1
        data, peer = self.socket.recvfrom(65536)
        if len(data) < 20 or peer[0] != 0:
            raise RuntimeError('invalid conntrack response')
        size, kind, flags, seq, _ = struct.unpack_from('=IHHII', data)
        if size != len(data) or seq != self.sequence:
            raise RuntimeError(f'unexpected conntrack response framing: size={size} length={len(data)} sequence={seq}/{self.sequence} flags={flags}')
        if kind == 2:
            error = struct.unpack_from('=i', data, 16)[0]
            if error == -errno.ENOENT:
                return None
            raise OSError(-error if error < 0 else errno.EPROTO, 'conntrack query failed')
        # ctnetlink_fill_info uses CT_NEW + MULTI even for a single exact GET.
        # ctnetlink_get_conntrack unicasts it without a trailing NLMSG_DONE.
        if kind != 0x100 or flags & ~2:
            raise RuntimeError(f'unexpected conntrack response type/flags: type={kind:#x} flags={flags}')
        fields = attributes(data[20:])
        if tuple_value(fields[2]) != (remote, public, remote_port, port):
            raise RuntimeError('conntrack reply tuple mismatch')
        # Includes TIME_WAIT; no state is excluded as supposedly free.
        return tuple_value(fields[1])

    def close(self):
        self.socket.close()


class Nft:
    def __init__(self):
        path = ctypes.util.find_library('nftables')
        if not path:
            raise RuntimeError('libnftables is required for this isolated prototype')
        self.lib = ctypes.CDLL(path)
        signatures = {
            'nft_ctx_new': ([ctypes.c_uint32], ctypes.c_void_p),
            'nft_ctx_free': ([ctypes.c_void_p], None),
            'nft_ctx_buffer_output': ([ctypes.c_void_p], ctypes.c_int),
            'nft_ctx_buffer_error': ([ctypes.c_void_p], ctypes.c_int),
            'nft_ctx_get_error_buffer': ([ctypes.c_void_p], ctypes.c_char_p),
            'nft_run_cmd_from_buffer': ([ctypes.c_void_p, ctypes.c_char_p], ctypes.c_int),
        }
        for name, (args, result) in signatures.items():
            function = getattr(self.lib, name)
            function.argtypes, function.restype = args, result
        self.ctx = self.lib.nft_ctx_new(0)
        if not self.ctx:
            raise MemoryError('nft context allocation failed')
        if self.lib.nft_ctx_buffer_output(self.ctx) or self.lib.nft_ctx_buffer_error(self.ctx):
            self.close()
            raise RuntimeError('nft output buffering failed')

    def run(self, command):
        if self.lib.nft_run_cmd_from_buffer(self.ctx, command.encode()) != 0:
            error = self.lib.nft_ctx_get_error_buffer(self.ctx)
            raise RuntimeError((error or b'nft update failed').decode(errors='replace'))

    def close(self):
        self.lib.nft_ctx_free(self.ctx)


class Picker:
    def __init__(self, ports, public, conntrack):
        self.ports, self.public, self.ct = ports, public, conntrack
        self.cursor, self.leases = 0, {}

    def choose(self, flow, deadline):
        if len(self.leases) >= 4096:
            return None
        for _ in range(min(64, len(self.ports))):
            port = self.ports[self.cursor]
            self.cursor = (self.cursor + 1) % len(self.ports)
            slot = (flow[1], flow[3], port)
            owner = self.ct.lookup(flow[1], self.public, flow[3], port, deadline)
            if owner is not None:
                if self.leases.get(slot) == owner:
                    del self.leases[slot]
                continue
            if slot not in self.leases:
                self.leases[slot] = flow
                return port
        return None

    def confirm(self, flow, port, deadline):
        slot = (flow[1], flow[3], port)
        if self.ct.lookup(flow[1], self.public, flow[3], port, deadline) == flow:
            self.leases.pop(slot, None)
        # ponytail: unknown confirmation retains a bounded lease, not a guessed
        # timer expiry. A production controller needs reconciled lifecycle state.


def queue_helpers():
    code = runpy.run_path(str(Path(__file__).with_name('snat-queue-path.py')))['WORKER']
    namespace = dict(socket=socket, struct=struct)
    exec(code.split('\ndef queue_worker():')[0], namespace)
    return namespace


def packet_flow(fields):
    packet = fields[10]
    if len(packet) < 40 or packet[0] >> 4 != 4 or packet[9] != 6:
        raise ValueError('not IPv4 TCP')
    ihl = (packet[0] & 15) * 4
    if (ihl < 20 or len(packet) < ihl+20 or
            struct.unpack_from('!H', packet, 6)[0] & 0x3fff or
            packet[ihl+13] & 0x12 != 0x02):
        raise ValueError('not an unfragmented initial TCP SYN')
    ct = attributes(fields[11])  # NFQA_CT is required, not guessed as zone zero.
    if (ct.get(18, b'\0\0') != b'\0\0' or
            attributes(ct[1]).get(3, b'\0\0') != b'\0\0' or
            attributes(ct[2]).get(3, b'\0\0') != b'\0\0'):
        raise ValueError('non-default conntrack zone')
    flow = (socket.inet_ntoa(packet[12:16]), socket.inet_ntoa(packet[16:20]),
            *struct.unpack_from('!HH', packet, ihl))
    if tuple_value(ct[1]) != flow:
        raise ValueError('already translated or mismatched original tuple')
    return flow


def _worker(pipe, ports, public):
    ct, nft, queue = None, None, None
    try:
        ct, nft = Conntrack(), Nft()
        picker = Picker(ports, public, ct)
        helpers = queue_helpers()
        queue = helpers['q_open'](fail_open=True, conntrack=True)
        queue.settimeout(0.02)
        # Refuse Python child-process creation in the connection hot path.
        def no_process(event, args):
            if event in ('subprocess.Popen', 'os.system', 'os.fork', 'os.posix_spawn'):
                raise RuntimeError('per-connection subprocess forbidden')
        sys.addaudithook(no_process)
        pipe.send(('ready', None))
        while True:
            pipe.send(('alive', None))
            try:
                packet_id, fields = helpers['q_receive'](queue, details=True)
            except socket.timeout:
                continue
            start, port, flow = time.monotonic(), None, None
            deadline = start + 0.02
            queries = ct.queries
            outcome = 'fallback'
            try:
                flow = packet_flow(fields)
                port = picker.choose(flow, deadline)
                if port is not None:
                    if time.monotonic() >= deadline:
                        raise TimeoutError('selection deadline')
                    key = f'{flow[0]} . {flow[1]} . {flow[2]} . {flow[3]}'
                    nft.run(f'add element inet jpipoe_test picks {{ {key} : {port} }}\n')
                    outcome = 'selected'
            except (ValueError, KeyError, OSError, RuntimeError) as exc:
                outcome = 'fallback: '+str(exc).split('\n')[0]
                # Do not leave a timed-out netlink response poisoning later queries.
                ct.close()
                ct = Conntrack()
                picker.ct = ct
                queries = 0
            helpers['q_verdict'](queue, packet_id, 1)
            if port is not None and flow is not None:
                try:
                    picker.confirm(flow, port, deadline)
                except (ValueError, KeyError, OSError, RuntimeError):
                    pass  # Retain the unconfirmed lease.
            pipe.send(('result', dict(outcome=outcome, port=port, queries=ct.queries-queries,
                                      elapsed_us=(time.monotonic()-start)*1e6,
                                      leases=len(picker.leases))))
    except BaseException as exc:
        pipe.send(('error', str(exc)))
    finally:
        if queue is not None: queue.close()
        if ct is not None: ct.close()
        if nft is not None: nft.close()
        pipe.close()


class Allocator:
    """One selector process, monitored outside its GIL/libnftables calls.

    A stalled consumer is killed, NOT magically drained: held packets drop,
    while later packets use nft queue bypass and the native segmented rules.
    No automatic restart. Existing conntrack mappings are never modified.
    """
    def __init__(self, ports, reserved=(), public='203.0.113.1', watchdog=0.25):
        values, blocked = list(ports), list(reserved)
        if any(type(p) is not int or not 1 <= p <= 65535 for p in values+blocked):
            raise ValueError('invalid configured port')
        legal = sorted(set(values) - set(blocked))
        if not legal:
            raise ValueError('empty legal pool')
        public = str(ipaddress.IPv4Address(public))
        self.results, self.failure = [], None
        self.stopping = threading.Event()
        context = multiprocessing.get_context('spawn')
        self.pipe, child = context.Pipe(duplex=False)
        self.process = context.Process(target=_worker, args=(child, legal, public), daemon=True)
        self.process.start()
        child.close()
        message = self.pipe.recv() if self.pipe.poll(5) else ('timeout', None)
        if message[0] != 'ready':
            if self.process.is_alive(): self.process.kill()
            self.process.join(); self.pipe.close()
            raise RuntimeError('allocator startup failed: '+str(message))
        self.watcher = threading.Thread(target=self._watch, args=(watchdog,), daemon=True)
        self.watcher.start()

    def _watch(self, deadline):
        last = time.monotonic()
        try:
            while not self.stopping.is_set():
                if self.pipe.poll(0.02):
                    kind, value = self.pipe.recv()
                    last = time.monotonic()
                    if kind == 'result': self.results.append(value)
                    elif kind == 'error':
                        self.failure = value
                        return
                if time.monotonic() - last >= deadline:
                    self.failure = 'watchdog timeout: held packets may drop'
                    self.process.kill()
                    self.process.join(timeout=2)
                    return
        except (EOFError, OSError):
            if not self.stopping.is_set(): self.failure = 'allocator exited'

    def close(self):
        self.stopping.set()
        if self.process.is_alive(): self.process.kill()
        self.process.join(timeout=2)
        self.watcher.join(timeout=2)
        self.pipe.close()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()
