/**
 * CF-Workers-SUB 终极合并版 (修复 + 提速 + 审计 + 鉴权)
 * 1. 修复：包含 ctx 参数和 safeBase64，彻底解决 1101 报错。
 * 2. 提速：恢复了 scv, tfo, fdn 等关键参数，解决节点连接慢/超时问题。
 * 3. 功能：包含一键拉黑、审计日志、可视化后台。
 */

// --- 基础配置 ---
let mytoken = 'auto'; 
let adminPassword = 'admin'; // 后台管理密码
let FileName = 'CF-Workers-SUB';
let SUBUpdateTime = 6;
let total = 99; 
let timestamp = 4102329600000; 
let MainData = `https://cfxr.eu.org/getSub`;  // 默认节点源
let subConverter = "SUBAPI.cmliussss.net"; 
let subConfig = "https://raw.githubusercontent.com/cmliu/ACL4SSR/main/Clash/config/ACL4SSR_Online_MultiCountry.ini";
let subProtocol = 'https';

export default {
    async fetch(request, env, ctx) { // 核心修复：保留 ctx 参数
        try {
            const url = new URL(request.url);
            const clientIP = request.headers.get('CF-Connecting-IP') || '0.0.0.0';
            const userAgentHeader = request.headers.get('User-Agent') || "Unknown";
            const userAgent = userAgentHeader.toLowerCase();

            // --- 1. 故障自检：检查 KV 是否绑定成功 ---
            if (!env.KV && url.pathname === '/admin_panel') {
                return new Response(`<h1>配置错误：未找到 KV 绑定</h1>
                <p>代码试图读取变量 <code>KV</code>，但未找到。</p>
                <p>请去 Cloudflare 设置 -> 变量和机密 -> KV 命名空间绑定，确保变量名称准确填写的 <strong>KV</strong> (必须大写，无空格)。</p>
                <p>绑定后，请尝试在“部署”标签页重新部署一次代码。</p>`, 
                { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
            }
            
            // --- 2. 黑名单拦截 ---
            if (env.KV) {
                const blacklistData = await env.KV.get('BLACKLIST_IPS');
                const blacklist = blacklistData ? blacklistData.split(',') : [];
                if (blacklist.includes(clientIP)) {
                    return new Response('Access Denied: Your IP has been blacklisted.', { status: 403 });
                }
            }

            // --- 3. 可视化后台管理 ---
            if (url.pathname === '/admin_panel') {
                const pwd = url.searchParams.get('p');
                if (pwd !== (env.ADMIN_PWD || adminPassword)) return new Response('Unauthorized', { status: 401 });
                
                // 处理一键拉黑/解封 API
                const action = url.searchParams.get('action');
                const targetIp = url.searchParams.get('ip');
                if (action && targetIp && env.KV) {
                    let currentData = await env.KV.get('BLACKLIST_IPS');
                    let currentList = currentData ? currentData.split(',') : [];
                    
                    if (action === 'block') {
                        if (!currentList.includes(targetIp)) currentList.push(targetIp);
                    } else if (action === 'unblock') {
                        currentList = currentList.filter(ip => ip !== targetIp);
                    }
                    await env.KV.put('BLACKLIST_IPS', currentList.join(','));
                    return new Response('Success');
                }
                return await handleAdminPanel(env);
            }

            // --- 变量初始化 ---
            mytoken = env.TOKEN || mytoken;
            let BotToken = env.TGTOKEN || '';
            let ChatID = env.TGID || '';
            let TG = env.TG || 0;
            subConverter = env.SUBAPI || subConverter;
            subConfig = env.SUBCONFIG || subConfig;
            FileName = env.SUBNAME || FileName;

            const token = url.searchParams.get('token');
            const timeTemp = Math.ceil(new Date().setHours(0,0,0,0) / 1000);
            const fakeToken = await MD5MD5(`${mytoken}${timeTemp}`);
            const guestToken = env.GUESTTOKEN || await MD5MD5(mytoken);
            
            const isValidRequest = [mytoken, fakeToken, guestToken].includes(token) || url.pathname == ("/" + mytoken);

            // --- 4. 审计日志 (非阻塞) ---
            if (isValidRequest && env.KV && !userAgent.includes('mozilla')) {
                const logPromise = recordLog(env, clientIP, userAgentHeader, token || 'PathMode', url, request.cf);
                if (ctx && ctx.waitUntil) ctx.waitUntil(logPromise);
            }

            // --- 核心业务逻辑 ---
            if (!isValidRequest) {
                if (TG == 1 && url.pathname !== "/" && url.pathname !== "/favicon.ico") await sendMessage(BotToken, ChatID, `#异常访问`, clientIP, `UA: ${userAgentHeader}\n路径: ${url.pathname}`);
                if (env.URL302) return Response.redirect(env.URL302, 302);
                return new Response(await nginx(), { status: 200, headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
            } else {
                // KV 编辑页面 (浏览器访问)
                if (env.KV && userAgent.includes('mozilla') && !url.search) {
                    return await KV(request, env, 'LINK.txt', guestToken, mytoken, FileName);
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
                    const subResult = await getSUB(subLinks, request, "v2rayn", userAgentHeader);
                    remoteNodes = subResult[0].join('\n');
                    subConverterURLPart = subResult[1];
                }

                let totalContent = v2rayNodes + remoteNodes;
                let format = url.searchParams.has('clash') || userAgent.includes('clash') ? 'clash' : 
                             (url.searchParams.has('sb') || userAgent.includes('sing-box') ? 'singbox' : 'base64');

                if (format === 'base64') {
                    const responseHeaders = { 
                        "content-type": "text/plain; charset=utf-8",
                        "Profile-Update-Interval": `${SUBUpdateTime}`,
                        "Subscription-Userinfo": `upload=0; download=0; total=${total * 1073741824}; expire=${timestamp / 1000}`
                    };
                    return new Response(safeBase64Encode(totalContent), { headers: responseHeaders });
                } else {
                    // ★★★ 提速关键点：加入了 tfo, scv, fdn 等参数，确保节点连接兼容性 ★★★
                    let subURL = `${url.origin}/sub?token=${fakeToken}|${subConverterURLPart}`;
                    let convertUrl = `${subProtocol}://${subConverter}/sub?target=${format}&url=${encodeURIComponent(subURL)}&insert=false&config=${encodeURIComponent(subConfig)}&emoji=true&list=false&tfo=false&scv=true&fdn=false&sort=false&new_name=true`;
                    
                    const subResp = await fetch(convertUrl, { headers: { 'User-Agent': userAgentHeader } });
                    let content = await subResp.text();
                    if (format === 'clash') content = clashFix(content);
                    return new Response(content, { headers: { "content-type": "text/plain; charset=utf-8" } });
                }
            }
        } catch (e) {
            return new Response(`Error detected: ${e.message}\nStack: ${e.stack}`, { status: 500 });
        }
    }
};

// --- 工具函数 (增强容错) ---

async function recordLog(env, ip, ua, token, url, cf) {
    try {
        const logKey = `LOG_${Date.now()}`;
        const logData = {
            time: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
            ip: ip, loc: cf ? `${cf.country || ''}-${cf.city || ''}` : 'Unknown',
            ua: ua, token: token, path: url.pathname + url.search
        };
        await env.KV.put(logKey, JSON.stringify(logData), { expirationTtl: 604800 });
    } catch(e) { console.log('Log error:', e); }
}

async function handleAdminPanel(env) {
    const list = await env.KV.list({ prefix: 'LOG_', limit: 100 });
    const blacklistData = await env.KV.get('BLACKLIST_IPS');
    const blacklist = blacklistData ? blacklistData.split(',') : [];
    
    let logs = [];
    for (const key of list.keys) {
        const val = await env.KV.get(key.name);
        if (val) logs.push(JSON.parse(val));
    }
    logs.sort((a, b) => new Date(b.time) - new Date(a.time));

    return new Response(`
    <!DOCTYPE html><html><head><title>审计后台</title><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        body { font-family: sans-serif; background: #f4f7f9; padding: 20px; }
        .card { background: white; padding: 20px; border-radius: 10px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); max-width: 1200px; margin: auto; }
        table { width: 100%; border-collapse: collapse; margin-top: 15px; }
        th, td { padding: 10px; border-bottom: 1px solid #eee; text-align: left; font-size: 13px; }
        th { background: #007bff; color: white; }
        .btn { padding: 4px 8px; border: none; border-radius: 4px; color: white; cursor: pointer; font-size: 12px; }
        .block { background: #dc3545; } .unblock { background: #28a745; }
        .status-b { color: #dc3545; font-weight: bold; }
    </style></head>
    <body><div class="card">
        <h2>节点使用审计 (最近100条)</h2>
        <p>当前黑名单IP数: ${blacklist.length}</p>
        <table><thead><tr><th>时间</th><th>IP</th><th>地区</th><th>标识</th><th>操作</th></tr></thead>
        <tbody>${logs.map(l => `<tr>
            <td>${l.time}</td>
            <td>${l.ip} ${blacklist.includes(l.ip) ? '<span class="status-b">[封禁]</span>' : ''}</td>
            <td>${l.loc}</td>
            <td>${l.token}</td>
            <td>${blacklist.includes(l.ip) 
                ? `<button class="btn unblock" onclick="doAct('unblock','${l.ip}')">一键解封</button>` 
                : `<button class="btn block" onclick="doAct('block','${l.ip}')">一键拉黑</button>`}
            </td>
        </tr>`).join('')}</tbody></table>
    </div>
    <script>
    async function doAct(a, ip) {
        if(confirm('确定要操作吗?')){
            const u = new URL(window.location.href);
            u.searchParams.set('action', a); u.searchParams.set('ip', ip);
            await fetch(u); location.reload();
        }
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
    } catch(e) { console.error(e); }
    return [newapi, subURLs];
}

function safeBase64Decode(str) {
    if (!str) return "";
    try {
        str = str.replace(/\s/g, '');
        if (str.length % 4 !== 0) str += "=".repeat(4 - (str.length % 4));
        return decodeURIComponent(escape(atob(str)));
    } catch (e) { return str; }
}

function safeBase64Encode(str) { try { return btoa(unescape(encodeURIComponent(str))); } catch(e) { return ""; } }
async function MD5MD5(text) { const data = new TextEncoder().encode(text); const hash = await crypto.subtle.digest('MD5', data); return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join(''); }
async function ADD(envadd) { return (envadd || "").split(/[	"'|\r\n]+/).filter(x => x.trim() !== ""); }
function clashFix(content) { return content.replace(/mtu: 1280, udp: true/g, 'mtu: 1280, remote-dns-resolve: true, udp: true'); }
async function nginx() { return `<h1>Welcome to nginx!</h1>`; }
async function sendMessage(token, id, type, ip, data = "") { if (!token || !id) return; try { await fetch(`https://api.telegram.org/bot${token}/sendMessage?chat_id=${id}&text=${encodeURIComponent(type + '\nIP: ' + ip + '\n' + data)}`); } catch (e) {} }

async function KV(request, env, txt, guest, mytoken, FileName) {
    const url = new URL(request.url);
    if (request.method === "POST") { await env.KV.put(txt, await request.text()); return new Response("保存成功"); }
    let content = await env.KV.get(txt) || '';
    return new Response(`<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="padding:20px;"><h2>订阅编辑</h2>
    <p>订阅地址: <code>https://${url.hostname}/${mytoken}</code></p>
    <p style="color:red">提示：请填入你自己的节点链接（一行一个），默认节点速度可能较慢。</p>
    <textarea id="c" style="width:100%;height:400px;border:1px solid #ccc;padding:10px;">${content}</textarea><br>
    <button onclick="save()" style="margin-top:10px;padding:10px 20px;background:#28a745;color:white;border:none;cursor:pointer;">保存配置</button>
    <script>function save(){fetch(window.location.href,{method:'POST',body:document.getElementById('c').value}).then(r=>r.text()).then(t=>alert(t));}</script>
    </body></html>`, { headers: { "Content-Type": "text/html;charset=utf-8" } });
}
