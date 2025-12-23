// ================================================================
// 1. 静态配置区域 (只放不依赖 env 的常量)
// ================================================================
const defaultUUID = '90204786-9045-420c-b2b9-293026330025'; // 默认 UUID
const proxyIP = ''; // 优选 IP，留空自动
const adminPath = '/admin'; // 管理后台路径
const adminKey = 'zyk20031230'; // <--- 【重要】请修改这个管理密码

// ================================================================
// 2. 备用节点列表 (完整版，保留所有备用路径)
// ================================================================
let addresses = [
	'www.visa.com.sg',
	'www.visa.com',
	'icook.hk',
	'ip.sb',
	'www.gov.se',
	'icook.tw',
	'www.digitalocean.com',
	'www.csgo.com',
	'www.whoer.net',
	'telegram.org',
	'ip.sb',
	'csgo.com',
	'www.cloudflare.com',
    'www.apple.com',
    'www.amazon.com',
    'www.microsoft.com',
    'www.google.com',
    'www.baidu.com',
    'www.alibaba.com',
    'www.tencent.com'
];

let addressesapi = [
	'https://raw.githubusercontent.com/cmliu/WorkerVless2sub/main/addressesapi.txt',
	'https://raw.githubusercontent.com/cmliu/WorkerVless2sub/main/addressesipv6api.txt'
];

let addressesnotls = [
	'www.visa.com.sg',
	'www.visa.com',
	'icook.hk',
	'ip.sb'
];

let addressesnotlsapi = [
	'https://raw.githubusercontent.com/cmliu/WorkerVless2sub/main/addressesapi.txt'
];

const BLOCK_MSG = 'Access Denied: Your IP has been banned.';
const NODE_BLOCK_MSG = 'Service Unavailable: Target node is banned.';

// ================================================================
// 3. Worker 主逻辑
// ================================================================
export default {
	async fetch(request, env, ctx) {
		// 【关键修复】env 必须在 fetch 函数内部调用，绝对不能放在文件最开头
		// 这里会自动读取你 Cloudflare 后台设置的 TOKEN，读不到就用默认的
		const userID = (env.TOKEN || defaultUUID).toLowerCase();
		
		// 【关键修复】自动兼容你设置的 KV 名字 (无论是 'KV' 还是 'KV_BLACKLIST')
		const DB = env.KV_BLACKLIST || env.KV;

		const url = new URL(request.url);
		const clientIP = request.headers.get('CF-Connecting-IP');
		const upgradeHeader = request.headers.get('Upgrade');

		// -------------------------------------------------------------
		// [模块 A] 管理员 API (一键封 IP)
		// -------------------------------------------------------------
		if (url.pathname.startsWith(adminPath)) {
			return handleAdmin(url, DB, adminKey);
		}

		// -------------------------------------------------------------
		// [模块 B] 用户黑名单拦截
		// -------------------------------------------------------------
		if (DB && clientIP) {
			const isBanned = await DB.get(`u_${clientIP}`);
			if (isBanned) {
				return new Response(BLOCK_MSG, { status: 403 });
			}
		}

		// -------------------------------------------------------------
		// [模块 C] VLESS 核心业务
		// -------------------------------------------------------------
		if (!upgradeHeader || upgradeHeader !== 'websocket') {
			// 返回伪装网页 (Dashboard)
			return new Response(`
			<!DOCTYPE html>
			<html>
			<head>
			<title>Worker Dashboard</title>
			<style>
				body { width: 35em; margin: 0 auto; font-family: Tahoma, Verdana, Arial, sans-serif; padding: 20px; }
				.status { color: green; font-weight: bold; }
				.error { color: red; font-weight: bold; }
				pre { background: #f4f4f4; padding: 10px; border-radius: 5px; overflow-x: auto; }
			</style>
			</head>
			<body>
			<h1>Worker Service Status</h1>
			<p>Service Status: <span class="status">Running</span></p>
			<p>Client IP: ${clientIP}</p>
			<p>Current UUID: ${userID}</p>
			<p>KV Database: ${DB ? '<span class="status">Connected</span>' : '<span class="error">Not Connected (Check Bindings)</span>'}</p>
			
			<hr>
			<h3>How to use Ban System:</h3>
			<p>Replace <code>${adminKey}</code> with your secret key.</p>
			<pre>
# Ban a User IP (Stop them from accessing):
https://${url.hostname}${adminPath}/ban?key=${adminKey}&type=user&ip=${clientIP}

# Ban a Target Node (Stop connection to a specific site):
https://${url.hostname}${adminPath}/ban?key=${adminKey}&type=node&ip=example.com

# Unban:
https://${url.hostname}${adminPath}/unban?key=${adminKey}&type=user&ip=${clientIP}
			</pre>
			</body>
			</html>`, {
				status: 200,
				headers: { "Content-Type": "text/html;charset=utf-8" },
			});
		} else {
			// 处理 VLESS 请求
			return await vlessOverWSHandler(request, userID, proxyIP, DB);
		}
	},
};

/**
 * 管理后台逻辑
 */
async function handleAdmin(url, DB, correctKey) {
	const key = url.searchParams.get("key");
	const type = url.searchParams.get("type"); 
	const ip = url.searchParams.get("ip");
	const action = url.pathname.split("/").pop(); 

	if (key !== correctKey) return new Response("Auth Failed: Incorrect Key", { status: 401 });
	if (!DB) return new Response("Error: KV Binding Not Found. Please bind KV in Cloudflare settings.", { status: 500 });
	if (!ip || !type) return new Response("Missing 'ip' or 'type' parameter", { status: 400 });

	const kvKey = type === 'user' ? `u_${ip}` : `n_${ip}`;

	if (action === 'ban') {
		await DB.put(kvKey, `Banned at ${new Date().toISOString()}`);
		return new Response(`🚫 Banned [${type}]: ${ip}`, { status: 200 });
	}
	if (action === 'unban') {
		await DB.delete(kvKey);
		return new Response(`✅ Unbanned [${type}]: ${ip}`, { status: 200 });
	}
	if (action === 'check') {
		const val = await DB.get(kvKey);
		return new Response(val ? `⚠️ Banned: ${val}` : `🆗 Clean`, { status: 200 });
	}
	return new Response("Invalid Action. Use /ban, /unban, or /check", { status: 400 });
}

/**
 * VLESS 处理核心逻辑 (包含完整的流处理和错误重试)
 */
async function vlessOverWSHandler(request, userID, proxyIP, DB) {
	const webSocketPair = new WebSocketPair();
	const [client, webSocket] = Object.values(webSocketPair);

	webSocket.accept();

	let address = '';
	let portWithRandomLog = '';
	const log = (info, event) => {
		console.log(`[${address}:${portWithRandomLog}] ${info}`, event || '');
	};
	const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';

	const readableWebSocketStream = makeReadableWebSocketStream(webSocket, earlyDataHeader, log);

	let remoteSocketWapper = { value: null };
	let udpStreamWrite = null;
	let isDns = false;

	// 流量转发管道
	readableWebSocketStream.pipeTo(new WritableStream({
		async write(chunk, controller) {
			if (isDns && udpStreamWrite) {
				return udpStreamWrite(chunk);
			}
			if (remoteSocketWapper.value) {
				const writer = remoteSocketWapper.value.writable.getWriter();
				await writer.write(chunk);
				writer.releaseLock();
				return;
			}

			const {
				hasError,
				message,
				portRemote = 443,
				addressRemote = '',
				rawDataIndex,
				vlessVersion = new Uint8Array([0, 0]),
				isUDP,
			} = processVlessHeader(chunk, userID);

			address = addressRemote;
			portWithRandomLog = `${portRemote}--${Math.random()} ${isUDP ? 'udp ' : 'tcp '}`;

			if (hasError) {
				console.log(message); // 打印错误日志但不断开，防止探测
				return; 
			}

			// [核心功能] 节点黑名单检查
			if (DB) {
				const isNodeBanned = await DB.get(`n_${addressRemote}`);
				if (isNodeBanned) {
					webSocket.close(1000, NODE_BLOCK_MSG);
					return;
				}
			}

			const vlessResponseHeader = new Uint8Array([vlessVersion[0], 0]);
			const rawClientData = chunk.slice(rawDataIndex);

			handleTCPOutBound(remoteSocketWapper, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, log, proxyIP);
		},
		close() { log(`readableWebSocketStream is close`); },
		abort(reason) { log(`readableWebSocketStream is abort`, JSON.stringify(reason)); },
	})).catch((err) => { log('readableWebSocketStream pipeTo error', err); });

	return new Response(null, {
		status: 101,
		webSocket: client,
	});
}

/**
 * 建立出站 TCP 连接 (包含重试逻辑)
 */
async function handleTCPOutBound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, log, proxyIP) {
	async function connectAndWrite(address, port) {
		const tcpSocket = connect({ hostname: address, port: port });
		remoteSocket.value = tcpSocket;
		log(`connected to ${address}:${port}`);
		const writer = tcpSocket.writable.getWriter();
		await writer.write(vlessResponseHeader);
		await writer.write(rawClientData);
		writer.releaseLock();
		return tcpSocket;
	}

	async function retry() {
		// 随机选择一个备用节点进行重试
		let retryAddr = proxyIP || addresses[Math.floor(Math.random() * addresses.length)]; 
		log(`retry connecting to ${retryAddr}...`);
		
		const tcpSocket = await connectAndWrite(retryAddr, portRemote);
		tcpSocket.closed.catch(error => console.log('retry tcpSocket closed error', error)).finally(() => safeCloseWebSocket(webSocket));
		remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, null, log);
	}

	try {
		const tcpSocket = await connectAndWrite(addressRemote, portRemote);
		remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, retry, log);
	} catch (e) {
		log(`connect error, retrying...`, e);
		retry();
	}
}

// ================================================================
// 4. 辅助工具函数 (协议解析等)
// ================================================================

function makeReadableWebSocketStream(webSocket, earlyDataHeader, log) {
	let readableStreamCancel = false;
	const stream = new ReadableStream({
		start(controller) {
			webSocket.addEventListener('message', (event) => {
				if (readableStreamCancel) return;
				controller.enqueue(event.data);
			});
			webSocket.addEventListener('close', () => {
				safeCloseWebSocket(webSocket);
				if (readableStreamCancel) return;
				controller.close();
			});
			webSocket.addEventListener('error', (err) => {
				log('webSocket server has error');
				controller.error(err);
			});
			const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
			if (error) controller.error(error);
			else if (earlyData) controller.enqueue(earlyData);
		},
		pull(controller) {},
		cancel(reason) {
			if (readableStreamCancel) return;
			log(`ReadableStream was canceled, due to ${reason}`);
			readableStreamCancel = true;
			safeCloseWebSocket(webSocket);
		}
	});
	return stream;
}

function processVlessHeader(vlessBuffer, userID) {
	if (vlessBuffer.byteLength < 24) return { hasError: true, message: 'invalid data' };
	const version = new Uint8Array(vlessBuffer.slice(0, 1));
	let isUDP = false;
	
	const optLength = new Uint8Array(vlessBuffer.slice(17, 18))[0];
	const command = new Uint8Array(vlessBuffer.slice(18 + optLength, 18 + optLength + 1))[0];

	if (command === 2) isUDP = true;
	const portIndex = 18 + optLength + 1;
	const portRemote = new DataView(vlessBuffer.slice(portIndex, portIndex + 2)).getUint16(0);
	const addressIndex = portIndex + 2;
	const addressType = new Uint8Array(vlessBuffer.slice(addressIndex, addressIndex + 1))[0];
	let addressLength = 0;
	let addressValueIndex = addressIndex + 1;
	let addressRemote = '';

	switch (addressType) {
		case 1: 
			addressLength = 4;
			addressRemote = new Uint8Array(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)).join('.');
			break;
		case 2: 
			addressLength = new Uint8Array(vlessBuffer.slice(addressValueIndex, addressValueIndex + 1))[0];
			addressValueIndex += 1;
			addressRemote = new TextDecoder().decode(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
			break;
		case 3: 
			addressLength = 16;
			const dataView = new DataView(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
			const ipv6 = [];
			for (let i = 0; i < 8; i++) ipv6.push(dataView.getUint16(i * 2).toString(16));
			addressRemote = ipv6.join(':');
			break;
		default: return { hasError: true, message: `invild addressType is ${addressType}` };
	}
	if (!addressRemote) return { hasError: true, message: `addressRemote is empty` };

	const rawDataIndex = addressValueIndex + addressLength;
	return { hasError: false, portRemote, addressRemote, rawDataIndex, vlessVersion: version, isUDP };
}

async function remoteSocketToWS(remoteSocket, webSocket, vlessResponseHeader, retry, log) {
	let vlessHeader = vlessResponseHeader;
	let hasIncomingData = false;
	await remoteSocket.readable.pipeTo(new WritableStream({
		start() {},
		async write(chunk, controller) {
			hasIncomingData = true;
			if (vlessHeader) {
				webSocket.send(await new Blob([vlessHeader, chunk]).arrayBuffer());
				vlessHeader = null;
			} else {
				webSocket.send(chunk);
			}
		},
		close() { log(`remoteSocket.readable is close`); },
		abort(reason) { console.error(`remoteSocket.readable abort`, reason); },
	})).catch((err) => console.error(`remoteSocketToWS error:`, err));
	if (hasIncomingData === false && retry) retry();
}

function base64ToArrayBuffer(base64Str) {
	if (!base64Str) return { earlyData: null, error: null };
	try {
		base64Str = base64Str.replace(/-/g, '+').replace(/_/g, '/');
		const decode = atob(base64Str);
		const arryBuffer = Uint8Array.from(decode, (c) => c.charCodeAt(0));
		return { earlyData: arryBuffer.buffer, error: null };
	} catch (error) { return { earlyData: null, error }; }
}

function safeCloseWebSocket(socket) {
	try { if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CLOSING) socket.close(); } 
	catch (error) { console.error('safeCloseWebSocket error', error); }
}

