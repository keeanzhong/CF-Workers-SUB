/**
 * CF-Workers-SUB (Service Worker 兼容版)
 * 专治 Error 1101
 * 适用于 GitHub 部署且环境配置为 Legacy 的情况
 */

// 监听 fetch 事件 (这是 Service Worker 的标志)
addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

// 默认配置
const DEFAULT_Config = {
    TOKEN: 'auto',
    pwd: 'zyk20031230',
    // 如果 KV 没绑定成功，这里会作为最后一道防线
    MockLink: 'vmess://Error_KV_Not_Bound' 
};

async function handleRequest(request) {
  try {
    const url = new URL(request.url);
    const path = url.pathname;
    
    // --- 1. 变量获取 (Service Worker 模式下，变量是全局的) ---
    // 我们尝试读取全局变量，如果读不到就用默认值，防止报错 1101
    let myToken = DEFAULT_Config.TOKEN;
    if (typeof TOKEN !== 'undefined') myToken = TOKEN;

    let myKV = null;
    if (typeof KV !== 'undefined') myKV = KV;

    // --- 2. 探针检查 (访问 /_ping 看活不活) ---
    if (path === '/_ping') {
        return new Response(`Pong! Service Worker Mode. KV status: ${myKV ? 'OK' : 'Missing'}`, { status: 200 });
    }

    // --- 3. 后台入口 ---
    // 兼容 /admin_panel 和 /<token>/admin_panel
    if (path.includes('/admin_panel')) {
        // 检查密码
        const pwdParam = url.searchParams.get('p');
        if (pwdParam !== DEFAULT_Config.pwd) {
            return new Response('Unauthorized (SW Mode)', { status: 401 });
        }

        if (!myKV) {
            return new Response("严重错误：KV 全局变量未定义。请检查 Cloudflare 后台变量绑定是否名为 'KV'。", { status: 500 });
        }

        // 简单的 KV 编辑逻辑
        return await handleAdmin(myKV, request);
    }

    // --- 4. 订阅逻辑 ---
    // 校验 Token
    const urlToken = url.searchParams.get('token');
    const isTokenValid = (urlToken === myToken) || path.startsWith(`/${myToken}`);

    if (!isTokenValid) {
        return new Response("Worker is running (SW Mode). Token Error.", { status: 200 });
    }

    // 读取节点
    let content = "";
    if (myKV) {
        content = await myKV.get('LINK.txt');
    }

    if (!content) {
        content = "No nodes found in KV. Please go to admin_panel to add.";
    }

    // 输出 Base64
    return new Response(btoa(content), {
        headers: { "content-type": "text/plain; charset=utf-8" }
    });

  } catch (err) {
    // 捕获所有错误，打印出来，不再报 1101
    return new Response(`❌ Worker Error (SW Mode):\n${err.message}\n${err.stack}`, { status: 500 });
  }
}

// 简易后台处理
async function handleAdmin(db, request) {
    // 如果是保存请求
    if (request.method === 'POST') {
        const text = await request.text();
        await db.put('LINK.txt', text);
        return new Response("保存成功 (Saved)", { status: 200 });
    }

    // 读取当前配置
    const current = await db.get('LINK.txt') || '';
    
    const html = `
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"><title>SW Admin</title></head>
    <body style="padding: 20px; font-family: sans-serif;">
        <h2 style="color: green">✅ Service Worker 模式运行正常</h2>
        <form>
            <p>编辑节点配置 (LINK.txt):</p>
            <textarea id="box" style="width:100%; height:400px">${current}</textarea>
            <br><br>
            <button type="button" onclick="save()" style="padding:10px 20px">保存配置</button>
        </form>
        <script>
            async function save() {
                const txt = document.getElementById('box').value;
                await fetch(window.location.href, { method: 'POST', body: txt });
                alert('已保存!');
            }
        </script>
    </body>
    </html>
    `;
    return new Response(html, { headers: { 'content-type': 'text/html' }});
}
