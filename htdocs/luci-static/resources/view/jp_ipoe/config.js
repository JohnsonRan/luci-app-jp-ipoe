'use strict';
'require view';
'require form';
'require fs';
'require ui';
'require uci';
'require poll';
'require tools.widgets as widgets';

return view.extend({
	load: function() {
		return Promise.all([
			uci.load('jp_ipoe')
		]);
	},

	// Lines starting "ERROR:" on stderr are the backend's user-visible failure
	// contract (see CLAUDE.md); every handler that surfaces command failures
	// must extract them through here.
	extractErrorLines: function(text) {
		return (text || '').split(/\n/).filter(function(line) {
			return line.indexOf('ERROR:') === 0;
		});
	},

	formatCommandOutput: function(res) {
		var output = (res.stderr || res.stdout || '').trim();
		var errors = this.extractErrorLines(output);

		if (errors.length)
			return _('Setup script exited with code:') + ' ' + res.code + '\n' + errors.join('\n');

		if (output)
			return _('Setup script exited with code:') + ' ' + res.code + '\n' + output.split(/\n/).slice(-8).join('\n');

		return _('Setup script exited with code:') + ' ' + res.code;
	},

	runSetupAction: function(args, okMessage, failMessage) {
		var self = this;
		return fs.exec('/usr/sbin/jp-ipoe-setup', args).then(function(res) {
			if (res.code === 0) {
				var unchanged = args[0] === 'start' && (res.stdout || '').trim() === 'JP_IPOE_UNCHANGED=1';
				ui.addTimeLimitedNotification(null, E('p', unchanged
					? _('IPoE is already configured. No restart needed.') : okMessage), 5000, 'info');
			} else
				ui.addNotification(null, E('pre', {},
					(failMessage ? failMessage + '\n' : '') + self.formatCommandOutput(res)), 'error');
		}).catch(function(e) {
			ui.addNotification(null, E('p', _('Error executing setup script:') + ' ' + e.message), 'error');
		});
	},

	// Count the assigned ranges from mapcalc, not unreserved or idle ports.
	portRangeSummary: function(text) {
		if (text == null || text === '-' || text === _('Unavailable'))
			return _('Unavailable');
		if (typeof text !== 'string')
			return _('Unknown');
		text = text.trim().replace(/^(['"])([\s\S]*)\1$/, '$2').trim();
		if (!text)
			return _('Unavailable');

		var ranges = text.split(/[\s,]+/).map(function(token) {
			var match = token.match(/^(\d+)(?:-(\d+))?$/);
			if (!match)
				return null;
			var first = Number(match[1]), last = Number(match[2] || match[1]);
			return first >= 1 && last <= 65535 && first <= last ? [first, last] : null;
		});
		if (ranges.some(function(range) { return !range; }))
			return _('Unknown');
		ranges.sort(function(a, b) { return a[0] - b[0]; });
		var total = 0;
		for (var i = 0; i < ranges.length; i++) {
			// Do not silently double-count malformed overlapping ranges.
			if (i && ranges[i][0] <= ranges[i - 1][1])
				return _('Unknown');
			total += ranges[i][1] - ranges[i][0] + 1;
		}
		return _('Ranges: %d · Assigned ports: %d').replace('%d', ranges.length).replace('%d', total);
	},

	// Single source for the status table: renderStatusPanel builds the rows
	// from id/label, updateStatus fills them via get(data).
	statusFields: function() {
		var counter = function(data, key) {
			var value = (data.conntrack || {})[key];
			return (typeof value === 'string' || typeof value === 'number') && /^[0-9]+$/.test(value)
				? String(value) : _('Unavailable');
		};
		return [
			{ id: 's-wan6-iface', label: _('WAN6 Interface'), get: function(d) { return { text: d.wan6_iface || '-' }; } },
			{ id: 's-wan6-device', label: _('WAN6 Device'), get: function(d) { return { text: d.wan6_device || '-' }; } },
			{ id: 's-wan6-ipv6', label: _('WAN6 IPv6 Address'), get: function(d) { return { text: d.wan6_ipv6 || _('Not connected'), ok: !!d.wan6_ipv6 }; } },
			{ id: 's-mape-iface', label: _('MAP-E Interface'), get: function(d) { return { text: d.mape_iface || '-' }; } },
			{ id: 's-mape-state', label: _('MAP-E Tunnel State'), get: function(d) { return { text: d.mape_state || 'down', ok: d.mape_state === 'up', bold: true }; } },
			{ id: 's-mape-ipv4', label: _('MAP-E IPv4 Address'), get: function(d) { return { text: d.mape_ipv4 || _('Not assigned'), ok: !!d.mape_ipv4 }; } },
			{ id: 's-br-addr', label: _('Border Relay (BR)'), get: function(d) { return { text: d.br_addr || _('Not set'), ok: !!d.br_addr }; } },
			{ id: 's-port-info', label: _('Assigned Port Ranges'), get: function(d) { return { text: d.port_info || '-' }; } },
			{ id: 's-pppoe-metric', label: _('PPPoE Fallback Metric'), get: function(d) { return { text: d.pppoe_fallback_metrics || _('None') }; } },
			{ id: 's-ct-count', label: _('Conntrack entries / limit'), get: function(d) { return { text: counter(d, 'count') + ' / ' + counter(d, 'max') }; } },
			{ id: 's-ct-insert-failed', label: _('Conntrack insert failures'), get: function(d) { return { text: counter(d, 'insert_failed') }; } },
			{ id: 's-ct-drop', label: _('Conntrack drops'), get: function(d) { return { text: counter(d, 'drop') }; } },
			{ id: 's-ct-early-drop', label: _('Conntrack early evictions'), get: function(d) { return { text: counter(d, 'early_drop') }; } }
		];
	},

	render: function() {
		var self = this;

		var m, s, o;

		m = new form.Map('jp_ipoe', null, _('Set up OCN Virtual Connect / v6plus (MAP-E) over an existing DHCPv6 WAN.'));

		s = m.section(form.NamedSection, 'config', 'jp_ipoe', _('Settings'));
		s.addremove = false;

		o = s.option(form.Flag, 'enabled', _('Enable at Boot'), _('Automatically apply configuration on router startup.'));
		o.default = o.disabled;

		o = s.option(widgets.DeviceSelect, 'wan_device', _('WAN Physical Device'), _('Physical network device used for WAN connection (e.g. eth0).'));
		o.default = 'eth0';
		o.noaliases = true;

		o = s.option(widgets.NetworkSelect, 'wan6_iface', _('IPv6 WAN Interface Name'), _('Name of the existing DHCPv6 interface to use (default: wan6).'));
		o.default = 'wan6';
		o.nocreate = true;

		o = s.option(form.Value, 'mape_iface', _('MAP-E Interface Name'), _('Name for the MAP-E tunnel interface (default: wan6mape).'));
		o.default = 'wan6mape';
		o.datatype = 'string';

		o = s.option(form.Flag, 'legacymap', _('Use Legacy MAP'), _('Required for OCN Virtual Connect and v6plus.'));
		o.default = o.enabled;
		o.rmempty = false;

		o = s.option(form.Flag, 'auto', _('Auto Parameters'), _('Look up OCN/v6plus parameters from the WAN6 prefix. Disable for manual setup.'));
		o.default = o.disabled;
		o.rmempty = false;

		o = s.option(form.Value, 'br_addr', _('BR Address (Border Relay)'), _('Border Relay IPv6 address, from the MAP-E calculator (http://ipv4.web.fc2.com/map-e.html).'));
		o.datatype = 'ip6addr';
		o.optional = true;
		o.placeholder = '2001:f88:...';
		o.depends('auto', '0');

		o = s.option(form.Value, 'ipaddr', _('IPv4 Prefix (ipaddr)'), _('Mapped IPv4 prefix calculated from the MAP-E calculator (e.g. 153.153.153.153).'));
		o.datatype = 'ip4addr';
		o.optional = true;
		o.depends('auto', '0');

		o = s.option(form.Value, 'ip4prefixlen', _('IPv4 Prefix Length'), _('Normally 20 for OCN.'));
		o.datatype = 'integer';
		o.default = '20';
		o.optional = true;
		o.depends('auto', '0');

		o = s.option(form.Value, 'ip6prefix', _('IPv6 Prefix'), _('Mapped IPv6 prefix (e.g. 2400:4050::).'));
		o.datatype = 'ip6addr';
		o.optional = true;
		o.depends('auto', '0');

		o = s.option(form.Value, 'ip6prefixlen', _('IPv6 Prefix Length'), _('Normally 38 for OCN.'));
		o.datatype = 'integer';
		o.default = '38';
		o.optional = true;
		o.depends('auto', '0');

		o = s.option(form.Value, 'ealen', _('EA bits length'), _('Normally 18 for OCN.'));
		o.datatype = 'integer';
		o.default = '18';
		o.optional = true;
		o.depends('auto', '0');

		o = s.option(form.Value, 'psidlen', _('PSID bits length'), _('Normally 6 for OCN.'));
		o.datatype = 'integer';
		o.default = '6';
		o.optional = true;
		o.depends('auto', '0');

		o = s.option(form.Value, 'offset', _('PSID offset'), _('Normally 6 for OCN.'));
		o.datatype = 'integer';
		o.default = '6';
		o.optional = true;
		o.depends('auto', '0');

		o = s.option(form.Value, 'dont_snat_to', _('Reserved IPv4 Ports'), _('Exclude these IPv4 ports from MAP-E SNAT (space-separated). Leave empty unless reserving inbound ports.'));
		o.datatype = 'string';
		o.optional = true;
		o.placeholder = '2938 7088 10233';

		o = s.option(form.Flag, 'dhcpv6_relay', _('Enable DHCPv6/NDP Relay'), _('Enable for RA /64 without prefix delegation (PD). With PD, disable to use server mode.'));
		o.default = o.enabled;
		o.rmempty = false;

		var s2 = m.section(form.NamedSection, 'config', 'jp_ipoe', _('Actions'));

		var applyIPoE = function(force) {
			if (force && !window.confirm(_('Force reconnect and repair IPoE? This runs the full setup and may interrupt IPv4 and IPv6 traffic.')))
				return;
			ui.addTimeLimitedNotification(null, E('p', _('Checking IPoE settings; changes may take about 30 seconds.')), 5000, 'info');
			return m.save(null, true).then(function() {
				return self.runSetupAction([force ? 'repair' : 'start'], _('IPoE configuration applied.'));
			});
		};

		o = s2.option(form.Button, '_apply', _('Apply IPoE Configuration'));
		o.inputstyle = 'action';
		o.onclick = function() { return applyIPoE(false); };

		o = s2.option(form.Button, '_repair', _('Force Reconnect / Repair'));
		o.inputstyle = 'negative';
		o.description = _('Force full setup when IPoE is connected but unusable.');
		o.onclick = function() { return applyIPoE(true); };

		o = s2.option(form.Button, '_stop', _('Stop IPoE Interfaces'));
		o.inputstyle = 'negative';
		o.onclick = function() {
			if (!window.confirm(_('Stop MAP-E now? IPv4 traffic using IPoE will be interrupted.') + '\n' + _('Native IPv6 rules are not removed by stopping MAP-E.')))
				return;
			return self.runSetupAction(['stop'], _('IPoE interfaces stopped.'));
		};

		o = s2.option(form.Button, '_preview', _('Preview Parameters'));
		o.inputstyle = 'neutral';
		o.description = _('Preview from the WAN6 prefix without applying. Requires a global WAN6 IPv6 address.');
		o.onclick = function() {
			return self.previewParams();
		};

		o = s2.option(form.Button, '_detect_br', _('Auto-Detect BR Address'));
		o.inputstyle = 'neutral';
		o.description = _('Detect BR from the live MAP-E rule, then optionally save and apply. Manual mode only.');
		o.depends('auto', '0');
		o.onclick = function() {
			return self.detectBR();
		};

		return m.render().then(function(formNode) {
			var configPanel = E('div', { 'id': 'jp-tab-config' }, [
				formNode,
				E('div', {
					'id': 'jp-preview-out',
					'style': 'margin-top:8px; font-family:monospace; white-space:pre-wrap; color:inherit; display:none; padding:8px 10px; border:1px solid rgba(128,128,128,0.4); border-radius:4px; background:rgba(128,128,128,0.08);'
				}, '')
			]);

			var statusPanel = E('div', { 'id': 'jp-tab-status', 'style': 'display:none;' }, self.renderStatusPanel());
			var forwardPanel = E('div', { 'id': 'jp-tab-forward', 'class': 'jp-forward', 'style': 'display:none;' }, self.renderForwardPanel());

			var mkTab = function(name, label, active) {
				return E('li', { 'class': active ? 'cbi-tab' : 'cbi-tab-disabled' }, [
					E('a', {
						'href': '#',
						'click': function(ev) {
							ev.preventDefault();
							self.switchTab(name);
						}
					}, label)
				]);
			};

			var tabmenu = E('ul', { 'class': 'cbi-tabmenu', 'id': 'jp-tabmenu' }, [
				mkTab('config', _('Configuration'), true),
				mkTab('status', _('Status'), false),
				mkTab('forward', _('Port Forwarding'), false)
			]);

			self.activeTab = 'config';
			poll.add(L.bind(self.updateStatus, self), 10);

			return E('div', { 'class': 'cbi-map' }, [
				E('h2', {}, _('JP IPoE')),
				tabmenu,
				configPanel,
				statusPanel,
				forwardPanel
			]);
		});
	},

	switchTab: function(name) {
		var menu = document.getElementById('jp-tabmenu');
		if (!menu)
			return;

		this.activeTab = name;
		var tabs = menu.querySelectorAll('li');
		['config', 'status', 'forward'].forEach(function(tab, index) {
			document.getElementById('jp-tab-' + tab).style.display = tab === name ? '' : 'none';
			tabs[index].className = tab === name ? 'cbi-tab' : 'cbi-tab-disabled';
		});

		if (name === 'status')
			this.updateStatus();
		else if (name === 'forward') {
			this.loadForwards();
			this.loadForwardDevices();
		}
	},

	renderForwardPanel: function() {
		var self = this;
		var field = function(id, label, input, hidden) {
			return E('div', { 'id': id + '-field', 'class': 'jp-forward-field', 'style': hidden ? 'display:none;' : '' }, [
				E('label', { 'for': id }, label), input
			]);
		};
		return [
			E('style', {}, [
				'.jp-forward{max-width:1100px}',
				'.jp-forward .jp-forward-section{margin:1rem 0;padding:1rem;border:1px solid rgba(128,128,128,.3);border-radius:4px}',
				'.jp-forward .jp-forward-summary,.jp-forward .jp-forward-heading{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:.75rem}',
				'.jp-forward h3,.jp-forward .jp-forward-summary p{margin:0}',
				'.jp-forward .jp-forward-public{font-size:1.1em}',
				'.jp-forward .jp-forward-note{margin:.75rem 0;line-height:1.5}',
				'.jp-forward details{margin-top:.75rem}',
				'.jp-forward summary{cursor:pointer;padding:.25rem 0}',
				'.jp-forward .jp-forward-ranges{display:grid;grid-template-columns:repeat(auto-fit,minmax(8rem,1fr));gap:.35rem .75rem;max-height:12rem;overflow:auto;list-style:none;padding:.75rem 0;margin:0;font-family:monospace}',
				'.jp-forward .jp-forward-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:1rem;margin:1rem 0}',
				'.jp-forward .jp-forward-selectors{display:grid;grid-template-columns:2fr 1fr;gap:1rem;margin:1rem 0}',
				'.jp-forward .jp-forward-table .td{overflow-wrap:anywhere;white-space:normal}',
				'.jp-forward .jp-forward-field{display:flex;flex-direction:column;gap:.5rem;min-width:0}',
				'.jp-forward .jp-forward-field input,.jp-forward .jp-forward-field select{width:100%;max-width:none;min-width:0;box-sizing:border-box;margin:0}',
				'.jp-forward .jp-forward-actions{display:flex;justify-content:flex-end;gap:.5rem}',
				'.jp-forward .jp-forward-table{overflow-x:auto;margin-top:.75rem}',
				'.jp-forward .jp-forward-table table{min-width:42rem;margin:0}',
				'.jp-forward .jp-forward-empty{text-align:center;padding:1.5rem .5rem;margin:0}',
				'@media(max-width:850px){.jp-forward .jp-forward-fields{grid-template-columns:repeat(2,minmax(0,1fr))}}',
				'@media(max-width:520px){.jp-forward .jp-forward-fields,.jp-forward .jp-forward-selectors{grid-template-columns:minmax(0,1fr)}}'
			].join('\n')),
			E('section', { 'class': 'jp-forward-section' }, [
				E('div', { 'class': 'jp-forward-summary', 'aria-live': 'polite' }, [
					E('div', {}, [_('Public IPv4'), ': ', E('strong', { 'id': 'jp-forward-public', 'class': 'jp-forward-public' }, '—')]),
					E('p', { 'id': 'jp-forward-allocation' }, _('Loading...'))
				]),
				E('details', {}, [
					E('summary', {}, _('Assigned Port Ranges')),
					E('ul', { 'id': 'jp-forward-portsets', 'class': 'jp-forward-ranges', 'tabindex': '0' })
				])
			]),
			E('section', { 'class': 'jp-forward-section' }, [
				E('h3', {}, _('Add a forward')),
				E('p', { 'class': 'jp-forward-note' }, _('Leave the IPv4 external port empty for automatic selection. IPv6 uses the device address and service port directly.')),
				E('div', { 'class': 'jp-forward-selectors' }, [
					field('jp-forward-device', _('Device (MAC)'), E('select', {
						'id': 'jp-forward-device', 'class': 'cbi-input-select',
						'change': function() { self.selectForwardDevice(); }
					}, [E('option', { 'value': '' }, _('Enter addresses manually'))])),
					field('jp-forward-family', _('IP version'), E('select', {
						'id': 'jp-forward-family', 'class': 'cbi-input-select',
						'change': function() { self.updateForwardFamily(); }
					}, [
						E('option', { 'value': 'ipv4' }, 'IPv4'),
						E('option', { 'value': 'ipv6' }, 'IPv6'),
						E('option', { 'value': 'dual' }, 'IPv4 + IPv6')
					]))
				]),
				E('p', { 'class': 'jp-forward-note' }, _('Fills current addresses only, without MAC binding. Verify the address and LAN service.')),
				E('div', { 'class': 'jp-forward-fields' }, [
					field('jp-forward-proto', _('Protocol'), E('select', { 'id': 'jp-forward-proto', 'class': 'cbi-input-select' }, [
						E('option', { 'value': 'tcp' }, 'TCP'),
						E('option', { 'value': 'udp' }, 'UDP'),
						E('option', { 'value': 'tcpudp' }, 'TCP + UDP')
					])),
					field('jp-forward-ip', _('LAN IPv4 Address'), E('input', { 'id': 'jp-forward-ip', 'class': 'cbi-input-text', 'type': 'text', 'inputmode': 'decimal', 'required': '', 'placeholder': '192.168.1.10' })),
					field('jp-forward-ip6', _('Device public IPv6'), E('input', { 'id': 'jp-forward-ip6', 'class': 'cbi-input-text', 'type': 'text', 'list': 'jp-forward-ip6-options', 'required': '', 'disabled': '', 'placeholder': '2001:db8::10' }), true),
					E('datalist', { 'id': 'jp-forward-ip6-options' }),
					field('jp-forward-dest', _('Service Port'), E('input', { 'id': 'jp-forward-dest', 'class': 'cbi-input-text', 'type': 'number', 'min': 1, 'max': 65535, 'step': 1, 'required': '', 'placeholder': '8080' })),
					field('jp-forward-port', _('External Port'), E('input', { 'id': 'jp-forward-port', 'class': 'cbi-input-text', 'type': 'number', 'min': 1, 'max': 65535, 'step': 1, 'placeholder': _('Automatic port') }))
				]),
				E('div', { 'class': 'jp-forward-actions' }, E('button', {
					'class': 'btn cbi-button cbi-button-positive',
					'click': function() {
						var family = document.getElementById('jp-forward-family').value;
						var fields = ['proto', 'dest'].concat(family !== 'ipv6' ? ['ip', 'port'] : [], family !== 'ipv4' ? ['ip6'] : []);
						if (!fields.every(function(id) { return document.getElementById('jp-forward-' + id).reportValidity(); }))
							return;
						var value = function(id) { return document.getElementById('jp-forward-' + id).value.trim(); };
						var commands = [];
						if (family !== 'ipv6')
							commands.push(['forward_add', value('proto'), value('ip'), value('dest'), value('port')]);
						if (family !== 'ipv4')
							commands.push(['forward_add6', value('proto'), value('ip6'), value('dest')]);
						self.confirmForward(commands);
					}
				}, _('Check & Add Forward')))
			]),
			E('section', { 'class': 'jp-forward-section' }, [
				E('div', { 'class': 'jp-forward-heading' }, [
					E('h3', {}, _('Existing forwards')),
					E('button', { 'class': 'btn cbi-button', 'click': ui.createHandlerFn(self, function() {
						return Promise.all([self.loadForwards(), self.loadForwardDevices()]);
					}) }, _('Refresh'))
				]),
				E('p', { 'class': 'jp-forward-note' }, _('Published rules are not proof of Internet reachability.')),
				E('div', { 'id': 'jp-forward-rules', 'class': 'jp-forward-table' }, E('p', { 'class': 'jp-forward-empty' }, _('Loading...')))
			]),
			E('details', {}, [
				E('summary', {}, _('Checks and limitations')),
				E('p', { 'class': 'jp-forward-note' }, _('IPv6 rules survive MAP-E stop and plugin uninstall. Delete here or in Firewall traffic rules; recreate after destination IPv6 changes.')),
				E('p', { 'class': 'jp-forward-note' }, _('Local checks: LAN routes, IPv4 port/NAT conflicts and duplicate managed IPv6 rules. Service availability and other firewall policies are not verified.')),
				E('p', { 'class': 'jp-forward-note' }, _('IPv4 external ports must be assigned; LAN service ports need not be. Checks cover redirects, router bindings and outbound NAT, not custom nftables rules. Stop UPnP first.')),
				E('p', { 'class': 'jp-forward-note' }, _('IPv4 targets use the main lan subnet. Ports are reserved from SNAT without changing manual reservations. Public IPv4 or incompatible allocation changes suspend rules; delete and recreate them.'))
			])
		];
	},

	updateForwardFamily: function() {
		var family = document.getElementById('jp-forward-family').value;
		['ip', 'port', 'ip6'].forEach(function(id) {
			var hidden = id === 'ip6' ? family === 'ipv4' : family === 'ipv6';
			document.getElementById('jp-forward-' + id + '-field').style.display = hidden ? 'none' : '';
			document.getElementById('jp-forward-' + id).disabled = hidden;
		});
	},

	loadForwardDevices: function() {
		var self = this;
		return fs.exec('/usr/sbin/jp-ipoe-setup', ['forward_devices']).then(function(res) {
			if (res.code !== 0)
				throw new Error(self.formatCommandOutput(res));
			self.forwardDevices = JSON.parse(res.stdout);
			var select = document.getElementById('jp-forward-device'), previous = select.value;
			select.textContent = '';
			select.appendChild(E('option', { 'value': '' }, _('Enter addresses manually')));
			Object.keys(self.forwardDevices).sort().forEach(function(mac) {
				var device = self.forwardDevices[mac];
				select.appendChild(E('option', { 'value': mac }, [device.name || '', mac, (device.ipaddrs || []).join(', ')].filter(Boolean).join(' — ')));
			});
			select.value = previous;
		}).catch(function() {
			ui.addNotification(null, E('p', _('Unable to load devices. Enter addresses manually.')), 'warning');
		});
	},

	selectForwardDevice: function() {
		var device = (this.forwardDevices || {})[document.getElementById('jp-forward-device').value];
		if (!device)
			return;
		var ipv6 = (device.ip6addrs || []).filter(function(ip) { return /^[23][0-9a-f]{3}:/i.test(ip); });
		document.getElementById('jp-forward-ip').value = (device.ipaddrs || [])[0] || '';
		document.getElementById('jp-forward-ip6').value = ipv6[0] || '';
		var list = document.getElementById('jp-forward-ip6-options');
		list.textContent = '';
		ipv6.forEach(function(ip) { list.appendChild(E('option', { 'value': ip })); });
	},

	forwardEndpoint: function(address, port) {
		return (address.indexOf(':') >= 0 ? '[' + address + ']' : address) + ':' + port;
	},

	loadForwards: function() {
		var self = this;
		return fs.exec('/usr/sbin/jp-ipoe-setup', ['forward_list']).then(function(res) {
			if (res.code !== 0)
				throw new Error(self.formatCommandOutput(res));
			var data = JSON.parse(res.stdout);
			var ranges = (data.portsets || '').trim().split(/\s+/).filter(Boolean);
			var ports = ranges.reduce(function(total, range) {
				var bounds = range.split('-');
				return total + Number(bounds[1] || bounds[0]) - Number(bounds[0]) + 1;
			}, 0);
			document.getElementById('jp-forward-public').textContent = data.public_ip || '—';
			document.getElementById('jp-forward-allocation').textContent = data.up
				? _('MAP-E connected') + ' · ' + _('Assigned ports') + ': ' + ports + ' · ' + _('Port ranges') + ': ' + ranges.length
				: _('MAP-E is down. IPv4 forwarding requires IPoE; IPv6 uses the native connection.');
			var rangeList = document.getElementById('jp-forward-portsets');
			rangeList.textContent = '';
			ranges.forEach(function(range) { rangeList.appendChild(E('li', {}, range)); });
			if (!ranges.length)
				rangeList.appendChild(E('li', {}, _('Not assigned')));
			var table = E('table', { 'class': 'table cbi-section-table' }, [
				E('tr', { 'class': 'tr table-titles' }, [_('IP version'), _('Protocol'), _('Public Endpoint'), _('LAN Endpoint'), _('Status'), _('Actions')].map(function(label) {
					return E('th', { 'class': 'th', 'scope': 'col' }, label);
				}))
			]);
			(data.rules || []).forEach(function(rule) {
				table.appendChild(E('tr', { 'class': 'tr' }, [
					E('td', { 'class': 'td' }, rule.family === 'ipv6' ? 'IPv6' : 'IPv4'),
					E('td', { 'class': 'td' }, rule.proto === 'tcpudp' ? 'TCP + UDP' : rule.proto.toUpperCase()),
					E('td', { 'class': 'td' }, self.forwardEndpoint(rule.public_ip, rule.external_port)),
					E('td', { 'class': 'td' }, self.forwardEndpoint(rule.internal_ip, rule.internal_port)),
					E('td', { 'class': 'td' }, rule.inspection_failed ? _('Firewall state unavailable') : rule.pending_remove ? _('Removal pending; retry deletion') : rule.active
						? (rule.family === 'ipv6' ? _('Firewall rule installed') : _('Published to tunnel'))
						: _('Inactive (tunnel down, allocation changed or local check failed)')),
					E('td', { 'class': 'td' }, E('button', {
						'class': 'btn cbi-button cbi-button-negative',
						'click': function() { self.confirmForward(['forward_remove', rule.id], rule); }
					}, _('Delete')))
				]));
			});
			var container = document.getElementById('jp-forward-rules');
			container.textContent = '';
			container.appendChild(data.rules && data.rules.length ? table : E('p', { 'class': 'jp-forward-empty' }, _('No managed port forwards.')));
		}).catch(function(e) {
			var allocation = document.getElementById('jp-forward-allocation');
			if (allocation)
				allocation.textContent = _('Refresh failed; displayed rules may be outdated.');
			ui.addNotification(null, E('p', e.message), 'error');
		});
	},

	confirmForward: function(args, rule) {
		var self = this;
		if (this.forwardBusy) {
			ui.addTimeLimitedNotification(null, E('p', _('A port-forwarding operation is in progress. Please wait.')), 5000, 'info');
			return;
		}
		var commands = Array.isArray(args[0]) ? args : [args];
		var adding = commands[0][0] !== 'forward_remove';
		var ipv6 = (rule && rule.family === 'ipv6') || commands.some(function(command) { return command[0] === 'forward_add6'; });
		var proto = rule ? rule.proto : commands[0][1];
		var endpoint = rule
			? self.forwardEndpoint(rule.public_ip, rule.external_port) + ' → ' + self.forwardEndpoint(rule.internal_ip, rule.internal_port)
			: commands.map(function(command) {
				return command[0] === 'forward_add6'
					? 'IPv6: ' + self.forwardEndpoint(command[2], command[3])
					: 'IPv4: ' + (command[4] || _('Automatic port')) + ' → ' + self.forwardEndpoint(command[2], command[3]);
			}).join(' / ');
		ui.showModal(_('Apply Port Forwarding'), [
			E('p', {}, (proto === 'tcpudp' ? 'TCP + UDP' : proto.toUpperCase()) + ': ' + endpoint),
			E('p', {}, _('Updates do not restart MAP-E or clear existing connections.')),
			E('p', {}, adding
				? _('This exposes the LAN service to the Internet. Secure it first; local checks do not guarantee future availability.')
				: _('Deletion removes only this rule. Existing sessions or other firewall rules may still allow access.')),
			ipv6 ? E('p', {}, _('IPv6 rules survive MAP-E stop and plugin uninstall. Delete here or in Firewall traffic rules; recreate after destination IPv6 changes.')) : '',
			commands.length > 1 ? E('p', {}, _('Dual stack saves two rules separately. On failure, successful rules remain; check existing rules before retrying.')) : '',
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel')),
				' ',
				E('button', {
					'class': 'btn cbi-button cbi-button-action',
					'click': ui.createHandlerFn(self, function() {
						if (self.forwardBusy)
							return;
						self.forwardBusy = true;
						return commands.reduce(function(pending, command) {
							return pending.then(function() {
								return fs.exec('/usr/sbin/jp-ipoe-setup', command).then(function(res) {
									if (res.code !== 0)
										throw new Error(self.formatCommandOutput(res));
									var message = _('Port forward removed.');
									if (adding) {
										var result = JSON.parse(res.stdout);
										message = _('Port forward added:') + ' ' + self.forwardEndpoint(result.public_ip, result.external_port);
									}
									ui.addTimeLimitedNotification(null, E('p', message), 5000, 'info');
								});
							});
						}, Promise.resolve()).catch(function(e) {
							ui.addNotification(null, E('p', (commands.length > 1
								? _('Partial completion is possible. Review existing rules before retrying.') + ' ' : '') + e.message), 'error');
						}).then(function() {
							self.forwardBusy = false;
							ui.hideModal();
							return self.loadForwards();
						});
					})
				}, _('Confirm'))
			])
		]);
	},

	previewParams: function() {
		var self = this;
		var out = document.getElementById('jp-preview-out');
		if (out) {
			out.style.display = '';
			out.textContent = _('Resolving parameters from WAN6 prefix...');
		}

		return fs.exec('/usr/sbin/jp-ipoe-setup', ['resolve']).then(function(res) {
			if (res.code === 0 && res.stdout) {
				var p = {};
				res.stdout.split(/\n/).forEach(function(line) {
					var mm = line.match(/^JP_AUTO_(\w+)='?([^']*)'?/);
					if (mm) p[mm[1]] = mm[2];
				});
				if (out)
					out.textContent =
						_('BR') + ': ' + (p.BR || '-') + '\n' +
						_('IPv4 Prefix') + ': ' + (p.IPADDR || '-') + '/' + (p.IP4PREFIXLEN || '') + '\n' +
						_('IPv6 Prefix') + ': ' + (p.IP6PREFIX || '-') + '/' + (p.IP6PREFIXLEN || '') + '\n' +
						'EA / PSID / ' + _('offset') + ': ' + (p.EALEN || '') + ' / ' + (p.PSIDLEN || '') + ' / ' + (p.OFFSET || '');
			} else {
				var err = self.extractErrorLines(res.stderr).join(' ');
				if (out) out.textContent = err || _('Could not resolve parameters.');
			}
		}).catch(function(e) {
			if (out) out.textContent = _('Error:') + ' ' + e.message;
		});
	},

	renderStatusPanel: function() {
		return [
			E('div', { 'class': 'cbi-section' }, [
				E('table', { 'class': 'table cbi-section-table', 'style': 'table-layout:fixed;width:100%;overflow-wrap:anywhere;' }, [
					E('tr', { 'class': 'tr table-titles' }, [
						E('th', { 'class': 'th' }, _('Item')),
						E('th', { 'class': 'th' }, _('Value'))
					])
				].concat(this.statusFields().map(function(field, index) {
					return E('tr', { 'class': 'tr cbi-rowstyle-' + (index % 2 + 1) }, [
						E('td', { 'class': 'td left' }, field.label),
						field.id === 's-port-info'
							? E('td', { 'class': 'td left' }, E('details', {}, [
								E('summary', { 'id': 's-port-info-summary', 'style': 'cursor:pointer;' }, _('Unavailable')),
								// Refresh only this value, preserving the disclosure's open state.
								E('div', { 'id': field.id, 'tabindex': '0', 'aria-label': field.label,
									'style': 'margin-top:.5rem;max-height:12rem;overflow:auto;overflow-wrap:anywhere;white-space:pre-wrap;font-family:monospace;' }, '-')
							]))
							: E('td', { 'class': 'td left', 'id': field.id }, '-')
					]);
				})))
			]),
			E('p', { 'class': 'cbi-map-descr' }, _('Conntrack covers the whole router. Failure/eviction counters are cumulative, not MAP-E port usage or Internet loss. Unavailable is not zero.')),
			E('div', { 'class': 'cbi-page-actions', 'style': 'display:flex; gap:8px;' }, [
				E('button', {
					'class': 'btn cbi-button cbi-button-action',
					'click': ui.createHandlerFn(this, function() {
						return this.updateStatus();
					})
				}, _('Refresh'))
			])
		];
	},

	updateStatus: function() {
		// Skip the polled status exec while the Status tab is inactive: the
		// poll stays registered but does no work, avoiding a process spawn +
		// ubus round-trips every 10s while the user sits on Config.
		// switchTab() calls this directly on entering Status, so display stays
		// instant.
		if (this.activeTab !== 'status')
			return Promise.resolve();

		return fs.exec('/usr/sbin/jp-ipoe-setup', ['status']).then(function(res) {
			if (res.code !== 0 || !res.stdout)
				throw new Error('Status unavailable');
			var data = JSON.parse(res.stdout);
			if (!data || typeof data !== 'object' || Array.isArray(data) ||
				(data.mape_state !== 'up' && data.mape_state !== 'down'))
				throw new Error('Invalid status response');
			this.statusFields().forEach(function(field) {
				var v = field.get(data);
				this.setField(field.id, v.text, v.ok, v.bold);
			}, this);
		}.bind(this)).catch(function() {
			// Do not leave an old successful snapshot looking current after an
			// exec/parse failure, or create a notification on every failed poll.
			this.statusFields().forEach(function(field) {
				this.setField(field.id, _('Unavailable'));
			}, this);
		}.bind(this));
	},

	setField: function(id, text, isOk, isBold) {
		var el = document.getElementById(id);
		if (!el)
			return;

		el.textContent = text || '-';
		if (id === 's-port-info') {
			var summary = document.getElementById('s-port-info-summary');
			if (summary)
				summary.textContent = this.portRangeSummary(text);
		}
		el.style.color = isOk === true ? '#4caf50' : isOk === false ? '#f44336' : '';
		el.style.fontWeight = isBold === true ? 'bold' : 'normal';
	},

	detectBR: function() {
		var self = this;
		ui.addTimeLimitedNotification(null, E('p', _('Detecting BR address via mapcalc...')), 5000, 'info');

		return fs.exec('/usr/sbin/jp-ipoe-setup', ['detect_br']).then(function(res) {
			var errMsg = _('Detection failed');

			if (res.code === 0 && res.stdout) {
				try {
					var data = JSON.parse(res.stdout);
					if (!data.error && data.br_addr)
						return self.promptSaveBR(data.br_addr);
					if (data.error)
						errMsg += ': ' + data.error;
				} catch (e) {
					errMsg = _('Failed to parse detection result');
				}
			}

			ui.addNotification(null, E('p', errMsg), 'error');
		}).catch(function(e) {
			ui.addNotification(null, E('p', _('Detection error')), 'error');
		});
	},

	promptSaveBR: function(br) {
		var self = this;
		ui.showModal(_('Save BR Address'), [
			E('p', {}, _('Save detected BR address to configuration and re-apply IPoE?')),
			E('p', {}, E('strong', {}, br)),
			E('div', { 'class': 'right' }, [
				E('button', {
					'class': 'btn cbi-button cbi-button-neutral',
					'click': ui.hideModal
				}, _('Cancel')),
				' ',
				E('button', {
					'class': 'btn cbi-button cbi-button-positive',
					'click': ui.createHandlerFn(self, function() {
						return self.saveAndApplyBR(br);
					})
				}, _('Save & Apply'))
			])
		]);
	},

	saveAndApplyBR: function(br) {
		var self = this;
		uci.set('jp_ipoe', 'config', 'br_addr', br);
		return uci.save().then(function() {
			return uci.apply();
		}).then(function() {
			ui.hideModal();
			return self.runSetupAction(['start'],
				_('BR address saved and IPoE re-applied.'),
				_('BR address saved, but IPoE re-apply failed.'));
		}).catch(function(e) {
			ui.hideModal();
			ui.addNotification(null, E('p', _('Failed to save BR address')), 'error');
		});
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
