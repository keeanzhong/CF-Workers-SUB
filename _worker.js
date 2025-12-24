/**
 * CF-Workers-SUB 旗舰管理版 (修复+增强版)
 * 1. 还原：完全保留原版订阅处理逻辑，确保节点正常显示。
 * 2. 修复：解决 env is not defined 部署报错。
 * 3. 新增：搜索、管理员豁免、双重封禁。
 */

// --- 静态默认配置 (这里不读 env，防止报错) ---
const DEFAULTS = {
    mytoken: 'auto',
    adminPassword: 'zyk20031230',
    FileName: 'CF-Workers-SUB',
    SUBUpdateTime: 6,
    total: 99,
    timestamp: 4102329600000,
    MainData: `https://cfxr.eu.org/getSub`,
    subConverter: "SUBAPI.cmliussss.net",
    subConfig: "https://raw.githubusercontent.com/cmliu/ACL4SSR/main/Clash/config/ACL4SSR_Online_MultiCountry.ini",
    subProtocol: 'https'
};

export default {
    async fetch(request, env, ctx) {
        try {
            // =========================================================
            // 1. 变量初始化 (必须在 fetch 内部读取 env)
            // =========================================================
            let mytoken = env.TOKEN || DEFAULTS.mytoken;
            let adminPassword = env.ADMIN_PWD || DEFAULTS.adminPassword;
            let FileName = env.SUBNAME || DEFAULTS.FileName;
            let MainData = env.LINK || DEFAULTS.MainData;
            let subConverter = env.SUBAPI || DEFAULTS.subConverter;
            let subConfig = env.SUBCONFIG || DEFAULTS.subConfig;
            let subProtocol = DEFAULTS.subProtocol;
            
            const KV = env.KV; // 你的 KV 绑定
            const url = new URL(request.url);
            const clientIP = request.headers.get('CF-Connecting-IP') || '0.0.0.0';
            const userAgent = (request.headers.get('User-Agent') || "Unknown").toLowerCase();
            const userID = url.searchParams.get('id') || url.searchParams.get('user') || 'default';

            // =========================================================
            // 2. 检查 KV (防止报错)
            // =========================================================
            if (!KV && url.pathname === '/admin_panel') {
                return new Response(`配置错误：未找到 KV 绑定。请在后台 Variables 绑定 KV 命名空间，变量名必须为 KV`, { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
            }

            // =========================================================
            // 3. 黑名单拦截
            // =========================================================
            if (KV) {
                const blIP = (await KV.get('BLACKLIST_IPS') || "").split(',');
                if (blIP.includes(clientIP)) return new Response('Access Denied (IP Blocked).', { status: 403 });
                const blID = (await KV.get('BLACKLIST_IDS') || "").split(',');
                if (userID !== 'default' && blID.includes(userID)) return new Response('Access Denied (User Blocked).', { status: 403 });
            }

            // =========================================================
            // 4. 后台管理 API
            // =========================================================
            if (url.pathname === '/admin_panel') {
                const pwd = url.searchParams.get('p');
                if (pwd !== adminPassword) return new Response('Unauthorized', { status: 401 });

                const act = url.searchParams.get('action');
                const val = url.searchParams.get('val');
                const type = url.searchParams.get('type');

                if (act && val && KV) {
                    const key = type === 'id' ? 'BLACKLIST_IDS' : 'BLACKLIST_IPS';
                    let list = (await KV.get(key) || "").split(',').filter(x => x);

                    if (act === 'block') {
                        if (!list.includes(val)) list.push(val);
                    } else if (act === 'unblock') {
                        list = list.filter(x => x !== val);
                    }

                    await KV.put(key, list.join(','));
                    return new Response('Success');
                }
                // 渲染后台页面
                return await handleAdminPanel(KV);
            }

            // =========================================================
            // 5. 核心业务逻辑 (保留原版订阅处理)
            // =========================================================
            
            // Token 计算
            const token = url.searchParams.get('token');
            const fakeToken = await MD5MD5(`${mytoken}${Math.ceil(new Date().setHours(0, 0, 0, 0) / 1000)}`);
            const guestToken = env.GUESTTOKEN || await MD5MD5(mytoken);
            const isValidRequest = [mytoken, fakeToken, guestToken].includes(token) || url.pathname == ("/" + mytoken);

            // 强制审计日志
            if (isValidRequest && KV) {
                if (ctx && ctx.waitUntil) {
                    ctx.waitUntil(recordLog(KV, clientIP, userID, userAgent, url, request.cf));
                }
            }

            // 处理请求
            if (!isValidRequest) {
                // 如果没有 Token，跳转或显示首页
                if (env.URL302) return Response.redirect(env.URL302, 302);
                return new Response(await nginx(), { status: 200, headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
            } else {
                // 1. 如果是浏览器直接访问，进入简易编辑器
                if (KV && userAgent.includes('mozilla') && !url.search) {
                    return await KVPage(request, KV, 'LINK.txt', mytoken);
                }

                // 2. 获取并处理订阅数据 (核心逻辑，保留原版)
                let finalData = (KV ? await KV.get('LINK.txt') : env.LINK) || MainData;
                let links = await ADD(finalData); // 调用原版 ADD 函数
                
                let v2rayNodes = ""; 
                let subLinks = [];
                for (let x of links) {
                    if (x.toLowerCase().startsWith('http')) subLinks.push(x);
                    else v2rayNodes += x + '\n';
                }

                let remoteNodes = "";
                let subConverterURLPart = "";
                if (subLinks.length > 0) {
                    const subResult = await getSUB(subLinks, request, "v2rayn", userAgent);
                    remoteNodes = subResult[0].join('\n');
                    subConverterURLPart = subResult[1];
                }

                let totalContent = v2rayNodes + remoteNodes;
                
                // 格式转换 (Clash / Singbox / Base64)
                let format = url.searchParams.has('clash') || userAgent.includes('clash') ? 'clash' :
                             (url.searchParams.has('sb') || userAgent.includes('sing-box') ? 'singbox' : 'base64');

                let responseContent = "";
                if (format === 'base64') {
                    responseContent = safeBase64Encode(totalContent);
                } else {
                    let subURL = `${url.origin}/sub?token=${fakeToken}|${subConverterURLPart}`;
                    let convertUrl = `${subProtocol}://${subConverter}/sub?target=${format}&url=${encodeURIComponent(subURL)}&insert=false&config=${encodeURIComponent(subConfig)}&emoji=true&list=false&tfo=false&scv=true&fdn=false&sort=false&new_name=true`;
                    
                    try {
                        const subResp = await fetch(convertUrl, { headers: { 'User-Agent': userAgent } });
                        if (subResp.ok) {
                            responseContent = await subResp.text();
                            if (format === 'clash') responseContent = clashFix(responseContent);
                        } else {
                            // 转换失败回退到 Base64
                            responseContent = safeBase64Encode(totalContent);
                        }
                    } catch (e) {
                        responseContent = safeBase64Encode(totalContent);
                    }
                }

                return new Response(responseContent, {
                    headers: {
                        "content-type": "text/plain; charset=utf-8",
                        "Profile-Update-Interval": `${DEFAULTS.SUBUpdateTime}`,
                        "Subscription-Userinfo": `upload=0; download=0; total=${DEFAULTS.total * 1073741824}; expire=${DEFAULTS.timestamp / 1000}`,
                        "Cache-Control": "no-store, no-cache, must-revalidate",
                    }
                });
            }

        } catch (e) {
            return new Response(`Worker Error: ${e.message}\nStack: ${e.stack}`, { status: 200 }); // 返回200防止522
        }
    }
};

// =========================================================
// 辅助函数 (完整保留)
// =========================================================

async function recordLog(KV, ip, userID, ua, url, cf) {
    try {
        const logKey = `LOG_${Date.now()}_${Math.random().toString(36).substring(7)}`;
        const logData = {
            time: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
            ip: ip, loc: cf ? `${cf.country || ''}-${cf.city || ''}` : 'Unknown',
            user: userID, ua: ua, path: url.pathname + url.search
        };
        await KV.put(logKey, JSON.stringify(logData), { expirationTtl: 604800 });
    } catch (e) {}
}

async function handleAdminPanel(KV) {
    const list = await KV.list({ prefix: 'LOG_', limit: 100 });
    const blIP = (await KV.get('BLACKLIST_IPS') || "").split(',');
    const blID = (await KV.get('BLACKLIST_IDS') || "").split(',');

    let logs = [];
    let adminIPs = new Set(); 

    // 获取日志并识别管理员
    for (const key of list.keys) {
        const val = await KV.get(key.name);
        if (val) {
            const log = JSON.parse(val);
            logs.push(log);
            // 只要访问过后台，自动标记为管理员
            if (log.path && log.path.includes('/admin_panel')) {
                adminIPs.add(log.ip);
            }
        }
    }
    logs.sort((a, b) => new Date(b.time) - new Date(a.time));

    // 分析一号多用 (排除管理员IP)
    const userIpMap = {};
    logs.forEach(l => {
        if (l.user && l.user !== 'default' && !adminIPs.has(l.ip)) {
            if (!userIpMap[l.user]) userIpMap[l.user] = new Set();
            userIpMap[l.user].add(l.ip);
        }
    });

    const multiIpUsers = Object.entries(userIpMap)
        .filter(([_, ips]) => ips.size > 1)
        .map(([u, ips]) => ({ user: u, count: ips.size, ips: Array.from(ips) }));

    const html = `
    <!DOCTYPE html><html><head><title>Admin Panel</title><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        body{font-family:sans-serif;background:#f4f7f9;padding:20px;color:#333;font-size:14px;}
        .card{background:white;padding:20px;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,0.1);margin-bottom:20px;}
        h3{margin:0 0 15px 0;border-bottom:1px solid #eee;padding-bottom:10px;color:#444;}
        table{width:100%;border-collapse:collapse;}
        th,td{padding:10px;border-bottom:1px solid #eee;text-align:left;}
        th{background:#fafafa;font-weight:600;}
        input,select{padding:8px;border:1px solid #ddd;border-radius:4px;box-sizing:border-box;}
        .search-box{width:100%;margin-bottom:15px;}
        .btn{padding:5px 10px;border:none;border-radius:4px;color:white;cursor:pointer;margin-right:5px;}
        .block{background:#ff4d4f}.unblock{background:#52c41a}
        .tag{padding:2px 6px;border-radius:4px;font-size:11px;background:#f0f0f0;color:#666;}
        .b-tag{background:#fff1f0;color:#cf1322;border:1px solid #ffa39e;}
        .a-tag{background:#f6ffed;color:#389e0d;border:1px solid #b7eb8f;}
        .warn{color:#d46b08;font-weight:bold;}
        .ip-ban-btn{color:#ff4d4f;cursor:pointer;margin-left:5px;font-weight:bold;text-decoration:none;}
        .ip-ban-btn:hover{text-decoration:underline;}
    </style></head>
    <body><div style="max-width:1200px;margin:auto;">
        
        <div class="card">
            <h3>🔍 搜索与控制</h3>
            <input type="text" id="searchInput" class="search-box" onkeyup="searchTable()" placeholder="输入 ID 或 IP 筛选...">
            <div style="display:flex;gap:10px;">
                <input type="text" id="manualVal" placeholder="ID 或 IP" style="padding:8px;border:1px solid #ddd;border-radius:4px;flex:1;">
                <select id="manualType" style="padding:8px;border:1px solid #ddd;border-radius:4px;">
                    <option value="id">用户ID</option><option value="ip">IP地址</option>
                </select>
                <button class="btn block" onclick="act('block')">⛔ 封禁</button>
                <button class="btn unblock" onclick="act('unblock')">✅ 解封</button>
            </div>
            <p style="font-size:12px;color:#999;margin-bottom:0;">当前黑名单: ID(${blID.length}) / IP(${blIP.length})</p>
        </div>

        ${multiIpUsers.length > 0 ? `
        <div class="card" style="border-left:4px solid #faad14;">
            <h3 style="margin-top:0;color:#d46b08;">⚠️ 一号多用检测 (已自动豁免管理员)</h3>
            <table id="multiTable">
                <thead><tr><th>用户ID</th><th>IP数</th><th>关联IP (点击红色IP封禁)</th><th>账号操作</th></tr></thead>
                <tbody>
                    ${multiIpUsers.map(m => `
                    <tr>
                        <td class="warn">${m.user}</td>
                        <td><span class="tag b-tag">${m.count}</span></td>
                        <td>
                            ${m.ips.map(ip => `
                                <div style="margin:2px 0;">
                                    ${ip} 
                                    ${!blIP.includes(ip) ? 
                                    `<span class="ip-ban-btn" onclick="doAct('block','${ip}','ip')">❌封IP</span>` : 
                                    `<span class="tag b-tag">已封</span>`}
                                </div>
                            `).join('')}
                        </td>
                        <td>
                            ${!blID.includes(m.user) ? 
                            `<button class="btn block" onclick="doAct('block','${m.user}','id')">封号</button>` : 
                            `<span class="tag b-tag">已封号</span>`}
                        </td>
                    </tr>`).join('')}
                </tbody>
            </table>
        </div>` : ''}

        <div class="card">
            <h3 style="margin-top:0;">📊 访问日志</h3>
            <table id="logTable">
                <thead><tr><th>时间</th><th>用户ID</th><th>IP / 归属</th><th>UA</th><th>操作</th></tr></thead>
                <tbody>${logs.map(l => {
                    const isBanID = blID.includes(l.user);
                    const isBanIP = blIP.includes(l.ip);
                    const isAdmin = adminIPs.has(l.ip);
                    return `<tr>
                        <td>${l.time.split(' ')[1]}</td>
                        <td><span class="${isBanID?'tag b-tag':'tag'}">${l.user}</span></td>
                        <td>
                            ${l.ip} ${isAdmin?'<span class="tag a-tag">Admin</span>':''}
                            <div style="font-size:11px;color:#999">${l.loc}</div>
                        </td>
                        <td style="font-size:11px;color:#888;max-width:200px;overflow:hidden;text-overflow:ellipsis" title="${l.ua}">${l.ua}</td>
                        <td>
                            ${l.user!=='default'&&!isBanID ? `<button class="btn block" onclick="doAct('block','${l.user}','id')">封ID</button>` : ''}
                            ${!isAdmin&&!isBanIP ? `<button class="btn block" onclick="doAct('block','${l.ip}','ip')">封IP</button>` : ''}
                            ${isBanID||isBanIP ? `<button class="btn unblock" onclick="location.reload()">刷新</button>` : ''}
                        </td>
                    </tr>`
                }).join('')}</tbody>
            </table>
        </div>
    </div>
    <script>
    async function doAct(a,v,t){if(confirm('确认对 ['+v+'] 执行 ['+a+']?')){await fetch('?action='+a+'&val='+v+'&type='+t);location.reload();}}
    function act(a){const v=document.getElementById('manualVal').value,t=document.getElementById('manualType').value;if(v)doAct(a,v,t);}
    function searchTable(){
        const filter=document.getElementById('searchInput').value.toUpperCase();
        ['logTable','multiTable'].forEach(id=>{
            const t=document.getElementById(id);
            if(t){
                const tr=t.getElementsByTagName('tr');
                for(let i=1;i<tr.length;i++){
                    const txt=tr[i].textContent||tr[i].innerText;
                    tr[i].style.display=txt.toUpperCase().indexOf(filter)>-1?'':'none';
                }
            }
        });
    }
    </script></body></html>`;
    return new Response(html, { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
}

// ------------------------------------------
// 原版核心工具函数 (确保节点生成逻辑不变)
// ------------------------------------------

async function getSUB(api, request, 追加UA, userAgentHeader) {
    let newapi = []; let subURLs = "";
    try {
        const responses = await Promise.allSettled(api.map(url => fetch(url, { headers: { "User-Agent": `v2rayN/6.45 ${追加UA}(${userAgentHeader})` } }).then(r => r.ok ? r.text() : "")));
        for (const [i, r] of responses.entries()) {
            if (r.status === 'fulfilled' && r.value) {
                if (r.value.includes('proxies:')) subURLs += "|" + api[i];
                else newapi.push(r.value.includes('://') ? r.value : safeBase64Decode(r.value));
            }
        }
    } catch(e) {}
    return [newapi, subURLs];
}
function safeBase64Decode(str) { try { str=str.replace(/\s/g,''); if(str.length%4!==0)str+="=".repeat(4-(str.length%4)); return decodeURIComponent(escape(atob(str))); } catch(e){return str;} }
function safeBase64Encode(str) { try { return btoa(unescape(encodeURIComponent(str))); } catch(e) { return ""; } }
async function MD5MD5(text) { const data = new TextEncoder().encode(text); const hash = await crypto.subtle.digest('MD5', data); return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join(''); }
async function ADD(envadd) { return (envadd || "").split(/[	"'|\r\n]+/).filter(x => x.trim() !== ""); }
function clashFix(content) { return content.replace(/mtu: 1280, udp: true/g, 'mtu: 1280, remote-dns-resolve: true, udp: true'); }
async function nginx() { return `<h1>Welcome to nginx!</h1>`; }
async function KVPage(request, KV, txt, mytoken) {
    const url = new URL(request.url);
    if (request.method === "POST") { await KV.put(txt, await request.text()); return new Response("保存成功"); }
    let content = await KV.get(txt) || '';
    return new Response(`<!DOCTYPE html><html><body style="padding:20px;"><h2>节点编辑</h2><p>订阅: <code>${url.origin}/${mytoken}</code></p><textarea id="c" style="width:100%;height:400px;">${content}</textarea><br><button onclick="save()">保存</button><script>function save(){fetch(window.location.href,{method:'POST',body:document.getElementById('c').value}).then(r=>r.text()).then(t=>alert(t));}</script></body></html>`, { headers: { "Content-Type": "text/html;charset=utf-8" } });
}
