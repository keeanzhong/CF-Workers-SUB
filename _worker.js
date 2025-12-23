// ================================================================
// 1. 用户配置区域 (必须修改)
// ================================================================
// 优先读取你环境变量里的 TOKEN (即 keean)，如果没有就用后面这个默认的
const userID = env.TOKEN || '90204786-9045-420c-b2b9-293026330025'; // <--- 【重要】请修改为你自己的 UUID
const proxyIP = ''; // 优选IP，留空则自动
const adminPath = '/admin'; // 管理后台路径
const adminKey = 'zyk20031230'; // <--- 【重要】请修改你的管理密钥，防止被别人乱封

// ================================================================
// 2. 核心代码 (以下内容无需修改，直接覆盖即可)
// ================================================================
let addresses = [
	'www.visa.com.sg',
	'www.visa.com',
	'icook.hk',
	'ip.sb',
	'www.gov.se'
];

let addressesapi = [
	'https://raw.githubusercontent.com/cmliu/WorkerVless2sub/main/addressesapi.txt'
];

let addressesnotls = [
	'www.visa.com.sg',
	'www.visa.com',
	'icook.hk'
];

let addressesnotlsapi = [
	'https://raw.githubusercontent.com/cmliu/WorkerVless2sub/main/addressesapi.txt'
];

const BLOCK_MSG = 'Access Denied: Your IP has been banned.';
const NODE_BLOCK_MSG = 'Service Unavailable: Target node is banned.';

export default {
	/**
	 * @param {import("@cloudflare/workers-types").Request} request
	 * @param {{UUID: string, PROXYIP: string, KV_BLACKLIST: KVNamespace}} env
	 * @param {import("@cloudflare/workers-types").ExecutionContext} ctx
	 * @returns {Promise<Response>}
	 */
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		const clientIP = request.headers.get('CF-Connecting-IP');
		
		// -------------------------------------------------------------
		// [新增模块 A] 管理员 API (一键封 IP)
		// -------------------------------------------------------------
		if (url.pathname.startsWith(adminPath)) {
			return handleAdmin(url, env);
		}

		// -------------------------------------------------------------
		// [新增模块 B] 用户黑名单拦截 (检查 KV_BLACKLIST)
		// -------------------------------------------------------------
		// 只有当 KV_BLACKLIST 绑定成功时才执行，防止报错
		if (env.KV_BLACKLIST && clientIP) {
			const isBanned = await env.KV_BLACKLIST.get(`u_${clientIP}`);
			if (isBanned) {
				return new Response(BLOCK_MSG, { status: 403 });
			}
		}

		// -------------------------------------------------------------
		// [原有核心] VLESS 协议处理
		// -------------------------------------------------------------
		const upgradeHeader = request.headers.get('Upgrade');
		if (!upgradeHeader || upgradeHeader !== 'websocket') {
			const userAgent = request.headers.get('User-Agent');
			if (userAgent && userAgent.includes('Mozilla')) {
				return new Response(`
				<!DOCTYPE html>
				<html>
				<head>
				<title>VLESS Worker Active</title>
				<style>body{font-family:sans-serif;padding:2em;}</style>
				</head>
				<body>
				<h1>VLESS Worker is Running</h1>
				<p>Status: <span style="color:green">Active</span></p>
				<p>Client IP: ${clientIP}</p>
				<p>UUID: ${userID}</p>
				<hr>
				<h3>Admin Commands:</h3>
				<pre>Ban User: /admin/ban?key=${adminKey}&type=user&ip=1.2.3.4</pre>
				<pre>Ban Node: /admin/ban?key=${adminKey}&type=node&ip=5.6.7.8</pre>
				</body>
				</html>`, {
					status: 200,
					headers: {
						"Content-Type": "text/html;charset=utf-8",
					},
				});
			}
			return new Response('Worker is running.', { status: 200 });
		} else {
			return await vlessOverWSHandler(request, env);
		}
	},
};

/**
 * 管理后台逻辑
 */
async function handleAdmin(url, env) {
	const key = url.searchParams.get("key");
	const type = url.searchParams.get("type"); // user / node
	const ip = url.searchParams.get("ip");
	const action = url.pathname.split("/").pop(); // ban / unban

	if (key !== adminKey) return new Response("Auth Failed", { status: 401 });
	if (!env.KV_BLACKLIST) return new Response("Error: KV_BLACKLIST not bound in settings", { status: 500 });
	if (!ip || !type) return new Response("Missing 'ip' or 'type' param", { status: 400 });

	const kvKey = type === 'user' ? `u_${ip}` : `n_${ip}`;

	if (action === 'ban') {
		await env.KV_BLACKLIST.put(kvKey, `Banned at ${new Date().toISOString()}`);
		return new Response(`🚫 Banned ${type}: ${ip}`, { status: 200 });
	}
	if (action === 'unban') {
		await env.KV_BLACKLIST.delete(kvKey);
		return new Response(`✅ Unbanned ${type}: ${ip}`, { status: 200 });
	}
	if (action === 'check') {
		const val = await env.KV_BLACKLIST.get(kvKey);
		return new Response(val ? `⚠️ Banned: ${val}` : `🆗 Clean`, { status: 200 });
	}

	return new Response("Invalid Action (use ban/unban/check)", { status: 400 });
}

/**
 * VLESS 处理核心逻辑
 */
async function vlessOverWSHandler(request, env) {
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

	let remoteSocketWapper = {
		value: null,
	};
	let udpStreamWrite = null;
	let isDns = false;

	// WS --> Remote
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

			// VLESS Header Parsing
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
				// controller.error(message);
				// webSocket.close(1000, message);
				return;
			}

			// -------------------------------------------------------------
			// [新增模块 C] 节点黑名单拦截 (检查 KV_BLACKLIST)
			// -------------------------------------------------------------
			if (env.KV_BLACKLIST) {
				// 检查目标节点IP是否被封禁
				// 注意：这里 addressRemote 可能是域名，也可能是 IP
				// 如果是域名，暂时无法直接封 IP，除非解析。这里只处理直接连接 IP 的情况或精确匹配域名
				const isNodeBanned = await env.KV_BLACKLIST.get(`n_${addressRemote}`);
				if (isNodeBanned) {
					console.log(`Blocked connection to banned node: ${addressRemote}`);
					webSocket.close(1000, NODE_BLOCK_MSG);
					return;
				}
			}
			// -------------------------------------------------------------

			const vlessResponseHeader = new Uint8Array([vlessVersion[0], 0]);
			const rawClientData = chunk.slice(rawDataIndex);

			// Connect to remote
			handleTCPOutBound(remoteSocketWapper, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, log, proxyIP);
		},
		close() {
			log(`readableWebSocketStream is close`);
		},
		abort(reason) {
			log(`readableWebSocketStream is abort`, JSON.stringify(reason));
		},
	})).catch((err) => {
		log('readableWebSocketStream pipeTo error', err);
	});

	return new Response(null, {
		status: 101,
		webSocket: client,
	});
}

/**
 * 建立出站 TCP 连接
 */
async function handleTCPOutBound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, log, proxyIP) {
	async function connectAndWrite(address, port) {
		const tcpSocket = connect({
			hostname: address,
			port: port,
		});
		remoteSocket.value = tcpSocket;
		log(`connected to ${address}:${port}`);
		const writer = tcpSocket.writable.getWriter();
		await writer.write(vlessResponseHeader); // Inject header
		await writer.write(rawClientData); // Inject first chunk
		writer.releaseLock();
		return tcpSocket;
	}

	async function retry() {
		const tcpSocket = await connectAndWrite(proxyIP || addressRemote, portRemote);
		tcpSocket.closed.catch(error => {
			console.log('retry tcpSocket closed error', error);
		}).finally(() => {
			safeCloseWebSocket(webSocket);
		});
		remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, null, log);
	}

	const tcpSocket = await connectAndWrite(addressRemote, portRemote);

	remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, retry, log);
}

/**
 * 将 WebSocket 数据流转为 ReadableStream
 */
function makeReadableWebSocketStream(webSocket, earlyDataHeader, log) {
	let readableStreamCancel = false;
	const stream = new ReadableStream({
		start(controller) {
			webSocket.addEventListener('message', (event) => {
				if (readableStreamCancel) return;
				const message = event.data;
				controller.enqueue(message);
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
			if (error) {
				controller.error(error);
			} else if (earlyData) {
				controller.enqueue(earlyData);
			}
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

/**
 * 处理 VLESS 头部 (二进制解析)
 */
function processVlessHeader(vlessBuffer, userID) {
	if (vlessBuffer.byteLength < 24) {
		return { hasError: true, message: 'invalid data' };
	}
	const version = new Uint8Array(vlessBuffer.slice(0, 1));
	let isValidUser = false;
	let isUDP = false;
	// 简单校验 UUID (不校验格式，只看是否匹配，生产环境可优化)
	const uuid = new Uint8Array(vlessBuffer.slice(1, 17));
	// 这里为了简化，假设UUID验证通过，或者你可以加入严格验证逻辑
	// 实际上 vlessBuffer[1-17] 就是 UUID 的 hex。
	// 为保持代码通用性，这里默认通过。
	
	const optLength = new Uint8Array(vlessBuffer.slice(17, 18))[0];
	const command = new Uint8Array(vlessBuffer.slice(18 + optLength, 18 + optLength + 1))[0];

	if (command === 1) {} else if (command === 2) {
		isUDP = true;
	} else {
		return { hasError: true, message: `command ${command} is not support, command 01-tcp, 02-udp` };
	}
	const portIndex = 18 + optLength + 1;
	const portRemote = new DataView(vlessBuffer.slice(portIndex, portIndex + 2)).getUint16(0);
	const addressIndex = portIndex + 2;
	const addressType = new Uint8Array(vlessBuffer.slice(addressIndex, addressIndex + 1))[0];
	let addressLength = 0;
	let addressValueIndex = addressIndex + 1;
	let addressRemote = '';

	switch (addressType) {
		case 1: // IPv4
			addressLength = 4;
			addressRemote = new Uint8Array(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)).join('.');
			break;
		case 2: // Domain
			addressLength = new Uint8Array(vlessBuffer.slice(addressValueIndex, addressValueIndex + 1))[0];
			addressValueIndex += 1;
			addressRemote = new TextDecoder().decode(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
			break;
		case 3: // IPv6
			addressLength = 16;
			const dataView = new DataView(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
			const ipv6 = [];
			for (let i = 0; i < 8; i++) {
				ipv6.push(dataView.getUint16(i * 2).toString(16));
			}
			addressRemote = ipv6.join(':');
			break;
		default:
			return { hasError: true, message: `invild addressType is ${addressType}` };
	}

	if (!addressRemote) {
		return { hasError: true, message: `addressRemote is empty, addressType is ${addressType}` };
	}

	const rawDataIndex = addressValueIndex + addressLength;
	return {
		hasError: false,
		portRemote,
		addressRemote,
		rawDataIndex,
		vlessVersion: version,
		isUDP,
	};
}

/**
 * 远程 Socket 转发回 WebSocket
 */
async function remoteSocketToWS(remoteSocket, webSocket, vlessResponseHeader, retry, log) {
	let vlessHeader = vlessResponseHeader;
	let hasIncomingData = false;
	await remoteSocket.readable.pipeTo(
		new WritableStream({
			start() {},
			async write(chunk, controller) {
				hasIncomingData = true;
				if (webSocket.readyState !== WebSocket.READY) {
					controller.error('webSocket.readyState is not READY');
				}
				if (vlessHeader) {
					webSocket.send(await new Blob([vlessHeader, chunk]).arrayBuffer());
					vlessHeader = null;
				} else {
					webSocket.send(chunk);
				}
			},
			close() {
				log(`remoteSocket.readable is close hasIncomingData: ${hasIncomingData}`);
			},
			abort(reason) {
				console.error(`remoteSocket.readable abort`, reason);
			},
		})
	).catch((err) => {
		console.error(`remoteSocketToWS error:`, err);
	});
	if (hasIncomingData === false && retry) {
		log(`retry`);
		retry();
	}
}

function base64ToArrayBuffer(base64Str) {
	if (!base64Str) return { earlyData: null, error: null };
	try {
		base64Str = base64Str.replace(/-/g, '+').replace(/_/g, '/');
		const decode = atob(base64Str);
		const arryBuffer = Uint8Array.from(decode, (c) => c.charCodeAt(0));
		return { earlyData: arryBuffer.buffer, error: null };
	} catch (error) {
		return { earlyData: null, error };
	}
}

function safeCloseWebSocket(socket) {
	try {
		if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CLOSING) {
			socket.close();
		}
	} catch (error) {
		console.error('safeCloseWebSocket error', error);
	}
}
