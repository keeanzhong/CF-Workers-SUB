/**
 * CF-Workers-SUB 旗舰管理版 (修复+功能增强版)
 * 核心功能：订阅管理、节点转换
 * 新增功能：
 * 1. 后台搜索 (ID/IP)
 * 2. 一号多用检测 (管理员IP自动豁免)
 * 3. 异常检测列表中支持 [封IP] 和 [封号]
 * 4. 修复 env 启动报错
 */

// --- 基础静态配置 (默认值) ---
const DEFAULT_CONFIG = {
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
            // 1. 变量初始化 (必须在 fetch 内部读取，修复 522/1101 报错)
            // =========================================================
            // 优先读取环境变量，没有则使用上面定义的默认值
            let mytoken = env.TOKEN || DEFAULT_CONFIG.mytoken;
            let adminPassword = env.ADMIN_PWD || DEFAULT_CONFIG.adminPassword;
            let FileName = env.SUBNAME || DEFAULT_CONFIG.FileName;
            let MainData = env.LINK || DEFAULT_CONFIG.MainData;
            let subConverter = env.SUBAPI || DEFAULT_CONFIG.subConverter;
            let subConfig = env.SUBCONFIG || DEFAULT_CONFIG.subConfig;
            let subProtocol = DEFAULT_CONFIG.subProtocol;
            
            // TG 推送配置
            let BotToken = env.TGTOKEN || '';
            let ChatID = env.TGID || '';
            let TG = env.TG || 0;

            const url = new URL(request.url);
            const clientIP = request.headers.get('CF-Connecting-IP') || '0.0.0.0';
            const userAgentHeader = request.headers.get('User-Agent') || "Unknown";
            const userAgent = userAgentHeader.toLowerCase();
            const userID = url.searchParams.get('id') || url.searchParams.get('user') || 'default';

            // =========================================================
            // 2. 检查 KV 绑定
            // =========================================================
            if (!env.KV && url.pathname === '/admin_panel') {
                return new Response(`配置错误：未找到 KV 绑定。请在后台 Settings -> Variables 绑定 KV 命名空间，变量名必须为 KV`, { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
            }

            // =========================================================
            // 3. 黑名单拦截 (极速)
            // =========================================================
            if (env.KV) {
                const blIP = (await env.KV.get('BLACKLIST_IPS') || "").split(',');
                if (blIP.includes(clientIP)) return new Response('Access Denied (IP Blocked).', { status: 403 });
                const blID = (await env.KV.get('BLACKLIST_IDS') || "").split(',');
                if (userID !== 'default' && blID.includes(userID)) return new Response('Access Denied (User Blocked).', { status: 403 });
            }

            // =========================================================
            // 4. 后台管理 API (处理封禁/解封请求)
            // =========================================================
            if (url.pathname === '/admin_panel') {
                const pwd = url.searchParams.get('p');
                if (pwd !== adminPassword) return new Response('Unauthorized', { status: 401 });
                
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
                // 渲染带有新功能的后台页面
                return await handleAdminPanel(env);
            }

            // =========================================================
            // 5. Token 计算与验证
            // =========================================================
            const token = url.searchParams.get('token');
            const fakeToken = await MD5MD5(`${mytoken}${Math.ceil(new Date().setHours(0,0,0,0) / 1000)}`);
            const guestToken = env.GUESTTOKEN || await MD5MD5(mytoken);
            const isValidRequest = [mytoken, fakeToken, guestToken].includes(token) || url.pathname == ("/" + mytoken);

            // =========================================================
            // 6. 强制审计日志 (不阻塞主线程)
            // =========================================================
            if (isValidRequest && env.KV) {
                if (ctx && ctx.waitUntil) {
                    ctx.waitUntil(recordLog(env, clientIP, userID, userAgentHeader, url, request.cf));
                }
            }

            // =========================================================
            // 7. 核心业务逻辑 (你原来的订阅处理代码)
            // =========================================================
            if (!isValidRequest) {
                // 异常访问
                if (TG == 1 && url.pathname !== "/" && url.pathname !== "/favicon.ico") {
                    // await sendMessage(BotToken, ChatID, `#异常访问`, clientIP, `UA: ${userAgentHeader}\n路径: ${url.pathname}`);
                }
                if (env.URL302) return Response.redirect(env.URL302, 302);
                return new Response(await nginx(), { status: 200, headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
            } else {
                // 简易节点编辑页面 (浏览器直接访问)
                if (env.KV && userAgent.includes('mozilla') && !url.search) {
                    return await KVPage(request, env, 'LINK.txt', mytoken);
                }

                // --- 核心订阅生成逻辑 (完全保留) ---
                let finalData = (env.KV ? await env.KV.get('LINK.txt') : env.LINK) || MainData;
                let links = await ADD(finalData);
                
                let v2rayNodes = ""; 
                let subLinks = [];
                for (let x of links) {
                    if (x.toLowerCase().startsWith('http')) subLinks.push(x);
                    else v2rayNodes += x + '\n';
                }

                let remoteNodes = "";
                let subConverterURLPart = "";
                if (subLinks.length > 0) {
                    const subResult = await getSUB(subLinks, request, "v2rayn", userAgentHeader);
                    remoteNodes = subResult[0].join('\n');
                    subConverterURLPart = subResult[1];
                }

                let totalContent = v2rayNodes + remoteNodes;
                
                // 格式输出判断
                let format = url.searchParams.has('clash') || userAgent.includes('clash') ? 'clash' : 
                             (url.searchParams.has('sb') || userAgent.includes('sing-box') ? 'singbox' : 'base64');

                let responseContent = "";
                if (format === 'base64') {
                    responseContent = safeBase64Encode(totalContent);
                } else {
                    let subURL = `${url.origin}/sub?token=${fakeToken}|${subConverterURLPart}`;
                    let convertUrl = `${subProtocol}://${subConverter}/sub?target=${format}&url=${encodeURIComponent(subURL)}&insert=false&config=${encodeURIComponent(subConfig)}&emoji=true&list=false&tfo=false&scv=true&fdn=false&sort=false&new_name=true`;
                    
                    try {
                        const subResp = await fetch(convertUrl, { headers: { 'User-Agent': userAgentHeader } });
                        if(subResp.ok) {
                            responseContent = await subResp.text();
                            if (format === 'clash') responseContent = clashFix(responseContent);
                        } else {
                            responseContent = safeBase64Encode(totalContent); // 转换失败降级
                        }
                    } catch(e) {
                        responseContent = safeBase64Encode(totalContent);
                    }
                }

                return new Response(responseContent, { 
                    headers: { 
                        "content-type": "text/plain; charset=utf-8",
                        "Profile-Update-Interval": `${DEFAULT_CONFIG.SUBUpdateTime}`,
                        "Subscription-Userinfo": `upload=0; download=0; total=${DEFAULT_CONFIG.total * 1073741824}; expire=${DEFAULT_CONFIG.timestamp / 1000}`,
                        "Cache-Control": "no-store, no-cache, must-revalidate",
                    } 
                });
            }
        } catch (e) {
            return new Response(`Worker Error: ${e.message}\nStack: ${e.stack}`, { status: 500 });
        }
    }
};

// =========================================================
// 辅助函数区域 (包含后台渲染逻辑)
// =========================================================

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
    <!DOCTYPE html><html><head><title>Admin Panel</title><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        body{font-family:'Segoe UI', sans-serif;background:#f4f7f9;padding:20px;color:#333;font-size:14px;}
        .card{background:white;padding:20px;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,0.1);margin-bottom:20px;}
        h3{margin:0 0 15px 0;border-bottom:1px solid #eee;padding-bottom:10px;color:#444;}
        table{width:100%;border-collapse:collapse;margin-top:10px}
        th,td{padding:10px;border-bottom:1px solid #eee;text-align:left;}
        th{background:#fafafa;color:#666;font-weight:600;}
        tr:hover{background:#f9f9f9;}
        
        .btn{padding:5px 10px;border:none;border-radius:4px;color:white;cursor:pointer;font-size:12px;margin-right:5px;transition:0.2s;}
        .btn:hover{opacity:0.9}
        .block{background:#ff4d4f}.unblock{background:#52c41a}
        
        .tag{padding:2px 6px;border-radius:4px;font-size:11px;background:#f5f5f5;color:#666;border:1px solid #d9d9d9;}
        .b-tag{background:#fff1f0;color:#cf1322;border:1px solid #ffa39e;}
        .a-tag{background:#f6ffed;color:#389e0d;border:1px solid #b7eb8f;}
        
        .warn{color:#d46b08;font-weight:bold;}
        .ip-ban-btn{color:#ff4d4f;cursor:pointer;margin-left:5px;font-weight:bold;text-decoration:none;border:1px solid #ff4d4f;padding:0 3px;border-radius:3px;font-size:10px;}
        .ip-ban-btn:hover{background:#ff4d4f;color:white;}
        
        .search-box{width:100%;padding:10px;border:1px solid #ddd;border-radius:4px;box-sizing:border-box;margin-bottom:10px;}
        .ip-list-item{display:inline-block; margin-right:8px; margin-bottom:4px;}
    </style></head>
    <body><div style="max-width:1200px;margin:auto;">
        
        <div class="card">
            <h3>🔍 搜索与控制</h3>
            <input type="text" id="searchInput" class="search-box" onkeyup="searchTable()" placeholder="输入 ID 或 IP 实时筛选...">
            <div style="display:flex;gap:10px;margin-top:10px;">
                <input type="text" id="manualVal" placeholder="输入 ID 或 IP" style="padding:8px;border:1px solid #ddd;border-radius:4px;flex:1;">
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
            <h3 style="color:#d46b08;">⚠️ 一号多用检测 (已自动豁免管理员)</h3>
            <table id="multiTable">
                <thead><tr><th>用户ID</th><th>IP数</th><th>关联IP (点击封禁)</th><th>账号操作</th></tr></thead>
                <tbody>
                    ${multiIpUsers.map(m => `
                    <tr>
                        <td class="warn">${m.user}</td>
                        <td><span class="tag b-tag">${m.count}</span></td>
                        <td>
                            ${m.ips.map(ip => `
                                <div class="ip-list-item">
                                    ${ip} 
                                    ${!blIP.includes(ip) ? 
                                    `<span class="ip-ban-btn" onclick="doAct('block','${ip}','ip')" title="封禁此IP">封IP</span>` : 
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
            <h3>📊 访问日志</h3>
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
    </script></body></html>`, { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
}

// ---------------------------------------------------------------
// 原始功能函数 (getSUB, ADD, safeBase64... 保持不变，确保订阅正常)
// ---------------------------------------------------------------

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
async function KVPage(request, env, txt, mytoken) {
    const url = new URL(request.url);
    if (request.method === "POST") { await env.KV.put(txt, await request.text()); return new Response("保存成功"); }
    let content = await env.KV.get(txt) || '';
    return new Response(`<!DOCTYPE html><html><body style="padding:20px;"><h2>节点编辑</h2><p>订阅: <code>${url.origin}/${mytoken}</code></p><textarea id="c" style="width:100%;height:400px;">${content}</textarea><br><button onclick="save()">保存</button><script>function save(){fetch(window.location.href,{method:'POST',body:document.getElementById('c').value}).then(r=>r.text()).then(t=>alert(t));}</script></body></html>`, { headers: { "Content-Type": "text/html;charset=utf-8" } });
}
