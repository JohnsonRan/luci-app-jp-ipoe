'use strict';
'require view';
'require form';
'require fs';
'require ui';

return view.extend({
	render: function() {
		var m, s, o;

		m = new form.Map('jp_ipoe', _('JP IPoE Configuration'), _('Configure OCN Virtual Connect (MAP-E) IPoE connection. This plugin will automatically set up IPv6 WAN (DHCPv6) and MAP-E tunnel interfaces.'));

		s = m.section(form.NamedSection, 'config', 'jp_ipoe', _('Settings'));
		s.addremove = false;

		o = s.option(form.Flag, 'enabled', _('Enable at Boot'), _('Automatically apply configuration on router startup.'));
		o.default = o.disabled;

		o = s.option(form.Value, 'wan_device', _('WAN Physical Device'), _('Physical network device used for WAN connection (e.g. eth0).'));
		o.default = 'eth0';
		o.datatype = 'string';

		o = s.option(form.Value, 'wan6_iface', _('IPv6 WAN Interface Name'), _('Name for the DHCPv6 interface to be created (default: wan6).'));
		o.default = 'wan6';
		o.datatype = 'string';

		o = s.option(form.Value, 'mape_iface', _('MAP-E Interface Name'), _('Name for the MAP-E tunnel interface (default: wan6mape).'));
		o.default = 'wan6mape';
		o.datatype = 'string';

		o = s.option(form.Flag, 'legacymap', _('Use Legacy MAP'), _('Enable legacy MAP mode. Required for OCN Virtual Connect.'));
		o.default = o.enabled;
		o.rmempty = false;

		o = s.option(form.Value, 'br_addr', _('BR Address (Border Relay)'), _('OCN\'s Border Relay IPv6 address (e.g. 2001:f88:...). Use the MAP-E calculator (http://ipv4.web.fc2.com/map-e.html) to obtain this value.'));
		o.datatype = 'ip6addr';
		o.optional = true;
		o.placeholder = '2001:f88:...';

		o = s.option(form.Value, 'ipaddr', _('IPv4 Prefix (ipaddr)'), _('Mapped IPv4 prefix calculated from the MAP-E calculator (e.g. 153.153.153.153).'));
		o.datatype = 'ip4addr';
		o.optional = true;

		o = s.option(form.Value, 'ip4prefixlen', _('IPv4 Prefix Length'), _('Normally 20 for OCN.'));
		o.datatype = 'integer';
		o.default = '20';
		o.optional = true;

		o = s.option(form.Value, 'ip6prefix', _('IPv6 Prefix'), _('Mapped IPv6 prefix (e.g. 2400:4050::).'));
		o.datatype = 'ip6addr';
		o.optional = true;

		o = s.option(form.Value, 'ip6prefixlen', _('IPv6 Prefix Length'), _('Normally 38 for OCN.'));
		o.datatype = 'integer';
		o.default = '38';
		o.optional = true;

		o = s.option(form.Value, 'ealen', _('EA bits length'), _('Normally 42 for OCN.'));
		o.datatype = 'integer';
		o.default = '42';
		o.optional = true;

		o = s.option(form.Value, 'psidlen', _('PSID bits length'), _('Normally 6 for OCN.'));
		o.datatype = 'integer';
		o.default = '6';
		o.optional = true;

		o = s.option(form.Value, 'offset', _('PSID offset'), _('Normally 4 for OCN.'));
		o.datatype = 'integer';
		o.default = '4';
		o.optional = true;

		o = s.option(form.Value, 'dont_snat_to', _('Reserved IPv4 Ports'), _('Space-separated IPv4 ports that should never be selected for MAP-E SNAT. Leave empty unless you intentionally reserve fixed inbound service ports.'));
		o.datatype = 'string';
		o.optional = true;
		o.placeholder = '2938 7088 10233';

		o = s.option(form.Flag, 'dhcpv6_relay', _('Enable DHCPv6/NDP Relay'), _('Enable this if your ISP provides only an RA /64 prefix without Prefix Delegation (PD). If you have IPv6-PD, uncheck this to use standard Server mode.'));
		o.default = o.enabled;
		o.rmempty = false;

		var s2 = m.section(form.NamedSection, 'config', 'jp_ipoe', _('Actions'), _('Apply or remove IPoE configuration immediately.'));
		
		o = s2.option(form.DummyValue, '_apply_buttons');
		o.modalonly = false;
		o.render = function(section_id) {
			return E('div', { class: 'cbi-value' }, [
				E('div', { class: 'cbi-value-field' }, [
						E('button', {
							class: 'btn cbi-button cbi-button-action',
							click: ui.createHandlerFn(this, function() {
								ui.addNotification(null, E('p', _('Applying IPoE configuration. Please wait ~30 seconds for IPv6 prefix detection.')), 'info');
								return m.save(null, true).then(function() {
									return fs.exec('/usr/sbin/jp-ipoe-setup', ['start']);
								}).then(function(res) {
									if (res.code === 0)
										ui.addNotification(null, E('p', _('IPoE configuration applied.')), 'info');
									else
										ui.addNotification(null, E('p', _('Setup script exited with code: ') + res.code), 'error');
								}).catch(function(e) {
									ui.addNotification(null, E('p', _('Error executing setup script: ') + e.message), 'error');
								});
							})
						}, _('Apply IPoE Configuration')),
					'\u00a0\u00a0',
						E('button', {
							class: 'btn cbi-button cbi-button-negative',
							click: ui.createHandlerFn(this, function() {
								return fs.exec('/usr/sbin/jp-ipoe-setup', ['stop']).then(function(res) {
									ui.addNotification(null, E('p', _('IPoE interfaces stopped.')), 'info');
								}).catch(function(e) {
									ui.addNotification(null, E('p', _('Error executing setup script: ') + e.message), 'error');
								});
						})
					}, _('Stop IPoE Interfaces'))
				])
			]);
		};

		return m.render();
	}
});
