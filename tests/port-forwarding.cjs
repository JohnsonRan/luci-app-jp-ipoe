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
echo BUSY
jp_forward_busy() { JP_FORWARD_BUSY='tcp 1001'; }
jp_forward_emit wan6mape 203.0.113.1 '1000-1005'
echo UNAVAILABLE
jp_forward_busy() { return 1; }
jp_forward_emit wan6mape 203.0.113.1 '1000-1005'
`);
  assert.match(emitted, /name=jp_ipoe_saved/);
  assert.match(emitted, /src=wan\ndest=lan\nsrc_dip=203.0.113.1\nsrc_dport=1001\ndest_ip=192.168.1.10\ndest_port=8080/);
  assert.equal((emitted.match(/type=redirect/g) || []).length, 1);

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
  assert.match(fs.readFileSync(tmp + '/protocol-nft', 'utf8'), /0 : 1002/);

  const batch = run('SNAT excludes manual and managed ports, keeps all other ranges, atomic replace', `
nft() { [ "$1" = '-f' ] || fail "non-atomic $*"; cat; }
apply_rules wan6mape map-wan6mape 203.0.113.1 '1000-1003 2000-2001' || fail apply
`, nft);
  assert.match(batch, /add table inet jpipoe_wan6mape\nflush table inet jpipoe_wan6mape/);
  assert.match(batch, /mod 4 map \{ 0 : 1002, 1 : 1003, 2 : 2000, 3 : 2001 \}/);
  assert.doesNotMatch(batch, / : 100[01](?:,| )/);

  run('SNAT exhaustion and nft failure propagate without delete-first', `
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

  const setup = stripSources(read('root/usr/sbin/jp-ipoe-setup')).split('# Entry point')[0];
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
    'root/usr/libexec/jp-ipoe-forward', 'root/usr/libexec/jp-ipoe-map-nft',
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
      addNotification: (title, node) => { notifications++; messages.push(node.children ?? node.attrs); },
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
    await modal[modal.length - 1].children[2].attrs.click();
    assert.deepEqual(calls, failAt === 'forward_add' ? ['forward_add'] : ['forward_add', 'forward_add6']);
    assert.equal(view.forwardBusy, false);
    if (failAt) assert(messages.some(message => /Partial completion is possible/.test(message)));
  }
  console.log('PASS device selection, IPv6 address filtering, family controls and dual-stack partial failures');
  console.log(`PASS ${count} backend checks + package/UI structure and shell/JS syntax. Real browser/OpenWrt kernel not exercised.`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
}
main().catch(error => { console.error(error); process.exitCode = 1; });
