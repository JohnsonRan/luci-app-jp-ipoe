// Dependency-free checks: node tests/port-forwarding.cjs (requires POSIX sh + awk).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const root = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-forward-')).replace(/\\/g, '/');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const stripSources = s => s.replace(/^\. .*$/gm, '');
const library = stripSources(read('root/usr/share/jp-ipoe/config.sh')) + '\n' +
  stripSources(read('root/usr/share/jp-ipoe/forward.sh')).replaceAll('/proc/net/', tmp + '/proc/');
const command = stripSources(read('root/usr/libexec/jp-ipoe-forward')).split('\njp_ipoe_config_load\ncase ')[0]
  .replaceAll('/proc/sys/kernel/random/uuid', tmp + '/uuid');
const nft = stripSources(read('root/usr/libexec/jp-ipoe-map-nft')).split('\ncase "$1" in')[0];
const info = stripSources(read('root/usr/libexec/jp-ipoe-info')).split('\ncase "$1" in')[0]
  .replaceAll('/proc/sys/net/netfilter/', tmp + '/netfilter/');
let count = 0;

// config_load deliberately replaces current sections, as on OpenWrt. This
// catches callbacks accidentally losing their own fields during nested loads.
const mocks = `
fail() { echo "FAIL: $*" >&2; exit 1; }
append() { local old; eval "old=\\\"\\\${$1-}\\\""; eval "$1=\\\"\\$old\\\${old:+\\\${3:- }}\\$2\\\""; }
list_contains() { local value; eval "value=\\\"\\\${$1-}\\\""; case " $value " in *" $2 "*) return 0;; *) return 1;; esac; }
config_load() { CURRENT_PACKAGE="$1"; eval "CONFIG_SECTIONS=\\\"\\\${DB_@PACKAGE@sections-}\\\""; }
config_get() { local v; eval "v=\\\"\\\${DB_@PACKAGE@$2_$3-\\$4}\\\""; export "$1=$v"; }
config_get_bool() { config_get "$@"; }
config_foreach() { local cb="$1" type="$2" section kind sections="$CONFIG_SECTIONS"; shift 2
 for section in $sections; do config_get kind "$section" TYPE ''; if [ "$kind" = "$type" ]; then "$cb" "$section" "$@"; fi; done; return 0; }
network_get_subnet() { export "$1=192.168.1.1/24"; }
network_get_ipaddr() { export "$1=192.168.1.1"; }
network_get_device() { [ "$2" = lan ] || return 1; export "$1=br-lan"; }
ip() { [ "$1 $2 $3" = '-4 route get' ] || fail "unexpected ip $*"; printf '%s dev br-lan src 192.168.1.1\\n' "$4"; }
network_flush_cache() { :; }
network_is_up() { return 0; }
logger() { :; }
pidof() { return 1; }
json_init() { :; }
json_add_object() { echo object; }
json_add_string() { printf '%s=%s\\n' "$1" "$2"; }
json_add_boolean() { json_add_string "$@"; }
json_add_array() { :; }
json_close_array() { :; }
json_close_object() { echo end; }
json_dump() { :; }
DB_jp_ipoe_sections='config saved other'
DB_jp_ipoe_config_TYPE=jp_ipoe
DB_jp_ipoe_config_dont_snat_to=1000
DB_jp_ipoe_saved_TYPE=forward
DB_jp_ipoe_saved_iface=wan6mape
DB_jp_ipoe_saved_public_ip=203.0.113.1
DB_jp_ipoe_saved_external_port=1001
DB_jp_ipoe_saved_internal_ip=192.168.1.10
DB_jp_ipoe_saved_internal_port=8080
DB_jp_ipoe_saved_proto=tcp
DB_jp_ipoe_other_TYPE=forward
DB_jp_ipoe_other_iface=another
DB_jp_ipoe_other_external_port=1003
DB_firewall_sections='wan lan redirect'
DB_firewall_wan_TYPE=zone
DB_firewall_wan_name=wan
DB_firewall_wan_network='wan wan6 wan6mape'
DB_firewall_lan_TYPE=zone
DB_firewall_lan_name=lan
DB_firewall_lan_network=lan
DB_firewall_redirect_TYPE=redirect
DB_firewall_redirect_src_dport=1002:1003
DB_firewall_redirect_proto=udp
JP_FORWARD_BUSY='tcp 1004
udp 1005'
MAPE_IFACE=wan6mape
`.replaceAll('@PACKAGE@', '${CURRENT_PACKAGE}_');

function run(name, body, extra = '') {
  const r = cp.spawnSync('sh', ['-s'], {
    cwd: root, input: mocks + '\n' + library + '\n' + extra + '\n' + body,
    encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', TEST_TMP: tmp }
  });
  assert.equal(r.status, 0, `${name}\n${r.stdout}\n${r.stderr}\n${r.error || ''}`);
  count++;
  console.log('PASS', name);
  return r.stdout;
}

async function main() {
try {
  fs.writeFileSync(tmp + '/uuid', '00000000-0000-0000-0000-000000000001\n');
  fs.mkdirSync(tmp + '/proc');
  fs.mkdirSync(tmp + '/netfilter');
  fs.writeFileSync(tmp + '/netfilter/nf_conntrack_count', '0\n');
  fs.writeFileSync(tmp + '/netfilter/nf_conntrack_max', '30720\n');
  for (const p of ['tcp', 'tcp6', 'udp', 'udp6']) fs.writeFileSync(tmp + '/proc/' + p,
    'sl local_address rem_address st\n' + (p === 'tcp6' ? '0: 00000000000000000000000000000000:1F90 0:0000 0A\n' : ''));

  run('ports: bounds, strict input, noncontiguous ranges, exhaustion', `
for p in 1 8080 65535; do jp_forward_port_valid "$p" || fail "$p"; done
for p in '' 0 65536 01 1.5 -1 '1;id' '1000-1001'; do jp_forward_port_valid "$p" && fail "accepted $p"; done
[ "$(jp_forward_select '1000-1003 2000-2001' '1000 1001:1003' '')" = 2000 ] || fail select
jp_forward_select '1000-1003 2000-2001' '' 1500 && fail gap
jp_forward_select '1000-1001' '1000-1001' '' && fail exhaustion
for bad in '0-2' '3-2' '1-65536' '1;id' '01' '!1000' '1-2-3'; do
 jp_forward_select "$bad" '' '' && fail "accepted $bad"
done
jp_forward_select '1-3' '!2' '' && fail malformed-blocked
exit 0
`);

  run('IPv4: strict syntax and LAN host boundary', `
for ip in 192.168.1.10 203.0.113.1; do jp_forward_ipv4_valid "$ip" || fail "$ip"; done
for ip in '' 1.2.3 1.2.3.256 01.2.3.4 '1.2.3.4;id' 127.0.0.1 224.0.0.1; do jp_forward_ipv4_valid "$ip" && fail "$ip"; done
jp_forward_ipv4_valid '192.168.1.10
192.168.1.11' && fail multiline
jp_forward_lan_valid 192.168.1.10 || fail lan
for ip in 192.168.2.10 192.168.1.0 192.168.1.255 192.168.1.1; do jp_forward_lan_valid "$ip" && fail "$ip"; done
exit 0
`);

  run('IPv4 FIB: direct LAN only; reject gateways, local/foreign/unknown routes and failed inspection', `
ip() { printf '%s\\n' "$ROUTE"; }
ROUTE='192.168.1.10 dev br-lan src 192.168.1.1 uid 0'
jp_forward_lan_valid 192.168.1.10 || fail direct
for ROUTE in '' 'local 192.168.1.10 dev lo' 'broadcast 192.168.1.10 dev br-lan' \
 '192.168.1.10 dev eth0' '192.168.1.10 via 192.168.1.2 dev br-lan' \
 '192.168.1.10 dev br-lan via 192.168.1.2' 'unreachable 192.168.1.10' \
 '192.168.1.11 dev br-lan' '192.168.1.10 src 192.168.1.1'; do
 jp_forward_lan_valid 192.168.1.10 && fail "unsafe route $ROUTE"
done
ip() { return 1; }
jp_forward_lan_valid 192.168.1.10 && fail failed-query
network_get_device() { return 1; }
ip() { fail should-not-query; }
jp_forward_lan_valid 192.168.1.10 && fail missing-device
exit 0
`);

  const stats = run('conntrack diagnostics: complete per-CPU sums preserve zero and large counters', `
conntrack() { [ "$*" = -S ] || fail mutation; printf '%s\\n' \
 'cpu=0 insert_failed=3000000000 drop=2 early_drop=0 found=8' \
 'cpu=1 early_drop=0 drop=3 insert_failed=4000000000'; }
jp_ipoe_info_conntrack
`, info);
  assert.match(stats, /^count=0$/m);
  assert.match(stats, /^max=30720$/m);
  assert.match(stats, /^insert_failed=7000000000$/m);
  assert.match(stats, /^drop=5$/m);
  assert.match(stats, /^early_drop=0$/m);

  run('conntrack diagnostics: empty, partial, malformed and failed dumps remain unavailable', `
conntrack() { printf '%s\\n' "$STATS"; }
for STATS in '' 'error reading stats' 'cpu=0 insert_failed=0 drop=0' \
 'cpu=0 insert_failed=-1 drop=0 early_drop=0' 'cpu=0 insert_failed=1.5 drop=0 early_drop=0' \
 'cpu=0 insert_failed=bad drop=0 early_drop=0' 'cpu=0 insert_failed=0 drop=0 early_drop=0 drop=1' \
 'cpu=0 insert_failed=0 drop=0 early_drop=0
cpu=0 insert_failed=0 drop=0 early_drop=0' \
 'cpu=0 insert_failed=0 drop=0 early_drop=0
cpu=1 drop=0 early_drop=0'; do
 output="$(jp_ipoe_info_conntrack)" || fail unavailable-broke-status
 for key in insert_failed drop early_drop; do
  printf '%s\\n' "$output" | grep -q "^$key=$" || fail "guessed $key from $STATS"
 done
done
for rc in 1 127; do
 conntrack() { echo 'cpu=0 insert_failed=0 drop=0 early_drop=0'; return "$rc"; }
 output="$(jp_ipoe_info_conntrack)" || fail command-failure
 printf '%s\\n' "$output" | grep -q '^insert_failed=$' || fail partial-command-output
done
`, info);

  run('conntrack diagnostics: missing or malformed sysctls do not become zero', `
conntrack() { return 1; }
printf 'invalid\\n' > "$TEST_TMP/netfilter/nf_conntrack_count"
rm "$TEST_TMP/netfilter/nf_conntrack_max"
output="$(jp_ipoe_info_conntrack)" || fail unavailable-broke-status
printf '%s\\n' "$output" | grep -q '^count=$' || fail malformed-count
printf '%s\\n' "$output" | grep -q '^max=$' || fail absent-limit
printf '0\\n' > "$TEST_TMP/netfilter/nf_conntrack_count"
printf '30720\\n' > "$TEST_TMP/netfilter/nf_conntrack_max"
`, info);

  const partialStatus = run('status remains readable when optional conntrack inspection fails', `
network_get_subnet6() { export "$1=2001:db8::/64"; }
uci() { return 1; }
conntrack() { return 1; }
jp_ipoe_info_status wan6 wan6mape 2001:db8::1
`, info);
  assert.match(partialStatus, /^mape_state=up$/m);
  assert.match(partialStatus, /^wan6_ipv6=2001:db8::\/64$/m);
  assert.match(partialStatus, /^insert_failed=$/m);

  run('reservation union preserves manual ports and interface scope', `
jp_forward_reserved wan6mape
[ "$JP_FORWARD_RESERVED" = '1000 1001' ] || fail "$JP_FORWARD_RESERVED"
[ "$DB_jp_ipoe_config_dont_snat_to" = 1000 ] || fail changed-manual
jp_forward_reserved another
[ "$JP_FORWARD_RESERVED" = '1000 1003' ] || fail other-interface
jp_forward_reserved wan6mape 203.0.113.2
[ "$JP_FORWARD_RESERVED" = 1000 ] || fail stale-allocation
`);

  run('protocol-aware conflicts, ranges, disabled rules and self exclusion', `
jp_forward_blocked wan6mape tcp ''
[ "$(jp_forward_select '1001-1005' "$JP_FORWARD_BLOCKED" '')" = 1002 ] || fail tcp
jp_forward_blocked wan6mape udp ''
[ "$(jp_forward_select '1001-1005' "$JP_FORWARD_BLOCKED" '')" = 1001 ] || fail udp-share
jp_forward_blocked wan6mape tcpudp ''
jp_forward_select '1001-1005' "$JP_FORWARD_BLOCKED" '' && fail combined
jp_forward_blocked wan6mape tcp saved
jp_forward_select '1001-1005' "$JP_FORWARD_BLOCKED" 1001 >/dev/null || fail self
DB_firewall_redirect_enabled=0
jp_forward_blocked wan6mape udp ''
jp_forward_select '1002-1003' "$JP_FORWARD_BLOCKED" '' >/dev/null || fail disabled
DB_firewall_redirect_enabled=1; DB_firewall_redirect_src_dport=''
jp_forward_blocked wan6mape udp ''
jp_forward_select '1001-1005' "$JP_FORWARD_BLOCKED" '' && fail wildcard
exit 0
`);

  run('kernel snapshot: NAT reply port, original source, IPv6 bindings, failure', `
conntrack() { printf '%s\\n' \
 'tcp 6 100 ESTABLISHED src=192.168.1.20 dst=1.1.1.1 sport=50000 dport=443 src=1.1.1.1 dst=203.0.113.1 sport=443 dport=24080 [ASSURED]' \
 'udp 17 100 src=203.0.113.1 dst=1.1.1.1 sport=24081 dport=53 src=1.1.1.1 dst=203.0.113.1 sport=53 dport=24081' \
 'tcp 6 100 src=1.1.1.1 dst=203.0.113.1 sport=50000 dport=24082 src=192.168.1.10 dst=1.1.1.1 sport=8080 dport=50000'; }
jp_forward_busy 203.0.113.1 || fail snapshot
printf '%s\\n' "$JP_FORWARD_BUSY" | grep -q '^tcp 24080$' || fail reply-port
printf '%s\\n' "$JP_FORWARD_BUSY" | grep -q '^udp 24081$' || fail original-port
printf '%s\\n' "$JP_FORWARD_BUSY" | grep -q '^tcp 8080$' || fail ipv6-bind
printf '%s\\n' "$JP_FORWARD_BUSY" | grep -q '24082' && fail inbound-not-outbound
conntrack() { return 1; }
jp_forward_busy 203.0.113.1 && fail unavailable
pidof() { return 0; }
conntrack() { fail should-not-run; }
jp_forward_busy 203.0.113.1 && fail upnp
exit 0
`);

  const emitted = run('netifd redirects: valid only; incompatible allocation and conflicts suspended', `
jp_forward_busy() { JP_FORWARD_BUSY=''; }
echo VALID
jp_forward_emit wan6mape 203.0.113.1 '1000-1005'
echo WRONG_IP
jp_forward_emit wan6mape 203.0.113.2 '1000-1005'
echo WRONG_PORT
jp_forward_emit wan6mape 203.0.113.1 '2000-2005'
echo WRONG_ROUTE
ip() { echo '192.168.1.10 dev eth0'; }
jp_forward_emit wan6mape 203.0.113.1 '1000-1005'
echo BUSY
ip() { printf '%s dev br-lan\\n' "$4"; }
jp_forward_busy() { JP_FORWARD_BUSY='tcp 1001'; }
jp_forward_emit wan6mape 203.0.113.1 '1000-1005'
echo UNAVAILABLE
jp_forward_busy() { return 1; }
jp_forward_emit wan6mape 203.0.113.1 '1000-1005'
`);
  assert.match(emitted, /name=jp_ipoe_saved/);
  assert.match(emitted, /src=wan\ndest=lan\nsrc_dip=203.0.113.1\nsrc_dport=1001\ndest_ip=192.168.1.10\ndest_port=8080/);
  assert.equal((emitted.match(/type=redirect/g) || []).length, 1);

  const rendered = run('shared render: explicit bounds, stable sections, single-rule scope and empty list', `
json_init() { echo INIT; }
json_add_array() { echo "$1["; }
json_close_array() { echo ']'; }
json_dump() { echo DUMP; }
jp_forward_busy() { :; }
jp_forward_emit_cb() {
 [ "$JP_EMIT_IFACE/$JP_EMIT_PUBLIC/$JP_EMIT_RANGES" = 'wan6mape/203.0.113.1/1000-1005' ] || fail bounds
 echo "$1"
 config_load firewall
}
jp_forward_render wan6mape 203.0.113.1 '1000-1005'
jp_forward_render wan6mape 203.0.113.1 '1000-1005' saved
DB_jp_ipoe_sections=config
jp_forward_busy() { fail unexpected-inspection; }
jp_forward_render wan6mape 203.0.113.1 '1000-1005'
`);
  assert.equal(rendered, 'INIT\nfirewall[\nsaved\nother\n]\nDUMP\nINIT\nfirewall[\nsaved\n]\nDUMP\nINIT\nfirewall[\n]\nDUMP\n');

  const protocol = read('root/usr/share/jp-ipoe/map.sh')
    .replace(/^\. \/usr\/share\/jp-ipoe\/forward\.sh$/m, '')
    .replaceAll('/tmp/map-', tmp + '/map-');
  const integration = run('full protocol: commit reserved SNAT before dynamic redirect and update', `
json_get_vars() { local v; for v in "$@"; do case "$v" in
 maptype) export "$v=map-e";; tunlink) export "$v=wan6";; zone) export "$v=wan";; *) export "$v=";; esac; done; }
mapcalc() { echo 'RULE_BMR=1 RULE_COUNT=1 RULE_1_IPV4ADDR=203.0.113.1 RULE_1_IPV6ADDR=2001:db8::1 RULE_1_BR=2001:db8::2 RULE_1_PD6IFACE=wan6 RULE_1_PORTSETS="1000-1005"'; }
for fn in proto_add_host_dependency proto_init_update proto_add_ipv4_address proto_add_tunnel proto_close_tunnel proto_add_ipv4_route proto_add_data proto_close_data proto_block_restart ubus; do eval "$fn() { :; }"; done
proto_notify_error() { echo "ERROR=$2"; }
proto_send_update() { echo PUBLISHED; }
jp_forward_busy() { JP_FORWARD_BUSY=''; }
nft() { cat > "$TEST_TMP/protocol-nft"; echo SNAT_COMMIT; }
jp_ipoe_run_helper() { shift; apply_rules "$@"; }
echo SUCCESS
proto_map_setup wan6mape wan6mape
echo NFT_FAILURE
nft() { cat >/dev/null; return 1; }
proto_map_setup wan6mape wan6mape
`, nft + '\nINCLUDE_ONLY=1\n' + protocol);
  assert(integration.indexOf('SNAT_COMMIT') < integration.indexOf('type=redirect'));
  assert(integration.indexOf('type=redirect') < integration.indexOf('PUBLISHED'));
  assert.match(integration, /ERROR=INVALID_PORTSETS/);
  assert.equal((integration.match(/PUBLISHED/g) || []).length, 1);
  assert.match(fs.readFileSync(tmp + '/protocol-nft', 'utf8'), /snat ip to 203\.0\.113\.1 : 1002-1005/);

  const batch = run('SNAT excludes manual and managed ports, keeps all other ranges, atomic replace', `
nft() { [ "$1" = '-f' ] || fail "non-atomic $*"; cat; }
apply_rules wan6mape map-wan6mape 203.0.113.1 '1000-1003 2000-2001' || fail apply
`, nft);
  assert.match(batch, /add table inet jpipoe_wan6mape\ndelete table inet jpipoe_wan6mape\nadd table inet jpipoe_wan6mape/);
  assert.match(batch, /numgen inc mod 2 vmap \{ 0 : jump pool_0, 1 : jump pool_1 \}/);
  assert.equal((batch.match(/snat ip to 203\.0\.113\.1 : 1002-1003/g) || []).length, 3);
  assert.equal((batch.match(/snat ip to 203\.0\.113\.1 : 2000-2001/g) || []).length, 3);
  assert.doesNotMatch(batch, / : 100[01](?:,| |\n)/);
  assert.doesNotMatch(batch, /jhash|snat ip to [^\n]+ : (?:tcp|udp) sport/);

  run('SNAT grouping splits reservations, normalizes overlaps, handles singleton and bounds', `
DONT_SNAT_TO='1001 1003'
build_ranges '2000 1000-1005 1004-1005' || fail group
[ "$RANGELIST" = '[1000,1000],[1002,1002],[1004,1005],[2000,2000]' ] || fail "$RANGELIST"
[ "$RANGECOUNT" = 4 ] || fail count
DONT_SNAT_TO=''
build_ranges '65534-65535 1 2' || fail bounds
[ "$RANGELIST" = '[1,2],[65534,65535]' ] || fail "$RANGELIST"
DONT_SNAT_TO='1 2'
build_ranges '1-2' && fail empty
exit 0
`, nft);

  run('SNAT exhaustion and nft failure propagate without a separate delete command', `
nft() { [ "$1" = '-f' ] || fail non-atomic; cat >/dev/null; return 1; }
apply_rules wan6mape map-wan6mape 203.0.113.1 '1000-1001' && fail empty
apply_rules wan6mape map-wan6mape 203.0.113.1 '1000-1003' && fail nft-error
exit 0
`, nft);

  const cliMocks = command + `
uci() { printf '%s\\n' "$*" >> "$TEST_TMP/uci-log"; [ "$1" != add ] || echo created;
 case "$*" in '-q get network.wan6mape.proto') echo map;; '-q get network.wan6mape.maptype') echo map-e;; esac; return 0; }
jp_forward_runtime() { JP_PUBLIC=203.0.113.1; JP_RANGES='1000-1005'; JP_LINK=map-wan6mape; }
jp_forward_busy() { JP_FORWARD_BUSY='tcp 1004'; }
jp_forward_refresh_snat() { echo snat >> "$TEST_TMP/uci-log"; }
jp_forward_render() { echo ready; }
jp_forward_contains() { [ "$1" = ready ]; }
jp_forward_publish() { case "$2" in
 '{"firewall":[]}') echo "withdraw:$1" >> "$TEST_TMP/uci-log"; JP_ACTIVE='';;
 *) echo "publish:$1" >> "$TEST_TMP/uci-log"; JP_ACTIVE="jp_ipoe_$1";; esac; }
jp_forward_active() { :; }
ifdown() { fail unexpected-ifdown; }
ifup() { fail unexpected-ifup; }
`;
  fs.writeFileSync(tmp + '/uci-log', '');
  const added = run('add: automatic selection and persisted scoped rule', `jp_forward_add tcp 192.168.1.10 8080 '' || fail add`, cliMocks);
  assert.match(added, /external_port=1002/);
  let log = fs.readFileSync(tmp + '/uci-log', 'utf8');
  assert.match(log, /set jp_ipoe.created.public_ip=203.0.113.1/);
  assert.match(log, /set jp_ipoe.created.external_port=1002/);
  assert.doesNotMatch(log, /set .*dont_snat_to|set firewall/);
  assert(log.indexOf('snat') < log.indexOf('publish:created'), 'reserve before publish');

  fs.writeFileSync(tmp + '/uci-log', '');
  run('add: apply race rolls back only new rule', `
jp_forward_active() { JP_ACTIVE=''; }
jp_forward_add tcp 192.168.1.10 8080 '' && fail race
exit 0
`, cliMocks);
  log = fs.readFileSync(tmp + '/uci-log', 'utf8');
  assert.match(log, /-q delete jp_ipoe.created/);
  assert.equal((log.match(/snat/g) || []).length, 2);
  assert(log.indexOf('withdraw:created') < log.indexOf('-q delete jp_ipoe.created'));
  assert(log.indexOf('-q delete jp_ipoe.created') < log.lastIndexOf('snat'));
  assert.doesNotMatch(log, /delete jp_ipoe.saved|dont_snat_to=/);

  fs.writeFileSync(tmp + '/uci-log', '');
  run('add: pending changes, last SNAT port, invalid destination rejected before mutation', `
jp_forward_add icmp 192.168.1.10 80 '' && fail proto
jp_forward_add tcp 192.168.2.10 80 '' && fail address
ip() { echo '192.168.1.10 via 192.168.1.2 dev br-lan'; }
jp_forward_add tcp 192.168.1.10 80 '' && fail indirect-route
ip() { printf '%s dev br-lan\\n' "$4"; }
jp_forward_add tcp 192.168.1.10 80 '1000;id' && fail injection
jp_forward_runtime() { JP_PUBLIC=203.0.113.1; JP_RANGES='1000-1002'; }
jp_forward_add tcp 192.168.1.10 80 1002 && fail last-port
uci() { [ "$1" != changes ] || echo pending; }
jp_forward_add tcp 192.168.1.10 80 '' && fail pending
exit 0
`, cliMocks);
  assert.doesNotMatch(fs.readFileSync(tmp + '/uci-log', 'utf8'), /^add /m);

  fs.writeFileSync(tmp + '/uci-log', '');
  run('remove: refuses unsafe IDs; failed withdrawal keeps rule and reservation', `
jp_forward_remove config && fail config
jp_forward_remove 'saved;id' && fail injection
jp_forward_publish() { return 1; }
jp_forward_remove saved && fail publish
exit 0
`, cliMocks);
  log = fs.readFileSync(tmp + '/uci-log', 'utf8');
  assert.doesNotMatch(log, /delete jp_ipoe.saved|snat/);

  fs.writeFileSync(tmp + '/uci-log', '');
  run('remove: withdraw before deleting config and releasing reservation', `
jp_forward_remove saved || fail remove
`, cliMocks);
  log = fs.readFileSync(tmp + '/uci-log', 'utf8');
  assert(log.indexOf('withdraw:saved') < log.indexOf('delete jp_ipoe.saved'));
  assert(log.indexOf('commit jp_ipoe') < log.indexOf('snat'));

  fs.writeFileSync(tmp + '/uci-log', '');
  run('add: unconfirmed rollback keeps saved rule without reconnecting', `
jp_forward_publish() { return 1; }
jp_forward_add tcp 192.168.1.10 8080 '' && fail publish
exit 0
`, cliMocks);
  log = fs.readFileSync(tmp + '/uci-log', 'utf8');
  assert.doesNotMatch(log, /delete jp_ipoe.created/);
  assert.equal((log.match(/snat/g) || []).length, 1);
  assert.doesNotMatch(command, /\b(?:ifdown|ifup)\b|conntrack\s+-(?:D|F)\b/);

  run('release: cleanup failure stops later steps and propagates SNAT failure', `
for failed in delete commit snat; do
 steps=''
 uci() { [ "$1" != -q ] || shift; steps="$steps $1"; [ "$1" != "$failed" ]; }
 jp_forward_refresh_snat() { steps="$steps snat"; [ "$failed" != snat ]; }
 jp_forward_release saved && fail unexpected-success
 case "$failed:$steps" in
  'delete: delete'|'commit: delete commit'|'snat: delete commit snat') ;;
  *) fail "unexpected cleanup order $failed:$steps" ;;
 esac
done
`, command);

  const setup = stripSources(read('root/usr/sbin/jp-ipoe-setup')).split('# Entry point')[0];
  run('DHCP modes: relay and PD server mode both reach tunnel bringup without rollback', `
uci() { printf '%s\\n' "$*" >> "$TEST_TMP/dhcp-log"; }
odhcpd_mock() { [ "$1" = restart ] || fail service-action; }
validate_config() { :; }
apply_map_protocol() { :; }
apply_network_config() { :; }
apply_firewall_config() { :; }
bringup_mape() { BROUGHT_UP=1; }
rollback_failed_start() { fail unexpected-rollback; }
WAN6_IFACE=access6
for DHCPV6_RELAY in 1 0; do
 : > "$TEST_TMP/dhcp-log"
 BROUGHT_UP=0
 run_start_pipeline || fail "DHCP mode $DHCPV6_RELAY"
 [ "$BROUGHT_UP" = 1 ] || fail missing-bringup
 if [ "$DHCPV6_RELAY" = 1 ]; then lan_mode=relay; wan_mode=relay; else lan_mode=server; wan_mode=disabled; fi
 for option in ra dhcpv6; do
  grep -Fxq "set dhcp.lan.$option=$lan_mode" "$TEST_TMP/dhcp-log" || fail lan-mode
  grep -Fxq "set dhcp.access6.$option=$wan_mode" "$TEST_TMP/dhcp-log" || fail wan-mode
 done
 grep -Fxq 'commit dhcp' "$TEST_TMP/dhcp-log" || fail missing-commit
done
`, setup.replaceAll('/etc/init.d/odhcpd', 'odhcpd_mock'));

  const customZones = `
DB_firewall_sections='wan lan uplink'
DB_firewall_wan_network=wan
DB_firewall_uplink_TYPE=zone
DB_firewall_uplink_name=uplink
DB_firewall_uplink_network=access6
DB_jp_ipoe_config_wan6_iface=access6
DB_jp_ipoe_config_mape_iface=ip4map
DB_network_sections='access6'
DB_network_access6_TYPE=interface
DB_network_access6_proto=dhcpv6
WAN_DEVICE=eth0
WAN6_IFACE=access6
MAPE_IFACE=ip4map
`;
  run('zone lookup: membership before names, explicit fallback, no guessing on ambiguity', `
uci() { fail unexpected-mutation; }
[ "$(find_firewall_zone wan access6 wan)" = uplink ] || fail custom-zone
[ "$(find_firewall_zone wan absent wan)" = wan ] || fail network-fallback
[ "$(find_firewall_zone wan absent '')" = wan ] || fail name-fallback
result="$(find_firewall_zone '' absent '')"; rc=$?
[ "$rc" = 1 ] && [ -z "$result" ] || fail missing-not-ambiguous
DB_firewall_wan_network='wan access6'
result="$(find_firewall_zone wan access6 wan)"; rc=$?
[ "$rc" = 2 ] && [ -z "$result" ] || fail ambiguous-primary
DB_firewall_wan_network=wan
DB_firewall_uplink_network='access6 wan'
result="$(find_firewall_zone wan absent wan)"; rc=$?
[ "$rc" = 2 ] && [ -z "$result" ] || fail ambiguous-fallback
DB_firewall_uplink_name=wan
result="$(find_firewall_zone wan absent '')"; rc=$?
[ "$rc" = 2 ] && [ -z "$result" ] || fail duplicate-name
`, setup + customZones);

  const zoneWrites = run('firewall setup: add MAP only to the existing WAN6 zone', `
uci() { printf 'WRITE %s\\n' "$*"; }
setup_firewall access6 ip4map || fail setup
`, setup + customZones);
  assert.match(zoneWrites, /^WRITE add_list firewall.uplink.network=ip4map$/m);
  assert.doesNotMatch(zoneWrites, /firewall\.wan\.|network=access6/);

  run('ownership preflight: ambiguous WAN/MAP or foreign MAP zone rejects setup before writes', `
uci() { [ "$*" = '-q get network.access6' ] || fail "unexpected UCI $*"; echo interface; }
apply_map_protocol() { fail installer-before-validation; }
for scenario in wan_ambiguous map_ambiguous map_foreign; do
 DB_firewall_wan_network=wan
 DB_firewall_uplink_network=access6
 case "$scenario" in
  wan_ambiguous) DB_firewall_wan_network='wan access6';;
  map_ambiguous) DB_firewall_wan_network='wan ip4map'; DB_firewall_uplink_network='access6 ip4map';;
  map_foreign) DB_firewall_wan_network='wan ip4map';;
 esac
 setup_firewall access6 ip4map && fail "unsafe firewall setup $scenario"
 run_start_pipeline && fail "unsafe startup $scenario"
done
exit 0
`, setup + customZones);

  run('stop, repair and boot: ambiguous ownership aborts before teardown or restart', `
uci() { fail unexpected-mutation; }
ifdown() { fail unexpected-ifdown; }
cmd_start() { fail start-after-refused-stop; }
restart_wan6_interface() { fail restart-after-refused-stop; }
for iface in access6 ip4map; do
 DB_firewall_wan_network="wan $iface"
 DB_firewall_uplink_network="access6 $iface"
 cmd_stop && fail ambiguous-stop
 cmd_repair && fail ambiguous-repair
 cmd_boot && fail ambiguous-boot
done
exit 0
`, setup + customZones);

  const cleanupWrites = run('firewall cleanup: use actual MAP zone; missing is safe, ambiguous is refused', `
DB_firewall_wan_network='wan access6'
DB_firewall_uplink_network=ip4map
uci() { printf 'WRITE %s\\n' "$*"; }
fw4() { :; }
remove_firewall_network ip4map || fail cleanup
uci() { fail unexpected-mutation; }
DB_firewall_uplink_network=''
remove_firewall_network ip4map || fail already-removed
DB_firewall_uplink_network=ip4map
DB_firewall_wan_network='wan access6 ip4map'
remove_mape_config() { fail delete-after-refused-withdrawal; }
remove_managed_config && fail ambiguous-cleanup
exit 0
`, setup + customZones);
  assert.match(cleanupWrites, /^WRITE del_list firewall.uplink.network=ip4map$/m);
  assert.doesNotMatch(cleanupWrites, /firewall\.wan\./);

  const metricWrites = run('PPPoE fallback: scope by selected WAN zone, not a conventional interface name', `
DB_network_sections='wan backup access6'
DB_network_wan_TYPE=interface
DB_network_wan_proto=pppoe
DB_network_backup_TYPE=interface
DB_network_backup_proto=pppoe
DB_network_access6_TYPE=interface
DB_network_access6_proto=dhcpv6
DB_firewall_uplink_network='access6 backup'
[ "$(find_wan_pppoe_sections)" = backup ] || fail unrelated-pppoe
uci() { printf 'WRITE %s\\n' "$*"; }
setup_pppoe_fallback_metrics || fail metrics
uci() { fail mutation-after-ambiguous-zone; }
DB_firewall_wan_network='wan access6'
setup_pppoe_fallback_metrics && fail ignored-ambiguity
exit 0
`, setup + customZones);
  assert.match(metricWrites, /^WRITE set network.backup.metric=200$/m);
  assert.doesNotMatch(metricWrites, /network\.wan\.metric/);

  run('interface roles: refuse unrelated WAN6/MAP targets before any lifecycle mutation', `
uci() { [ "$1 $2" = '-q get' ] || fail "unexpected write $*"; echo interface; }
ifdown() { fail unexpected-ifdown; }
ifup() { fail unexpected-ifup; }
apply_map_protocol() { fail installer-before-validation; }
for scenario in lan_wan6 pppoe_wan6 map_wan map_lan foreign_map wrong_type same bad_name; do
 DB_jp_ipoe_config_wan6_iface=access6; DB_jp_ipoe_config_mape_iface=ip4map
 DB_network_access6_proto=dhcpv6; DB_network_ip4map_TYPE=''
 case "$scenario" in
  lan_wan6) DB_jp_ipoe_config_wan6_iface=lan;;
  pppoe_wan6) DB_network_access6_proto=pppoe;;
  map_wan) DB_jp_ipoe_config_mape_iface=wan;;
  map_lan) DB_jp_ipoe_config_mape_iface=lan;;
  foreign_map) DB_network_ip4map_TYPE=interface; DB_network_ip4map_proto=map; DB_network_ip4map_maptype=map-e; DB_network_ip4map_tunlink=other6;;
  wrong_type) DB_network_ip4map_TYPE=device;;
  same) DB_jp_ipoe_config_mape_iface=access6;;
  bad_name) DB_jp_ipoe_config_mape_iface='@interface[0]';;
 esac
 for cmd in cmd_start cmd_stop cmd_repair cmd_boot; do
  "$cmd" force && fail "accepted $scenario via $cmd"
 done
done
exit 0
`, setup + customZones + `
DB_network_wan_TYPE=interface
DB_network_wan_proto=pppoe
DB_network_lan_TYPE=interface
DB_network_lan_proto=static
`);

  run('interface roles: reuse only matching MAP-E; absent targets allowed only for teardown', `
DB_network_ip4map_TYPE=interface
DB_network_ip4map_proto=map
DB_network_ip4map_maptype=map-e
DB_network_ip4map_tunlink=access6
validate_interface_roles || fail matching-map
for field in proto maptype tunlink; do
 eval "saved=\\\"\\\${DB_network_ip4map_$field}\\\""
 eval "DB_network_ip4map_$field=''"
 validate_interface_roles && fail "accepted empty $field"
 eval "DB_network_ip4map_$field=\\\"$saved\\\""
done
DB_network_ip4map_TYPE=''
validate_interface_roles || fail new-map
DB_network_access6_TYPE=''
validate_interface_roles && fail missing-wan6
validate_interface_roles stop || fail already-stopped
config_load() { return 1; }
validate_interface_roles stop && fail unreadable-config
exit 0
`, setup + customZones);

  run('Apply comparisons: changed/absent options are not confused with a saved fingerprint', `
uci() { [ "$1 $2" = '-q get' ] || fail mutation; case "$3" in
 network.test.mtu) echo 1460;; network.test.proto) echo map;; *) return 1;; esac; }
option_matches network.test.mtu 1460 || fail matching
option_matches network.test.mtu 1500 && fail changed
option_matches network.test.proto dhcpv6 && fail wrong-protocol
option_matches network.test.missing '' || fail optional
option_matches network.test.missing required && fail missing
exit 0
`, setup);

  fs.writeFileSync(tmp + '/uci-log', '');
  run('Apply dispatch: unchanged skips pipeline; drift repairs; explicit repair bypasses shortcut', `
uci() { [ "$*" = 'commit jp_ipoe' ] || fail "unexpected mutation $*"; echo COMMIT >> "$TEST_TMP/uci-log"; }
configuration_is_current() { echo CHECK >> "$TEST_TMP/uci-log"; return 0; }
run_start_pipeline() { echo PIPELINE >> "$TEST_TMP/uci-log"; }
[ "$(cmd_start)" = 'JP_IPOE_UNCHANGED=1' ] || fail unchanged-marker
[ "$(grep -c PIPELINE "$TEST_TMP/uci-log")" = 0 ] || fail redundant-apply
cmd_stop() { echo STOP >> "$TEST_TMP/uci-log"; }
cmd_repair || fail repair
configuration_is_current() { echo CHECK >> "$TEST_TMP/uci-log"; return 1; }
cmd_start || fail drift
run_start_pipeline() { return 1; }
cmd_start && fail hidden-error
exit 0
`, setup);
  log = fs.readFileSync(tmp + '/uci-log', 'utf8');
  assert.equal((log.match(/CHECK/g) || []).length, 3);
  assert.equal((log.match(/PIPELINE/g) || []).length, 2);
  assert.equal((log.match(/COMMIT/g) || []).length, 3);
  assert.equal((log.match(/STOP/g) || []).length, 1);
  assert.match(setup, /restart_wan6_interface "\$WAN6_IFACE" \|\| true\s+cmd_start force/);

  const locked = run('locked operations attempt PPPoE restoration after both success and failure', `
LOCK_DIR="$TEST_TMP/setup-lock"
restore_stopped_pppoe_fallback() { echo RESTORE; }
operation() { return "$1"; }
for expected in 0 1; do
 run_locked operation "$expected"; actual=$?
 [ "$actual" = "$expected" ] || fail changed-result
 rm -rf "$LOCK_DIR"
done
`, setup);
  assert.equal((locked.match(/RESTORE/g) || []).length, 2);

  run('IPv6 destinations: canonical LAN GUA only; reject local, WAN, via and invalid input', `
network_get_device() { export "$1=br-lan"; }
ip() { printf '%s\\n' "$ROUTE"; }
ROUTE='2001:db8::10 from :: dev br-lan src 2001:db8::1'
jp_forward6_lan_valid 2001:0db8:0:0:0:0:0:10 || fail global
[ "$JP6_ADDRESS" = 2001:db8::10 ] || fail canonical
for address in fe80::10 fd00::10 ::1 2::10 '2001:db8::10/64' '2001:db8::10;reboot'; do
 if jp_forward6_lan_valid "$address"; then fail unsafe-address; fi
done
for ROUTE in 'local 2001:db8::1 dev lo' '2001:db8::10 dev eth0' '2001:db8::10 via fe80::1 dev br-lan'; do
 if jp_forward6_lan_valid 2001:db8::10; then fail unsafe-route; fi
done
ip() { return 1; }
if jp_forward6_lan_valid 2001:::10; then fail malformed; fi
`, command);

  const v6fixture = `
WAN6_IFACE=wan6
DB_firewall_sections="$DB_firewall_sections jp_ipoe6_saved"
DB_firewall_jp_ipoe6_saved_TYPE=rule
DB_firewall_jp_ipoe6_saved_name=jp_ipoe6_saved
DB_firewall_jp_ipoe6_saved_family=ipv6
DB_firewall_jp_ipoe6_saved_target=ACCEPT
DB_firewall_jp_ipoe6_saved_dest_ip=2001:db8::10
DB_firewall_jp_ipoe6_saved_dest_port=22
DB_firewall_jp_ipoe6_saved_proto=tcp
jp_forward_clean_config() { return 0; }
uci() { echo "$*" >> "$TEST_TMP/v6-log"; }
fw4() { echo "RELOAD $*" >> "$TEST_TMP/v6-log"; }
`;
  run('IPv6 ownership and duplicate protocol checks', `
${v6fixture}
config_load firewall
jp_forward6_owned jp_ipoe6_saved || fail owned
if jp_forward6_owned wan; then fail foreign; fi
JP6_ADDRESS=2001:db8::10; JP6_PORT=22; JP6_PROTO=tcpudp; JP6_DUPLICATE=0
config_foreach jp_forward6_duplicate_cb rule
[ "$JP6_DUPLICATE" = 1 ] || fail duplicate
JP6_PROTO=udp; JP6_DUPLICATE=0
config_foreach jp_forward6_duplicate_cb rule
[ "$JP6_DUPLICATE" = 0 ] || fail protocol
DB_firewall_jp_ipoe6_saved_target=DROP
if jp_forward6_owned jp_ipoe6_saved; then fail foreign-target; fi
`, command);

  fs.writeFileSync(tmp + '/v6-log', '');
  run('IPv6 add uses native firewall only and does not require MAP-E', `
${v6fixture}
DB_firewall_sections='wan lan'
network_is_up() { [ "$1" = wan6 ]; }
network_get_device() { export "$1=br-lan"; }
ip() { echo '2001:db8::10 dev br-lan'; }
uci() { case "$*" in '-q get '*) return 1;; esac; echo "$*" >> "$TEST_TMP/v6-log"; }
nft() { echo 'comment "!fw4: jp_ipoe6_00000000000000000000000000000001"'; }
jp_forward_refresh_snat() { fail snat; }
jp_forward_runtime() { fail mape; }
jp_forward6_add tcpudp 2001:db8::10 22 || fail add
`, command);
  let v6log = fs.readFileSync(tmp + '/v6-log', 'utf8');
  assert.match(v6log, /\.family=ipv6/);
  assert.match(v6log, /\.target=ACCEPT/);
  assert.match(v6log, /\.proto=tcp udp/);
  assert.doesNotMatch(v6log, /DNAT|SNAT|set network\.|set jp_ipoe\./);
  assert(v6log.indexOf('commit firewall') < v6log.indexOf('RELOAD reload'));

  for (const [name, fw4rc, nftrc] of [['withdrawn', 0, 1], ['reload failure', 1, 1], ['still installed', 0, 0], ['nft unavailable', 0, 2]]) {
    fs.writeFileSync(tmp + '/v6-log', '');
    run('IPv6 removal: ' + name, `
${v6fixture}
fw4() { echo RELOAD >> "$TEST_TMP/v6-log"; return ${fw4rc}; }
jp_forward6_installed() { echo INSPECT >> "$TEST_TMP/v6-log"; return ${nftrc}; }
jp_forward6_remove jp_ipoe6_saved
rc=$?
[ "$rc" ${name === 'withdrawn' ? '=' : '!='} 0 ] || fail result
`, command);
    v6log = fs.readFileSync(tmp + '/v6-log', 'utf8');
    assert(v6log.indexOf('.enabled=0') < v6log.indexOf('RELOAD'));
    if (name === 'withdrawn') assert(v6log.indexOf('INSPECT') < v6log.indexOf('delete firewall.jp_ipoe6_saved'));
    else assert.doesNotMatch(v6log, /delete firewall\./);
  }

  run('IPv6 installed check distinguishes missing rule from unreadable nft state', `
nft() { echo 'comment "!fw4: jp_ipoe6_saved"'; }
jp_forward6_installed jp_ipoe6_saved || fail present
jp_forward6_installed jp_ipoe6_other; [ "$?" = 1 ] || fail absent
nft() { return 1; }
jp_forward6_installed jp_ipoe6_saved; [ "$?" = 2 ] || fail unknown
`, command);

  for (const p of ['root/usr/share/jp-ipoe/forward.sh', 'root/usr/share/jp-ipoe/config.sh',
    'root/usr/libexec/jp-ipoe-forward', 'root/usr/libexec/jp-ipoe-map-nft', 'root/usr/libexec/jp-ipoe-info',
    'root/usr/share/jp-ipoe/map.sh', 'root/usr/sbin/jp-ipoe-setup']) {
    const r = cp.spawnSync('sh', ['-n', p], { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 0, p + '\n' + r.stderr);
  }
  const makefile = read('Makefile');
  assert.equal((makefile.match(/^include .*\/luci\.mk$/gm) || []).length, 1);
  assert.doesNotMatch(makefile, /\$\(\s*call\s+BuildPackage[, ]/);
  assert.match(makefile, /call (Build\/DefaultTargets|BuildPackage|KernelPackage)/,
    'include/scan.mk must discover the package before make expands luci.mk');
  assert.match(makefile, /^LUCI_DESCRIPTION:=\S.+$/m);
  assert(makefile.indexOf('include $(TOPDIR)/feeds/luci/luci.mk') > makefile.lastIndexOf('\nendef'),
    'define custom package hooks before luci.mk registers the package');
  const postinst = makefile.match(/define Package\/.*\/postinst\n([\s\S]*?)\nendef/)[1].replaceAll('$$', '$');
  const postinstCheck = cp.spawnSync('sh', ['-n'], { input: postinst, encoding: 'utf8' });
  assert.equal(postinstCheck.status, 0, postinstCheck.stderr);
  console.log('PASS LuCI scan signature, single registration, description, hook ordering and postinst syntax');

  const js = read('htdocs/luci-static/resources/view/jp_ipoe/config.js');
  let modal, notifications = 0, executions = 0;
  const messages = [], elements = {};
  let executeCommand = () => { executions++; throw new Error('Unexpected duplicate submission'); };
  const view = new Function('view', 'ui', 'E', '_', 'fs', 'document', js)(
    { extend: value => value },
    { showModal: (title, nodes) => { modal = nodes; }, hideModal: () => {},
      addNotification: (title, node, style) => {
        assert(['warning', 'error'].includes(style), 'only warnings/errors stay until dismissed');
        notifications++; messages.push(node.children ?? node.attrs);
      },
      addTimeLimitedNotification: (title, node, timeout, style) => {
        assert.equal(timeout, 5000);
        assert.equal(style, 'info');
        notifications++; messages.push(node.children ?? node.attrs);
      },
      createHandlerFn: (owner, fn) => (typeof fn === 'string' ? owner[fn] : fn).bind(owner) },
    (tag, attrs, children) => ({ tag, attrs, children }), text => text,
    { exec: (...args) => executeCommand(...args) },
    { getElementById: id => elements[id] }
  );
  view.forwardBusy = true;
  view.confirmForward([]);
  assert.equal(notifications, 1);
  assert.equal(modal, undefined);
  view.forwardBusy = false;
  view.confirmForward(['forward_remove', 'saved'], { proto: 'tcpudp', public_ip: '203.0.113.1',
    external_port: '1001', internal_ip: '192.168.1.10', internal_port: '8080' });
  assert.match(modal[0].children, /TCP \+ UDP: 203\.0\.113\.1:1001 → 192\.168\.1\.10:8080/);
  const modalText = () => modal.filter(node => node.tag === 'p').map(node => node.children).join('\n');
  assert.match(modalText(), /Existing sessions or other firewall rules may still allow access/);
  view.forwardBusy = true;
  modal[modal.length - 1].children[2].attrs.click();
  assert.equal(executions, 0);
  console.log('PASS forwarding UI target confirmation and duplicate-submit guard');
  const nodes = [];
  function collect(node) {
    if (Array.isArray(node)) return node.forEach(collect);
    if (!node || typeof node !== 'object') return;
    nodes.push(node);
    collect(node.children);
  }
  collect(view.renderForwardPanel());
  const details = nodes.filter(node => node.tag === 'details');
  assert.equal(details.length, 2);
  assert(details.every(node => !Object.hasOwn(node.attrs, 'open')), 'technical details start collapsed');
  assert.equal(nodes.find(node => node.attrs.id === 'jp-forward-portsets').tag, 'ul');
  assert.equal(nodes.filter(node => node.attrs.class === 'jp-forward-field').length, 7);
  console.log('PASS forwarding UI collapsed details, range list and compact fields');
  for (const id of ['device', 'family', 'ip', 'port', 'ip6', 'ip6-options', 'ip-field', 'port-field', 'ip6-field'])
    elements['jp-forward-' + id] = { value: '', disabled: false, style: {}, appendChild: () => {} };
  view.forwardDevices = { 'aa:bb:cc:dd:ee:ff': { ipaddrs: ['192.168.1.10'], ip6addrs: ['fe80::10', 'fd00::10', '2001:db8::10'] } };
  elements['jp-forward-device'].value = 'aa:bb:cc:dd:ee:ff';
  view.selectForwardDevice();
  assert.equal(elements['jp-forward-ip'].value, '192.168.1.10');
  assert.equal(elements['jp-forward-ip6'].value, '2001:db8::10');
  for (const family of ['ipv4', 'ipv6', 'dual']) {
    elements['jp-forward-family'].value = family;
    view.updateForwardFamily();
    assert.equal(elements['jp-forward-ip'].disabled, family === 'ipv6');
    assert.equal(elements['jp-forward-port'].disabled, family === 'ipv6');
    assert.equal(elements['jp-forward-ip6'].disabled, family === 'ipv4');
  }
  assert.equal(view.forwardEndpoint('2001:db8::10', '22'), '[2001:db8::10]:22');
  const dual = [['forward_add', 'tcp', '192.168.1.10', '22', '1001'], ['forward_add6', 'tcp', '2001:db8::10', '22']];
  view.loadForwards = () => Promise.resolve();
  for (const failAt of [null, 'forward_add', 'forward_add6']) {
    const calls = [];
    executeCommand = (file, args) => {
      calls.push(args[0]);
      return Promise.resolve({ code: args[0] === failAt ? 1 : 0, stderr: 'ERROR: test failure',
        stdout: JSON.stringify({ public_ip: args[2], external_port: args[4] || args[3] }) });
    };
    view.forwardBusy = false;
    view.confirmForward(dual);
    for (const warning of [
      /do not restart MAP-E or clear existing connections/,
      /exposes the LAN service to the Internet.*Secure it first/,
      /local checks do not guarantee future availability/,
      /IPv6 rules survive MAP-E stop and plugin uninstall/,
      /Delete here or in Firewall traffic rules; recreate after destination IPv6 changes/,
      /two rules separately.*successful rules remain.*check existing rules before retrying/
    ]) assert.match(modalText(), warning, 'concise copy must retain the safety warning');
    await modal[modal.length - 1].children[2].attrs.click();
    assert.deepEqual(calls, failAt === 'forward_add' ? ['forward_add'] : ['forward_add', 'forward_add6']);
    assert.equal(view.forwardBusy, false);
    if (failAt) assert(messages.some(message => /Partial completion is possible/.test(message)));
  }
  console.log('PASS device selection, IPv6 address filtering, family controls and dual-stack partial failures');

  nodes.length = 0;
  collect(view.renderStatusPanel());
  const statusNote = nodes.filter(node => node.tag === 'p').map(node => node.children).join('\n');
  assert.match(statusNote, /whole router.*counters are cumulative/);
  assert.match(statusNote, /not MAP-E port usage or Internet loss.*Unavailable is not zero/);
  assert.match(nodes.find(node => node.tag === 'table').attrs.style, /table-layout:fixed.*overflow-wrap:anywhere/,
    'expanded ranges must not squeeze labels or overflow narrow screens');
  const rangeDetails = nodes.filter(node => node.tag === 'details');
  assert.equal(rangeDetails.length, 1, 'status port ranges use a native disclosure');
  const rangeDetail = rangeDetails[0];
  assert(!Object.hasOwn(rangeDetail.attrs, 'open'), 'status ranges start collapsed');
  const rangeSummary = rangeDetail.children[0];
  assert.equal(rangeSummary.tag, 'summary');
  assert.equal(rangeSummary.attrs.id, 's-port-info-summary');
  assert.equal(rangeSummary.children, 'Unavailable');
  const rangeValue = nodes.find(node => node.attrs.id === 's-port-info');
  assert.equal(rangeDetail.children[1], rangeValue, 'refresh only updates the disclosure content');
  assert.equal(rangeValue.attrs.tabindex, '0', 'scrollable ranges are keyboard accessible');
  assert.equal(rangeValue.attrs['aria-label'], 'Assigned Port Ranges');
  assert.match(rangeValue.attrs.style, /max-height:12rem/);
  assert.match(rangeValue.attrs.style, /overflow:auto/);
  assert.match(rangeValue.attrs.style, /overflow-wrap:anywhere/);
  const longRanges = Array.from({ length: 63 }, (_, i) => `${(i + 1) * 1024 + 224}-${(i + 1) * 1024 + 239}`).join(' ');
  const fields = view.statusFields();
  for (const field of fields) elements[field.id] = { textContent: '', style: {} };
  for (const node of [rangeValue, rangeSummary]) {
    node.style = {};
    Object.defineProperty(node, 'textContent', {
      get() { return this.children; }, set(value) { this.children = value; }
    });
    elements[node.attrs.id] = node;
  }
  for (const [input, expected] of [
    ["'1248-1263 2272-2287'", 'Ranges: 2 · Assigned ports: 32'],
    ['"80, 443, 5000-5002"', 'Ranges: 3 · Assigned ports: 5'],
    ['2272-2287\t1248-1263\n', 'Ranges: 2 · Assigned ports: 32'],
    ['1-65535', 'Ranges: 1 · Assigned ports: 65535'],
    ['65535', 'Ranges: 1 · Assigned ports: 1'],
    ['', 'Unavailable'], ['  ', 'Unavailable'], ["''", 'Unavailable'],
    [undefined, 'Unavailable'], [null, 'Unavailable'], ['-', 'Unavailable'],
    ['Unavailable', 'Unavailable'],
    ['1-3 3-5', 'Unknown'], ['80 80', 'Unknown'], ['0', 'Unknown'],
    ['65536', 'Unknown'], ['9-2', 'Unknown'], ['bad', 'Unknown'],
    ['<img src=x onerror=alert(1)>', 'Unknown'], ['"80', 'Unknown'],
    [[], 'Unknown'], [true, 'Unknown']
  ]) assert.equal(view.portRangeSummary(input), expected, 'range summary for '+JSON.stringify(input));
  let statusCalls = 0;
  let statusReply = { code: 0, stdout: JSON.stringify({ mape_state: 'up', port_info: longRanges, conntrack: {
    count: '0', max: '30720', insert_failed: '7000000000', drop: '0', early_drop: '0'
  } }) };
  executeCommand = (file, args) => {
    assert.equal(file, '/usr/sbin/jp-ipoe-setup');
    assert.deepEqual(args, ['status']);
    statusCalls++;
    return statusReply instanceof Error ? Promise.reject(statusReply) : Promise.resolve(statusReply);
  };
  view.activeTab = 'config';
  await view.updateStatus();
  assert.equal(statusCalls, 0, 'hidden Status tab must not inspect kernel state');
  view.activeTab = 'status';
  await view.updateStatus();
  assert.equal(elements['s-ct-count'].textContent, '0 / 30720');
  assert.equal(elements['s-ct-insert-failed'].textContent, '7000000000');
  assert.equal(elements['s-ct-insert-failed'].style.color, '', 'historical global errors are not a red MAP-E fault');
  assert.equal(elements['s-ct-drop'].textContent, '0');
  assert.equal(rangeValue.textContent, longRanges, 'all port ranges remain available, not truncated');
  assert.equal(rangeSummary.textContent, 'Ranges: 63 · Assigned ports: 1008', 'count assigned ports, not free or unreserved capacity');
  rangeDetail.open = true;
  statusReply = { code: 0, stdout: JSON.stringify({ mape_state: 'up', port_info: '80 443 5000-5002' }) };
  await view.updateStatus();
  assert.equal(rangeDetail.open, true, 'polling must not reset the expanded state');
  assert.equal(rangeDetail.children[1], rangeValue, 'polling must not replace the disclosure');
  assert.equal(rangeSummary.textContent, 'Ranges: 3 · Assigned ports: 5');
  assert.equal(rangeValue.textContent, '80 443 5000-5002');
  statusReply = { code: 0, stdout: '{"mape_state":"up","port_info":"malformed range"}' };
  await view.updateStatus();
  assert.equal(rangeSummary.textContent, 'Unknown', 'invalid data must not retain old counts');
  assert.equal(rangeValue.textContent, 'malformed range', 'keep raw details as text');
  const dropField = fields.find(field => field.id === 's-ct-drop');
  for (const drop of [undefined, null, '', 'bad', -1, [0], {}])
    assert.equal(dropField.get({ conntrack: { drop } }).text, 'Unavailable');
  assert.equal(dropField.get({ conntrack: { drop: 0 } }).text, '0');
  statusReply = { code: 0, stdout: '{"mape_state":"up"}' };
  await view.updateStatus();
  assert.equal(elements['s-mape-state'].textContent, 'up', 'older backends still show interface status');
  assert.equal(elements['s-ct-drop'].textContent, 'Unavailable');
  assert.equal(rangeValue.textContent, '-', 'missing ranges must clear the previous allocation');
  assert.equal(rangeSummary.textContent, 'Unavailable');
  for (statusReply of [{ code: 1, stdout: '{}' }, { code: 0, stdout: '' },
    { code: 0, stdout: 'not json' }, { code: 0, stdout: 'null' },
    { code: 0, stdout: '[]' }, { code: 0, stdout: '{}' },
    { code: 0, stdout: '{"mape_state":true}' }, new Error('RPC unavailable')]) {
    await view.updateStatus();
    for (const field of fields) assert.equal(elements[field.id].textContent, 'Unavailable', 'do not retain stale successful status');
    assert.equal(rangeSummary.textContent, 'Unavailable', 'failed refresh must also clear old range counts');
  }
  assert.equal(rangeDetail.open, true, 'failed refresh preserves the disclosure state while clearing its value');
  console.log('PASS status ranges: assigned counts, invalid/absent data, collapsed bounded details and stable refreshes');
  console.log('PASS kernel diagnostic UI: zero/unavailable/large counters, old backend, failed refresh and inactive-tab guard');
  console.log(`PASS ${count} backend checks + package/UI structure and shell/JS syntax. Real browser/OpenWrt kernel not exercised.`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
}
main().catch(error => { console.error(error); process.exitCode = 1; });
