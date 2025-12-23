/**
 * CF-Workers-SUB 最终修复版
 * 1. 修复：将 env 调用移至 fetch 内部，解决 1101/522 启动崩溃问题。
 * 2. 新增：搜索功能、管理员IP豁免、一键封禁节点IP。
 */

// --- 静态配置 (这里绝对不能出现 env) ---
const config = {
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
            // --- 1. 变量初始化 (必须在这里读取 env) ---
            const mytoken = env.TOKEN || config.mytoken;
            const adminPwd = env.ADMIN_PWD || config.adminPassword;
            const subConverter = env.SUBAPI || config.subConverter;
            const subConfig = env.SUBCONFIG || config.subConfig;
            const FileName = env.SUBNAME || config.FileName;
            const MainData = env.LINK || config.MainData;

            const url = new URL(request.url);
            const clientIP = request.headers.get('CF-Connecting-IP') || '0.0.0.0';
            const userAgent = (request.headers.get('User-Agent') || "Unknown").toLowerCase();
            const userID = url.searchParams.get('id') || url.searchParams.get('user') || 'default';

            // --- 2. 检查 KV 绑定 ---
            if (!env.KV && url.pathname === '/admin_panel') {
                return new Response(`配置错误：未找到 KV 绑定。请在后台 Variables 绑定 KV 命名空间，变量名为 KV`, { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
            }
            
            // --- 3. 黑名单拦截 ---
            if (env.KV) {
                const blIP = (await env.KV.get('BLACKLIST_IPS') || "").split(',');
                if (blIP.includes(clientIP)) return new Response('Access Denied (IP Blocked).', { status: 403 });
                const blID = (await env.KV.get('BLACKLIST_IDS') || "").split(',');
                if (userID !== 'default' && blID.includes(userID)) return new Response('Access Denied (User Blocked).', { status: 403 });
            }

            // --- 4. 后台管理 API ---
            if (url.pathname === '/admin_panel') {
                const pwd = url.searchParams.get('p');
                if (pwd !== adminPwd) return new Response('Unauthorized', { status: 401 });
                
                const act = url.searchParams.get('action');
                const val = url.searchParams.get('val');
                const type = url.searchParams.get('type');
                
                if (act && val && env.KV) {
                    const key = type === 'id' ? 'BLACKLIST_IDS' : 'BLACKLIST_IPS';
                    let list = (await env.KV.get(key) || "").split(',').filter(x => x);
                    
                    if (act === 'block') { 
                        if (!list.includes(val)) list.push(val); 
                    } else if (act === 'unblock') { 
                        list = list.filter(x => x !== val); 
                    }
                    
                    await env.KV.put(key, list.join(','));
                    return new Response('Success');
                }
                // 渲染后台页面 (传入 env)
                return await handleAdminPanel(env);
            }

            // --- 5. Token 验证 ---
            const token = url.searchParams.get('token');
            const fakeToken = await MD5MD5(`${mytoken}${Math.ceil(new Date().setHours(0,0,0,0) / 1000)}`);
            const guestToken = env.GUESTTOKEN || await MD5MD5(mytoken);
            const isValidRequest = [mytoken, fakeToken, guestToken].includes(token) || url.pathname == ("/" + mytoken);

            // --- 6. 审计日志 ---
            if (isValidRequest && env.KV) {
                if (ctx && ctx.waitUntil) {
                    ctx.waitUntil(recordLog(env, clientIP, userID, userAgent, url, request.cf));
                }
            }

            // --- 7. 核心业务 ---
            if (!isValidRequest) {
                if (env.URL302) return Response.redirect(env.URL302, 302);
                return new Response(await nginx(), { status: 200, headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
            } else {
                if (env.KV && userAgent.includes('mozilla') && !url.search) {
                    return await KV(request, env, 'LINK.txt', mytoken);
                }

                let finalData = (env.KV ? await env.KV.get('LINK.txt') : "") || MainData;
                let links = await ADD(finalData);
                let v2rayNodes = ""; let subLinks = [];
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
                let format = url.searchParams.has('clash') || userAgent.includes('clash') ? 'clash' : 
                             (url.searchParams.has('sb') || userAgent.includes('sing-box') ? 'singbox' : 'base64');

                let responseContent = "";
                if (format === 'base64') {
                    responseContent = safeBase64Encode(totalContent);
                } else {
                    let subURL = `${url.origin}/sub?token=${fakeToken}|${subConverterURLPart}`;
                    let convertUrl = `${config.subProtocol}://${subConverter}/sub?target=${format}&url=${encodeURIComponent(subURL)}&insert=false&config=${encodeURIComponent(subConfig)}&emoji=true&list=false&tfo=false&scv=true&fdn=false&sort=false&new_name=true`;
                    const subResp = await fetch(convertUrl, { headers: { 'User-Agent': userAgent } });
                    responseContent = await subResp.text();
                    if (format === 'clash') responseContent = clashFix(responseContent);
                }

                return new Response(responseContent, { 
                    headers: { 
                        "content-type": "text/plain; charset=utf-8",
                        "Profile-Update-Interval": `${config.SUBUpdateTime}`,
                        "Subscription-Userinfo": `upload=0; download=0; total=${config.total * 1073741824}; expire=${config.timestamp / 1000}`,
                        "Cache-Control": "no-store, no-cache, must-revalidate",
                    } 
                });
            }
        } catch (e) {
            return new Response(`Worker Error: ${e.message}`, { status: 500 });
        }
    }
};

// --- 辅助函数 ---

async function recordLog(env, ip, userID, ua, url, cf) {
    try {
        const logKey = `LOG_${Date.now()}_${Math.random().toString(36).substring(7)}`;
        const logData = {
            time: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
            ip: ip, loc: cf ? `${cf.country || ''}-${cf.city || ''}` : 'Unknown',
            user: userID, ua: ua, path: url.pathname + url.search
        };
        await env.KV.put(logKey, JSON.stringify(logData), { expirationTtl: 604800 });
    } catch(e) {}
}

async function handleAdminPanel(env) {
    const list = await env.KV.list({ prefix: 'LOG_', limit: 100 });
    const blIP = (await env.KV.get('BLACKLIST_IPS') || "").split(',');
    const blID = (await env.KV.get('BLACKLIST_IDS') || "").split(',');
    
    let logs = [];
    let adminIPs = new Set(); // 存储被识别为管理员的IP

    // 1. 获取日志并识别管理员
    for (const key of list.keys) {
        const val = await env.KV.get(key.name);
        if (val) {
            const log = JSON.parse(val);
            logs.push(log);
            // 如果访问路径包含 admin_panel，则自动标记该IP为管理员
            if (log.path && log.path.includes('/admin_panel')) {
                adminIPs.add(log.ip);
            }
        }
    }
    logs.sort((a, b) => new Date(b.time) - new Date(a.time));

    // 2. 核心逻辑：分析多IP用户 (自动排除管理员IP)
    const userIpMap = {};
    logs.forEach(l => {
        // 条件：是有效用户 + 不是默认用户 + IP不是管理员IP
        if (l.user && l.user !== 'default' && !adminIPs.has(l.ip)) {
            if (!userIpMap[l.user]) userIpMap[l.user] = new Set();
            userIpMap[l.user].add(l.ip);
        }
    });
    
    // 筛选出 IP 数 > 1 的用户
    const multiIpUsers = Object.entries(userIpMap)
        .filter(([_, ips]) => ips.size > 1)
        .map(([u, ips]) => ({ user: u, count: ips.size, ips: Array.from(ips) }));

    return new Response(`
    <!DOCTYPE html><html><head><title>管理后台</title><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        body{font-family:sans-serif;background:#f4f7f9;padding:20px;color:#333;font-size:14px;}
        .container{max-width:1200px;margin:auto;}
        .card{background:white;padding:20px;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,0.1);margin-bottom:20px;}
        h3{margin-top:0; border-bottom:1px solid #eee; padding-bottom:10px; display:flex; justify-content:space-between; align-items:center;}
        table{width:100%;border-collapse:collapse;margin-top:10px}
        th,td{padding:12px 8px;border-bottom:1px solid #f0f0f0;text-align:left;}
        th{background:#fafafa;color:#666;font-weight:600;}
        tr:hover{background:#f9f9f9;}
        
        .btn{padding:5px 10px;border:none;border-radius:4px;color:white;cursor:pointer;font-size:12px;margin-right:5px;transition:0.2s;}
        .btn:hover{opacity:0.9}
        .block{background:#ff4d4f}.unblock{background:#52c41a}.action{background:#1890ff}
        
        .tag{padding:2px 6px;border-radius:4px;font-size:11px;background:#f5f5f5;color:#666;border:1px solid #d9d9d9;}
        .b-tag{background:#fff1f0;color:#cf1322;border-color:#ffa39e;}
        .a-tag{background:#f6ffed;color:#389e0d;border-color:#b7eb8f;}
        
        .warn-card {border-left: 4px solid #faad14;}
        .search-box {width:100%; padding:10px; border:1px solid #d9d9d9; border-radius:4px; margin-bottom:10px; box-sizing:border-box;}
        
        .ip-list {display:flex; flex-wrap:wrap; gap:5px;}
        .ip-item {background:#f0f5ff; padding:2px 5px; border-radius:3px; font-size:12px; display:flex; align-items:center; gap:5px; border:1px solid #d6e4ff;}
        .ban-icon {cursor:pointer; color:#ff4d4f; font-weight:bold; font-size:14px; line-height:1; margin-left:3px;}
        .ban-icon:hover {transform:scale(1.2);}
        
        .input-group {display:flex; gap:10px;}
        input, select {padding: 8px; border:1px solid #d9d9d9; border-radius:4px;}
    </style></head>
    <body><div class="container">
    
    <div class="card">
        <h3>🔍 搜索与操作</h3>
        <input type="text" id="searchInput" class="search-box" onkeyup="searchTable()" placeholder="在此输入 ID 或 IP 进行实时筛选...">
        
        <div class="input-group" style="margin-top:15px; border-top:1px solid #eee; padding-top:15px;">
            <input type="text" id="manualVal" placeholder="输入 ID 或 IP" style="flex:1">
            <select id="manualType"><option value="id">用户ID</option><option value="ip">IP地址</option></select>
            <button class="btn block" onclick="manualAct('block')">⛔ 封禁</button>
            <button class="btn unblock" onclick="manualAct('unblock')">✅ 解封</button>
        </div>
        <div style="margin-top:10px;font-size:12px;color:#888;">
            <span class="tag b-tag">已封ID: ${blID.length}</span> 
            <span class="tag b-tag">已封IP: ${blIP.length}</span>
        </div>
    </div>

    ${multiIpUsers.length > 0 ? `
    <div class="card warn-card">
        <h3 style="color:#d46b08;">⚠️ 异常检测：一号多用 (已排除管理员)</h3>
        <table id="multiTable">
            <thead><tr><th>用户ID</th><th>IP数量</th><th>关联IP (点击❌封禁IP)</th><th>账号操作</th></tr></thead>
            <tbody>
                ${multiIpUsers.map(m => `
                <tr>
                    <td style="font-weight:bold;color:#d46b08">${m.user}</td>
                    <td><span class="tag b-tag">${m.count}</span></td>
                    <td>
                        <div class="ip-list">
                        ${m.ips.map(ip => `
                            <div class="ip-item">
                                ${ip} 
                                ${!blIP.includes(ip) ? 
                                `<span class="ban-icon" onclick="doAct('block','${ip}','ip')" title="封禁此IP">❌</span>` : 
                                `<span style="color:#cf1322;font-size:10px;">(已封)</span>`}
                            </div>
                        `).join('')}
                        </div>
                    </td>
                    <td>
                        ${!blID.includes(m.user) ? 
                        `<button class="btn block" onclick="doAct('block','${m.user}','id')">封号</button>` : 
                        `<span class="tag b-tag">已封号</span>`}
                    </td>
                </tr>
                `).join('')}
            </tbody>
        </table>
    </div>` : ''}

    <div class="card">
        <h3>📊 访问日志 (最近100条)</h3>
        <table id="logTable">
            <thead><tr><th>时间</th><th>用户ID</th><th>IP地址</th><th>客户端</th><th>操作</th></tr></thead>
            <tbody>${logs.map(l => {
                const isBlockID = blID.includes(l.user);
                const isBlockIP = blIP.includes(l.ip);
                const isAdmin = adminIPs.has(l.ip);
                return `<tr>
                    <td>${l.time.split(' ')[1]}</td>
                    <td><span class="${isBlockID?'tag b-tag':'tag'}">${l.user}</span></td>
                    <td>
                        ${l.ip} 
                        ${isAdmin?'<span class="tag a-tag">Admin</span>':''} 
                        <div style="font-size:10px;color:#999">${l.loc}</div>
                    </td>
                    <td style="font-size:11px;color:#888;max-width:200px;overflow:hidden;text-overflow:ellipsis" title="${l.ua}">${l.ua}</td>
                    <td>
                        ${l.user!=='default' ? (isBlockID ? `<button class="btn unblock" onclick="doAct('unblock','${l.user}','id')">解ID</button>`:`<button class="btn block" onclick="doAct('block','${l.user}','id')">封ID</button>`):''}
                        ${!isAdmin ? (isBlockIP ? `<button class="btn unblock" onclick="doAct('unblock','${l.ip}','ip')">解IP</button>`:`<button class="btn block" onclick="doAct('block','${l.ip}','ip')">封IP</button>`):''}
                    </td>
                </tr>`
            }).join('')}</tbody>
        </table>
    </div>
    </div>
    
    <script>
    async function doAct(act, val, type){
        if(confirm('确认操作：对 ['+val+'] 执行 ['+act+'] ?')){
            const u=new URL(window.location.href);
            u.searchParams.set('action',act);u.searchParams.set('val',val);u.searchParams.set('type',type);
            await fetch(u);location.reload();
        }
    }
    async function manualAct(act) {
        const val = document.getElementById('manualVal').value.trim();
        const type = document.getElementById('manualType').value;
        if(!val) return alert('请输入内容');
        await doAct(act, val, type);
    }
    function searchTable() {
        var input = document.getElementById("searchInput");
        var filter = input.value.toUpperCase();
        var tables = [document.getElementById("logTable"), document.getElementById("multiTable")];
        tables.forEach(table => {
            if(!table) return;
            var tr = table.getElementsByTagName("tr");
            for (var i = 1; i < tr.length; i++) {
                var txt = tr[i].textContent || tr[i].innerText;
                tr[i].style.display = txt.toUpperCase().indexOf(filter) > -1 ? "" : "none";
            }
        });
    }
    </script></body></html>`, { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
}

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
async function KV(request, env, txt, mytoken) {
    const url = new URL(request.url);
    if (request.method === "POST") { await env.KV.put(txt, await request.text()); return new Response("保存成功"); }
    let content = await env.KV.get(txt) || '';
    return new Response(`<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="padding:20px;"><h2>节点编辑</h2><p>订阅地址: <code>https://${url.hostname}/${mytoken}</code></p><textarea id="c" style="width:100%;height:400px;border:1px solid #ccc;padding:10px;">${content}</textarea><br><button onclick="save()" style="padding:10px 20px;background:#28a745;color:white;border:none;cursor:pointer;">保存配置</button><script>function save(){fetch(window.location.href,{method:'POST',body:document.getElementById('c').value}).then(r=>r.text()).then(t=>alert(t));}</script></body></html>`, { headers: { "Content-Type": "text/html;charset=utf-8" } });
}

