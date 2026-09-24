#!/usr/bin/env python3
"""Check readiness against actual nft JSON using native ucode, in a temporary netns.

sudo python3 tests/snat-checker.py [--ucode /path/to/ucode-wrapper]
Requires Linux root, iproute2, nft, ucode + its fs module, and Python 3.
No packages are installed and no host firewall is changed.
"""
import argparse
import copy
import json
import os
from pathlib import Path
import re
import runpy
import signal
import subprocess
import sys
import uuid


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ucode', default='ucode')
    args = parser.parse_args()
    if sys.platform != 'linux' or os.geteuid() != 0:
        parser.error('Linux root and network namespaces are required')
    fixture = runpy.run_path(str(Path(__file__).with_name('snat-collision.py')))
    command = fixture['command']
    helper = (fixture['ROOT'] / 'root/usr/libexec/jp-ipoe-map-nft').read_text()
    program = re.search(r"ucode -e '([^']+)'", helper).group(1)
    signal.signal(signal.SIGTERM, lambda signum, _: sys.exit(128 + signum))
    ns = 'jpc-' + uuid.uuid4().hex[:8]
    command('ip', 'netns', 'add', ns)
    try:
        for reserved in ([40003, 41003], [40001, 40003, 41003]):
            batch = fixture['generate'](helper, reserved)
            command('ip', 'netns', 'exec', ns, 'nft', '-f', '-', input=batch)
            raw = command('ip', 'netns', 'exec', ns, 'nft', '-j', 'list', 'table', 'inet', 'jpipoe_test')
            state = json.loads(raw)
            allowed = [p for p in list(range(40000, 40006)) + list(range(41000, 41006)) if p not in reserved]
            ranges = []
            for p in allowed:
                if ranges and ranges[-1][1] == p - 1: ranges[-1][1] = p
                else: ranges.append([p, p])
            def check(name, data, expected):
                result = subprocess.run([args.ucode, '-e', program, json.dumps(ranges), 'e0', '203.0.113.1'],
                                        input=json.dumps(data), text=True, capture_output=True, timeout=10)
                if (result.returncode == 0) != expected:
                    raise RuntimeError(name + ': unexpected exit ' + str(result.returncode) + '\n' + result.stderr)
                print('PASS checker:', name)
            check('accept actual kernel rules, reservations '+str(reserved), state, True)

            def mutated():
                data = copy.deepcopy(state)
                rules = [x['rule'] for x in data['nftables'] if 'rule' in x]
                base = [r for r in rules if r['chain'] == 'srcnat']
                pool = [r for r in rules if r['chain'] == 'pool_0']
                return data, base, pool
            data, base, pool = mutated()
            pool[0]['expr'][-1]['snat']['port'] = 40003
            check('reject reserved port', data, False)
            data, base, pool = mutated()
            pool[0]['expr'][-1]['snat']['addr'] = '203.0.113.99'
            check('reject wrong public IP', data, False)
            data, base, pool = mutated()
            base[0]['expr'][-1]['vmap']['key']['numgen']['mod'] += 1
            check('reject wrong modulus', data, False)
            data, base, pool = mutated()
            base[0]['expr'][-1]['vmap']['key']['numgen']['mode'] = 'random'
            check('reject wrong allocation mode', data, False)
            data, base, pool = mutated()
            base[0]['expr'][-1]['vmap']['data']['set'][0][1]['jump']['target'] = 'wrong'
            check('reject wrong dispatch target', data, False)
            data, base, pool = mutated()
            base[0]['expr'][1]['match']['right'] = 'wrong-device'
            check('reject wrong interface', data, False)
            data, base, pool = mutated()
            del pool[0]['expr'][0]
            check('reject missing protocol guard', data, False)
            data, base, pool = mutated()
            base[2]['expr'][1]['match']['op'] = '!='
            check('reject inverted echo guard', data, False)
            data, base, pool = mutated()
            data['nftables'].append({'rule': copy.deepcopy(pool[0])})
            check('reject extra rule', data, False)
            data, base, pool = mutated()
            data['nftables'].append({'chain': {'name': 'stale'}})
            check('reject leftover chain', data, False)
    finally:
        command('ip', 'netns', 'delete', ns)


if __name__ == '__main__':
    try: main()
    except (RuntimeError, subprocess.SubprocessError) as error:
        print('ERROR:', error, file=sys.stderr)
        if isinstance(error, subprocess.CalledProcessError): print(error.stderr, file=sys.stderr)
        sys.exit(1)
