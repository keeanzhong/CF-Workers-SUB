/**
 * CF-Workers-SUB 增强版
 * 整合功能：1. 节点审计记录 2. 可视化管理后台 3. IP黑名单限制
 * 原有功能：完整保留订阅转换、Base64/Clash/Singbox支持、KV编辑页面
 */

// --- 基础配置项 ---
let mytoken = 'auto'; 
let adminPassword = 'admin'; // 可视化后台管理密码 (建议修改)
let FileName = 'CF-Workers-SUB';
let SUBUpdateTime = 6;
let total = 99;
let timestamp = 4102329600000;
let MainData = `https://cfxr.eu.org/getSub`; 
let urls = [];
let subConverter = "SUBAPI.cmliussss.net"; 
let subConfig = "https://raw.githubusercontent.com/cmliu/ACL4SSR/main/Clash/config/ACL4SSR_Online_MultiCountry.ini";
let subProtocol = 'https';

// --- 功能：黑名单 IP 限制 ---
// 将需要封禁的 IP 放入数组，例如: const BLACKLIST_IPS = ['1.2.3.4'];
const BLACKLIST_IPS = []; 

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		const clientIP = request.headers.get('CF-Connecting-IP');
		const userAgentHeader = request.headers.get('User-Agent') || "Unknown";
		const userAgent = userAgentHeader.toLowerCase();
		
		// 1. IP 拦截校验
		if (BLACKLIST_IPS.includes(clientIP)) {
			return new Response('Forbidden: Your IP is blacklisted.', { status: 403 });
		}

		// 2. 可视化后台入口
		if (url.pathname === '/admin_panel') {
			const pwd = url.searchParams.get('p');
			if (pwd !== (env.ADMIN_PWD || adminPassword)) return new Response('Unauthorized', { status: 401 });
			return await handleAdminPanel(env);
		}

		// 初始化原项目环境变量
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

		// 3. 访问记录审计 (仅记录有效的订阅请求)
		const isValidRequest = [mytoken, fakeToken, guestToken].includes(token) || url.pathname == ("/" + mytoken);
		if (isValidRequest && env.KV && !userAgent.includes('mozilla')) {
			await recordLog(env, clientIP, userAgentHeader, token || 'PathMode', url, request.cf);
		}

		// --- 核心订阅逻辑 ---
		if (!isValidRequest) {
			if (TG == 1 && url.pathname !== "/" && url.pathname !== "/favicon.ico") await sendMessage(BotToken, ChatID, `#异常访问 ${FileName}`, clientIP, `UA: ${userAgentHeader}\n路径: ${url.pathname}`);
			if (env.URL302) return Response.redirect(env.URL302, 302);
			return new Response(await nginx(), { status: 200, headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
		} else {
			// 原有 KV 编辑页面逻辑
			if (env.KV && userAgent.includes('mozilla') && !url.search) {
				await sendMessage(BotToken, ChatID, `#编辑订阅 ${FileName}`, clientIP, `UA: ${userAgentHeader}`);
				return await KV(request, env, 'LINK.txt', guestToken, mytoken, FileName, subConverter, subConfig, subProtocol);
			}

			// 获取数据源
			let finalData = (env.KV ? await env.KV.get('LINK.txt') : env.LINK) || MainData;
			let links = await ADD(finalData);
			let v2rayNodes = ""; let subLinks = [];
			for (let x of links) {
				if (x.toLowerCase().startsWith('http')) subLinks.push(x);
				else v2rayNodes += x + '\n';
			}

			// 处理远端订阅
			let remoteNodes = "";
			let subConverterURLPart = "";
			if (subLinks.length > 0) {
				const subResult = await getSUB(subLinks, request, "v2rayn", userAgentHeader);
				remoteNodes = subResult[0].join('\n');
				subConverterURLPart = subResult[1];
			}

			let totalNodes = v2rayNodes + remoteNodes;
			let 订阅格式 = 'base64';
			if (url.searchParams.has('clash') || userAgent.includes('clash')) 订阅格式 = 'clash';
			else if (url.searchParams.has('sb') || userAgent.includes('sing-box')) 订阅格式 = 'singbox';

			if (订阅格式 === 'base64') {
				const base64Data = btoa(unescape(encodeURIComponent(totalNodes)));
				return new Response(base64Data, { 
					headers: { 
						"content-type": "text/plain; charset=utf-8",
						"Profile-Update-Interval": `${SUBUpdateTime}`,
						"Subscription-Userinfo": `upload=0; download=0; total=${total * 1073741824}; expire=${timestamp / 1000}`
					} 
				});
			} else {
				let subURL = `${url.origin}/sub?token=${fakeToken}|${subConverterURLPart}`;
				let convertUrl = `${subProtocol}://${subConverter}/sub?target=${订阅格式}&url=${encodeURIComponent(subURL)}&insert=false&config=${encodeURIComponent(subConfig)}&emoji=true&list=false`;
				const subResp = await fetch(convertUrl, { headers: { 'User-Agent': userAgentHeader } });
				let content = await subResp.text();
				if (订阅格式 === 'clash') content = await clashFix(content);
				return new Response(content, { headers: { "content-type": "text/plain; charset=utf-8" } });
			}
		}
	}
};

// --- 功能函数补全 (防止 1101 错误) ---

async function recordLog(env, ip, ua, token, url, cf) {
	const logKey = `LOG_${Date.now()}`;
	const logData = {
		time: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
		ip: ip,
		loc: cf ? `${cf.country || ''}-${cf.city || ''}` : 'Unknown',
		ua: ua,
		token: token,
		path: url.pathname + url.search
	};
	await env.KV.put(logKey, JSON.stringify(logData), { expirationTtl: 604800 });
}

async function handleAdminPanel(env) {
	const list = await env.KV.list({ prefix: 'LOG_', limit: 100 });
	const logs = [];
	for (const key of list.keys) {
		const val = await env.KV.get(key.name);
		if (val) logs.push(JSON.parse(val));
	}
	logs.sort((a, b) => new Date(b.time) - new Date(a.time));

	return new Response(`
	<!DOCTYPE html><html><head><title>节点审计后台</title>
	<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
	<style>
		body { font-family: -apple-system, sans-serif; background: #f0f2f5; padding: 20px; color: #333; }
		.card { background: white; padding: 24px; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.08); max-width: 1200px; margin: auto; }
		h2 { color: #1a73e8; margin-top: 0; display: flex; align-items: center; }
		table { width: 100%; border-collapse: collapse; margin-top: 20px; }
		th, td { padding: 12px; border-bottom: 1px solid #eee; text-align: left; font-size: 13px; }
		th { background: #f8f9fa; font-weight: 600; }
		tr:hover { background: #fcfcfc; }
		.ua { font-size: 11px; color: #888; max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.tag { background: #e8f0fe; color: #1967d2; padding: 2px 8px; border-radius: 4px; font-size: 11px; }
	</style></head>
	<body><div class="card">
		<h2>📡 节点访问审计 (最近100次记录)</h2>
		<table><thead><tr><th>时间</th><th>IP地址</th><th>地区</th><th>Token</th><th>请求路径</th><th>设备信息</th></tr></thead>
		<tbody>${logs.map(l => `<tr><td>${l.time}</td><td><b>${l.ip}</b></td><td><span class="tag">${l.loc}</span></td><td>${l.token}</td><td><code>${l.path}</code></td><td class="ua" title="${l.ua}">${l.ua}</td></tr>`).join('')}</tbody>
		</table>
	</div></body></html>`, { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
}

async function getSUB(api, request, 追加UA, userAgentHeader) {
	let newapi = ""; let subURLs = "";
	try {
		const responses = await Promise.allSettled(api.map(url => fetch(url, { headers: { "User-Agent": `v2rayN/6.45 ${追加UA}(${userAgentHeader})` } }).then(r => r.ok ? r.text() : "")));
		for (const [i, r] of responses.entries()) {
			if (r.status === 'fulfilled' && r.value) {
				if (r.value.includes('proxies:')) subURLs += "|" + api[i];
				else newapi += (r.value.includes('://') ? r.value : await base64Decode(r.value)) + '\n';
			}
		}
	} catch (e) {}
	return [await ADD(newapi), subURLs];
}

async function base64Decode(str) {
	try {
		const bytes = new Uint8Array(atob(str.replace(/\s/g, '')).split('').map(c => c.charCodeAt(0)));
		return new TextDecoder('utf-8').decode(bytes);
	} catch (e) { return ""; }
}

async function MD5MD5(text) {
	const data = new TextEncoder().encode(text);
	const hash = await crypto.subtle.digest('MD5', data);
	return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function ADD(envadd) {
	var addtext = envadd.replace(/[	"'|\r\n]+/g, '\n').replace(/\n+/g, '\n');
	return addtext.split('\n').filter(x => x.trim() !== "");
}

function clashFix(content) {
	if (content.includes('type: wireguard')) {
		return content.replace(/mtu: 1280, udp: true/g, 'mtu: 1280, remote-dns-resolve: true, udp: true');
	}
	return content;
}

async function nginx() {
	return `<!DOCTYPE html><html><head><title>Welcome to nginx!</title><style>body{width:35em;margin:0 auto;font-family:Tahoma,sans-serif;}</style></head><body><h1>Welcome to nginx!</h1></body></html>`;
}

async function sendMessage(token, id, type, ip, data = "") {
	if (!token || !id) return;
	try {
		const info = await fetch(`http://ip-api.com/json/${ip}?lang=zh-CN`).then(r => r.json());
		const msg = `${type}\nIP: ${ip}\n地区: ${info.country || ''} ${info.city || ''}\n${data}`;
		await fetch(`https://api.telegram.org/bot${token}/sendMessage?chat_id=${id}&text=${encodeURIComponent(msg)}`);
	} catch (e) {}
}

// --- 补全 KV 编辑页面代码 ---
async function KV(request, env, txt, guest, mytoken, FileName, subConverter, subConfig, subProtocol) {
	const url = new URL(request.url);
	if (request.method === "POST") {
		const content = await request.text();
		await env.KV.put(txt, content);
		return new Response("保存成功");
	}
	let content = await env.KV.get(txt) || '';
	const html = `<!DOCTYPE html><html><head><title>${FileName} 编辑</title><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
	<style>body{padding:20px;font-family:sans-serif;} textarea{width:100%;height:400px;margin:10px 0;padding:10px;} .btn{padding:10px 20px;background:#28a745;color:white;border:none;cursor:pointer;border-radius:4px;}</style></head>
	<body><h2>${FileName} 订阅编辑</h2>
	<p>自适应订阅: <code>https://${url.hostname}/${mytoken}</code></p>
	<textarea id="c">${content}</textarea><br>
	<button class="btn" onclick="save()">保存配置</button>
	<script>function save(){ fetch(window.location.href,{method:'POST',body:document.getElementById('c').value}).then(r=>r.text()).then(t=>alert(t)); }</script>
	</body></html>`;
	return new Response(html, { headers: { "Content-Type": "text/html;charset=utf-8" } });
}
