/**
 * CF-Workers-SUB 旗舰管理版 (增强版 + 后台可达性修复)
 *
 * 你遇到的 522 不是代码报错，而是 /admin_panel 没被路由到 Worker（请求落到源站，源站不通 -> 522）。
 * 本版本做了两件“必杀”：
 * 1) 增加后台别名： /<TOKEN>/admin_panel   （适配只绑定 /<TOKEN>* 路由的情况）
 * 2) 修复“管理员豁免”实际无效：后台成功登录的 IP 会写入 KV: ADMIN_IPS，自动从多IP检测中豁免
 *
 * 其他功能保持不变。
 */

// --- 默认配置（可被 env 覆盖） ---
const DEFAULT_TOKEN = 'auto';
const DEFAULT_ADMIN_PWD = 'zyk20031230';
const DEFAULT_SUBNAME = 'CF-Workers-SUB';
const DEFAULT_SUB_UPDATE_TIME = 6;
const DEFAULT_TOTAL_GB = 99;
const DEFAULT_EXPIRE_TS_MS = 4102329600000;
const DEFAULT_MAIN_DATA = `https://cfxr.eu.org/getSub`;
const DEFAULT_SUBAPI = "SUBAPI.cmliussss.net";
const DEFAULT_SUBCONFIG = "https://raw.githubusercontent.com/cmliu/ACL4SSR/main/Clash/config/ACL4SSR_Online_MultiCountry.ini";
const DEFAULT_SUBPROTOCOL = 'https';

// --- KV Keys ---
const KEY_BLACKLIST_IPS = 'BLACKLIST_IPS';
const KEY_BLACKLIST_IDS = 'BLACKLIST_IDS';
const KEY_ADMIN_IPS = 'ADMIN_IPS';
const LOG_PREFIX = 'LOG_';

// 日志保留 7 天
const LOG_TTL = 604800;

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const path = normalizePath(url.pathname);

      const clientIP = request.headers.get('CF-Connecting-IP') || '0.0.0.0';
      const userAgentRaw = request.headers.get('User-Agent') || 'Unknown';
      const userAgent = userAgentRaw.toLowerCase();
      const userID = url.searchParams.get('id') || url.searchParams.get('user') || 'default';

      // 每次请求都从 env 读取配置（不污染全局变量，避免并发问题）
      const TOKEN = env.TOKEN || DEFAULT_TOKEN;
      const ADMIN_PWD = env.ADMIN_PWD || DEFAULT_ADMIN_PWD;
      const SUBNAME = env.SUBNAME || DEFAULT_SUBNAME;
      const SUBAPI = env.SUBAPI || DEFAULT_SUBAPI;
      const SUBCONFIG = env.SUBCONFIG || DEFAULT_SUBCONFIG;
      const SUBPROTOCOL = env.SUBPROTOCOL || DEFAULT_SUBPROTOCOL;

      // 后台路径：原版 + 别名（兼容只绑 /TOKEN* 路由）
      const ADMIN_PATHS = new Set([
        '/admin_panel',
        `/${TOKEN}/admin_panel`,
      ]);

      // 额外提供一个“探活”地址，帮助你判断是否请求真的打到 Worker
      const PING_PATHS = new Set([
        '/_ping',
        `/${TOKEN}/_ping`,
      ]);

      // --- PING ---
      if (PING_PATHS.has(path)) {
        return new Response('pong', {
          headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
        });
      }

      // --- 后台优先处理（关键：让 /TOKEN/admin_panel 也能进） ---
      if (ADMIN_PATHS.has(path)) {
        if (!env.KV) {
          return htmlResp(
            `配置错误：未找到 KV 绑定，请在 Workers -> Settings/Variables 中绑定 KV 命名空间，变量名必须为 <b>KV</b>。`,
            500
          );
        }

        const pwd = url.searchParams.get('p');
        if (pwd !== ADMIN_PWD) {
          return new Response('Unauthorized: Password Error', { status: 401 });
        }

        // 成功访问后台：记录管理员IP（用于“管理员豁免”）
        if (ctx?.waitUntil) {
          ctx.waitUntil(markAdminIP(env, clientIP));
          ctx.waitUntil(recordLog(env, clientIP, '__admin__', userAgentRaw, url, request.cf, true));
        } else {
          // 极少数情况下 ctx 不存在，仍尽力写入（不阻塞主流程）
          markAdminIP(env, clientIP);
          recordLog(env, clientIP, '__admin__', userAgentRaw, url, request.cf, true);
        }

        const act = url.searchParams.get('action');
        const val = url.searchParams.get('val');
        const type = url.searchParams.get('type');

        // 后台操作：封禁/解封
        if (act && val) {
          const key = type === 'id' ? KEY_BLACKLIST_IDS : KEY_BLACKLIST_IPS;
          let list = parseCSV(await env.KV.get(key));

          if (act === 'block') {
            if (!list.includes(val)) list.push(val);
          } else if (act === 'unblock') {
            list = list.filter(x => x !== val);
          }

          await env.KV.put(key, list.join(','));
          return new Response('Success', { headers: { 'cache-control': 'no-store' } });
        }

        return await handleAdminPanel(env, url.origin, TOKEN);
      }

      // --- 黑名单拦截（非后台请求才拦，避免把自己锁死） ---
      if (env.KV) {
        const blIP = parseCSV(await env.KV.get(KEY_BLACKLIST_IPS));
        if (blIP.includes(clientIP)) return new Response('Access Denied (IP Blocked).', { status: 403 });

        const blID = parseCSV(await env.KV.get(KEY_BLACKLIST_IDS));
        if (userID !== 'default' && blID.includes(userID)) {
          return new Response('Access Denied (User Blocked).', { status: 403 });
        }
      }

      // --- token 校验 ---
      const tokenParamRaw = url.searchParams.get('token') || '';
      // 兼容 token 后面拼接了 |xxx 的情况（更稳，不影响原有用法）
      const tokenParam = tokenParamRaw.split('|')[0];

      const fakeToken = await MD5HEX(`${TOKEN}${Math.ceil(new Date().setHours(0, 0, 0, 0) / 1000)}`);
      const guestToken = env.GUESTTOKEN || await MD5HEX(TOKEN);

      const isValidRequest =
        [TOKEN, fakeToken, guestToken].includes(tokenParam) ||
        path === `/${TOKEN}`;

      // --- 审计日志（仅记录有效请求，避免 KV 爆炸） ---
      if (isValidRequest && env.KV && ctx?.waitUntil) {
        ctx.waitUntil(recordLog(env, clientIP, userID, userAgentRaw, url, request.cf, false));
      }

      // --- 无效请求：伪装页 or 302 ---
      if (!isValidRequest) {
        if (env.URL302) return Response.redirect(env.URL302, 302);
        return new Response(await nginx(), {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=UTF-8', 'cache-control': 'no-store' },
        });
      }

      // --- 浏览器访问 token 路径且无 query：进入节点编辑器 ---
      if (env.KV && userAgent.includes('mozilla') && !url.search) {
        return await KVEditor(request, env, 'LINK.txt', TOKEN);
      }

      // --- 获取节点数据 ---
      const finalData = (env.KV ? await env.KV.get('LINK.txt') : env.LINK) || DEFAULT_MAIN_DATA;
      const links = await ADD(finalData);

      let v2rayNodes = "";
      let subLinks = [];
      for (const x of links) {
        if (x.toLowerCase().startsWith('http')) subLinks.push(x);
        else v2rayNodes += x + '\n';
      }

      let remoteNodes = "";
      let subConverterURLPart = "";
      if (subLinks.length > 0) {
        const subResult = await getSUB(subLinks, "v2rayn", userAgentRaw);
        remoteNodes = subResult[0].join('\n');
        subConverterURLPart = subResult[1];
      }

      const totalContent = v2rayNodes + remoteNodes;

      const format =
        url.searchParams.has('clash') || userAgent.includes('clash')
          ? 'clash'
          : (url.searchParams.has('sb') || userAgent.includes('sing-box'))
            ? 'singbox'
            : 'base64';

      let responseContent = "";
      if (format === 'base64') {
        responseContent = safeBase64Encode(totalContent);
      } else {
        // 注意：这里把额外 URL 用 | 拼接给 SUBAPI（不会影响你原有逻辑）
        const subURL = `${url.origin}/sub?token=${fakeToken}${subConverterURLPart}`;
        const convertUrl =
          `${SUBPROTOCOL}://${SUBAPI}/sub?target=${format}` +
          `&url=${encodeURIComponent(subURL)}` +
          `&insert=false&config=${encodeURIComponent(SUBCONFIG)}` +
          `&emoji=true&list=false&tfo=false&scv=true&fdn=false&sort=false&new_name=true`;

        const subResp = await fetch(convertUrl, { headers: { 'User-Agent': userAgentRaw } });
        responseContent = await subResp.text();
        if (format === 'clash') responseContent = clashFix(responseContent);
      }

      return new Response(responseContent, {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "Profile-Update-Interval": `${DEFAULT_SUB_UPDATE_TIME}`,
          "Subscription-Userinfo": `upload=0; download=0; total=${DEFAULT_TOTAL_GB * 1073741824}; expire=${DEFAULT_EXPIRE_TS_MS / 1000}`,
          "Cache-Control": "no-store, no-cache, must-revalidate",
        },
      });

    } catch (e) {
      return new Response(`Error: ${e.message}`, { status: 500 });
    }
  },
};

// =============== 工具函数 ===============

function normalizePath(p) {
  // 去掉末尾多余 /
  if (!p) return '/';
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

function parseCSV(str) {
  return (str || '')
    .split(',')
    .map(s => (s || '').trim())
    .filter(Boolean);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function htmlResp(html, status = 200) {
  return new Response(`<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:20px;">${html}</body>`, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

async function markAdminIP(env, ip) {
  try {
    const list = parseCSV(await env.KV.get(KEY_ADMIN_IPS));
    if (!list.includes(ip)) {
      list.push(ip);
      await env.KV.put(KEY_ADMIN_IPS, list.join(','));
    }
  } catch (_) { }
}

// 记录日志（新增 ts，排序稳定；isAdmin 标记可用）
async function recordLog(env, ip, userID, ua, url, cf, isAdmin = false) {
  try {
    const ts = Date.now();
    const logKey = `${LOG_PREFIX}${ts}_${Math.random().toString(36).slice(2)}`;
    const logData = {
      ts,
      time: new Date(ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
      ip,
      loc: cf ? `${cf.country || ''}-${cf.city || ''}` : 'Unknown',
      user: userID,
      ua,
      path: `${url.pathname}${url.search}`,
      isAdmin: !!isAdmin,
    };
    await env.KV.put(logKey, JSON.stringify(logData), { expirationTtl: LOG_TTL });
  } catch (_) { }
}

async function handleAdminPanel(env, origin, TOKEN) {
  // 黑名单
  const blIP = parseCSV(await env.KV.get(KEY_BLACKLIST_IPS));
  const blID = parseCSV(await env.KV.get(KEY_BLACKLIST_IDS));

  // 管理员 IP（来自 KV 持久集合）
  const adminIPs = new Set(parseCSV(await env.KV.get(KEY_ADMIN_IPS)));

  // 取最近 100 条日志
  const list = await env.KV.list({ prefix: LOG_PREFIX, limit: 100 });

  // 并发拉取日志（避免 100 次串行 await 太慢）
  const logsRaw = await mapLimit(list.keys, 20, async (k) => {
    const val = await env.KV.get(k.name);
    if (!val) return null;
    try {
      const obj = JSON.parse(val);
      // 有些旧日志可能没有 ts
      if (typeof obj.ts !== 'number') obj.ts = Date.parse(obj.time) || 0;
      // 有 isAdmin 标记的也加入 adminIPs
      if (obj.isAdmin && obj.ip) adminIPs.add(obj.ip);
      return obj;
    } catch (_) {
      return null;
    }
  });

  const logs = logsRaw.filter(Boolean).sort((a, b) => (b.ts || 0) - (a.ts || 0));

  // 多 IP 检测（排除管理员 IP）
  const userIpMap = new Map();
  for (const l of logs) {
    if (!l.user || l.user === 'default' || l.user === '__admin__') continue;
    if (adminIPs.has(l.ip)) continue;

    if (!userIpMap.has(l.user)) userIpMap.set(l.user, new Set());
    userIpMap.get(l.user).add(l.ip);
  }

  const multiIpUsers = [...userIpMap.entries()]
    .filter(([_, ips]) => ips.size > 1)
    .map(([u, ips]) => ({ user: u, count: ips.size, ips: [...ips] }));

  const safeOrigin = escapeHtml(origin);
  const safeToken = escapeHtml(TOKEN);

  return new Response(`
<!DOCTYPE html><html><head><title>管理后台</title><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body{font-family:'Segoe UI',system-ui;background:#f4f7f9;padding:20px;color:#333}
  .card{background:white;padding:25px;border-radius:12px;box-shadow:0 4px 6px rgba(0,0,0,0.05);max-width:1200px;margin:auto;margin-bottom:20px;}
  table{width:100%;border-collapse:collapse;margin-top:15px}
  th,td{padding:12px;border-bottom:1px solid #eee;text-align:left;font-size:14px;vertical-align:top;}
  th{background:#f8f9fa;color:#495057;font-weight:600}
  .btn{padding:6px 12px;border:none;border-radius:4px;color:white;cursor:pointer;font-size:12px;margin-right:5px;transition:0.2s}
  .btn:hover{opacity:0.9}
  .block{background:#e74c3c}.unblock{background:#2ecc71}
  .input-group {display:flex; gap:10px; margin-top:10px; align-items:center;}
  input, select {padding: 10px; border:1px solid #ddd; border-radius:6px; outline:none;}
  .tag{padding:3px 8px;border-radius:4px;font-size:11px;background:#e9ecef;color:#495057;font-weight:500}
  .b-tag{background:#e74c3c;color:white}
  .warn-card {border-left: 5px solid #f1c40f;}
  .warn-title {color:#d35400;font-weight:bold;display:flex;align-items:center;gap:8px;font-size:18px;}
  .ip-item { display:flex; align-items:center; gap:8px; margin-bottom:6px; }
  .ban-icon { cursor:pointer; color:#e74c3c; font-size:12px; text-decoration:none; border:1px solid #e74c3c; padding:0 6px; border-radius:3px; }
  .ban-icon:hover { background:#e74c3c; color:white; }
  .search-box { width: 100%; padding: 10px; margin-bottom: 15px; border: 2px solid #eee; border-radius: 8px; font-size: 14px; }
  .search-box:focus { border-color: #3498db; }
  code{background:#f1f3f5;padding:2px 6px;border-radius:6px}
</style></head>
<body>

<div class="card">
  <h2 style="margin:0 0 10px 0;">✅ 后台入口（修复版）</h2>
  <div style="font-size:13px;color:#666;line-height:1.8">
    <div>如果你只绑定了 <code>/${safeToken}*</code> 路由，请用这个（必进）：<br>
      <code>${safeOrigin}/${safeToken}/admin_panel?p=你的后台密码</code>
    </div>
    <div style="margin-top:8px;">
      如果你给 Worker 额外加了路由 <code>/admin_panel*</code>，也可以继续用老地址：<br>
      <code>${safeOrigin}/admin_panel?p=你的后台密码</code>
    </div>
    <div style="margin-top:8px;">
      探活：<code>${safeOrigin}/${safeToken}/_ping</code> 或 <code>${safeOrigin}/_ping</code>（看你路由覆盖范围）
    </div>
  </div>
</div>

<div class="card">
  <input type="text" id="searchInput" onkeyup="searchTable()" class="search-box" placeholder="🔍 搜索用户ID、IP地址或客户端...">
</div>

${multiIpUsers.length > 0 ? `
<div class="card warn-card">
  <h2 class="warn-title">⚠️ 异常检测：发现一号多用</h2>
  <p style="color:#666;font-size:13px">以下 ID 在记录中使用了多个不同的 IP 地址（管理员IP已自动排除）。</p>
  <table id="multiTable">
    <thead><tr><th>用户ID</th><th>IP数量</th><th>使用过的IP (点击封禁)</th><th>账号操作</th></tr></thead>
    <tbody>
      ${multiIpUsers.map(m => `
      <tr style="background:#fff9e6">
        <td style="font-weight:bold;color:#d35400">${escapeHtml(m.user)}</td>
        <td style="font-weight:bold;color:#e74c3c">${m.count} 个</td>
        <td style="font-size:12px;color:#666">
          ${m.ips.map(ip => `
            <div class="ip-item">
              <span>${escapeHtml(ip)}</span>
              ${!blIP.includes(ip) ?
                `<a class="ban-icon" onclick="doAct('block','${escapeHtml(ip)}','ip')" title="封禁此IP">封IP</a>` :
                `<span class="tag b-tag">已封</span>`}
            </div>
          `).join('')}
        </td>
        <td>
          ${!blID.includes(m.user) ?
            `<button class="btn block" onclick="doAct('block','${escapeHtml(m.user)}','id')">封禁账号</button>` :
            `<span class="tag b-tag">账号已封</span>`}
        </td>
      </tr>
      `).join('')}
    </tbody>
  </table>
</div>` : ''}

<div class="card">
  <h2>🔨 手动封禁 / 解封</h2>
  <div class="input-group">
    <input type="text" id="manualVal" placeholder="输入 ID 或 IP" style="flex:1">
    <select id="manualType">
      <option value="id">用户ID</option>
      <option value="ip">IP地址</option>
    </select>
    <button class="btn block" onclick="manualAct('block')">⛔ 封禁</button>
    <button class="btn unblock" onclick="manualAct('unblock')">✅ 解封</button>
  </div>
  <div style="margin-top:15px; font-size:12px; color:#666;">
    <strong>当前封禁ID:</strong> ${blID.filter(Boolean).map(escapeHtml).join(', ') || '无'}<br>
    <strong>当前封禁IP:</strong> ${blIP.filter(Boolean).map(escapeHtml).join(', ') || '无'}
  </div>
</div>

<div class="card">
  <h2>📊 审计日志 (最近100条)</h2>
  <table id="logTable">
    <thead><tr><th>时间</th><th>用户ID</th><th>IP地址</th><th>客户端UA</th><th>快捷操作</th></tr></thead>
    <tbody>
      ${logs.map(l => {
        const isBlockID = blID.includes(l.user);
        const isBlockIP = blIP.includes(l.ip);
        const isAdminIP = adminIPs.has(l.ip);

        const timeStr = escapeHtml((l.time || '').split(' ')[1] || (l.time || ''));
        const userStr = escapeHtml(l.user || '');
        const ipStr = escapeHtml(l.ip || '');
        const locStr = escapeHtml(l.loc || '');
        const uaStr = escapeHtml(l.ua || '');

        const canOperateUser = l.user && l.user !== 'default' && l.user !== '__admin__';
        const canOperateIP = l.ip && !isAdminIP;

        return `<tr>
          <td>${timeStr}</td>
          <td><span class="${isBlockID ? 'tag b-tag' : 'tag'}">${userStr}</span></td>
          <td>
            ${ipStr}
            ${isAdminIP ? '<span class="tag" style="background:#2ecc71;color:white;margin-left:6px">Admin</span>' : ''}
            <br><span style="font-size:10px;color:#999">${locStr}</span>
          </td>
          <td style="font-size:11px;color:#666;max-width:260px;overflow:hidden;text-overflow:ellipsis;" title="${uaStr}">${uaStr}</td>
          <td>
            ${canOperateUser ? (
              isBlockID
                ? `<button class="btn unblock" onclick="doAct('unblock','${userStr}','id')">解ID</button>`
                : `<button class="btn block" onclick="doAct('block','${userStr}','id')">封ID</button>`
            ) : ''}
            ${canOperateIP ? (
              isBlockIP
                ? `<button class="btn unblock" onclick="doAct('unblock','${ipStr}','ip')">解IP</button>`
                : `<button class="btn block" onclick="doAct('block','${ipStr}','ip')">封IP</button>`
            ) : ''}
          </td>
        </tr>`;
      }).join('')}
    </tbody>
  </table>
</div>

<script>
async function doAct(act, val, type){
  if(confirm('确定对 ['+val+'] 执行 ['+act+'] 吗?')){
    const u=new URL(window.location.href);
    u.searchParams.set('action',act);
    u.searchParams.set('val',val);
    u.searchParams.set('type',type);
    await fetch(u, { cache: 'no-store' });
    location.reload();
  }
}
async function manualAct(act) {
  const val = document.getElementById('manualVal').value.trim();
  const type = document.getElementById('manualType').value;
  if(!val) return alert('请输入内容！');
  await doAct(act, val, type);
}
function searchTable() {
  const input = document.getElementById("searchInput");
  const filter = input.value.toUpperCase();
  const tables = [document.getElementById("logTable"), document.getElementById("multiTable")];
  tables.forEach(function(table) {
    if (!table) return;
    const tr = table.getElementsByTagName("tr");
    for (let i = 0; i < tr.length; i++) {
      if (tr[i].getElementsByTagName("th").length > 0) continue;
      let found = false;
      const tds = tr[i].getElementsByTagName("td");
      for (let j = 0; j < tds.length; j++) {
        const txtValue = (tds[j].textContent || tds[j].innerText || "");
        if (txtValue.toUpperCase().indexOf(filter) > -1) { found = true; break; }
      }
      tr[i].style.display = found ? "" : "none";
    }
  });
}
</script>

</body></html>
  `, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const current = idx++;
      if (current >= items.length) break;
      try {
        results[current] = await fn(items[current], current);
      } catch (_) {
        results[current] = null;
      }
    }
  });
  await Promise.all(workers);
  return results;
}

async function getSUB(api, extraUA, userAgentHeader) {
  let newapi = [];
  let subURLs = "";
  try {
    const responses = await Promise.allSettled(
      api.map(url =>
        fetch(url, { headers: { "User-Agent": `v2rayN/6.45 ${extraUA}(${userAgentHeader})` } })
          .then(r => (r.ok ? r.text() : ""))
      )
    );
    for (const [i, r] of responses.entries()) {
      if (r.status === 'fulfilled' && r.value) {
        if (r.value.includes('proxies:')) subURLs += "|" + api[i];
        else newapi.push(r.value.includes('://') ? r.value : safeBase64Decode(r.value));
      }
    }
  } catch (_) { }
  return [newapi, subURLs];
}

function safeBase64Decode(str) {
  try {
    str = (str || '').replace(/\s/g, '');
    if (str.length % 4 !== 0) str += "=".repeat(4 - (str.length % 4));
    return decodeURIComponent(escape(atob(str)));
  } catch (_) { return str; }
}
function safeBase64Encode(str) {
  try { return btoa(unescape(encodeURIComponent(str))); } catch (_) { return ""; }
}

// Cloudflare Workers 某些环境支持 crypto.subtle.digest('MD5')，这里保持你的原逻辑
async function MD5HEX(text) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('MD5', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function ADD(envadd) {
  return (envadd || "").split(/[	"'|\r\n]+/).filter(x => x.trim() !== "");
}
function clashFix(content) {
  return (content || "").replace(/mtu: 1280, udp: true/g, 'mtu: 1280, remote-dns-resolve: true, udp: true');
}
async function nginx() {
  return `<h1>Welcome</h1>`;
}

// 节点编辑器
async function KVEditor(request, env, txt, mytoken) {
  const url = new URL(request.url);
  if (request.method === "POST") {
    await env.KV.put(txt, await request.text());
    return new Response("保存成功", { headers: { 'cache-control': 'no-store' } });
  }
  const content = await env.KV.get(txt) || '';
  return new Response(`<!DOCTYPE html><html><head><meta charset="utf-8"></head>
  <body style="padding:20px;">
    <h2>节点编辑</h2>
    <p>订阅地址: <code>https://${escapeHtml(url.hostname)}/${escapeHtml(mytoken)}</code></p>
    <textarea id="c" style="width:100%;height:400px;border:1px solid #ccc;padding:10px;">${escapeHtml(content)}</textarea><br>
    <button onclick="save()" style="padding:10px 20px;background:#28a745;color:white;border:none;cursor:pointer;">保存配置</button>
    <script>
      function save(){
        fetch(window.location.href,{method:'POST',body:document.getElementById('c').value})
          .then(r=>r.text()).then(t=>alert(t));
      }
    </script>
  </body></html>`, { headers: { "Content-Type": "text/html; charset=utf-8", 'cache-control': 'no-store' } });
}
