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

// --- 功能 3：黑名单 IP 限制 ---
// 在括号内填入要封禁的 IP，例如: const BLACKLIST_IPS = ['1.2.3.4', '5.6.7.8'];
const BLACKLIST_IPS = []; 

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		const clientIP = request.headers.get('CF-Connecting-IP');
		const userAgentHeader = request.headers.get('User-Agent') || "Unknown";
		const userAgent = userAgentHeader.toLowerCase();
		
		// 1. 黑名单拦截逻辑
		if (BLACKLIST_IPS.includes(clientIP)) {
			return new Response('Access Denied: Your IP is blacklisted.', { status: 403 });
		}

		// 2. 可视化后台管理入口 (功能 1 & 2)
		// 访问方式: https://你的域名/admin_panel?p=管理密码
		if (url.pathname === '/admin_panel') {
			const pwd = url.searchParams.get('p');
			if (pwd !== (env.ADMIN_PWD || adminPassword)) return new Response('Unauthorized', { status: 401 });
			return await handleAdminPanel(env);
		}

		// 初始化原项目变量
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

		// 3. 行为审计记录 (记录订阅请求，排除你自己打开管理页面的行为)
		const isValidRequest = [mytoken, fakeToken, guestToken].includes(token) || url.pathname == ("/" + mytoken);
		if (isValidRequest && env.KV && !userAgent.includes('mozilla')) {
			await recordLog(env, clientIP, userAgentHeader, token || 'PathMode', url, request.cf);
		}

		// --- 以下完全保留原项目核心逻辑 ---
		if (!isValidRequest) {
			if (TG == 1 && url.pathname !== "/" && url.pathname !== "/favicon.ico") await sendMessage(BotToken, ChatID, `#异常访问`, clientIP, `UA: ${userAgentHeader}\n路径: ${url.pathname}`);
			if (env.URL302) return Response.redirect(env.URL302, 302);
			return new Response(await nginx(), { status: 200, headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
		} else {
			// 原有的 KV 编辑页面功能
			if (env.KV && userAgent.includes('mozilla') && !url.search) {
				return await KV(request, env, 'LINK.txt', guestToken, mytoken, FileName, subConverter, subConfig, subProtocol);
			}

			// 获取节点数据逻辑
			let finalData = (env.KV ? await env.KV.get('LINK.txt') : env.LINK) || MainData;
			let 重新汇总 = await ADD(finalData);
			let 自建 = ""; let 订阅 = "";
			for (let x of 重新汇总) {
				if (x.toLowerCase().startsWith('http')) 订阅 += x + '\n';
				else 自建 += x + '\n';
			}

			// 订阅转换逻辑
			let 订阅转换URL = `${url.origin}/sub?token=${fakeToken}|${订阅.replace(/\n/g, '|')}`;
			let 订阅格式 = 'base64';
			if (url.searchParams.has('clash') || userAgent.includes('clash')) 订阅格式 = 'clash';
			else if (url.searchParams.has('sb') || userAgent.includes('sing-box')) 订阅格式 = 'singbox';

			if (订阅格式 === 'base64') {
				const responseHeaders = { "content-type": "text/plain; charset=utf-8", "Profile-Update-Interval": `${SUBUpdateTime}` };
				return new Response(btoa(unescape(encodeURIComponent(自建 + 订阅))), { headers: responseHeaders });
			} else {
				let convertUrl = `${subProtocol}://${subConverter}/sub?target=${订阅格式}&url=${encodeURIComponent(订阅转换URL)}&insert=false&config=${encodeURIComponent(subConfig)}&emoji=true`;
				return fetch(convertUrl, { headers: { 'User-Agent': userAgentHeader } });
			}
		}
	}
};

// --- 新增：访问日志记录函数 ---
async function recordLog(env, ip, ua, token, url, cf) {
	const logKey = `LOG_${Date.now()}`;
	const logData = {
		time: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
		ip: ip,
		loc: `${cf.country}-${cf.city}`,
		ua: ua,
		token: token,
		path: url.pathname + url.search
	};
	// 记录保存7天 (604800秒)
	await env.KV.put(logKey, JSON.stringify(logData), { expirationTtl: 604800 });
}

// --- 新增：可视化审计后台页面 ---
async function handleAdminPanel(env) {
	const list = await env.KV.list({ prefix: 'LOG_', limit: 100 });
	const logs = [];
	for (const key of list.keys) {
		const val = await env.KV.get(key.name);
		if (val) logs.push(JSON.parse(val));
	}
	logs.sort((a, b) => new Date(b.time) - new Date(a.time));

	const html = `
	<!DOCTYPE html><html><head><title>SUB 审计后台</title>
	<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
	<style>
		body { font-family: -apple-system, sans-serif; background: #f0f2f5; padding: 20px; }
		.card { background: white; padding: 20px; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.05); max-width: 1200px; margin: auto; }
		h2 { color: #1a73e8; border-bottom: 2px solid #e8f0fe; padding-bottom: 10px; }
		table { width: 100%; border-collapse: collapse; margin-top: 20px; table-layout: fixed; }
		th, td { padding: 12px; border-bottom: 1px solid #f0f0f0; text-align: left; font-size: 13px; word-wrap: break-word; }
		th { background: #fafafa; font-weight: 600; color: #5f6368; }
		tr:hover { background: #f8f9fa; }
		.ua-text { color: #80868b; font-size: 11px; display: block; max-height: 40px; overflow: hidden; }
		.tag { background: #e8f0fe; color: #1967d2; padding: 2px 8px; border-radius: 4px; font-size: 11px; }
	</style>
	</head><body>
		<div class="card">
			<h2>节点使用记录 (最近 100 次访问)</h2>
			<table>
				<thead><tr><th width="15%">时间</th><th width="12%">IP地址</th><th width="12%">地区</th><th width="10%">用户标识</th><th width="20%">请求详情</th><th>客户端信息 (UA)</th></tr></thead>
				<tbody>
					${logs.map(l => `<tr>
						<td>${l.time}</td>
						<td><b>${l.ip}</b></td>
						<td><span class="tag">${l.loc}</span></td>
						<td>${l.token}</td>
						<td><code>${l.path}</code></td>
						<td><span class="ua-text">${l.ua}</span></td>
					</tr>`).join('')}
				</tbody>
			</table>
		</div>
	</body></html>`;
	return new Response(html, { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
}

// --- 原项目工具函数 ---
async function MD5MD5(text) {
	const encoder = new TextEncoder();
	const data = encoder.encode(text);
	const hash = await crypto.subtle.digest('MD5', data);
	return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}
async function ADD(envadd) {
	var addtext = envadd.replace(/[	"'|\r\n]+/g, '\n').replace(/\n+/g, '\n');
	return addtext.split('\n').filter(x => x.trim() !== "");
}
async function nginx() {
	return `<!DOCTYPE html><html><head><title>Welcome to nginx!</title><style>body { width: 35em; margin: 0 auto; font-family: sans-serif; }</style></head><body><h1>Welcome to nginx!</h1><p>Server is running successfully.</p></body></html>`;
}
async function sendMessage(token, id, type, ip, data) {
	if (!token || !id) return;
	const msg = `${type}\nIP: ${ip}\n${data}`;
	await fetch(`https://api.telegram.org/bot${token}/sendMessage?chat_id=${id}&text=${encodeURIComponent(msg)}`);
}

// 原有的 KV 编辑页面封装 (略作简化以适配)
async function KV(request, env, txt, guest, mytoken, FileName, subConverter, subConfig, subProtocol) {
	// ... 这里保持你原有的 HTML 编辑页面逻辑 ...
	// (篇幅原因此处略去原本那几百行HTML字符串，实际使用时建议保留原代码中的该部分)
	return new Response("已进入编辑模式，请在KV页面操作。");
}
