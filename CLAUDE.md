# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`luci-app-jp-ipoe` is an OpenWrt LuCI package that configures Japan NTT IPoE **MAP-E** (IPv4-over-IPv6) connections, targeting OCN Virtual Connect style lines. It does not build a binary — it installs shell scripts, a patched netifd protocol handler, LuCI views, and UCI config onto an OpenWrt router. There is no test suite; correctness is validated by running on a real OpenWrt device against a live NTT line.

The package layout follows OpenWrt convention: everything under `root/` is copied verbatim to the device filesystem, and `htdocs/` holds the LuCI client-side JS.

## Build / package

There is no local build or lint step runnable from this repo on its own — it compiles inside the OpenWrt SDK. The `Makefile` is an OpenWrt `luci.mk` package definition; `postinst` runs `jp-ipoe-install-map` to install the patched `map.sh`.

CI (`.github/workflows/build-packages.yml`) builds against the OpenWrt SDK for 24.10 (ipk) and 25.12 (apk), x86/64 and arm64. To reproduce a build locally you need an OpenWrt SDK checkout, then:

```sh
# inside an OpenWrt SDK tree, with this repo rsynced to package/luci-app-jp-ipoe
./scripts/feeds install -p luci luci-base
./scripts/feeds install -p packages map
echo "CONFIG_PACKAGE_luci-app-jp-ipoe=m" >> .config
make defconfig
make package/luci-app-jp-ipoe/compile V=s
```

Bump `PKG_VERSION` / `PKG_RELEASE` in `Makefile` when releasing. Tagging `v*` triggers a GitHub release; `workflow_dispatch` produces a nightly prerelease.

## Architecture

The system has three layers that must stay in sync: **LuCI UI → orchestration script → netifd protocol handler**.

### 1. Configuration model (UCI)

All state lives in one UCI file, `/etc/config/jp_ipoe`, section `config` of type `jp_ipoe`. Defaults seeded by `root/etc/config/jp_ipoe`; full default values (including MAP-E params 20/38/18/6/6 for OCN) are loaded by `jp_ipoe_config_load` in `root/usr/share/jp-ipoe/config.sh`. **Any new config option must be added in three places**: the default config file, `config.sh` (`config_get`), and the LuCI form `htdocs/.../jp_ipoe/config.js`.

### 2. Orchestration: `jp-ipoe-setup`

`root/usr/sbin/jp-ipoe-setup` is the entry point for everything. Subcommands: `start`, `stop`, `boot`, `status`, `detect_br`. `start` runs a strict pipeline (`cmd_start`): validate config → ensure patched `map.sh` is installed → configure WAN6 (DHCPv6 + DUID-LL) → wait for IPv6 → create MAP-E interface → add to firewall zone → DHCPv6/NDP relay → bring up tunnel. Any failure after network config triggers `rollback_failed_start`, which tears down the managed MAP-E interface so a failed apply never leaves half-state.

Key behaviors that are easy to break:
- **DUID-LL** (`ensure_wan6_duid_ll`): NTT NGN requires DHCPv6 DUID-LL (`00030001` + WAN MAC). The script only writes an interface-level `clientid` when the effective DUID isn't already correct, and never touches the global default DUID.
- **PPPoE fallback conflict** (`recover_wan6_after_pppoe_conflict`, `cmd_boot`): on boot, if WAN6 can't get IPv6, the script stops WAN PPPoE interfaces, restarts WAN6, then restarts PPPoE only after IPoE succeeds. PPPoE interfaces also get `metric=200` to deprioritize them. This boot-only recovery is why `boot` is a separate subcommand from `start`.
- **`ip6prefix` handling** (`wan6_ip6prefix_required`): `wan6.ip6prefix` is only set when relay mode or manual MAP/BR params are in use; PD-matched lines leave it unset.

The init script `root/etc/init.d/jp_ipoe` (procd, START=95) only runs when `enabled=1`; `boot()` calls `jp-ipoe-setup boot`, while `restart`/`reload` use the plain `start`/`stop` path.

### 3. Patched netifd protocol: `map.sh` + nft helper

`root/usr/share/jp-ipoe/map.sh` is a patched copy of OpenWrt's stock `/lib/netifd/proto/map.sh`. It is installed to `/lib/netifd/proto/map.sh` by `jp-ipoe-install-map` (backing up the stock script to `map.sh.orig` if present). The marker `JP_IPOE_PATCH_VERSION=` is how both the installer and `validate_map_protocol` detect whether the patched version is in place — **keep that marker when editing `map.sh`**.

The patch's purpose: stock OpenWrt only SNATs to the *first* assigned MAP-E port range. Japan MAP-E assigns multiple non-contiguous port ranges. In `proto_map_setup`, when `RULE_*_PORTSETS` has multiple ranges, it delegates firewall setup to `jp-ipoe-map-nft setup` instead of emitting a single SNAT object.

`root/usr/libexec/jp-ipoe-map-nft` builds a dedicated nftables table (`jpipoe_<cfg>`) with SNAT rules that distribute connections across *all* assigned port ranges via `jhash ... map { ... }`, maps ICMP echo IDs into the same ranges, and honors reserved ports from `dont_snat_to`. Tables are named per-interface and torn down on `proto_map_teardown`.

### 4. Status/detection helper: `jp-ipoe-info`

`root/usr/libexec/jp-ipoe-info` outputs JSON for the LuCI status page (`status`) and runs `mapcalc` for BR-address auto-detection (`detect_br`, `lookup_br`). `jp-ipoe-setup status`/`detect_br` are thin wrappers that load config and forward to this helper. The LuCI status page polls `jp-ipoe-setup status` every 10s.

It also resolves the full MAP-E rule from the WAN6 IPv6 prefix alone (`resolve <wan6_iface>` / `resolve_addr <ipv6>`), replicating the lookup logic of `ipv4.web.fc2.com/map-e.html` offline. The OCN Virtual Connect rule tables (`38`/`31`/`38_20`, ~690 entries ported verbatim from that page) live in `root/usr/share/jp-ipoe/ocn-mape-rules` (`<table> <hexkey> <octets...>`). `resolve` prints shell-eval `JP_AUTO_*` assignments (ipaddr, ip4prefixlen, ip6prefix, ip6prefixlen, ealen, psidlen, offset, BR) and exits non-zero when the prefix is not an OCN line. The per-host IPv4/PSID/ports are still computed by `mapcalc` downstream — `resolve` only supplies the matched rule.

### Auto mode

When `auto=1`, `apply_network_config` calls `apply_auto_params` (after WAN6 IPv6 is up, before `setup_mape`) to override the loaded `IPADDR`/`IP4PREFIXLEN`/`IP6PREFIX`/`IP6PREFIXLEN`/`EALEN`/`PSIDLEN`/`OFFSET`/`BR_ADDR` vars from the `resolve` output, so the rest of the pipeline is unchanged. `auto=1` also forces `wan6_ip6prefix_required` true (the resolved params behave like manual params). The LuCI form hides all manual MAP-E fields when `auto` is enabled.

### 5. LuCI frontend

A single view `htdocs/luci-static/resources/view/jp_ipoe/config.js` renders a client-side two-tab page (no reload between tabs): **Configuration** (the `form.Map` + Apply/Stop/Preview buttons) and **Status** (the read-only status table + BR auto-detect, polled every 10s). The status poll stays registered but `updateStatus` short-circuits while the Status panel is hidden (it only runs `jp-ipoe-setup status` when the panel is visible), so sitting on the Configuration tab costs no recurring `fs.exec`; `switchTab` calls `updateStatus` directly on entering Status for an instant refresh. Tab switching toggles panel `display` and `cbi-tab`/`cbi-tab-disabled` classes — there is one menu node (`admin/network/jp_ipoe` → `jp_ipoe/config`), not a parent with status/config children. The **Preview Parameters** button calls `jp-ipoe-setup resolve` and shows the auto-resolved params inline without applying. ACL grants `exec` on `jp-ipoe-setup` and `uci` access to `jp_ipoe` in `root/usr/share/rpcd/acl.d/`. The view talks to the backend **only** through `jp-ipoe-setup` (`fs.exec`) — there is no rpcd method; the ACL whitelists the script by path, so any subcommand is allowed.

## Conventions

- POSIX `sh` only (BusyBox ash on device) — no bashisms. Source `/lib/functions.sh` and use `config_*` / `uci` helpers, not hand-rolled parsing.
- Logging goes through `log` / `log_err` (in `jp-ipoe-setup`), which write to both `logger -t jp-ipoe` and stderr. Lines starting `ERROR:` are parsed back out by the LuCI Apply handler, so keep that prefix for user-visible failures.
- `mapcalc` lookups respect `RULE_BMR` (the matched rule index), falling back to `RULE_1_*` — see `mapcalc_lookup` / `jp_ipoe_info_mapcalc_lookup` (duplicated in both scripts).
- Translations: `po/templates/jp_ipoe.pot` and `po/zh_Hans/`. Wrap user-facing LuCI strings in `_()`.
- MAP-E MTU is fixed at 1460 (`MAPE_MTU`); PPPoE fallback metric at 200 (`PPPOE_FALLBACK_METRIC`).
