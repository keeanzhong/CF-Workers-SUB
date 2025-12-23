/**
 * CF-Workers-SUB 旗舰管理版
 * 1. 异常检测：新增“多IP使用检测”面板，自动揪出分享账号的人。
 * 2. 手动封禁：保留手动输入封禁功能。
 * 3. 强制审计：保留强制日志记录功能。
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

            // 1. 检查 KV
            if (!env.KV && url.pathname === '/admin_panel') {
                return new Response(`配置错误：未找到 KV 绑定`, { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
            }
            
            // 2. 黑名单拦截
            if (env.KV) {
                const blIP = (await env.KV.get('BLACKLIST_IPS') || "").split(',');
                if (blIP.includes(clientIP)) return new Response('Access Denied (IP Blocked).', { status: 403 });
                const blID = (await env.KV.get('BLACKLIST_IDS') || "").split(',');
                if (userID !== 'default' && blID.includes(userID)) return new Response('Access Denied (User Blocked).', { status: 403 });
            }

            // 3. 后台管理 API 处理
            if (url.pathname === '/admin_panel') {
                const pwd = url.searchParams.get('p');
                if (pwd !== (env.ADMIN_PWD || adminPassword)) return new Response('Unauthorized', { status: 401 });
                
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

            // 变量初始化
            mytoken = env.TOKEN || mytoken;
            let BotToken = env.TGTOKEN || '';
            let ChatID = env.TGID || '';
            let TG = env.TG || 0;
            subConverter = env.SUBAPI || subConverter;
            subConfig = env.SUBCONFIG || subConfig;
            FileName = env.SUBNAME || FileName;

            const token = url.searchParams.get('token');
            const fakeToken = await MD5MD5(`${mytoken}${Math.ceil(new Date().setHours(0,0,0,0) / 1000)}`);
            const guestToken = env.GUESTTOKEN || await MD5MD5(mytoken);
            const isValidRequest = [mytoken, fakeToken, guestToken].includes(token) || url.pathname == ("/" + mytoken);

            // --- 4. 强制审计日志 ---
            if (isValidRequest && env.KV) {
                const logPromise = recordLog(env, clientIP, userID, userAgent, url, request.cf);
                if (ctx && ctx.waitUntil) ctx.waitUntil(logPromise);
            }

            // 核心业务
            if (!isValidRequest) {
                if (env.URL302) return Response.redirect(env.URL302, 302);
                return new Response(await nginx(), { status: 200, headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
            } else {
                if (env.KV && userAgent.includes('mozilla') && !url.search) {
                    return await KV(request, env, 'LINK.txt', mytoken);
                }

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
    // 1. 获取日志并排序
    for (const key of list.keys) {
        const val = await env.KV.get(key.name);
        if (val) logs.push(JSON.parse(val));
    }
    logs.sort((a, b) => new Date(b.time) - new Date(a.time));

    // 2. 核心逻辑：分析多IP用户
    const userIpMap = {};
    logs.forEach(l => {
        if (l.user && l.user !== 'default') {
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
        body{font-family:sans-serif;background:#f4f7f9;padding:20px}
        .card{background:white;padding:20px;border-radius:10px;box-shadow:0 2px 8px rgba(0,0,0,0.1);max-width:1200px;margin:auto;margin-bottom:20px;}
        table{width:100%;border-collapse:collapse;margin-top:15px}
        th,td{padding:10px;border-bottom:1px solid #eee;text-align:left;font-size:13px}
        th{background:#007bff;color:white}
        .btn{padding:5px 10px;border:none;border-radius:4px;color:white;cursor:pointer;font-size:12px;margin-right:5px}
        .block{background:#dc3545}.unblock{background:#28a745}
        .input-group {display:flex; gap:10px; margin-top:10px; align-items: center;}
        input, select {padding: 8px; border:1px solid #ddd; border-radius:4px;}
        .tag{padding:2px 5px;border-radius:3px;font-size:11px;background:#e9ecef;color:#495057}.b-tag{background:#dc3545;color:white}
        .warn-card {border-left: 5px solid #ffc107;}
        .warn-title {color: #d39e00; font-weight: bold; display: flex; align-items: center; gap: 5px;}
    </style></head>
    <body>
    
    ${multiIpUsers.length > 0 ? `
    <div class="card warn-card">
        <h2 class="warn-title">⚠️ 异常检测：发现一号多用</h2>
        <p>以下 ID 在记录中使用了多个不同的 IP 地址，可能存在分享行为：</p>
        <table>
            <thead><tr><th>用户ID</th><th>IP数量</th><th>使用过的IP</th><th>操作</th></tr></thead>
            <tbody>
                ${multiIpUsers.map(m => `
                <tr style="background:#fff3cd">
                    <td style="font-weight:bold;color:#856404">${m.user}</td>
                    <td style="font-weight:bold;color:#dc3545">${m.count} 个</td>
                    <td style="font-size:11px;color:#666">${m.ips.join('<br>')}</td>
                    <td>
                        ${!blID.includes(m.user) ? 
                        `<button class="btn block" onclick="doAct('block','${m.user}','id')">立即封ID</button>` : 
                        `<span class="tag b-tag">已封禁</span>`}
                    </td>
                </tr>
                `).join('')}
            </tbody>
        </table>
    </div>` : ''}

    <div class="card">
        <h2>🔨 手动封禁 / 解封</h2>
        <div class="input-group">
            <input type="text" id="manualVal" placeholder="输入 ID (如 zhangsan) 或 IP" style="flex:1">
            <select id="manualType">
                <option value="id">封禁/解封 用户ID</option>
                <option value="ip">封禁/解封 IP地址</option>
            </select>
            <button class="btn block" onclick="manualAct('block')">⛔ 立即封禁</button>
            <button class="btn unblock" onclick="manualAct('unblock')">✅ 立即解封</button>
        </div>
        <div style="margin-top:15px; font-size:12px; color:#666;">
            <strong>当前封禁ID:</strong> ${blID.filter(x=>x).join(', ') || '无'}<br>
            <strong>当前封禁IP:</strong> ${blIP.filter(x=>x).join(', ') || '无'}
        </div>
    </div>

    <div class="card">
        <h2>📊 审计日志 (最近100条)</h2>
        <table><thead><tr><th>时间</th><th>用户ID</th><th>IP地址</th><th>客户端UA</th><th>快捷操作</th></tr></thead>
        <tbody>${logs.map(l => {
            const isBlockID = blID.includes(l.user);
            const isBlockIP = blIP.includes(l.ip);
            return `<tr>
                <td>${l.time.split(' ')[1]}</td>
                <td><span class="${isBlockID?'tag b-tag':'tag'}">${l.user}</span></td>
                <td>${l.ip} <span style="font-size:10px;color:#999">(${l.loc})</span></td>
                <td style="font-size:10px;color:#666;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${l.ua}">${l.ua}</td>
                <td>
                    ${l.user !== 'default' ? 
                        (isBlockID ? `<button class="btn unblock" onclick="doAct('unblock','${l.user}','id')">解ID</button>` : `<button class="btn block" onclick="doAct('block','${l.user}','id')">封ID</button>`) 
                    : ''}
                    ${isBlockIP ? `<button class="btn unblock" onclick="doAct('unblock','${l.ip}','ip')">解IP</button>` : `<button class="btn block" onclick="doAct('block','${l.ip}','ip')">封IP</button>`}
                </td>
            </tr>`
        }).join('')}</tbody></table>
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
