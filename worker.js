export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // 非 API 请求 → 交给静态资源 (index.html)
    if (!path.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    try {
      // ---------- 登录 / 注册 ----------
      if (path === '/api/login' && method === 'POST') {
        const { username, password, email } = await request.json();
        if (!username || !password) {
          return json({ success: false, message: '用户名和密码不能为空' }, 400, corsHeaders);
        }

        let user = await env.DB.prepare(
          'SELECT * FROM users WHERE username = ?'
        ).bind(username).first();

        if (user) {
          if (user.password !== password) {
            return json({ success: false, message: '密码错误' }, 401, corsHeaders);
          }
        } else {
          await env.DB.prepare(
            'INSERT INTO users (username, password, email, created_at) VALUES (?, ?, ?, ?)'
          ).bind(username, password, email || '', Date.now()).run();
          user = { username, email };
        }

        return json({ success: true, user }, 200, corsHeaders);
      }

      // ---------- 获取所有 ROM ----------
      if (path === '/api/roms' && method === 'GET') {
        const { results } = await env.DB.prepare(
          'SELECT * FROM roms ORDER BY created_at DESC'
        ).all();
        return json(results, 200, corsHeaders);
      }

      // ---------- 发布 ROM ----------
      if (path === '/api/roms' && method === 'POST') {
        const { name, version, developer, url, condition, code } = await request.json();
        if (!name || !version || !developer || !url) {
          return json({ success: false, message: '请填写完整信息' }, 400, corsHeaders);
        }

        await env.DB.prepare(
          'INSERT INTO roms (name, version, developer, url, condition, code, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).bind(name, version, developer, url, condition, code || '', Date.now()).run();

        return json({ success: true }, 200, corsHeaders);
      }

      return json({ success: false, message: 'Not Found' }, 404, corsHeaders);

    } catch (e) {
      return json({ success: false, message: e.message }, 500, corsHeaders);
    }
  }
};

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  });
}