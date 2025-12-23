/**
 * CF-Workers-SUB 旗舰管理版 (增强版)
 * 1. 异常检测：新增“多IP使用检测”面板，自动揪出分享账号的人。
 * 2. 手动封禁：保留手动输入封禁功能。
 * 3. 搜索功能：新增日志和列表搜索。
 * 4. 管理员豁免：管理员IP不计入多IP检测。
 */

// --- 基础配置 ---
let mytoken = 'auto'; 
let adminPassword = 'zyk20031230'; // 你的后台密码
let FileName = 'CF-Workers-SUB';
let SUBUpdateTime = 6;
let total = 99; 
let timestamp = 4102329600000; 
let MainData = `https://cfxr.eu.org/getSub`; 
let subConverter = "SUBAPI.cmliussss.net"; 
let subConfig = "https://raw.githubusercontent.com/cmliu/ACL4SSR/main/Clash/config/ACL4SSR_Online_MultiCountry.ini";
let subProtocol = 'https';

export default {
    async fetch(request, env, ctx) {
        try {
            const url = new URL(request.url);
            const clientIP = request.headers.get('CF-Connecting-IP') || '0.0.0.0';
            const userAgent = (request.headers.get('User-Agent') || "Unknown").toLowerCase();
            const userID = url.searchParams.get('id') || url.searchParams.get('user') || 'default';

            // 1. 检查 KV 绑定状态
            if (!env.KV && url.pathname === '/admin_panel') {
                return new Response(`配置错误：未找到 KV 绑定，请在后台 Settings -> Variables 绑定 KV 命名空间，变量名为 KV`, { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
            }
            
            // 2. 黑名单拦截 (极速拦截)
            if (env.KV) {
                const blIP = (await env.KV.get('BLACKLIST_IPS') || "").split(',');
                if (blIP.includes(clientIP)) return new Response('Access Denied (IP Blocked).', { status: 403 });
                const blID = (await env.KV.get('BLACKLIST_IDS') || "").split(',');
                if (userID !== 'default' && blID.includes(userID)) return new Response('Access Denied (User Blocked).', { status: 403 });
            }

            // 3. 后台管理 API 处理
            if (url.pathname === '/admin_panel') {
                const pwd = url.searchParams.get('p');
                if (pwd !== (env.ADMIN_PWD || adminPassword)) return new Response('Unauthorized: Password Error', { status: 401 });
                
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
                return await handleAdminPanel(env);
            }

            // 变量初始化 (防止 env 读取错误)
            mytoken = env.TOKEN || mytoken;
            subConverter = env.SUBAPI || subConverter;
            subConfig = env.SUBCONFIG || subConfig;
            FileName = env.SUBNAME || FileName;

            const token = url.searchParams.get('token');
            const fakeToken = await MD5MD5(`${mytoken}${Math.ceil(new Date().setHours(0,0,0,0) / 1000)}`);
            const guestToken = env.GUESTTOKEN || await MD5MD5(mytoken);
            const isValidRequest = [mytoken, fakeToken, guestToken].includes(token) || url.pathname == ("/" + mytoken);

            // --- 4. 强制审计日志 ---
            if (isValidRequest && env.KV) {
                // 使用 waitUntil 防止日志写入拖慢请求响应速度
                if (ctx && ctx.waitUntil) {
                    ctx.waitUntil(recordLog(env, clientIP, userID, userAgent, url, request.cf));
                }
            }

            // 核心业务
            if (!isValidRequest) {
                // 如果没有 Token，跳转或显示伪装页
                if (env.URL302) return Response.redirect(env.URL302, 302);
                return new Response(await nginx(), { status: 200, headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
            } else {
                // 如果是浏览器访问且带有 token，进入简单的节点编辑器
                if (env.KV && userAgent.includes('mozilla') && !url.search) {
                    return await KV(request, env, 'LINK.txt', mytoken);
                }

                // 获取节点数据
                let finalData = (env.KV ? await env.KV.get('LINK.txt') : env.LINK) || MainData;
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
                    let convertUrl = `${subProtocol}://${subConverter}/sub?target=${format}&url=${encodeURIComponent(subURL)}&insert=false&config=${encodeURIComponent(subConfig)}&emoji=true&list=false&tfo=false&scv=true&fdn=false&sort=false&new_name=true`;
                    const subResp = await fetch(convertUrl, { headers: { 'User-Agent': userAgent } });
                    responseContent = await subResp.text();
                    if (format === 'clash') responseContent = clashFix(responseContent);
                }

                return new Response(responseContent, { 
                    headers: { 
                        "content-type": "text/plain; charset=utf-8",
                        "Profile-Update-Interval": `${SUBUpdateTime}`,
                        "Subscription-Userinfo": `upload=0; download=0; total=${total * 1073741824}; expire=${timestamp / 1000}`,
                        "Cache-Control": "no-store, no-cache, must-revalidate",
                    } 
                });
            }
        } catch (e) {
            return new Response(`Error: ${e.message}`, { status: 500 });
        }
    }
};

// --- 工具函数 ---
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
    let adminIPs = new Set(); // 存储管理员IP

    // 1. 获取日志并排序，同时识别管理员IP
    for (const key of list.keys) {
        const val = await env.KV.get(key.name);
        if (val) {
            const log = JSON.parse(val);
            logs.push(log);
            // 如果路径包含 admin_panel，则视为管理员IP
            if (log.path && log.path.includes('/admin_panel')) {
                adminIPs.add(log.ip);
            }
        }
    }
    logs.sort((a, b) => new Date(b.time) - new Date(a.time));

    // 2. 核心逻辑：分析多IP用户 (排除管理员IP)
    const userIpMap = {};
    logs.forEach(l => {
        // 如果是默认用户，或者该IP是管理员IP，则跳过统计
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
        body{font-family:'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;background:#f4f7f9;padding:20px;color:#333}
        .card{background:white;padding:25px;border-radius:12px;box-shadow:0 4px 6px rgba(0,0,0,0.05);max-width:1200px;margin:auto;margin-bottom:20px;}
        table{width:100%;border-collapse:collapse;margin-top:15px}
        th,td{padding:12px;border-bottom:1px solid #eee;text-align:left;font-size:14px}
        th{background:#f8f9fa;color:#495057;font-weight:600}
        .btn{padding:6px 12px;border:none;border-radius:4px;color:white;cursor:pointer;font-size:12px;margin-right:5px;transition:0.2s}
        .btn:hover{opacity:0.9}
        .block{background:#e74c3c}.unblock{background:#2ecc71}.search-btn{background:#3498db}
        .input-group {display:flex; gap:10px; margin-top:10px; align-items: center;}
        input, select {padding: 10px; border:1px solid #ddd; border-radius:6px; outline:none;}
        .tag{padding:3px 8px;border-radius:4px;font-size:11px;background:#e9ecef;color:#495057;font-weight:500}
        .b-tag{background:#e74c3c;color:white}
        .warn-card {border-left: 5px solid #f1c40f;}
        .warn-title {color: #d35400; font-weight: bold; display: flex; align-items: center; gap: 8px; font-size: 18px;}
        .ip-item { display:flex; align-items:center; gap:5px; margin-bottom:2px; }
        .ban-icon { cursor:pointer; color:#e74c3c; font-size:12px; text-decoration:none; border:1px solid #e74c3c; padding:0 4px; border-radius:3px; }
        .ban-icon:hover { background:#e74c3c; color:white; }
        
        /* 搜索框样式 */
        .search-box { width: 100%; padding: 10px; margin-bottom: 15px; border: 2px solid #eee; border-radius: 8px; font-size: 14px; }
        .search-box:focus { border-color: #3498db; }
    </style></head>
    <body>
    
    <div class="card">
         <input type="text" id="searchInput" onkeyup="searchTable()" class="search-box" placeholder="🔍 搜索用户ID、IP地址或客户端...">
    </div>

    ${multiIpUsers.length > 0 ? `
    <div class="card warn-card">
        <h2 class="warn-title">⚠️ 异常检测：发现一号多用</h2>
        <p style="color:#666;font-size:13px">以下 ID 在记录中使用了多个不同的 IP 地址 (管理员IP已自动排除)：</p>
        <table id="multiTable">
            <thead><tr><th>用户ID</th><th>IP数量</th><th>使用过的IP (点击封禁)</th><th>账号操作</th></tr></thead>
            <tbody>
                ${multiIpUsers.map(m => `
                <tr style="background:#fff9e6">
                    <td style="font-weight:bold;color:#d35400">${m.user}</td>
                    <td style="font-weight:bold;color:#e74c3c">${m.count} 个</td>
                    <td style="font-size:12px;color:#666">
                        ${m.ips.map(ip => `
                            <div class="ip-item">
                                ${ip} 
                                ${!blIP.includes(ip) ? 
                                `<a class="ban-icon" onclick="doAct('block','${ip}','ip')" title="封禁此IP">封IP</a>` : 
                                `<span class="tag b-tag">已封</span>`}
                            </div>
                        `).join('')}
                    </td>
                    <td>
                        ${!blID.includes(m.user) ? 
                        `<button class="btn block" onclick="doAct('block','${m.user}','id')">封禁账号</button>` : 
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
            <strong>当前封禁ID:</strong> ${blID.filter(x=>x).join(', ') || '无'}<br>
            <strong>当前封禁IP:</strong> ${blIP.filter(x=>x).join(', ') || '无'}
        </div>
    </div>

    <div class="card">
        <h2>📊 审计日志 (最近100条)</h2>
        <table id="logTable">
            <thead><tr><th>时间</th><th>用户ID</th><th>IP地址</th><th>客户端UA</th><th>快捷操作</th></tr></thead>
            <tbody>${logs.map(l => {
                const isBlockID = blID.includes(l.user);
                const isBlockIP = blIP.includes(l.ip);
                const isAdminIP = adminIPs.has(l.ip);
                return `<tr>
                    <td>${l.time.split(' ')[1]}</td>
                    <td><span class="${isBlockID?'tag b-tag':'tag'}">${l.user}</span></td>
                    <td>
                        ${l.ip} 
                        ${isAdminIP ? '<span class="tag" style="background:#2ecc71;color:white">Admin</span>' : ''}
                        <br><span style="font-size:10px;color:#999">${l.loc}</span>
                    </td>
                    <td style="font-size:11px;color:#666;max-width:200px;overflow:hidden;text-overflow:ellipsis;" title="${l.ua}">${l.ua}</td>
                    <td>
                        ${l.user !== 'default' ? 
                            (isBlockID ? `<button class="btn unblock" onclick="doAct('unblock','${l.user}','id')">解ID</button>` : `<button class="btn block" onclick="doAct('block','${l.user}','id')">封ID</button>`) 
                        : ''}
                        ${!isAdminIP ? (isBlockIP ? `<button class="btn unblock" onclick="doAct('unblock','${l.ip}','ip')">解IP</button>` : `<button class="btn block" onclick="doAct('block','${l.ip}','ip')">封IP</button>`) : ''}
                    </td>
                </tr>`
            }).join('')}</tbody>
        </table>
    </div>
    
    <script>
    async function doAct(act, val, type){
        if(confirm('确定对 ['+val+'] 执行 ['+act+'] 吗?')){
            const u=new URL(window.location.href);
            u.searchParams.set('action',act);u.searchParams.set('val',val);u.searchParams.set('type',type);
            await fetch(u);location.reload();
        }
    }
    async function manualAct(act) {
        const val = document.getElementById('manualVal').value.trim();
        const type = document.getElementById('manualType').value;
        if(!val) return alert('请输入内容！');
        await doAct(act, val, type);
    }
    function searchTable() {
        var input, filter, tables, tr, td, i, txtValue;
        input = document.getElementById("searchInput");
        filter = input.value.toUpperCase();
        
        // 搜索所有表格
        var tables = [document.getElementById("logTable"), document.getElementById("multiTable")];
        
        tables.forEach(function(table) {
            if (!table) return;
            tr = table.getElementsByTagName("tr");
            for (i = 0; i < tr.length; i++) {
                // 跳过表头
                if (tr[i].getElementsByTagName("th").length > 0) continue;
                
                var found = false;
                // 搜索所有列
                var tds = tr[i].getElementsByTagName("td");
                for (var j = 0; j < tds.length; j++) {
                    if (tds[j]) {
                        txtValue = tds[j].textContent || tds[j].innerText;
                        if (txtValue.toUpperCase().indexOf(filter) > -1) {
                            found = true;
                            break;
                        }
                    }
                }
                tr[i].style.display = found ? "" : "none";
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
async function nginx() { return `<h1>Welcome</h1>`; }
async function KV(request, env, txt, mytoken) {
    const url = new URL(request.url);
    if (request.method === "POST") { await env.KV.put(txt, await request.text()); return new Response("保存成功"); }
    let content = await env.KV.get(txt) || '';
    return new Response(`<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="padding:20px;"><h2>节点编辑</h2><p>订阅地址: <code>https://${url.hostname}/${mytoken}</code></p><textarea id="c" style="width:100%;height:400px;border:1px solid #ccc;padding:10px;">${content}</textarea><br><button onclick="save()" style="padding:10px 20px;background:#28a745;color:white;border:none;cursor:pointer;">保存配置</button><script>function save(){fetch(window.location.href,{method:'POST',body:document.getElementById('c').value}).then(r=>r.text()).then(t=>alert(t));}</script></body></html>`, { headers: { "Content-Type": "text/html;charset=utf-8" } });
}

