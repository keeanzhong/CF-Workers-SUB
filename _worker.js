/**
 * CF-Workers-SUB 强制调试版
 * 1. 强制同步写入 KV (await)，确保日志必录。
 * 2. 禁用 HTTP 缓存，防止 Worker 不运行。
 * 3. 开启 Console 日志，方便后台排查。
 */

// --- 基础配置 ---
let mytoken = 'auto'; 
let adminPassword = 'zyk20031230'; 
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
        // console.log("请求进入: " + request.url); // 调试日志
        try {
            const url = new URL(request.url);
            const clientIP = request.headers.get('CF-Connecting-IP') || '0.0.0.0';
            const userAgent = (request.headers.get('User-Agent') || "Unknown").toLowerCase();
            const userID = url.searchParams.get('id') || url.searchParams.get('user') || 'default';

            // 1. 检查 KV
            if (!env.KV && url.pathname === '/admin_panel') {
                return new Response(`配置错误：未找到 KV 绑定`, { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
            }
            
            // 2. 黑名单
            if (env.KV) {
                const blIP = (await env.KV.get('BLACKLIST_IPS') || "").split(',');
                if (blIP.includes(clientIP)) return new Response('Access Denied (IP Blocked).', { status: 403 });
                const blID = (await env.KV.get('BLACKLIST_IDS') || "").split(',');
                if (userID !== 'default' && blID.includes(userID)) return new Response('Access Denied (User Blocked).', { status: 403 });
            }

            // 3. 后台管理
            if (url.pathname === '/admin_panel') {
                const pwd = url.searchParams.get('p');
                if (pwd !== (env.ADMIN_PWD || adminPassword)) return new Response('Unauthorized', { status: 401 });
                
                const act = url.searchParams.get('action');
                const val = url.searchParams.get('val');
                const type = url.searchParams.get('type');
                if (act && val && env.KV) {
                    const key = type === 'id' ? 'BLACKLIST_IDS' : 'BLACKLIST_IPS';
                    let list = (await env.KV.get(key) || "").split(',').filter(x => x);
                    if (act === 'block') { if (!list.includes(val)) list.push(val); }
                    else if (act === 'unblock') { list = list.filter(x => x !== val); }
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

            // --- 4. 强制同步审计 (DEBUG 核心) ---
            // 只要有 KV，不判断 User-Agent，强制写入，并且使用 await 等待写入完成
            if (isValidRequest && env.KV) {
                console.log(`正在记录日志: IP=${clientIP}, User=${userID}`); // 调试日志
                await recordLog(env, clientIP, userID, userAgent, url, request.cf);
                console.log(`日志写入完成`); // 调试日志
            } else {
                console.log(`不记录日志: Valid=${isValidRequest}, KV=${!!env.KV}`);
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
                let contentType = "text/plain; charset=utf-8";

                if (format === 'base64') {
                    responseContent = safeBase64Encode(totalContent);
                } else {
                    let subURL = `${url.origin}/sub?token=${fakeToken}|${subConverterURLPart}`;
                    let convertUrl = `${subProtocol}://${subConverter}/sub?target=${format}&url=${encodeURIComponent(subURL)}&insert=false&config=${encodeURIComponent(subConfig)}&emoji=true&list=false&tfo=false&scv=true&fdn=false&sort=false&new_name=true`;
                    const subResp = await fetch(convertUrl, { headers: { 'User-Agent': userAgent } });
                    responseContent = await subResp.text();
                    if (format === 'clash') responseContent = clashFix(responseContent);
                }

                // 添加禁止缓存头
                return new Response(responseContent, { 
                    headers: { 
                        "content-type": contentType,
                        "Profile-Update-Interval": `${SUBUpdateTime}`,
                        "Subscription-Userinfo": `upload=0; download=0; total=${total * 1073741824}; expire=${timestamp / 1000}`,
                        "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate", // 强制不缓存
                        "Pragma": "no-cache",
                        "Expires": "0"
                    } 
                });
            }
        } catch (e) {
            console.error(e); // 报错输出到后台
            return new Response(`Error: ${e.message}\n${e.stack}`, { status: 500 });
        }
    }
};

// --- 工具函数 ---
async function recordLog(env, ip, userID, ua, url, cf) {
    try {
        const logKey = `LOG_${Date.now()}_${Math.random().toString(36).substring(7)}`; // 防止Key冲突
        const logData = {
            time: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
            ip: ip, 
            loc: cf ? `${cf.country || ''}-${cf.city || ''}` : 'Unknown',
            user: userID, 
            ua: ua, 
            path: url.pathname + url.search
        };
        await env.KV.put(logKey, JSON.stringify(logData), { expirationTtl: 604800 });
    } catch(e) { console.error("KV Write Error: " + e.message); }
}

async function handleAdminPanel(env) {
    const list = await env.KV.list({ prefix: 'LOG_', limit: 100 });
    const blIP = (await env.KV.get('BLACKLIST_IPS') || "").split(',');
    const blID = (await env.KV.get('BLACKLIST_IDS') || "").split(',');
    
    let logs = [];
    for (const key of list.keys) {
        const val = await env.KV.get(key.name);
        if (val) logs.push(JSON.parse(val));
    }
    logs.sort((a, b) => new Date(b.time) - new Date(a.time));

    return new Response(`
    <!DOCTYPE html><html><head><title>调试后台</title><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <style>body{font-family:sans-serif;background:#f4f7f9;padding:20px}.card{background:white;padding:20px;border-radius:10px;box-shadow:0 2px 8px rgba(0,0,0,0.1);max-width:1200px;margin:auto}table{width:100%;border-collapse:collapse;margin-top:15px}th,td{padding:10px;border-bottom:1px solid #eee;text-align:left;font-size:13px}th{background:#007bff;color:white}.btn{padding:4px 8px;border:none;border-radius:4px;color:white;cursor:pointer;font-size:12px;margin-right:5px}.block{background:#dc3545}.unblock{background:#28a745}.tag{padding:2px 5px;border-radius:3px;font-size:11px;background:#e9ecef;color:#495057}.b-tag{background:#dc3545;color:white}</style></head>
    <body><div class="card">
        <h2>📊 节点使用审计 (DEBUG模式)</h2>
        <p>如果这里有数据，说明 KV 写入正常。如果 v2rayN 更新成功但这里没数据，请看 Cloudflare 实时日志。</p>
        <table><thead><tr><th>时间</th><th>用户ID</th><th>IP地址</th><th>客户端UA</th><th>操作</th></tr></thead>
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
    <script>async function doAct(act, val, type){if(confirm('确定对 ['+val+'] 执行 ['+act+'] 吗?')){const u=new URL(window.location.href);u.searchParams.set('action',act);u.searchParams.set('val',val);u.searchParams.set('type',type);await fetch(u);location.reload();}}</script></body></html>`, { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
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
async function sendMessage(token, id, type, ip, data = "") { if (!token || !id) return; try { await fetch(`https://api.telegram.org/bot${token}/sendMessage?chat_id=${id}&text=${encodeURIComponent(type + '\nIP: ' + ip + '\n' + data)}`); } catch (e) {} }
async function KV(request, env, txt, mytoken) {
    const url = new URL(request.url);
    if (request.method === "POST") { await env.KV.put(txt, await request.text()); return new Response("保存成功"); }
    let content = await env.KV.get(txt) || '';
    return new Response(`<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="padding:20px;"><h2>节点编辑</h2><p>订阅地址: <code>https://${url.hostname}/${mytoken}</code></p><textarea id="c" style="width:100%;height:400px;border:1px solid #ccc;padding:10px;">${content}</textarea><br><button onclick="save()" style="padding:10px 20px;background:#28a745;color:white;border:none;cursor:pointer;">保存配置</button><script>function save(){fetch(window.location.href,{method:'POST',body:document.getElementById('c').value}).then(r=>r.text()).then(t=>alert(t));}</script></body></html>`, { headers: { "Content-Type": "text/html;charset=utf-8" } });
}
