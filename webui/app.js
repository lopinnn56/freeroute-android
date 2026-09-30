/* FreeRoute 网关 Web UI — 交互逻辑
   5 Tab 布局与视觉复刻 CLIProxyAPI for Android，功能映射到 freeroute 引擎。
   与引擎通信：POST /freeroute/rpc {method, args} -> {ok, data} */
'use strict';

// ---------- 引擎基址（同源，从当前路径推断） ----------
// 页面路径形如 /freeroute/app/...；把 /app/ 之后的部分剥掉即得到引擎挂载根，
// 例如 /freeroute/app/ -> /freeroute。端点都直接挂在这根之下（/freeroute/rpc、
// /freeroute/health），所以这里不再重复拼 /freeroute 前缀。
const BASE = (location.pathname.replace(/\/app\/.*$/, '') || '').replace(/\/+$/, '');
const RPC_URL = BASE + '/rpc';

// ---------- 状态 ----------
let STATE = null;            // freeroute.state 快照
let ENGINE = null;           // engine-info
let LOGS = [];
let LOG_FILTER = 'all';
let currentTab = 0;
const openUpstreams = new Set();  // 展开的上游 id
const keyDrafts = {};             // 上游 id -> 正在编辑的 Key 文本
const keyShown = {};              // 上游 id -> 是否显示明文

// ---------- 工具 ----------
async function rpc(method, args) {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method: method, args: args || {} })
  });
  const json = await res.json();
  if (!json.ok) throw new Error((json.error && json.error.message) || '请求失败');
  return json.data;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}
function esc(s) { return String(s === undefined || s === null ? '' : s); }

let toastTimer = null;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}
function copy(label, text) {
  const done = () => toast('已复制 ' + label);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else fallbackCopy(text, done);
}
function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); done(); } catch (e) { toast('复制失败'); }
  document.body.removeChild(ta);
}
function fmtTokens(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(1) + ' M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + ' K';
  return String(n);
}
function fmtUptime(ms) {
  if (!ms || ms < 0) return '未运行';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d > 0) return String(d) + '天 ' + String(h).padStart(2, '0') + '小时';
  if (h > 0) return String(h).padStart(2, '0') + '小时 ' + String(m).padStart(2, '0') + '分';
  return String(m).padStart(2, '0') + '分 ' + String(s % 60).padStart(2, '0') + '秒';
}
function maskKey(k) {
  if (!k) return '';
  if (k.length <= 7) return '••••••••';
  return k.slice(0, 7) + '••••••••';
}
function healthLabel(h) {
  if (!h) return { cls: 'dim', text: '未知' };
  if (h.state === 'cooling') return { cls: 'amber', text: '冷却 ' + Math.ceil((h.cooldownMs || 0) / 1000) + 's' };
  if (h.state === 'degraded') return { cls: 'red', text: '降级 (' + h.consecutiveFailures + ')' };
  return { cls: 'green', text: '正常' };
}

// ---------- Tab 定义（图标 path 取自 CLIProxyAPI 的 vector drawable） ----------
const TABS = [
  { id: 'service', label: '服务', path: 'M4,4h16c1.1,0 2,0.9 2,2v3c0,1.1 -0.9,2 -2,2H4c-1.1,0 -2,-0.9 -2,-2V6c0,-1.1 0.9,-2 2,-2zm2,4h2V7H6v1zm14,5H4c-1.1,0 -2,0.9 -2,2v3c0,1.1 0.9,2 2,2h16c1.1,0 2,-0.9 2,-2v-3c0,-1.1 -0.9,-2 -2,-2zm-12,4h2v-1H6v1z' },
  { id: 'models', label: '模型', path: 'M12,2C6.48,2 2,6.48 2,12s4.48,10 10,10 10,-4.48 10,-10S17.52,2 12,2zm-1,17.93c-3.95,-0.49 -7,-3.85 -7,-7.93 0,-0.62 0.08,-1.21 0.21,-1.79L9,15v1c0,1.1 0.9,2 2,2v1.93zm6.9,-2.54c-0.26,-0.81 -1,-1.39 -1.9,-1.39h-1v-3c0,-0.55 -0.45,-1 -1,-1H8v-2h2c0.55,0 1,-0.45 1,-1V7h2c1.1,0 2,-0.9 2,-2v-0.41c2.93,1.19 5,4.06 5,7.41 0,2.08 -0.8,3.97 -2.1,5.39z' },
  { id: 'advanced', label: '设置', path: 'M12,2L4,5v6.09c0,5.05 3.41,9.76 8,10.91 4.59,-1.15 8,-5.86 8,-10.91V5l-8,-3zm-1,14.5l-3.5,-3.5 1.41,-1.41L11,13.67l5.09,-5.09 1.41,1.41L11,16.5z' },
  { id: 'metrics', label: '仪表', path: 'M19,3H5C3.9,3 3,3.9 3,5v14c0,1.1 0.9,2 2,2h14c1.1,0 2,-0.9 2,-2V5C21,3.9 20.1,3 19,3z M7,17H5v-4h2V17z M11,17H9V7h2V17z M15,17h-2v-7h2V17z M19,17h-2v-3h2V17z' },
  { id: 'about', label: '关于', path: 'M12,2C6.48,2 2,6.48 2,12s4.48,10 10,10 10,-4.48 10,-10S17.52,2 12,2zm1,15h-2v-6h2v6zm0,-8h-2V7h2v2z' }
];

function buildTabbar() {
  const bar = document.getElementById('tabbar');
  bar.innerHTML = '';
  TABS.forEach((t, i) => {
    const tab = el('div', 'tab' + (i === currentTab ? ' active' : ''));
    const pill = el('div', 'pill');
    pill.innerHTML = '<svg viewBox="0 0 24 24"><path d="' + t.path + '"/></svg>';
    tab.appendChild(pill);
    tab.onclick = () => selectTab(i);
    bar.appendChild(tab);
  });
}
function selectTab(i) {
  currentTab = i;
  document.querySelectorAll('#tabbar .tab').forEach((t, idx) => t.classList.toggle('active', idx === i));
  document.querySelectorAll('.page').forEach((p, idx) => p.classList.toggle('active', idx === i));
  // 切换到目标页时渲染之：各页根据最新 STATE 重建 UI。之前只渲染服务/仪表，
  // 导致模型、设置、关于页空白。
  if (i === 0) renderService();
  else if (i === 1) renderModels();
  else if (i === 2) renderAdvanced();
  else if (i === 3) refreshMetrics();
  else if (i === 4) renderAbout();
}

// ---------- 渲染：Tab 0 服务 ----------
function renderService() {
  const page = document.getElementById('page-service');
  if (!page) return;
  page.innerHTML = '';
  const st = STATE || { upstreams: [], totals: {}, catalog: {}, globalProxy: '' };
  const info = ENGINE || {};

  // Hero 卡
  const hero = el('div', 'card');
  const r1 = el('div', 'row gap');
  r1.appendChild(el('div', 'hero-title', 'FreeRoute 网关'));
  r1.appendChild(el('div', 'spacer'));
  r1.appendChild(el('div', 'badge purple', '免费模型池'));
  const portBadge = el('div', 'badge cyan mono', ':' + (info.port || '—'));
  r1.appendChild(portBadge);
  const upCount = (st.upstreams || []).filter(u => u.configured).length;
  r1.appendChild(el('div', 'badge ' + (upCount > 0 ? 'green' : 'dim'), '就绪 ' + upCount + '/' + (st.upstreams || []).length));
  hero.appendChild(r1);

  const r2 = el('div', 'row gap');
  r2.style.marginTop = '6px';
  const dot = el('div', 'dot' + (upCount > 0 ? ' on' : ''));
  r2.appendChild(dot);
  r2.appendChild(el('div', '', upCount > 0 ? ('运行中 · 引擎已就绪 · Node ' + (info.node || '')) : '未配置上游 Key'));
  r2.lastChild.style.fontSize = '11px';
  r2.lastChild.style.color = upCount > 0 ? 'var(--green)' : 'var(--dim)';
  hero.appendChild(r2);

  // 操作按钮行
  const r3 = el('div', 'row');
  r3.style.marginTop = '8px';
  const btnSync = el('div', 'btn cyan r3 flex1', '同步目录');
  btnSync.onclick = doCatalogSync;
  const btnFreellmapi = el('div', 'btn blue r3 flex1', '同步FreeLLMAPI');
  btnFreellmapi.style.marginLeft = '5px';
  btnFreellmapi.onclick = doFreellmapiSync;
  const btnProbe = el('div', 'btn blue r3 flex1', '探测模型');
  btnProbe.style.marginLeft = '5px';
  btnProbe.onclick = doProbeAll;
  const btnTest = el('div', 'btn neutral r3 flex1', '检查');
  btnTest.style.marginLeft = '5px';
  btnTest.onclick = doHealthCheck;
  r3.appendChild(btnSync); r3.appendChild(btnFreellmapi); r3.appendChild(btnProbe); r3.appendChild(btnTest);
  hero.appendChild(r3);
  page.appendChild(hero);

  // 配置备份卡（最显眼位置：Hero 正下方）
  page.appendChild(buildConfigBackupCard());

  // API 端点卡
  const epCard = el('div', 'card');
  const epHead = el('div', 'row');
  epHead.appendChild(el('div', 'card-title lg', 'API 端点'));
  epHead.appendChild(el('div', 'spacer'));
  epHead.appendChild(el('div', 'badge mono cyan', 'OpenAI 兼容'));
  epHead.style.marginBottom = '6px';
  epCard.appendChild(epHead);

  const endpoints = [
    { label: '● 本地请求端点', url: 'http://127.0.0.1:' + (info.port || 0) + '/freeroute/v1' },
    { label: '● 局域网请求端点', url: 'http://' + (location.hostname || '127.0.0.1') + ':' + (info.port || 0) + '/freeroute/v1' }
  ];
  endpoints.forEach((ep, idx) => {
    const row = el('div', 'row gap');
    const left = el('div');
    left.style.flex = '1'; left.style.minWidth = '0';
    left.appendChild(el('div', 'ep-label', ep.label));
    const u = el('div', 'ep-url ltr', ep.url);
    left.appendChild(u);
    row.appendChild(left);
    const cp = el('div', 'btn neutral r3 sm', '复制');
    cp.onclick = () => copy('端点', ep.url);
    row.appendChild(cp);
    epCard.appendChild(row);
    if (idx === 0) epCard.appendChild(el('div', 'hr'));
  });
  // 访问密钥（本引擎按设计免鉴权）
  epCard.appendChild(el('div', 'hr'));
  epCard.appendChild(el('div', 'ep-label', '● 访问密钥 (API Key)'));
  const keyRow = el('div', 'row gap');
  keyRow.style.marginTop = '2px';
  const kv = el('div', 'mono', 'sk-freeroute（占位，回环免鉴权）');
  kv.style.flex = '1'; kv.style.fontSize = '10.5px'; kv.style.color = 'var(--dim)';
  keyRow.appendChild(kv);
  const kc = el('div', 'btn neutral r3 sm', '复制');
  kc.onclick = () => copy('API Key', 'sk-freeroute');
  keyRow.appendChild(kc);
  epCard.appendChild(keyRow);
  page.appendChild(epCard);

  // 上游卡片（可展开）
  const upSection = el('div', 'section-header');
  upSection.appendChild(el('div', 't', '上游厂商'));
  upSection.appendChild(el('div', 's', '点击卡片展开配置密钥 / 测试连通性 / 查看模型'));
  page.appendChild(upSection);

  (st.upstreams || []).forEach(u => page.appendChild(buildUpstreamCard(u)));

  // 隐藏的上游（可恢复）
  if (st.hiddenUpstreams && st.hiddenUpstreams.length > 0) {
    const hid = el('div', 'card tight');
    const hr = el('div', 'row');
    hr.appendChild(el('div', '', '已隐藏 ' + st.hiddenUpstreams.length + ' 家上游'));
    hr.lastChild.style.fontSize = '11px'; hr.lastChild.style.color = 'var(--dim)'; hr.lastChild.style.flex = '1';
    const restore = el('div', 'btn neutral r3 sm', '恢复全部');
    restore.onclick = async () => {
      for (const h of st.hiddenUpstreams) {
        try { await rpc('restoreUpstream', { id: h.id }); } catch (e) {}
      }
      toast('已恢复'); refreshState();
    };
    hr.appendChild(restore);
    hid.appendChild(hr);
    page.appendChild(hid);
  }

  // 日志卡（弹性高度）
  const logCard = el('div', 'card flex');
  logCard.style.marginTop = '6px';
  const lh = el('div', 'row');
  lh.appendChild(el('div', 'card-title', '引擎日志'));
  lh.appendChild(el('div', 'spacer'));
  const refreshLog = el('div', 'btn neutral r3 sm', '刷新');
  refreshLog.onclick = loadLogs;
  const copyLog = el('div', 'btn neutral r3 sm', '复制');
  copyLog.style.marginLeft = '5px';
  copyLog.onclick = () => copy('日志', LOGS.join('\n'));
  const clearLog = el('div', 'btn neutral r3 sm', '清空');
  clearLog.style.marginLeft = '5px';
  clearLog.onclick = async () => { try { await rpc('clearLog'); LOGS = []; renderLogLines(); toast('日志已清空'); } catch (e) { toast(e.message); } };
  lh.appendChild(refreshLog); lh.appendChild(copyLog); lh.appendChild(clearLog);
  lh.style.paddingBottom = '4px';
  logCard.appendChild(lh);
  const wrap = el('div', 'log-wrap');
  wrap.id = 'log-wrap';
  logCard.appendChild(wrap);
  page.appendChild(logCard);
  renderLogLines();
}

function buildUpstreamCard(u) {
  const card = el('div', 'card up' + (openUpstreams.has(u.id) ? ' open' : ''));
  const head = el('div', 'up-head');
  const dot = el('div', 'dot' + (u.configured ? ' on' : ''));
  dot.style.marginRight = '6px';
  head.appendChild(dot);
  head.appendChild(el('div', 'up-name', u.name));
  head.appendChild(el('div', 'spacer'));
  const hl = healthLabel(u.health);
  head.appendChild(el('div', 'badge ' + hl.cls, hl.text));
  if (u.configured) head.appendChild(Object.assign(el('div', 'badge green mono', u.keys + ' Key'), { style: 'margin-left:4px' }));
  else head.appendChild(Object.assign(el('div', 'badge dim', '未配置'), { style: 'margin-left:4px' }));
  const caret = el('div', 'up-caret', '▶');
  caret.style.marginLeft = '6px';
  head.appendChild(caret);
  head.onclick = () => {
    if (openUpstreams.has(u.id)) openUpstreams.delete(u.id); else openUpstreams.add(u.id);
    card.classList.toggle('open');
  };
  card.appendChild(head);

  const body = el('div', 'up-body');
  if (u.note) body.appendChild(el('div', 'up-note', u.note));
  body.appendChild(el('div', 'up-meta', '模型 ' + u.modelsCount + ' · 免费 ' + u.freeCount + ' · 默认 ' + (u.defaultModel || '—')));
  if (u.stats && u.stats.requests > 0) {
    body.appendChild(el('div', 'up-meta', '请求 ' + u.stats.requests + ' · 成功 ' + u.stats.ok + ' · 失败 ' + u.stats.failed + (u.stats.lastLatencyMs ? ' · ' + u.stats.lastLatencyMs + 'ms' : '')));
  }
  if (u.health && u.health.lastError) {
    const e = el('div', 'up-note', '⚠ ' + u.health.lastError);
    e.style.color = 'var(--log-error)';
    body.appendChild(e);
  }
  if (u.health && u.health.keyFails && u.health.keyFails.length > 0) {
    const kf = u.health.keyFails[0];
    body.appendChild(el('div', 'up-note', '⚠ 第 ' + kf.index + ' 把 Key 失效（' + kf.code + '）'));
  }
  body.appendChild(el('div', 'hr'));

  if (!u.noAuth) {
    body.appendChild(el('div', 'field-label', 'API Key（多把用换行/逗号分隔，至多 8 把）'));
    const input = el('textarea', 'input');
    input.placeholder = u.configured ? '已配置 ' + u.keys + ' 把 Key（点「显示」编辑）' : '粘贴 API Key';
    input.value = keyDrafts[u.id] || '';
    input.oninput = () => { keyDrafts[u.id] = input.value; };
    if (!keyShown[u.id]) { input.style.display = 'none'; }
    body.appendChild(input);

    const krow = el('div', 'row gap');
    krow.style.marginTop = '4px';
    if (!keyShown[u.id]) {
      const shown = el('div', 'mono', u.configured ? maskKey('sk-' + u.id) : '未配置');
      shown.style.flex = '1'; shown.style.fontSize = '11px'; shown.style.color = u.configured ? 'var(--blue)' : 'var(--dim)';
      krow.appendChild(shown);
      const showBtn = el('div', 'btn neutral r3 sm', '👁 显示');
      showBtn.onclick = async () => {
        try {
          const r = await rpc('getKeys', { id: u.id });
          keyDrafts[u.id] = (r.keys || []).join('\n');
          keyShown[u.id] = true;
          renderService();
        } catch (e) { toast(e.message); }
      };
      krow.appendChild(showBtn);
    } else {
      const hideBtn = el('div', 'btn neutral r3 sm', '隐藏');
      hideBtn.onclick = () => { keyShown[u.id] = false; renderService(); };
      krow.appendChild(hideBtn);
    }
    const saveBtn = el('div', 'btn cyan r3 sm', '保存');
    saveBtn.onclick = async () => {
      const val = (keyDrafts[u.id] || '').trim();
      if (!val) { toast('请先输入 Key'); return; }
      saveBtn.textContent = '保存中…';
      try {
        const r = await rpc('setKey', { id: u.id, key: val });
        if (r && r.ok === false) throw new Error(r.error || '保存失败');
        toast('已保存 ' + ((r && r.keys) || 1) + ' 把 Key');
        keyShown[u.id] = false; keyDrafts[u.id] = '';
        refreshState();
      } catch (e) { toast(e.message); saveBtn.textContent = '保存'; }
    };
    krow.appendChild(saveBtn);
    const clearBtn = el('div', 'btn red-solid r3 sm', '清除');
    clearBtn.onclick = async () => {
      try { await rpc('clearKey', { id: u.id }); keyDrafts[u.id] = ''; toast('已清除'); refreshState(); }
      catch (e) { toast(e.message); }
    };
    krow.appendChild(clearBtn);
    // OAuth 链接登录（dsh-router-codebuddy 同款流程）：浏览器授权 → 自动入库
    if (u.id === 'codebuddy' || u.id === 'codebuddy-en') {
      const oauthBtn = el('div', 'btn green r3 sm flex1', '🔗 链接登录');
      oauthBtn.onclick = () => doOAuthLogin(u.id, oauthBtn);
      body.appendChild(oauthBtn);
      // 运维操作（workbuddy2api 同款：签到/余额/成长/连登/旅行/试用）
      body.appendChild(buildCodeBuddyOps(u.id));
    }
    body.appendChild(krow);
  } else {
    body.appendChild(el('div', 'up-note', '该上游免鉴权，无需配置 Key。'));
  }

  // 操作按钮
  const arow = el('div', 'row gap');
  arow.style.marginTop = '6px';
  const testBtn = el('div', 'btn yellow r3 sm flex1', '⚡ 测试');
  testBtn.onclick = async () => {
    testBtn.textContent = '测试中…';
    try {
      const r = await rpc('test', { id: u.id });
      toast(r.ok ? ('✓ ' + (r.model || '') + ' · ' + r.latencyMs + 'ms') : ('✗ ' + (r.error || '失败')));
    } catch (e) { toast(e.message); }
    testBtn.textContent = '⚡ 测试';
  };
  const probeBtn = el('div', 'btn neutral r3 sm flex1', '探测');
  probeBtn.onclick = async () => {
    probeBtn.textContent = '探测中…';
    try {
      const r = await rpc('probe', { id: u.id });
      const res = r.results && r.results[0];
      toast(res ? ('探测 ' + res.count + ' 个模型（免费 ' + res.free + '）') : '探测完成');
      refreshState();
    } catch (e) { toast(e.message); }
    probeBtn.textContent = '探测';
  };
  arow.appendChild(testBtn); arow.appendChild(probeBtn);
  if (u.signupUrl) {
    const signup = el('div', 'btn blue-tint r3 sm flex1', '申请 Key');
    // Android：用宿主桥调系统默认浏览器打开注册页；桌面/降级用新窗口
    signup.onclick = () => {
      if (window.AndroidBridge && typeof window.AndroidBridge.openBrowser === 'function') {
        window.AndroidBridge.openBrowser(u.signupUrl);
      } else {
        try { window.open(u.signupUrl, '_blank'); } catch (e) { toast('请复制链接到浏览器打开: ' + u.signupUrl); }
      }
    };
    arow.appendChild(signup);
  }
  const rm = el('div', 'btn red-solid r3 sm', '隐藏');
  rm.onclick = async () => {
    try { await rpc('removeUpstream', { id: u.id }); toast('已隐藏'); refreshState(); }
    catch (e) { toast(e.message); }
  };
  arow.appendChild(rm);
  body.appendChild(arow);

  // 教程
  if (u.tutorial && u.tutorial.length > 0) {
    body.appendChild(el('div', 'hr'));
    body.appendChild(el('div', 'field-label', '申请教程'));
    u.tutorial.forEach(t => {
      const li = el('div', 'up-note', '· ' + t);
      li.style.marginTop = '2px';
      body.appendChild(li);
    });
  }
  card.appendChild(body);
  return card;
}

// ---------- 渲染：Tab 1 模型 ----------
function renderModels() {
  const page = document.getElementById('page-models');
  if (!page) return;
  page.innerHTML = '';
  const st = STATE || { models: [], catalog: {} };

  const sh = el('div', 'section-header');
  sh.appendChild(el('div', 't', '免费模型'));
  sh.appendChild(el('div', 's', '目录即真相 · 跨上游合并去重 · 失效自动切换'));
  page.appendChild(sh);

  // 目录状态卡
  const catCard = el('div', 'card tight');
  const cr = el('div', 'row gap');
  cr.appendChild(el('div', 'card-title', '远程目录'));
  cr.appendChild(el('div', 'spacer'));
  const cat = st.catalog || {};
  cr.appendChild(el('div', 'badge ' + (cat.lastSyncError ? 'red' : (cat.lastSyncAt ? 'green' : 'dim')),
    cat.lastSyncError ? '同步失败' : (cat.lastSyncAt ? '已同步' : '未同步')));
  catCard.appendChild(cr);
  const meta = el('div', 'up-meta');
  meta.textContent = '条目 ' + (cat.lastCount || 0) + ' · 格式 ' + (cat.lastFormat || '—') +
    (cat.lastSyncAt ? ' · ' + new Date(cat.lastSyncAt).toLocaleTimeString() : '') +
    (cat.lastUsedFallback ? ' · 备份源' : '');
  catCard.appendChild(meta);
  if (cat.lastSyncError) {
    const e = el('div', 'up-note', '⚠ ' + cat.lastSyncError);
    e.style.color = 'var(--log-error)';
    catCard.appendChild(e);
  }
  const syncBtn = el('div', 'btn cyan r3 sm');
  syncBtn.textContent = '立即同步';
  syncBtn.style.marginTop = '6px';
  syncBtn.onclick = doCatalogSync;
  catCard.appendChild(syncBtn);
  page.appendChild(catCard);

  // 模型列表卡（弹性）
  const listCard = el('div', 'card flex');
  const lh = el('div', 'row');
  lh.appendChild(el('div', 'card-title', '可用模型 (' + (st.models || []).length + ')'));
  lh.appendChild(el('div', 'spacer'));
  const probeBtn = el('div', 'btn neutral r3 sm', '全量探测');
  probeBtn.onclick = doProbeAll;
  lh.appendChild(probeBtn);
  lh.style.paddingBottom = '4px';
  listCard.appendChild(lh);
  const wrap = el('div', 'audit-wrap');
  const models = st.models || [];
  if (models.length === 0) {
    wrap.appendChild(el('div', 'empty', '暂无可用模型。\n\n请先在「服务」页为至少一个上游配置 API Key，\n引擎会自动探测并展示可用的免费模型。'));
  } else {
    models.forEach(m => {
      const row = el('div', 'model-row');
      const left = el('div');
      left.style.flex = '1'; left.style.minWidth = '0';
      left.appendChild(el('div', 'model-id', (m.id === 'auto' ? '⚡ ' : '') + m.id));
      if (m.via && m.via.length > 0) {
        left.appendChild(el('div', 'model-via', m.via.map(v => v.upstream).join(' · ')));
      }
      row.appendChild(left);
      if (m.contextWindow) row.appendChild(el('div', 'badge dim mono', Math.round(m.contextWindow / 1024) + 'K'));
      const use = el('div', 'btn blue-tint r3 xs', '设为默认');
      use.style.marginLeft = '4px';
      use.onclick = async () => {
        try { await rpc('setDefault', { model: m.id }); toast('默认模型已设为 ' + m.id); refreshState(); }
        catch (e) { toast(e.message); }
      };
      row.appendChild(use);
      wrap.appendChild(row);
    });
  }
  listCard.appendChild(wrap);
  page.appendChild(listCard);
}

// ---------- 渲染：Tab 2 设置 ----------
function renderAdvanced() {
  const page = document.getElementById('page-advanced');
  if (!page) return;
  page.innerHTML = '';
  const st = STATE || { catalog: {}, globalProxy: '', autoTakeover: true };

  const sh = el('div', 'section-header');
  sh.appendChild(el('div', 't', '全局设置'));
  sh.appendChild(el('div', 's', '出站代理 · 远程目录 · 默认模型接管'));
  page.appendChild(sh);

  // 出站代理卡
  const proxyCard = el('div', 'card');
  const pr = el('div', 'row gap');
  pr.appendChild(el('div', 'card-title lg', '出站代理'));
  pr.appendChild(el('div', 'spacer'));
  const cur = st.globalProxy || '';
  pr.appendChild(el('div', 'badge mono ' + (cur ? 'green' : 'dim'), cur ? '已启用' : '直连'));
  proxyCard.appendChild(pr);
  proxyCard.appendChild(el('div', 'up-note', '作用于所有未单独配置代理的上游（对话与模型探测）。留空 = 直连。'));
  proxyCard.appendChild(el('div', 'field-label', '代理地址 (http / https)'));
  const proxyInput = el('input', 'input');
  proxyInput.placeholder = 'http://127.0.0.1:7890';
  proxyInput.value = cur;
  proxyCard.appendChild(proxyInput);
  const presetRow = el('div', 'pill-row');
  [['Clash 7890', 'http://127.0.0.1:7890'], ['v2ray 10809', 'http://127.0.0.1:10809'], ['直连', '']].forEach(p => {
    const b = el('div', 'btn neutral r3 sm', p[0]);
    b.onclick = () => { proxyInput.value = p[1]; };
    presetRow.appendChild(b);
  });
  proxyCard.appendChild(presetRow);
  const saveProxy = el('div', 'btn cyan r3', '保存代理');
  saveProxy.style.marginTop = '6px';
  saveProxy.onclick = async () => {
    try { await rpc('applyPatch', { patch: { proxy: proxyInput.value.trim() } }); toast('代理已保存'); refreshState(); }
    catch (e) { toast(e.message); }
  };
  proxyCard.appendChild(saveProxy);
  page.appendChild(proxyCard);

  // 远程目录卡
  const catCard = el('div', 'card');
  catCard.appendChild(el('div', 'card-title lg', '远程目录源'));
  catCard.appendChild(el('div', 'up-note', '免费模型目录的 JSON 地址。留空使用内置默认源（含备份源自动容灾）。'));
  catCard.appendChild(el('div', 'field-label', '目录 URL'));
  const catInput = el('input', 'input');
  catInput.placeholder = 'https://config.freetokenbox.com/freeroute.json';
  catInput.value = (st.catalog && st.catalog.remoteUrl) || '';
  catCard.appendChild(catInput);
  catCard.appendChild(el('div', 'field-label', '自动刷新间隔（毫秒，≥60000）'));
  const refInput = el('input', 'input');
  refInput.placeholder = '1800000';
  refInput.value = String((st.catalog && st.catalog.autoRefreshMs) || 1800000);
  catCard.appendChild(refInput);
  const saveCat = el('div', 'btn cyan r3', '保存目录设置');
  saveCat.style.marginTop = '6px';
  saveCat.onclick = async () => {
    const patch = { catalog: { remoteUrl: catInput.value.trim() } };
    const ms = Number(refInput.value);
    if (ms >= 60000) patch.catalog.autoRefreshMs = ms;
    try { await rpc('applyPatch', { patch: patch }); toast('目录设置已保存'); refreshState(); }
    catch (e) { toast(e.message); }
  };
  catCard.appendChild(saveCat);
  page.appendChild(catCard);

  // 默认模型接管卡
  const tkCard = el('div', 'card');
  const tr = el('div', 'row gap');
  tr.appendChild(el('div', 'card-title lg', '自动接管默认模型'));
  tr.appendChild(el('div', 'spacer'));
  const tkOn = st.autoTakeover !== false;
  const toggle = el('div', 'btn r3 sm ' + (tkOn ? 'green' : 'neutral'), tkOn ? '● 已开启' : '○ 已关闭');
  toggle.onclick = async () => {
    try { await rpc('applyPatch', { patch: { autoTakeover: !tkOn } }); toast('已' + (!tkOn ? '开启' : '关闭')); refreshState(); }
    catch (e) { toast(e.message); }
  };
  tr.appendChild(toggle);
  tkCard.appendChild(tr);
  tkCard.appendChild(el('div', 'up-note', '任一上游就绪时，把宿主默认模型切到 freeroute/auto。关闭后恢复原默认选择。'));
  if (st.currentSelection) {
    tkCard.appendChild(el('div', 'up-meta', '当前默认: ' + st.currentSelection.provider + '/' + st.currentSelection.model));
  }
  page.appendChild(tkCard);

  // 高级 JSON 卡
  const advCard = el('div', 'card flex');
  const ah = el('div', 'row');
  ah.appendChild(el('div', 'card-title', '高级：完整配置 JSON'));
  ah.appendChild(el('div', 'spacer'));
  const reload = el('div', 'btn neutral r3 sm', '读取');
  reload.onclick = loadRawConfig;
  ah.appendChild(reload);
  ah.style.paddingBottom = '4px';
  advCard.appendChild(ah);
  const ta = el('textarea', 'input');
  ta.id = 'raw-config';
  ta.style.flex = '1'; ta.style.minHeight = '120px';
  ta.placeholder = '{\n  "order": [],\n  "upstreams": {},\n  "proxy": ""\n}';
  advCard.appendChild(ta);
  const applyRaw = el('div', 'btn cyan r3', '应用 JSON');
  applyRaw.style.marginTop = '6px';
  applyRaw.onclick = async () => {
    let patch;
    try { patch = JSON.parse(ta.value); } catch (e) { toast('JSON 解析失败: ' + e.message); return; }
    try { await rpc('applyPatch', { patch: patch }); toast('配置已应用'); refreshState(); }
    catch (e) { toast(e.message); }
  };
  const saveConfig = el('div', 'btn green r3', '导出配置');
  saveConfig.style.marginTop = '6px';
  saveConfig.onclick = () => doExportConfig(saveConfig);
  const importRow = el('div', 'row gap');
  importRow.style.marginTop = '6px';
  const importBtn = el('div', 'btn blue r3 flex1', '恢复配置');
  importBtn.style.cursor = 'pointer';
  const hiddenFile = el('input', '');
  hiddenFile.type = 'file';
  hiddenFile.accept = '.json';
  hiddenFile.style.display = 'none';
  importBtn.onclick = () => {
    if (window.AndroidBridge && typeof window.AndroidBridge.pickImport === 'function') {
      window.AndroidBridge.pickImport();
    } else {
      try { hiddenFile.click(); } catch (e) { toast('无法打开文件选择器'); }
    }
  };
  hiddenFile.onchange = async function () {
    const f = hiddenFile.files && hiddenFile.files[0];
    hiddenFile.value = '';
    if (f) {
      importBtn.textContent = '恢复中…';
      await doImportConfig(f, () => { importBtn.textContent = '恢复配置'; refreshState(); loadRawConfig(); });
    }
  };
  importRow.appendChild(importBtn);
  importRow.appendChild(hiddenFile);
  applyRaw.style.marginTop = '0px';
  applyRaw.style.marginBottom = '4px';
  advCard.appendChild(applyRaw);
  advCard.appendChild(saveConfig);
  advCard.appendChild(importRow);
  page.appendChild(advCard);
}

async function loadRawConfig() {
  try {
    const st = await rpc('state');
    const ta = document.getElementById('raw-config');
    if (ta) {
      const up = {};
      (st.upstreams || []).forEach(u => { up[u.id] = { enabled: u.enabled }; });
      ta.value = JSON.stringify({ order: (st.upstreams || []).map(u => u.id), upstreams: up, proxy: st.globalProxy || '' }, null, 2);
    }
  } catch (e) { toast(e.message); }
}

// ---------- 渲染：Tab 3 仪表 ----------
function renderMetrics() {
  const page = document.getElementById('page-metrics');
  if (!page) return;
  page.innerHTML = '';
  const st = STATE || { totals: {} };
  const info = ENGINE || {};
  const t = st.totals || {};

  const sh = el('div', 'section-header');
  sh.appendChild(el('div', 't', '流量与运维监控'));
  sh.appendChild(el('div', 's', '核心调用吞吐指标、多模型实时 Token 统计与访问异常排查'));
  page.appendChild(sh);

  const failRate = t.requests > 0 ? (t.failed / t.requests * 100).toFixed(1) : '0.0';
  const kpis = [
    { l: '总请求量', v: String(t.requests || 0), c: 'blue' },
    { l: '失败请求', v: String(t.failed || 0) + ' (' + failRate + '%)', c: (t.failed > 0 ? 'red' : 'green') },
    { l: '成功率', v: (t.requests > 0 ? ((t.ok / t.requests * 100).toFixed(0)) : '100') + '%', c: 'cyan' },
    { l: 'Token 输入', v: fmtTokens(t.tokensIn), c: 'amber' },
    { l: 'Token 输出', v: fmtTokens(t.tokensOut), c: 'purple' },
    { l: '已运行时长', v: fmtUptime(info.uptimeMs), c: 'green' }
  ];
  const grid = el('div', 'kpi-grid');
  kpis.forEach(k => {
    const cell = el('div', 'kpi');
    cell.appendChild(el('div', 'l', k.l));
    cell.appendChild(el('div', 'v ' + k.c, k.v));
    grid.appendChild(cell);
  });
  const kpiCard = el('div', 'card');
  kpiCard.style.padding = '8px 10px';
  kpiCard.appendChild(grid);
  page.appendChild(kpiCard);

  // 上游明细
  const detailCard = el('div', 'card flex');
  const dh = el('div', 'row');
  dh.appendChild(el('div', 'card-title', '上游明细'));
  dh.appendChild(el('div', 'spacer'));
  const rf = el('div', 'btn neutral r3 sm', '⟳ 刷新');
  rf.onclick = refreshMetrics;
  dh.appendChild(rf);
  dh.style.paddingBottom = '4px';
  detailCard.appendChild(dh);
  const wrap = el('div', 'audit-wrap');
  const ups = (st.upstreams || []).filter(u => u.stats && u.stats.requests > 0);
  if (ups.length === 0) {
    wrap.appendChild(el('div', 'empty', '暂无调用记录（配置 Key 并发起请求后即可记录）'));
  } else {
    ups.forEach(u => {
      const row = el('div', 'audit-row');
      row.appendChild(el('div', 'model-id', u.name));
      row.appendChild(el('div', 'spacer'));
      row.appendChild(el('div', 'model-via', '请求 ' + u.stats.requests + ' · 成功 ' + u.stats.ok + ' · 失败 ' + u.stats.failed));
      const lat = el('div', 'badge mono ' + (u.stats.failed > 0 ? 'red' : 'green'), u.stats.lastLatencyMs ? u.stats.lastLatencyMs + 'ms' : '—');
      lat.style.marginLeft = '6px';
      row.appendChild(lat);
      wrap.appendChild(row);
    });
  }
  detailCard.appendChild(wrap);
  page.appendChild(detailCard);
}
async function refreshMetrics() {
  await refreshState();
  renderMetrics();
}

// ---------- 渲染：Tab 4 关于 ----------
function renderAbout() {
  const page = document.getElementById('page-about');
  if (!page) return;
  page.innerHTML = '';
  const scroll = el('div', 'about-scroll');
  const inner = el('div', 'about-inner');

  const icon = el('div', 'about-icon');
  icon.innerHTML = '<svg viewBox="0 0 24 24" fill="#58A6FF"><path d="' + TABS[0].path + '"/></svg>';
  inner.appendChild(icon);
  inner.appendChild(el('div', 'about-name', 'FreeRoute'));
  inner.appendChild(el('div', 'about-ver', 'v' + ((STATE && STATE.version) || '0.8.19') + ' · 免费模型聚合网关'));

  const card = el('div', 'about-card');
  const info = ENGINE || {};
  const rows = [
    { k: '引擎版本', v: 'v' + ((STATE && STATE.version) || '—'), cls: '', link: false },
    { k: '运行底座', v: 'Node ' + (info.node || '—'), cls: '', link: false },
    { k: '平台', v: info.platform || '—', cls: '', link: false },
    { k: '监听端口', v: ':' + (info.port || '—'), cls: 'cyan', link: false },
    { k: '配置持久化', v: (STATE && STATE.persistence) ? '已启用' : '未启用', cls: '', link: false },
    { k: '配置文件', v: (STATE && STATE.configPath) || '—', cls: '', link: false },
    { k: '项目主页', v: 'freeroute-android ↗', cls: 'blue', link: 'https://github.com/lopinnn56/freeroute-android' },
    { k: '模型目录源', v: 'FreeLLMAPI ↗', cls: 'blue', link: 'https://github.com/tashfeenahmed/freellmapi' },
    { k: '上游插件', v: 'dsh-freeroute ↗', cls: 'blue', link: 'https://github.com/dushaobindoudou/dsh-freeroute' },
    { k: '界面参考', v: 'CLIProxyAPI ↗', cls: 'blue', link: 'https://github.com/liaoyh9422-creator/CLIProxyAPI' }
  ];
  rows.forEach((r, i) => {
    const row = el('div', 'about-row' + (r.link ? ' link' : ''));
    row.appendChild(el('div', 'k', r.k));
    const v = el('div', 'v ' + r.cls, r.v);
    v.style.maxWidth = '60%'; v.style.overflow = 'hidden'; v.style.textOverflow = 'ellipsis'; v.style.whiteSpace = 'nowrap';
    row.appendChild(v);
    if (r.link) row.onclick = () => window.open(r.link, '_blank');
    card.appendChild(row);
  });
  inner.appendChild(card);

  const footer = el('div', 'about-footer');
  footer.textContent = 'FreeRoute 免费模型聚合网关\n基于 dsh-freeroute 引擎 · MIT License';
  inner.appendChild(footer);

  scroll.appendChild(inner);
  page.appendChild(scroll);
}

// ---------- 日志渲染 ----------
function renderLogLines() {
  const wrap = document.getElementById('log-wrap');
  if (!wrap) return;
  wrap.innerHTML = '';
  const lines = LOGS.slice(-600);
  if (lines.length === 0) {
    const empty = el('div', 'log-line info-b', '暂无日志。请求引擎后日志会显示在这里；可点上方「刷新」。');
    wrap.appendChild(empty);
    return;
  }
  lines.forEach((line, i) => {
    const div = el('div', 'log-line ' + classifyLog(line, i));
    div.textContent = stripTs(line);
    wrap.appendChild(div);
  });
  wrap.scrollTop = wrap.scrollHeight;
}
function classifyLog(line, i) {
  const s = line.toLowerCase();
  if (/error|fail|exception|❌|!!!/.test(s)) return 'error';
  if (/warn|⚠/.test(s)) return 'warn';
  if (/started|listening|success|✅|===|⚡|就绪|已保存|已同步/.test(s)) return 'success';
  return (i % 2 === 0) ? 'info-a' : 'info-b';
}
function stripTs(line) {
  return String(line)
    .replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?\s*/, '')
    .replace(/^\[?(\d{2}:\d{2}:\d{2})\]?\s*/, '');
}

async function loadLogs() {
  try {
    const r = await rpc('log', { tail: 400 });
    LOGS = (r && r.lines) || [];
    if (currentTab === 0) renderLogLines();
  } catch (e) { /* 日志不可用不阻塞 */ }
}

// ---------- 数据刷新 ----------
async function refreshState() {
  try {
    STATE = await rpc('state');
  } catch (e) {
    toast('引擎连接失败: ' + e.message);
    return;
  }
  if (!ENGINE) { try { ENGINE = await rpc('engineInfo'); } catch (e) {} }
  if (currentTab === 0) renderService();
  else if (currentTab === 1) renderModels();
  else if (currentTab === 2) renderAdvanced();
  else if (currentTab === 3) renderMetrics();
  else if (currentTab === 4) renderAbout();
}

async function doCatalogSync() {
  toast('正在同步目录…');
  try {
    const r = await rpc('catalogSync');
    if (r && r.ok) toast('目录已同步：' + r.count + ' 条（新增 ' + (r.added || 0) + '）');
    else toast('同步失败: ' + ((r && r.error) || '未知'));
    refreshState();
  } catch (e) { toast(e.message); }
}
// ---------- CodeBuddy 运维（workbuddy2api 能力：签到/余额/成长/连登/旅行/试用） ----------
// 卡片上的运维按钮行：每个按钮调用对应 RPC，结果弹出简洁汇总。
function buildCodeBuddyOps(upId) {
  const wrap = el('div', 'row gap');
  wrap.style.marginTop = '6px';
  const ops = [
    { label: '签到', method: 'cbCheckin', exec: (r) => {
      const okN = (r && r.success) || 0;
      let base = r && r.ok ? ('签到完成 ' + okN + '/' + (r.total || 0) + ' 个账号') : ('签到失败: ' + ((r && r.error) || ''));
      const rs = (r && r.results) || [];
      const diag = rs.map(x => '[HTTP ' + x.status + '] ' + (x.msg || '') + (x.raw ? ' | ' + x.raw.slice(0, 120) : '')).join(' ‖ ');
      return diag ? (base + ' ‖ ' + diag) : base;
    } },
    { label: '余额', method: 'cbUsage', exec: (r) => {
      if (!r || !r.ok) return '余额查询失败: ' + ((r && r.error) || '');
      const acts = r.results || [];
      const main = '余额：' + acts.map(a => (a.nickname || '账号') + ' ' + (a.remain >= 0 ? a.remain + '/' + a.total : '—')).join('；');
      const diag = acts.map(a => (a.status ? '[HTTP ' + a.status + '] ' : '') + (a.raw ? a.raw.slice(0, 150) : '')).join(' ‖ ');
      return diag ? (main + ' ‖ ' + diag) : main;
    } },
    { label: '成长任务', method: 'cbGrowth', exec: (r) => {
      if (!r || !r.ok) return '成长任务失败: ' + ((r && r.error) || '');
      const claims = (r.accounts || []).reduce((s, a) => s + (a.claimed || 0), 0);
      const base = '成长任务：领取 ' + claims + ' 个奖励';
      const diag = (r.accounts || []).map(a => '可领' + (a.claimable || 0) + ' 原' + (a.raw ? ' | ' + a.raw.slice(0, 150) : '')).join(' ‖ ');
      return diag ? (base + ' ‖ ' + diag) : base;
    } },
    { label: '连登+抽奖', method: 'cbStreak', exec: (r) => {
      if (!r || !r.ok) return '连登失败: ' + ((r && r.error) || '');
      const sum = (r.accounts || []).reduce((s, a) => s + (a.redeemed || 0), 0);
      const draws = (r.accounts || []).reduce((s, a) => s + (a.draws || 0), 0);
      return '连登：兑换 ' + sum + ' 档，抽奖 ' + draws + ' 次';
    } },
    { label: '猫猫旅行', method: 'cbTravel', exec: (r) => {
      if (!r || !r.ok) return '旅行失败: ' + ((r && r.error) || '');
      const d = (r.accounts || []).filter(a => a.departed).length;
      const c = (r.accounts || []).filter(a => a.claimed).length;
      return '旅行：出发 ' + d + '，领取 ' + c;
    } },
    { label: '试用包', method: 'cbTrial', exec: (r) => {
      if (!r || !r.ok) return '试用领取失败: ' + ((r && r.error) || '');
      const okN = (r.results || []).filter(x => x.ok).length;
      return '试用包：领取成功 ' + okN + '/' + (r.results || []).length;
    } }
  ];
  ops.forEach((op, i) => {
    const b = el('div', 'btn blue r3 sm flex1', op.label);
    if (i > 0) b.style.marginLeft = '4px';
    b.onclick = async () => {
      b.textContent = '…';
      try {
        const r = await rpc(op.method, { id: upId });
        toast(op.exec(r));
      } catch (e) { toast(e.message); }
      b.textContent = op.label;
    };
    wrap.appendChild(b);
  });
  return wrap;
}

// ---------- OAuth 链接登录（CodeBuddy 族） ----------
// 浏览器打开授权页 → 前端每 3s 轮询引擎 → 上游发 token 后自动入凭据环。
async function doOAuthLogin(upstreamId, btn) {
  const label = btn ? btn.textContent : '🔗 链接登录';
  try {
    btn.textContent = '获取链接…';
    const r = await rpc('oauthStart', { id: upstreamId });
    if (!r || !r.ok) { toast('获取登录链接失败: ' + ((r && r.error) || '未知')); btn.textContent = label; return; }
    // 用系统浏览器打开授权页（Android 桥 / 桌面新窗口）
    if (window.AndroidBridge && typeof window.AndroidBridge.openBrowser === 'function') {
      window.AndroidBridge.openBrowser(r.loginUrl);
    } else {
      try { window.open(r.loginUrl, '_blank'); } catch (e) { toast('请复制链接到浏览器打开: ' + r.loginUrl); }
    }
    toast('请在浏览器中完成授权，授权后自动返回…');
    btn.textContent = '等待授权…';
    const deadline = Date.now() + 290000;
    while (Date.now() < deadline) {
      await new Promise(res => setTimeout(res, 3000));
      const p = await rpc('oauthPoll', { id: upstreamId });
      if (p && p.ok && p.pending) continue;              // 仍在等待
      if (p && p.ok && p.success) {
        toast('✓ 登录成功，凭证已入库（第 ' + ((p.slot || 0) + 1) + ' 把 Key）');
        btn.textContent = label;
        refreshState();
        return;
      }
      // 失败 / 超时
      toast('登录失败: ' + ((p && p.error) || '未知'));
      btn.textContent = label;
      return;
    }
    btn.textContent = label;
  } catch (e) { toast(e.message); btn.textContent = label; }
}

async function doFreellmapiSync() {
  toast('正在同步 FreeLLMAPI 提供商…');
  try {
    const r = await rpc('freellmapiSync');
    if (r && r.ok) toast('已同步 FreeLLMAPI：' + r.count + ' 家提供商（新增 ' + (r.added || 0) + '）');
    else toast('同步失败: ' + ((r && r.error) || '未知'));
    refreshState();
  } catch (e) { toast(e.message); }
}
async function doProbeAll() {
  toast('正在探测所有上游模型…');
  try {
    const r = await rpc('probe');
    const total = (r.results || []).reduce((a, x) => a + x.count, 0);
    toast('探测完成：共 ' + total + ' 个模型');
    refreshState();
  } catch (e) { toast(e.message); }
}
async function doHealthCheck() {
  try {
    const res = await fetch(BASE + '/health');
    const j = await res.json();
    toast('引擎正常 · ' + j.route + ' v' + j.version);
  } catch (e) { toast('引擎未响应: ' + e.message); }
}

// ---------- 配置备份（导出 / 恢复） ----------
// 导出：Android 端用宿主桥弹「保存到」对话框让用户选位置（SAF）；
// 桌面浏览器则跳转 HTTP 端点按附件下载。
async function doExportConfig(btn) {
  const label = btn ? btn.textContent : '导出中…';
  if (btn) btn.textContent = '导出中…';
  try {
    const r = await rpc('freeroute.config.export');
    if (!r || !r.ok) { toast('导出失败: ' + ((r && r.error) || '未知')); if (btn) btn.textContent = label; return; }
    // 支持 Android 桥：弹系统保存位置选择器
    if (window.AndroidBridge && typeof window.AndroidBridge.saveConfig === 'function') {
      window.AndroidBridge.saveConfig(r.text);
      toast('请在系统对话框中选择保存位置');
    } else {
      // 桌面降级：HTTP 附件下载
      location.href = BASE + '/config/export';
    }
  } catch (e) { toast(e.message); }
  if (btn) btn.textContent = label;
}
// 恢复：读取选择文件，校验后整体覆盖配置与 Key。
async function doImportConfig(file, onDone) {
  if (!file) return;
  const text = await file.text();
  try {
    const r = await rpc('freeroute.config.import', { text: text });
    if (r && r.ok) {
      const c = r.counts || {};
      toast('配置已恢复：' + (c.upstreams || 0) + ' 个上游，' + (c.keys || 0) + ' 把 Key');
    } else {
      toast('恢复失败: ' + ((r && r.error) || '未知'));
    }
  } catch (e) { toast(e.message); }
  if (onDone) onDone();
}

// 全局回调供 Android 桥调用（SAF 路径）：
// - 配式导出完成（WebView 收到桌面路径字符串，给提示但不做文件操作）
// - 导入完成：收到文件内容后整体覆盖配置并刷新
window.__onConfigSaved = function(displayPath) {
  toast('配置已保存到: ' + displayPath);
};
window.__onConfigPicked = async function(text) {
  if (text === null || text === undefined) { toast('读取配置失败'); return; }
  try {
    const r = await rpc('freeroute.config.import', { text: text });
    if (r && r.ok) {
      const c = r.counts || {};
      toast('配置已恢复：' + (c.upstreams || 0) + ' 个上游，' + (c.keys || 0) + ' 把 Key');
      // 刷新状态以立即反馈
      if (currentTab === 0) refreshState();
      if (currentTab === 2) renderAdvanced();
    } else {
      toast('导入失败: ' + ((r && r.error) || '未知'));
    }
  } catch (e) { toast(e.message); }
};

// RikkaHub 配置导入回调（Android 桥读取文件后调用）
window.__onRikkaPicked = async function(text) {
  if (!text) { toast('RikkaHub 配置为空'); return; }
  toast('正在导入 RikkaHub 配置…');
  try {
    const r = await rpc('rikkaImport', { text: text });
    if (r && r.ok) {
      const st = r.skippedTypes || {};
      const stTxt = Object.keys(st).map(k => k + '×' + st[k]).join('，');
      toast('RikkaHub 导入完成：新增 ' + (r.added || 0) + '，更新 ' + (r.updated || 0) +
        '，Key ' + (r.keys || 0) + ' 把' + (stTxt ? '（跳过 ' + stTxt + '）' : ''));
      refreshState();
      renderService();
    } else {
      toast('RikkaHub 导入失败: ' + ((r && r.error) || '未知'));
    }
  } catch (e) { toast(e.message); }
};

// dsh-router 配置导入回调（Android 桥读取文件后调用）
window.__onDshrPicked = async function(text) {
  if (!text) { toast('dsh-router 导出内容为空'); return; }
  toast('正在导入 dsh-router 凭据…');
  try {
    const r = await rpc('dshrouterImport', { text: text });
    if (r && r.ok) {
      const st = r.skippedSup || {};
      const stTxt = Object.keys(st).map(k => k + '×' + st[k]).join('，');
      toast('dsh-router 导入完成：供应商 ' + (r.suppliers || 0) + '，Key ' + (r.keys || 0) +
        ' 把' + (stTxt ? '（跳过 ' + stTxt + '）' : ''));
      refreshState();
      renderService();
    } else {
      toast('dsh-router 导入失败: ' + ((r && r.error) || '未知'));
    }
  } catch (e) { toast(e.message); }
};
// 生成「配置备份」卡片：包含 导出配置 / 恢复配置 按钮，服务页顶部最显眼。
function buildConfigBackupCard() {
  const card = el('div', 'card');
  const h = el('div', 'row gap');
  h.appendChild(el('div', 'card-title lg', '配置备份'));
  h.appendChild(el('div', 'spacer'));
  h.appendChild(el('div', 'badge green', '含 API Key'));
  card.appendChild(h);
  card.appendChild(el('div', 'up-note', '导出当前全部上游 / 模型 / 代理与 API Key 配置为 JSON 文件；换机或重装后可一键恢复。'));

  const row = el('div', 'row gap');
  row.style.marginTop = '6px';
  const exportBtn = el('div', 'btn green r3 flex1', '导出配置');
  exportBtn.onclick = () => doExportConfig(exportBtn);
  const importWrap = el('div');
  importWrap.style.flex = '1';
  const importBtn = el('div', 'btn blue r3 flex1', '恢复配置');
  importBtn.style.cursor = 'pointer';
  const hiddenFile = el('input', '');
  hiddenFile.type = 'file';
  hiddenFile.accept = '.json';
  hiddenFile.style.display = 'none';
  // Android：调宿主桥用系统文件选择器（SAF）选文件并回调；桌面/降级用隐藏文件框
  importBtn.onclick = () => {
    if (window.AndroidBridge && typeof window.AndroidBridge.pickImport === 'function') {
      window.AndroidBridge.pickImport();
    } else {
      try { hiddenFile.click(); } catch (e) { toast('无法打开文件选择器'); }
    }
  };
  hiddenFile.onchange = async function () {
    const f = hiddenFile.files && hiddenFile.files[0];
    hiddenFile.value = '';
    if (f) {
      importBtn.textContent = '恢复中…';
      await doImportConfig(f, () => { importBtn.textContent = '恢复配置'; refreshState(); renderService(); renderAdvanced(); });
    }
  };
  importWrap.appendChild(importBtn);
  importWrap.appendChild(hiddenFile);
  row.appendChild(exportBtn);
  row.appendChild(importWrap);
  card.appendChild(row);

  // RikkaHub 模型配置导入行
  const rrow = el('div', 'row gap');
  rrow.style.marginTop = '6px';
  const rikkaBtn = el('div', 'btn purple r3 flex1', '导入 RikkaHub 配置');
  rikkaBtn.style.cursor = 'pointer';
  rikkaBtn.onclick = () => {
    if (window.AndroidBridge && typeof window.AndroidBridge.pickRikkaImport === 'function') {
      window.AndroidBridge.pickRikkaImport();
    } else {
      // 桌面降级：文件选择框直接读文本走同一回调
      const fi = el('input', '');
      fi.type = 'file';
      fi.accept = '.json,.zip';
      fi.onchange = async function () {
        const f = fi.files && fi.files[0];
        if (!f) return;
        if (f.name.toLowerCase().endsWith('.zip')) { toast('桌面端请先解压出 settings.json 再导入'); return; }
        window.__onRikkaPicked(await f.text());
      };
      fi.click();
    }
  };
  rrow.appendChild(rikkaBtn);
  card.appendChild(rrow);

  // dsh-router 凭据导入行
  const drow = el('div', 'row gap');
  drow.style.marginTop = '6px';
  const dshrBtn = el('div', 'btn purple r3 flex1', '导入 dsh-router 凭据');
  dshrBtn.style.cursor = 'pointer';
  dshrBtn.onclick = () => {
    if (window.AndroidBridge && typeof window.AndroidBridge.pickDshrImport === 'function') {
      window.AndroidBridge.pickDshrImport();
    } else {
      const fi = el('input', '');
      fi.type = 'file';
      fi.accept = '.json,.txt';
      fi.onchange = async function () {
        const f = fi.files && fi.files[0];
        if (!f) return;
        window.__onDshrPicked(await f.text());
      };
      fi.click();
    }
  };
  drow.appendChild(dshrBtn);
  card.appendChild(drow);
  card.appendChild(el('div', 'up-note',
    'dsh-router 用户：先用 sqlite3 导出凭据（select supplier||\'|\'||uid||\'|\'||data from credentials;），把输出存为 .json/.txt 后在此导入；openrouter/codebuddy 等账号 Key 自动进对应上游的轮换环。'));

  // 说明卡：dsh-router 族上游
  card.appendChild(el('div', 'hr'));
  card.appendChild(el('div', 'up-note',
    '「CodeBuddy」「CodeBuddyEN」已内置（来自 dsh-router-codebuddy），在下方上游列表配 Key 即用；' +
    'traework（TRAE SOLO）为非 OpenAI 协议，暂不内置，请参考 dsh-router-traework 项目在桌面端使用。'));
  return card;
}

// ---------- 启动 ----------
function buildPages() {
  const content = document.getElementById('content');
  content.innerHTML = '';
  [['service', renderService], ['models', renderModels], ['advanced', renderAdvanced], ['metrics', renderMetrics], ['about', renderAbout]]
    .forEach(([id], i) => {
      const p = el('div', 'page' + (i === 0 ? ' active' : ''));
      p.id = 'page-' + id;
      content.appendChild(p);
    });
}

async function boot() {
  buildTabbar();
  buildPages();
  await refreshState();
  await loadLogs();
  // 轮询：3s 状态/日志（对齐 CLIProxyAPI 的 3s 节奏）
  setInterval(() => { if (currentTab === 0) { loadLogs(); } }, 3000);
  setInterval(() => { if (currentTab === 3) refreshMetrics(); }, 3000);
  setInterval(() => { if (currentTab === 0 || currentTab === 1) refreshState(); }, 10000);
}
boot();