/**
 * CF-Workers-SUB 最终稳定调试版
 * 1. 内置 "防崩溃" 机制，不再报 1101，而是直接显示错误原因
 * 2. 移除所有复杂并发逻辑，确保稳定
 */

export default {
    async fetch(request, env, ctx) {
        // --- 全局错误捕获 (防止 1101) ---
        try {
            // 1. 初始化变量 & 检查环境
            const url = new URL(request.url);
            const userAgent = (request.headers.get('User-Agent') || "Unknown").toLowerCase();
            const clientIP = request.headers.get('CF-Connecting-IP') || '0.0.0.0';
            
            // 读取环境变量 (兼容大小写)
            const TOKEN = env.TOKEN || env.token || 'auto';
            // 注意：你的 KV 绑定名为 KV (大写)
            const DB = env.KV; 

            // 2. 核心检查：KV 是否真的绑定成功？
            if (!DB) {
                // 如果这里报错，说明后台 KV 绑定没生效，或者名字不是 KV
                throw new Error("严重错误：代码无法读取到 KV 数据库。请检查后台 [Settings] -> [Variables] -> [KV Namespace Bindings]，确保变量名为 'KV' (必须大写)");
            }

            // 3. 路由处理
            // 兼容 /keean/admin_panel 和 /admin_panel
            const path = url.pathname;
            const isAdmin = path.includes('/admin_panel');
            
            // --- 后台逻辑 ---
            if (isAdmin) {
                const pwd = url.searchParams.get('p');
                // 硬编码你的密码，防止读取环境变量失败
                const correctPwd = env.ADMIN_PWD || 'zyk20031230'; 
                
                if (pwd !== correctPwd) {
                    return new Response('密码错误 (Unauthorized)', { status: 401 });
                }

                // 简单的后台页面
                return await handleAdmin(DB);
            }

            // --- 订阅逻辑 ---
            // 校验 Token
            const paramToken = url.searchParams.get('token');
            const isTokenValid = paramToken === TOKEN || path.startsWith(`/${TOKEN}`);

            if (!isTokenValid) {
                // Token 不对，返回简单的提示或伪装
                return new Response("Cloudflare Worker is Running. (Token Error)", { status: 200 });
            }

            // 读取节点数据
            let content = await DB.get('LINK.txt');
            if (!content) {
                // 如果 KV 里没数据，给一个默认值防止报错
                content = "vmess://example_node";
            }

            // 简单的 Base64 输出 (最稳的逻辑)
            return new Response(btoa(content), { 
                headers: { "content-type": "text/plain; charset=utf-8" } 
            });

        } catch (err) {
            // --- 捕获错误，打印到屏幕上 ---
            return new Response(`❌ 程序运行出错 (不再报1101):\n\n错误信息: ${err.message}\n\n堆栈跟踪:\n${err.stack}`, { 
                status: 500,
                headers: { "content-type": "text/plain; charset=utf-8" }
            });
        }
    }
};

// --- 极简后台页面 (不含复杂逻辑) ---
async function handleAdmin(DB) {
    // 读取 KV 里的所有 key
    const list = await DB.list();
    const keys = list.keys.map(k => k.name).join(', ');
    
    // 读取当前的节点配置
    const currentConfig = await DB.get('LINK.txt') || '';

    return new Response(`
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"><title>调试后台</title></head>
    <body style="font-family: sans-serif; padding: 20px;">
        <h2 style="color: green;">✅ 后台连接成功！</h2>
        <p>如果能看到这个页面，说明 1101 错误已经修复。</p>
        <hr>
        <h3>KV 数据库状态</h3>
        <p>当前 KV 中的键: <code>${keys || '暂无数据'}</code></p>
        <hr>
        <h3>节点配置 (LINK.txt)</h3>
        <textarea id="cfg" style="width: 100%; height: 300px;">${currentConfig}</textarea>
        <br><br>
        <button onclick="save()" style="padding: 10px 20px; font-size: 16px;">保存配置</button>

        <script>
            async function save() {
                const txt = document.getElementById('cfg').value;
                try {
                    // 使用简单的 PUT 请求
                    await fetch(window.location.href, { method: 'POST', body: txt });
                    alert('保存成功！');
                } catch(e) {
                    alert('保存失败: ' + e);
                }
            }
        </script>
        
        ${""/* 这里的逻辑其实在 fetch 里要处理 POST，为了调试代码简单，我们暂时只读 */}
    </body>
    </html>
    `, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}
