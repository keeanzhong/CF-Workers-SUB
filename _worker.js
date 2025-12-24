/**
 * 终极诊断代码 v2.0
 * 作用：强制捕获所有错误，直接显示在浏览器上，防止 1101 页面。
 */

export default {
  async fetch(request, env, ctx) {
    // 1. 最外层错误捕获，确保不报 1101
    try {
      // --- 环境检查 ---
      const debugInfo = [];
      debugInfo.push("✅ Worker 已成功启动");
      debugInfo.push(`⌚ 时间: ${new Date().toLocaleString()}`);
      
      // 检查 KV 绑定
      if (env.KV) {
        debugInfo.push("✅ KV 数据库: 已连接");
        // 尝试读一个数据证明能用
        try {
          const val = await env.KV.get("TEST_KEY");
          debugInfo.push("✅ KV 读取权限: 正常");
        } catch (e) {
          debugInfo.push(`❌ KV 读取失败: ${e.message}`);
        }
      } else {
        debugInfo.push("❌ KV 数据库: 未找到 (变量名必须是 'KV')");
      }

      // 检查 Token
      const currentToken = env.TOKEN || "未设置";
      debugInfo.push(`🔑 当前 Token: ${currentToken}`);

      // --- 输出结果 ---
      const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>诊断成功</title>
        <style>
          body { font-family: sans-serif; padding: 20px; line-height: 1.6; }
          .card { background: #f0f9eb; border: 1px solid #c1e1c1; padding: 20px; border-radius: 8px; color: #2c662d; }
          .error { background: #fde2e2; border: 1px solid #f9cdcd; color: #a94442; }
          h2 { margin-top: 0; }
        </style>
      </head>
      <body>
        <div class="card ${!env.KV ? 'error' : ''}">
          <h2>🎉 恭喜！网站连接成功！</h2>
          <p>如果你看到了这个页面，说明之前的 522 和 1101 错误都已解决。</p>
          <hr>
          <strong>诊断详情：</strong>
          <pre>${debugInfo.join('\n')}</pre>
        </div>
        <p><strong>下一步：</strong><br>既然环境通了，现在告诉我（把截图发给我），我就会把完整的功能代码发给你覆盖回来。</p>
      </body>
      </html>
      `;

      return new Response(html, {
        headers: { "content-type": "text/html; charset=utf-8" }
      });

    } catch (err) {
      // 如果代码本身炸了，手动捕获并显示，而不是让 Cloudflare 报 1101
      return new Response(`❌ 致命错误 (已捕获):\n\n${err.stack}`, {
        status: 200, // 返回 200 让用户能看到错误
        headers: { "content-type": "text/plain; charset=utf-8" }
      });
    }
  }
};
