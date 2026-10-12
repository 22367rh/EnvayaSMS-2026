'use strict';

/* EnvayaSMS dashboard — dependency-free single-page app. */

var state = { user: null };

// --- tiny DOM helpers --------------------------------------------------------------------------
function el(tag, attrs, children) {
    var node = document.createElement(tag);
    attrs = attrs || {};
    if (attrs.class !== undefined) node.className = attrs.class;
    if (attrs.html) node.innerHTML = attrs.html;
    for (var k in attrs) {
        if (k === 'class' || k === 'html') continue;
        if (k.indexOf('on') === 0 && typeof attrs[k] === 'function') node.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
        else if (attrs[k] != null) node.setAttribute(k, attrs[k]);
    }
    var kids = children == null ? [] : (Array.isArray(children) ? children : [children]);
    for (var i = 0; i < kids.length; i++) {
        if (kids[i] == null || kids[i] === false) continue;
        node.appendChild(kids[i] && kids[i].nodeType ? kids[i] : document.createTextNode(String(kids[i])));
    }
    return node;
}
function $(sel, root) { return (root || document).querySelector(sel); }
function fmtTime(iso) {
    if (!iso) return '';
    var d = new Date(iso.replace(' ', 'T') + (iso.indexOf('T') === -1 ? 'Z' : ''));
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString();
}
function fmtClock(iso) {
    if (!iso) return '';
    var parts = String(iso).split(':');
    return parts[0] + ':' + (parts[1] || '00');
}

// --- API client ------------------------------------------------------------------------------
async function api(path, method, body) {
    var opts = { method: method || 'GET', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin' };
    if (body) opts.body = JSON.stringify(body);
    var res = await fetch(path, opts);
    var data = null;
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) {
        var msg = (data && data.error) || ('Request failed (' + res.status + ')');
        var err = new Error(msg); err.status = res.status; throw err;
    }
    return data;
}
async function apiGet(path) { return api(path, 'GET'); }

// --- auth / shell ----------------------------------------------------------------------------
async function loadMe() {
    try {
        var r = await apiGet('/api/me');
        state.user = r.user || null;
    } catch (_) { state.user = null; }
}
function currentConfig() { return apiGet('/api/config'); }

function renderShell() {
    // Top navigation order: Dashboard, Conversations, Inbox, Outbox, History.
    var items = [
        ['dashboard', 'Dashboard'],
        ['conversations', 'Conversations'],
        ['inbox', 'Inbox'],
        ['outbox', 'Outbox'],
        ['history', 'History']
    ];

    var nav = el('div', { class: 'nav-links' }, items.map(function (it) {
        return el('a', { href: '#/' + it[0], 'data-route': it[0] }, it[1]);
    }));

    var shell = el('div', { class: 'app-shell' }, [
        el('header', { class: 'topbar' }, [
            el('a', { href: '#/dashboard', class: 'brand-link' }, ['EnvayaSMS', el('small', null, 'Gateway console')]),
            nav,
            el('a', { href: '#/logout', onclick: onLogout, class: 'nav-logout' }, 'Log out')
        ]),
        el('main', { id: 'view', class: 'content' })
    ]);
    $('#app').innerHTML = '';
    $('#app').appendChild(shell);
}

async function onLogout() {
    try { await api('/api/logout', 'POST'); } catch (_) {}
    state.user = null;
    location.hash = '';
    render();
}

// --- landing (login / register) --------------------------------------------------------------
function renderLanding() {
    var mode = { value: 'login' };
    var errBox = el('div', { class: 'msg error' });
    var okBox = el('div', { class: 'msg ok' });
    // The <h1> heading is a live element reference (not a string) so setMode() can update it.
    var formTitleEl = el('h1', null, 'Log in');

    function showErr(msg) { errBox.className = 'msg error show'; okBox.className = 'msg ok'; errBox.textContent = msg; }
    function clearMsg() { errBox.className = 'msg error'; okBox.className = 'msg ok'; errBox.textContent = ''; okBox.textContent = ''; }

    // Inputs declared up front so both setMode() and onSubmit() can close over them.
    var username = el('input', { type: 'text', name: 'username', placeholder: 'Username', autocomplete: 'username' });
    var password = el('input', { type: 'password', name: 'password', placeholder: 'Password', autocomplete: 'current-password' });
    var confirmPassword = el('input', { type: 'password', name: 'confirmPassword', placeholder: 'Confirm password', autocomplete: 'new-password' });
    var email = el('input', { type: 'email', name: 'email', placeholder: 'Email (optional)', autocomplete: 'email' });
    var phone = el('input', { type: 'tel', name: 'phone', placeholder: 'Primary contact number (optional)', autocomplete: 'tel' });

    // Registration-only fields. Hidden on the login view so it only asks for what it needs.
    var regOnly = el('div', {}, [
        el('label', null, 'Confirm password'), confirmPassword,
        el('label', null, 'Email (optional)'), email,
        el('label', null, 'Primary contact number (optional)'), phone
    ]);

    function setMode(m) {
        mode.value = m;
        loginTab.classList.toggle('active', m === 'login');
        regTab.classList.toggle('active', m === 'register');
        formTitleEl.textContent = m === 'login' ? 'Log in' : 'Create account';
        submitBtn.textContent = m === 'login' ? 'Log in' : 'Create account';
        // Registration-only fields are shown only while registering.
        regOnly.style.display = m === 'register' ? '' : 'none';
    }

    var loginTab, regTab, submitBtn;
    var form = el('form', { onsubmit: onSubmit }, [
        el('div', { class: 'tabs' }, [
            loginTab = el('button', { type: 'button', class: 'active' }, 'Log in'),
            regTab = el('button', { type: 'button' }, 'Register')
        ]),
        el('div', { class: 'card', style: 'box-shadow:none;padding:0;border:none' }, [
            formTitleEl,
            errBox, okBox,
            el('label', null, 'Username'), username,
            el('label', null, 'Password'), password,
            regOnly,
            submitBtn = el('button', { type: 'submit', class: 'btn', style: 'width:100%;margin-top:8px' }, 'Log in')
        ])
    ]);

    async function onSubmit(e) {
        e.preventDefault();
        clearMsg();
        var uname = username.value.trim();
        try {
            if (mode.value === 'login') {
                if (!password.value) { showErr('Enter your password.'); return; }
                var r = await api('/api/login', 'POST', { username: uname, password: password.value });
                state.user = r.user;
                location.hash = '#/dashboard'; render();
            } else {
                if (password.value !== confirmPassword.value) { showErr('Passwords do not match.'); return; }
                await api('/api/register', 'POST', {
                    username: uname,
                    password: password.value,
                    email: email.value.trim(),
                    phone_number: phone.value.trim()
                });
                state.user = { username: uname };
                okBox.textContent = 'Account created — welcome!'; okBox.className = 'msg ok show';
                setTimeout(function () { location.hash = '#/dashboard'; render(); }, 600);
            }
        } catch (err) { showErr(err.message); }
    }

    loginTab.addEventListener('click', function () { clearMsg(); setMode('login'); });
    regTab.addEventListener('click', function () { clearMsg(); setMode('register'); });

    var wrap = el('div', { class: 'auth-wrap' }, [
        el('div', { class: 'card auth-card' }, [
            el('h1', null, 'EnvayaSMS'),
            el('p', { class: 'sub', style: 'margin-top:-8px' }, 'Gateway console — sign in to manage your devices.'),
            form,
            el('div', { class: 'home-link' }, [
                el('a', { href: '/', style: 'color:#64748b;font-size:13px;text-decoration:none' }, '← Back to home')
            ])
        ])
    ]);
    $('#app').innerHTML = '';
    $('#app').appendChild(wrap);
}

// --- router ----------------------------------------------------------------------------------
function route() {
    var raw = location.hash.replace(/^#\/?/, '') || 'dashboard';
    var parts = raw.split('/');
    var name = parts[0] || 'dashboard';
    if (name === 'logout') { onLogout(); return; }
    if (!state.user) { renderLanding(); return; }
    if (['dashboard', 'history', 'inbox', 'outbox', 'conversations', 'settings'].indexOf(name) === -1) name = 'dashboard';
    renderNavActive(name);
    var view = $('#view');
    if (!view) { renderShell(); view = $('#view'); }
    view.innerHTML = '';
    try {
        switch (name) {
            case 'dashboard': dashboardView(view); break;
            case 'history': historyView(view); break;
            case 'inbox': inboxView(view); break;
            case 'outbox': outboxView(view); break;
            case 'conversations': conversationsView(view); break;
            case 'settings': settingsView(view); break;
        }
    } catch (err) { view.appendChild(el('div', { class: 'msg error show' }, err.message || String(err))); }
}
function renderNavActive(name) {
    document.querySelectorAll('.topbar a[data-route]').forEach(function (a) {
        a.classList.toggle('active', a.getAttribute('data-route') === name);
    });
}
async function render() {
    if (!state.user) { try { await loadMe(); } catch (_) {} }
    if (!location.hash) location.hash = '#/dashboard';
    window.addEventListener('hashchange', route);
    route();
}
window.addEventListener('DOMContentLoaded', function () { render(); });

// --- helpers ---------------------------------------------------------------------------------
async function copyText(node, text) {
    try { await navigator.clipboard.writeText(text); node.textContent = 'Copied'; }
    catch (_) { var ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); node.textContent = 'Copied'; }
    setTimeout(function () { node.textContent = 'Copy'; }, 1200);
}

// --- dashboard -------------------------------------------------------------------------------
async function dashboardView(view) {
    view.appendChild(el('h1', null, 'Dashboard'));

    try {
        var cfg = await currentConfig();
        var devices = (await apiGet('/api/devices')).devices || [];

        // "Show device connection details" toggle reveals the shared secret.
        var secretVisible = false;
        function refreshSecret() {
            var sc = document.getElementById('secret-cell');
            if (sc) sc.textContent = secretVisible ? cfg.shared_secret : '••••••••';
        }
        var revealBtn = el('button', { class: 'btn small secondary' }, 'Show device connection details');
        revealBtn.addEventListener('click', function () {
            secretVisible = !secretVisible;
            revealBtn.textContent = secretVisible ? 'Hide connection details' : 'Show device connection details';
            refreshSecret();
        });

        // Configuration is shown as a key/value table.
        var configCard = el('div', { class: 'panel' }, [
            el('h2', null, 'Device configuration'),
            el('p', { class: 'sub', style: 'margin-top:-4px' }, 'Put these in your EnvayaSMS app settings. The shared secret is the key devices use to sign requests.'),
            kvTable([
                ['Server URL', el('code', null, cfg.server_url)],
                ['Username', el('code', null, cfg.username)]
            ]),
            kvRow('Shared secret', [el('code', { id: 'secret-cell' }, '••••••••'), revealBtn])
        ]);

        // Devices linked to this account, with their latest reported status.
        var devicesCard = buildDevicesCard(devices);

        view.appendChild(configCard);
        view.appendChild(devicesCard);
    } catch (err) {
        view.appendChild(el('div', { class: 'msg error show' }, err.message || String(err)));
    }
}

// A key/value table of [label, valueNode] rows.
function kvTable(rows) {
    return el('table', { class: 'kv' }, rows.map(function (r) {
        return el('tr', null, [el('th', { scope: 'col' }, r[0]), el('td', null, r[1])]);
    }));
}
// A single table row with one label cell and one or more value cells.
function kvRow(label, valueNodes) {
    var cells = [el('th', { scope: 'col' }, label)];
    for (var i = 0; i < valueNodes.length; i++) cells.push(el('td', null, valueNodes[i]));
    return el('tr', null, cells);
}

// A panel listing the account's linked devices with their latest status.
function buildDevicesCard(devices) {
    var title = devices.length ? ('Linked devices (' + devices.length + ')' ) : 'Linked devices';
    return el('div', { class: 'panel' }, [
        el('h2', null, title),
        devices.length ? deviceTable(devices) : el('div', { class: 'empty' }, 'No devices linked yet.')
    ]);
}
function deviceTable(devices) {
    var thead = el('thead', null, el('tr', null, [
        el('th', { scope: 'col' }, 'Device'),
        el('th', { scope: 'col' }, 'Status'),
        el('th', { scope: 'col' }, 'Battery'),
        el('th', { scope: 'col' }, 'Network'),
        el('th', { scope: 'col' }, 'Last seen')
    ]));
    var tbody = el('tbody');
    for (var i = 0; i < devices.length; i++) {
        var d = devices[i];
        tbody.appendChild(el('tr', null, [
            el('td', null, el('code', null, d.phone_id || '(unknown)')),
            el('td', null, statusBadge(d.device_status)),
            el('td', null, batteryCell(d.last_battery)),
            el('td', null, d.last_network || el('span', { class: 'muted' }, '—')),
            el('td', null, el('span', { class: 'muted' }, fmtTime(d.last_seen)))
        ]));
    }
    return el('div', { class: 'table-scroll' }, [el('table', null, [thead, tbody])]);
}
function statusBadge(status) {
    var s = (status || '').trim().toLowerCase();
    if (/online|connected|active/.test(s)) return el('span', { class: 'tag online' }, s || 'online');
    if (/offline|disconnected/i.test(s)) return el('span', { class: 'tag offline' }, s || 'offline');
    return el('span', { class: 'tag' }, status || 'unknown');
}
function batteryCell(level) {
    var b = level == null ? -1 : Number(level);
    if (b < 0) return el('span', { class: 'muted' }, '—');
    return el('span', { class: 'chip battery' }, b + '%');
}

function fieldRow(label, valueNode) {
    return el('div', { class: 'field' }, [label, valueNode]);
}
function kpi(value, label) {
    return el('div', { class: 'panel' }, [el('div', { class: 'kpi' }, String(value)), el('small', null, label)]);
}
function linkCard(title, desc, href) {
    return el('a', { href: href, class: 'panel', style: 'text-decoration:none;color:inherit;display:block' }, [
        el('div', { style: 'font-weight:600' }, title), el('div', { class: 'muted', style: 'font-size:13px' }, desc)
    ]);
}
function describeStatus(devices) {
    if (!devices.length) return 'no devices';
    var last = devices.filter(function (d) { return d.last_battery != null && Number(d.last_battery) >= 0; })[0];
    return last ? (last.last_battery + '%') : (devices.length + ' device' + (devices.length > 1 ? 's' : ''));
}

// --- SVG chart helpers -----------------------------------------------------------------------
/* Build an <svg> whose markup is a string, injected into a wrapper div. Pure DOM via innerHTML keeps
   the chart code readable; all values are numeric so there is no injection surface. */
function svgLineChart(points, opts) {
    opts = opts || {};
    if (!points.length) return el('div', { class: 'empty' }, 'No data yet.');
    var W = 720, H = 200, pad = { t: 16, r: 16, b: 26, l: 38 };
    var xs = points.map(function (d) { return Date.parse((d.t || '').replace(' ', 'T') + 'Z'); });
    var ys = points.map(function (d) { return d.level; });
    var minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
    var minY = opts.minY == null ? Math.min.apply(null, ys) : opts.minY;
    var maxY = opts.maxY == null ? Math.max.apply(null, ys) : opts.maxY;
    if (maxY === minY) { maxY += 1; }
    var xAt = function (x) { return minX === maxX ? pad.l + W / 2 : pad.l + ((x - minX) / (maxX - minX)) * (W - pad.l - pad.r); };
    var yAt = function (y) { return pad.t + (1 - (y - minY) / (maxY - minY)) * (H - pad.t - pad.b); };
    var pathD = points.map(function (d, i) {
        var x = xAt(xs[i]), y = yAt(ys[i]);
        return (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
    }).join(' ');
    var ticks = [minY, maxY];
    if (maxY - minY > 3) ticks.push((minY + maxY) / 2);
    var gridMarkup = '';
    for (var ti = 0; ti < ticks.length; ti++) {
        var yy = yAt(ticks[ti]);
        gridMarkup += '<line x1="' + pad.l + '" y1="' + yy.toFixed(1) + '" x2="' + (W - pad.r) + '" y2="' + yy.toFixed(1) + '" stroke="#eef0f3"/>';
        gridMarkup += '<text x="' + (pad.l - 6) + '" y="' + (yy + 3).toFixed(1) + '" text-anchor="end" font-size="9" fill="#94a3b8">' + Math.round(ticks[ti]) + '</text>';
    }
    var dots = '';
    for (var di = 0; di < points.length; di++) {
        dots += '<circle cx="' + xAt(xs[di]).toFixed(1) + '" cy="' + yAt(ys[di]).toFixed(1) + '" r="2.5" fill="#2563eb"/>';
    }
    var wrap = el('div', null);
    wrap.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" style="width:100%;height:auto">' +
        gridMarkup + '<path d="' + pathD + '" fill="none" stroke="#2563eb" stroke-width="2"/>' + dots + '</svg>';
    wrap.appendChild(el('div', { class: 'legend' }, opts.legend || ('Samples: ' + points.length + '; latest level ' + ys[ys.length - 1])));
    return wrap;
}

function svgBarChart(buckets, opts) {
    opts = opts || {};
    if (!buckets.length) return el('div', { class: 'empty' }, 'No data yet.');
    var W = 720, H = 220, pad = { t: 12, r: 16, b: 34, l: 40 };
    var maxV = Math.max.apply(null, buckets.map(function (b) { return Math.max(b.sent || 0, b.received || 0); })) || 1;
    var n = buckets.length;
    var bw = (W - pad.l - pad.r) / n;
    var groupX = function (i) { return pad.l + i * bw; };
    var barY = function (v) { return (H - pad.b) - (v / maxV) * (H - pad.t - pad.b); };
    var markup = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" style="width:100%;height:auto">';
    markup += '<line x1="' + pad.l + '" y1="' + (H - pad.b) + '" x2="' + (W - pad.r) + '" y2="' + (H - pad.b) + '" stroke="#e2e8f0"/>';
    markup += '<text x="6" y="14" font-size="9" fill="#94a3b8">Max ' + Math.round(maxV) + '</text>';
    for (var j = 0; j < n; j++) {
        var gx = groupX(j);
        var sh = (H - pad.b) - barY(buckets[j].sent || 0);
        var rh = (H - pad.b) - barY(buckets[j].received || 0);
        markup += '<rect x="' + (gx + bw * 0.2).toFixed(1) + '" y="' + (H - pad.b - sh).toFixed(1) + '" width="' + Math.max(1, bw * 0.28).toFixed(1) + '" height="' + sh.toFixed(1) + '" fill="#2563eb" rx="2"/>';
        markup += '<rect x="' + (gx + bw * 0.52).toFixed(1) + '" y="' + (H - pad.b - rh).toFixed(1) + '" width="' + Math.max(1, bw * 0.28).toFixed(1) + '" height="' + rh.toFixed(1) + '" fill="#93c5fd" rx="2"/>';
        if (n <= 31 || j % Math.ceil(n / 24) === 0) {
            markup += '<text x="' + (gx + bw / 2).toFixed(1) + '" y="' + (H - pad.b + 12) + '" font-size="8" fill="#94a3b8" text-anchor="middle">' + buckets[j].label + '</text>';
        }
    }
    markup += '</svg>';
    var wrap = el('div', null);
    wrap.innerHTML = markup;
    wrap.appendChild(el('div', { class: 'legend' }, [spanDot('#2563eb', 'Sent'), '   ', spanDot('#93c5fd', 'Received')]));
    return wrap;
}
function spanDot(color) { return el('span', { style: 'display:inline-block;width:10px;height:10px;border-radius:2px;background:' + color + ';vertical-align:middle;margin-right:4px' }); }

// --- history ---------------------------------------------------------------------------------
async function historyView(view) {
    view.appendChild(el('h1', null, 'History'));
    var body = el('div');
    view.appendChild(body);
    try {
        var devices = (await apiGet('/api/devices')).devices || [];
        var rangePills = ['24h', '7d', '30d', 'all'];
        var sel = { device: '', range: '7d' };

        var devSelect = el('select', { style: 'max-width:280px' },
            [el('option', { value: '' }, 'All devices')].concat(devices.map(function (d) {
                return el('option', { value: d.phone_id || '' }, (d.phone_id || '(unknown)') + (d.last_battery != null && Number(d.last_battery) >= 0 ? ' — ' + d.last_battery + '%' : ''));
            })));

        var pills = el('div', { class: 'pillbar' }, rangePills.map(function (r, i) {
            return el('button', { type: 'button', class: (i === 1 ? 'active' : ''), 'data-range': r }, r);
        }));
        pills.querySelectorAll('button').forEach(function (b) { b.addEventListener('click', function () {
            pills.querySelectorAll('button').forEach(function (x) { x.classList.remove('active'); });
            b.classList.add('active'); sel.range = b.getAttribute('data-range'); draw();
        }); });

        var deviceCol = el('div', { class: 'row' }, [el('label', { style: 'margin:0' }, 'Device'), devSelect]);
        var rangeCol = el('div', null, [el('span', { class: 'muted', style: 'align-self:center' }, 'Range'), pills]);
        body.appendChild(el('div', { class: 'row spread' }, [deviceCol, rangeCol]));
        var chartArea = el('div');
        body.appendChild(chartArea);

        async function draw() {
            chartArea.innerHTML = '<div class="muted">Loading…</div>';
            try {
                var q = 'range=' + encodeURIComponent(sel.range) + (sel.device ? '&device=' + encodeURIComponent(sel.device) : '');
                var data = await apiGet('/api/history?' + q);
                chartArea.innerHTML = '';
                chartArea.appendChild(el('h2', null, 'Battery level over time'));
                chartArea.appendChild(svgLineChart(data.battery, { legend: (data.battery.length ? 'Samples: ' + data.battery.length : 'No battery samples in range.' ) }));
                chartArea.appendChild(el('h2', null, 'Messages' + (sel.device ? '' + '' : ' (all devices)')));
                chartArea.appendChild(svgBarChart(data.buckets, {}));
            } catch (err) { chartArea.innerHTML = ''; chartArea.appendChild(el('div', { class: 'msg error show' }, err.message)); }
        }
        devSelect.addEventListener('change', function () { sel.device = devSelect.value; draw(); });
        draw();
    } catch (err) { body.appendChild(el('div', { class: 'msg error show' }, err.message)); }
}

// --- inbox / outbox --------------------------------------------------------------------------
async function inboxView(view) {
    view.appendChild(el('h1', null, 'Inbox'));
    var sub = el('p', { class: 'sub' }, 'Messages received on any of your devices.');
    var box = el('div');
    view.appendChild(sub); view.appendChild(box);

    var search = el('input', { type: 'search', placeholder: 'Filter by sender…', style: 'max-width:280px' });
    var tableWrap = el('div', { style: 'overflow:auto;border:1px solid var(--border);border-radius:10px' });
    box.appendChild(search); box.appendChild(tableWrap);

    async function load() {
        tableWrap.innerHTML = '<div class="muted" style="padding:16px">Loading…</div>';
        try {
            var data = await apiGet('/api/inbox?limit=1000');
            renderTable(data.messages || []);
        } catch (err) { tableWrap.innerHTML = '<div class="msg error show" style="margin:12px">' + err.message + '</div>'; }
    }
    function renderTable(rows) {
        var filtered = search.value.trim() ? rows.filter(function (r) { return String(r.sender || '').toLowerCase().indexOf(search.value.toLowerCase()) !== -1; }) : rows;
        tableWrap.innerHTML = '';
        if (!filtered.length) { tableWrap.appendChild(el('div', { class: 'empty' }, 'No messages.')); return; }
        var thead = el('thead', null, el('tr', null, [th('From'), th('Type'), th('Received'), th('Message')]));
        var tbody = el('tbody');
        filtered.slice(0, 500).forEach(function (r) {
            tbody.appendChild(el('tr', null, [td(r.sender || ''), td(el('span', { class: 'chip ' + (r.type === 'mms' ? 'mms' : 'sms') }, r.type || 'sms')), td(el('span', null, fmtTime(r.received_at))), td(el('div', { class: 'body-cell' }, r.body || ''))]));
        });
        tableWrap.appendChild(el('table', null, [thead, tbody]));
    }
    function th(t) { return el('th', null, t); }
    function td(c) { return el('td', null, c); }
    search.addEventListener('input', load);
    load();
}

async function outboxView(view) {
    view.appendChild(el('h1', null, 'Outbox'));
    var sub = el('p', { class: 'sub' }, 'Messages sent by any of your devices.');
    var box = el('div');
    view.appendChild(sub); view.appendChild(box);

    var toFilter = el('input', { type: 'text', placeholder: 'Filter by recipient…', style: 'max-width:240px' });
    var tableWrap = el('div', { style: 'overflow:auto;border:1px solid var(--border);border-radius:10px' });
    box.appendChild(toFilter); box.appendChild(tableWrap);

    async function load() {
        tableWrap.innerHTML = '<div class="muted" style="padding:16px">Loading…</div>';
        try {
            var data = await apiGet('/api/outbox?limit=1000');
            renderTable(data.messages || []);
        } catch (err) { tableWrap.innerHTML = '<div class="msg error show" style="margin:12px">' + err.message + '</div>'; }
    }
    function renderTable(rows) {
        var filtered = toFilter.value.trim() ? rows.filter(function (r) { return String(r.to || '').toLowerCase().indexOf(toFilter.value.toLowerCase()) !== -1; }) : rows;
        tableWrap.innerHTML = '';
        if (!filtered.length) { tableWrap.appendChild(el('div', { class: 'empty' }, 'No messages.')); return; }
        var tbody = el('tbody');
        filtered.slice(0, 500).forEach(function (r) {
            tbody.appendChild(el('tr', null, [td(r.to || ''), td(el('span', { class: 'chip ' + (r.type === 'mms' ? 'mms' : 'sms') }, r.type || 'sms')), td(statusTag(r.status)), td(fmtTime(r.created_at))]));
        });
        tableWrap.appendChild(el('table', null, [el('thead', null, el('tr', null, [th2('To'), th2('Type'), th2('Status'), th2('Sent')])), tbody]));
    }
    function th2(t) { return el('th', null, t); }
    function statusTag(s) { return el('span', { class: 'tag ' + (s || 'queued') }, s || 'queued'); }
    toFilter.addEventListener('input', load);
    load();
}

// --- conversations list ----------------------------------------------------------------------
async function conversationsView(view) {
    view.appendChild(el('h1', null, 'Conversations'));
    var sub = el('p', { class: 'sub' }, 'Tap a number to see every message sent or received with it, from any device.');
    var box = el('div');
    view.appendChild(sub); view.appendChild(box);

    // phone -> alias (empty string means "no alias set yet").
    var aliasesMap = {};

    async function load() {
        box.innerHTML = '<div class="muted" style="padding:16px">Loading…</div>';
        try {
            var data = await apiGet('/api/conversations');
            aliasesMap = (await apiGet('/api/aliases')).aliases || {};
            Object.keys(aliasesMap).forEach(function (k) { if (aliasesMap[k] == null) aliasesMap[k] = ''; });
            render(data.conversations || []);
        } catch (err) { box.innerHTML = '<div class="msg error show" style="margin:12px">' + err.message + '</div>'; }
    }

    function render(rows) {
        if (!rows.length) { box.innerHTML = ''; box.appendChild(el('div', { class: 'empty' }, 'No conversations yet.')); return; }
        var list = el('div', { class: 'conv-list' });
        rows.forEach(function (r) {
            var phone = r.phone || '';
            var alias = aliasesMap[phone] || '';
            // Show the alias when set, otherwise the raw number.
            var nameCol = el('div', null, [
                el('div', { class: 'name strong' }, alias || phone),
                !alias ? el('div', { class: 'muted phone-hint' }, phone) : null
            ]);
            list.appendChild(el('div', { class: 'conv-item', onclick: function () { location.hash = '#/conversation?phone=' + encodeURIComponent(phone); } }, [
                nameCol,
                el('div', { class: 'meta' }, [
                    el('button', { type: 'button', class: 'link-btn rename', title: 'Give this number an alias', onclick: function (e) { e.stopPropagation(); doRename(phone, alias); } }, '✎ Rename'),
                    el('div', { class: 'muted last' }, String(r.count || 0) + ' msgs · ' + (r.last_body || '').slice(0, 45)),
                    el('div', { class: 'muted when' }, fmtTime(r.last_ts))
                ])
            ]));
        });
        box.innerHTML = '';
        box.appendChild(list);
    }

    // Prompt for an alias; empty input clears it, cancel leaves it unchanged.
    async function doRename(phone, currentAlias) {
        var reply = window.prompt('Alias for ' + phone + ':', currentAlias || '');
        if (reply === null) return;
        try {
            await api('/api/aliases', 'POST', { phone: phone, alias: reply });
            aliasesMap[phone] = String(reply).trim();
            var data = await apiGet('/api/conversations');
            render(data.conversations || []);
        } catch (err) { alert('Could not save alias: ' + err.message); }
    }

    load();
}

// --- conversation detail ---------------------------------------------------------------------
async function conversationView(view) {
    var params = new URLSearchParams(location.hash.split('?')[1] || '');
    var phone = params.get('phone') || '';
    // Resolve the alias (if any) so the header shows "Mom" instead of a raw number.
    var aliasesMap = {};
    try { aliasesMap = (await apiGet('/api/aliases')).aliases || {}; } catch (_) {}
    view.appendChild(el('h1', null, 'Conversation'));
    var back = el('a', { href: '#/conversations', style: 'display:inline-block;margin-bottom:8px;text-decoration:none' }, '← All conversations');
    var title = el('div', null, [back, el('span', { class: 'conv-header-name' }, aliasesMap[phone] || phone)]);
    view.appendChild(title);
    var chat = el('div', { class: 'chat-wrap' });
    view.appendChild(chat);

    try {
        var data = await apiGet('/api/conversation?phone=' + encodeURIComponent(phone));
        if (!data.messages.length) { chat.appendChild(el('div', { class: 'empty' }, 'No messages yet.')); return; }
        var sorted = data.messages.slice().sort(function (a, b) {
            return Date.parse((a.ts || '').replace(' ', 'T') + 'Z') - Date.parse((b.ts || '').replace(' ', 'T') + 'Z');
        });
        sorted.forEach(function (m) {
            var cls = m.direction === 'sent' ? 'sent' : 'received';
            chat.appendChild(el('div', { class: 'bubble ' + cls }, [m.body || '', el('span', { class: 'when' }, fmtTime(m.ts))]));
        });
    } catch (err) { chat.appendChild(el('div', { class: 'msg error show' }, err.message)); }
}

// --- settings --------------------------------------------------------------------------------
async function settingsView(view) {
    view.appendChild(el('h1', null, 'Settings'));
    var errBox = el('div', { class: 'msg error' });
    var okBox = el('div', { class: 'msg ok' });
    var card = el('div', { class: 'panel', style: 'max-width:420px' }, [
        el('h2', null, 'Change login password'),
        el('p', { class: 'muted', style: 'font-size:13px;margin-top:-4px' }, 'This only changes your website sign-in. Your device shared secret is separate and unaffected.'),
        errBox, okBox
    ]);
    var cur = el('input', { type: 'password', placeholder: 'Current password' });
    var nw1 = el('input', { type: 'password', placeholder: 'New password (min 6)' });
    var nw2 = el('input', { type: 'password', placeholder: 'Confirm new password' });
    var btn = el('button', { class: 'btn', style: 'margin-top:10px', onclick: submit }, 'Update password');

    async function submit() {
        errBox.className = 'msg error'; okBox.className = 'msg ok';
        if (nw1.value !== nw2.value) { errBox.textContent = 'Passwords do not match'; errBox.className = 'msg error show'; return; }
        try {
            await api('/api/change-password', 'POST', { currentPassword: cur.value, newPassword: nw1.value });
            okBox.className = 'msg ok show'; okBox.textContent = 'Password updated. Please log in again.';
            cur.value = ''; nw1.value = ''; nw2.value = '';
            setTimeout(function () { api('/api/logout', 'POST').catch(function () {}); state.user = null; location.hash = ''; render(); }, 900);
        } catch (err) { errBox.textContent = err.message; errBox.className = 'msg error show'; }
    }

    card.appendChild(el('label', null, 'Current password'), cur);
    card.appendChild(el('label', null, 'New password'), nw1);
    card.appendChild(el('label', null, 'Confirm new password'), nw2);
    card.appendChild(btn);
    view.appendChild(card);
}
