#!/bin/sh
# Shared by the forwarding command, SNAT helper and netifd protocol handler.
# Callers provide network_* and (for emit) json_* helpers.

. /usr/share/jp-ipoe/config.sh

jp_forward_port_valid() {
	case "$1" in ''|0*|*[!0-9]*) return 1 ;; esac
	[ "${#1}" -le 5 ] && [ "$1" -le 65535 ]
}

jp_forward_ipv4_valid() {
	printf '%s\n' "$1" | awk -F. '
		NR != 1 || NF != 4 { exit 1 }
		{ for (i = 1; i <= 4; i++)
			if ($i !~ /^[0-9]+$/ || length($i) > 3 || $i > 255 || (length($i) > 1 && $i ~ /^0/)) exit 1
		  if ($1 == 0 || $1 == 127 || $1 >= 224) exit 1 }
	'
}

# Select a single assigned port, excluding ranges in blocked. A requested port
# must pass exactly the same checks as automatic selection. No shell eval.
jp_forward_select() {
	awk -v ranges="$1" -v blocked="$2" -v requested="$3" '
		function expand(text, out,    n,a,i,b,k,lo,hi) {
			gsub(/:/, "-", text)
			n = split(text, a, /[ \t\r\n]+/)
			for (i = 1; i <= n; i++) {
				if (a[i] == "") continue
				if (a[i] !~ /^[1-9][0-9]*(-[1-9][0-9]*)?$/) return 0
				k = split(a[i], b, "-"); lo = b[1] + 0; hi = k == 1 ? lo : b[2] + 0
				if (lo < 1 || hi > 65535 || lo > hi) return 0
				for (k = lo; k <= hi; k++) out[k] = 1
			}
			return 1
		}
		BEGIN {
			if (!expand(ranges, allowed) || !expand(blocked, used)) exit 1
			if (requested != "") {
				if (requested !~ /^[1-9][0-9]*$/ || !(requested in allowed) || requested in used) exit 1
				print requested; exit
			}
			for (p = 1; p <= 65535; p++)
				if (p in allowed && !(p in used)) { print p; exit }
			exit 1
		}'
}

jp_forward_rule_valid() {
	case "$JP_F_IFACE" in ''|*[!A-Za-z0-9_]*) return 1 ;; esac
	case "$JP_F_PROTO" in tcp|udp|tcpudp) ;; *) return 1 ;; esac
	jp_forward_port_valid "$JP_F_PORT" && jp_forward_port_valid "$JP_F_DEST" &&
		jp_forward_ipv4_valid "$JP_F_PUBLIC" && jp_forward_ipv4_valid "$JP_F_IP"
}

jp_forward_reserved_cb() {
	local iface port public
	config_get iface "$1" iface ""
	config_get port "$1" external_port ""
	config_get public "$1" public_ip ""
	[ "$iface" = "$JP_FORWARD_IFACE" ] || return 0
	[ -z "$JP_FORWARD_PUBLIC" ] || [ "$public" = "$JP_FORWARD_PUBLIC" ] || return 0
	jp_forward_port_valid "$port" && append JP_FORWARD_RESERVED "$port"
}

jp_forward_reserved() {
	JP_FORWARD_IFACE="$1"
	JP_FORWARD_PUBLIC="$2"
	JP_FORWARD_RESERVED=""
	config_load jp_ipoe
	config_get JP_FORWARD_RESERVED config dont_snat_to ""
	config_foreach jp_forward_reserved_cb forward
}

jp_forward_zone_cb() {
	local networks name
	config_get networks "$1" network ""
	list_contains networks "$JP_ZONE_NETWORK" || return 0
	config_get name "$1" name ""
	append JP_ZONE_NAMES "$name"
}

jp_forward_zone() {
	local JP_ZONE_NETWORK="$1" JP_ZONE_NAMES=""
	config_load firewall
	config_foreach jp_forward_zone_cb zone
	# Ambiguous/missing zones are not safe forwarding targets.
	case "$JP_ZONE_NAMES" in ''|*[!A-Za-z0-9_]*) return 1 ;; esac
	printf '%s' "$JP_ZONE_NAMES"
}

jp_forward_lan_valid() {
	local subnet router
	jp_forward_ipv4_valid "$1" || return 1
	network_get_subnet subnet lan && network_get_ipaddr router lan || return 1
	[ "$1" != "$router" ] || return 1
	awk -v address="$1" -v subnet="$subnet" '
		function ip(s, a) { split(s,a,"."); return ((a[1]*256+a[2])*256+a[3])*256+a[4] }
		BEGIN {
			split(subnet,s,"/"); if (s[2] !~ /^[0-9]+$/ || s[2] > 32) exit 1
			size = 2 ^ (32-s[2]); net = int(ip(s[1])/size); host = ip(address)
			if (int(host/size) != net || (size > 2 && (host == net*size || host == (net+1)*size-1))) exit 1
		}'
}

jp_forward_protocol_overlap() {
	local proto
	for proto in $1; do
		case "$proto" in
			all|any|tcpudp|tcp+udp|'*') return 0 ;;
			tcp|6) [ "$2" != udp ] && return 0 ;;
			udp|17) [ "$2" != tcp ] && return 0 ;;
		esac
	done
	return 1
}

jp_forward_redirect_cb() {
	local enabled family target proto ports
	config_get_bool enabled "$1" enabled 1
	[ "$enabled" = 1 ] || return 0
	config_get family "$1" family any
	case "$family" in ipv6|inet6) return 0 ;; esac
	config_get target "$1" target DNAT
	[ "$target" = DNAT ] || return 0
	config_get proto "$1" proto "tcp udp"
	jp_forward_protocol_overlap "$proto" "$JP_CHECK_PROTO" || return 0
	config_get ports "$1" src_dport "1-65535"
	# Deliberately conservative across source zones/addresses and schedules.
	append JP_FORWARD_BLOCKED "${ports:-1-65535}"
}

jp_forward_conflict_cb() {
	local section="$1"
	[ "$section" = "$JP_CHECK_IGNORE" ] && return 0
	jp_forward_load_rule "$section"
	[ "$JP_F_IFACE" = "$JP_CHECK_IFACE" ] || return 0
	jp_forward_protocol_overlap "$JP_F_PROTO" "$JP_CHECK_PROTO" || return 0
	append JP_FORWARD_BLOCKED "$JP_F_PORT"
}

# Snapshot kernel bindings (including IPv6 wildcard bindings) and outbound NAT.
# Fail closed if conntrack inspection is unavailable. New NAT allocations are
# prevented by installing SNAT reservations BEFORE calling this during setup.
jp_forward_busy() {
	local data file proto
	JP_FORWARD_BUSY=""
	pidof miniupnpd >/dev/null 2>&1 && return 1
	data="$(conntrack -L -f ipv4 2>/dev/null)" || return 1
	JP_FORWARD_BUSY="$(printf '%s\n' "$data" | awk -v ip="$1" '
		{
			proto=""; src=0; dst=0; sport=0; dport=0; origsrc=""; origdst=""; osport=""; rdport=""; replydst=""
			for(i=1;i<=NF;i++) {
				if ($i == "tcp" || $i == "udp") proto=$i
				split($i,a,"=")
				if(a[1]=="src" && ++src==1) origsrc=a[2]
				if(a[1]=="dst") { dst++; if(dst==1) origdst=a[2]; else if(dst==2) replydst=a[2] }
				if(a[1]=="sport" && ++sport==1) osport=a[2]
				if(a[1]=="dport" && ++dport==2) rdport=a[2]
			}
			# Existing inbound DNAT sessions are not outbound port collisions.
			if(proto!="" && origdst!=ip) {
				if(replydst==ip && rdport ~ /^[0-9]+$/) print proto,rdport
				if(origsrc==ip && osport ~ /^[0-9]+$/) print proto,osport
			}
		}')"
	for file in /proc/net/tcp /proc/net/tcp6 /proc/net/udp /proc/net/udp6; do
		[ -r "$file" ] || return 1
		case "$file" in *tcp*) proto=tcp ;; *) proto=udp ;; esac
		data="$(awk -v proto="$proto" '
			NR > 1 { split($2,a,":"); h=toupper(a[2]); p=0
				for(i=1;i<=length(h);i++) p=p*16+index("0123456789ABCDEF",substr(h,i,1))-1
				if(p>0) print proto,p }
		' "$file")" || return 1
		append JP_FORWARD_BUSY "$data" "
"
	done
}

jp_forward_blocked() {
	local JP_CHECK_IFACE="$1" JP_CHECK_PROTO="$2" JP_CHECK_IGNORE="$3"
	JP_FORWARD_BLOCKED="$(printf '%s\n' "$JP_FORWARD_BUSY" | awk -v p="$2" '$1 == p || p == "tcpudp" { print $2 }')"
	config_load firewall
	config_foreach jp_forward_redirect_cb redirect
	config_load jp_ipoe
	config_foreach jp_forward_conflict_cb forward
}

jp_forward_emit_cb() {
	local section="$1" iface public port address dest proto
	jp_forward_load_rule "$section"
	jp_forward_rule_valid || return 0
	[ "$JP_F_IFACE" = "$JP_EMIT_IFACE" ] && [ "$JP_F_PUBLIC" = "$JP_EMIT_PUBLIC" ] || return 0
	iface="$JP_F_IFACE"; public="$JP_F_PUBLIC"; port="$JP_F_PORT"
	address="$JP_F_IP"; dest="$JP_F_DEST"; proto="$JP_F_PROTO"
	jp_forward_lan_valid "$address" || return 0
	# config_foreach below reloads config, so preserve this rule in locals.
	jp_forward_blocked "$iface" "$proto" "$section"
	jp_forward_select "$JP_EMIT_RANGES" "$JP_FORWARD_BLOCKED" "$port" >/dev/null || {
		logger -t jp-ipoe "Port forwarding $section suspended: port $port outside allocation or locally busy."
		return 0
	}
	[ "$proto" = tcpudp ] && proto="tcp udp"
	json_add_object ""
	json_add_string type redirect
	json_add_string name "jp_ipoe_$section"
	json_add_string target DNAT
	json_add_string family inet
	json_add_string src "$JP_EMIT_SRC"
	json_add_string dest "$JP_EMIT_DEST"
	json_add_string src_dip "$public"
	json_add_string src_dport "$port"
	json_add_string dest_ip "$address"
	json_add_string dest_port "$dest"
	json_add_string proto "$proto"
	json_add_boolean reflection 0
	json_close_object
}

# Append dynamic fw4 redirects to netifd firewall data. No persistent firewall
# sections: disconnect withdraws redirects; a changed public IP/port set never
# silently retargets a saved forwarding rule to a different allocation.
jp_forward_emit() {
	local JP_EMIT_IFACE="$1" JP_EMIT_PUBLIC="$2" JP_EMIT_RANGES="$3"
	local JP_EMIT_SRC JP_EMIT_DEST only="$4"
	JP_EMIT_SRC="$(jp_forward_zone "$1")" || return 0
	JP_EMIT_DEST="$(jp_forward_zone lan)" || return 0
	[ "$JP_EMIT_SRC" != "$JP_EMIT_DEST" ] || return 0
	config_load jp_ipoe
	local sections="$CONFIG_SECTIONS" section type found=0
	for section in $sections; do
		config_get type "$section" TYPE
		[ "$type" = forward ] && found=1
	done
	[ "$found" = 1 ] || return 0
	jp_forward_busy "$2" || {
		logger -t jp-ipoe "Port forwarding suspended: cannot inspect local ports/NAT, or miniupnpd is running."
		return 0
	}
	# Hot updates render only the requested rule, preserving other live rules.
	# Stable section list: callbacks load both firewall and jp_ipoe.
	for section in $sections; do
		[ -n "$only" ] && [ "$section" != "$only" ] && continue
		config_get type "$section" TYPE
		[ "$type" = forward ] && jp_forward_emit_cb "$section"
	done
	return 0
}
