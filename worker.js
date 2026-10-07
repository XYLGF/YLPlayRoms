// ============================================================
// 工具：生成 18 位雪花风格 ID
// ============================================================
function generateSlug() {
  const ts = Date.now();                              // 13 位毫秒时间戳
  const rand = Math.floor(Math.random() * 100000);    // 5 位随机数
  return String(ts) + String(rand).padStart(5, '0');  // 18 位
}

// ============================================================
// 工具：SHA-256 + 盐哈希
// ============================================================
async function hashPassword(password, salt) {
  const encoder = new TextEncoder();
  const data = encoder.encode(salt + ':' + password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// ============================================================
// 工具：JSON 响应
// ============================================================
function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...headers
    }
  });
}

// ============================================================
// 主入口
// ============================================================
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (method === 'OPTIONS') return new Response(null, { headers: cors });

    // ========================================================
    // 路由分发
    // ========================================================
    if (path.startsWith('/api/')) {
      // API 请求 → 走下面的 API 逻辑
    } else if (path.includes('.')) {
      // 有后缀（.html/.css/.js/.png...）→ 静态资源
      return env.ASSETS.fetch(request);
    } else {
      // 无后缀（/system/xxx、/ 等）→ 返回 index.html 由前端路由处理
      const indexUrl = new URL(request.url);
      indexUrl.pathname = '/index.html';
      return env.ASSETS.fetch(new Request(indexUrl, request));
    }

    try {
      // ========================================================
      // 注册
      // ========================================================
      if (path === '/api/register' && method === 'POST') {
        const { username, password, email } = await request.json();
        if (!username || !password) {
          return json({ success: false, message: '用户名和密码不能为空' }, 400, cors);
        }
        if (username.length < 2 || username.length > 20) {
          return json({ success: false, message: '用户名长度 2-20 位' }, 400, cors);
        }
        if (password.length < 4) {
          return json({ success: false, message: '密码至少 4 位' }, 400, cors);
        }

        const exist = await env.DB.prepare('SELECT id FROM users WHERE username = ?')
          .bind(username).first();
        if (exist) {
          return json({ success: false, message: '用户名已被注册' }, 409, cors);
        }

        const salt = crypto.randomUUID();
        const hashed = await hashPassword(password, salt);
        const now = Date.now();

        await env.DB.prepare(
          'INSERT INTO users (username, password, salt, email, created_at) VALUES (?, ?, ?, ?, ?)'
        ).bind(username, hashed, salt, email || '', now).run();

        return json({ success: true, message: '注册成功' }, 200, cors);
      }

      // ========================================================
      // 登录
      // ========================================================
      if (path === '/api/login' && method === 'POST') {
        const { username, password } = await request.json();
        if (!username || !password) {
          return json({ success: false, message: '用户名和密码不能为空' }, 400, cors);
        }

        const user = await env.DB.prepare('SELECT * FROM users WHERE username = ?')
          .bind(username).first();

        if (!user) {
          return json({ success: false, message: '用户不存在，请先注册' }, 404, cors);
        }

        let isMatch = false;
        if (user.salt && user.password.length === 64) {
          const hashed = await hashPassword(password, user.salt);
          isMatch = (hashed === user.password);
        } else {
          if (user.password === password) {
            isMatch = true;
            const salt = crypto.randomUUID();
            const hashed = await hashPassword(password, salt);
            await env.DB.prepare(
              'UPDATE users SET password = ?, salt = ? WHERE id = ?'
            ).bind(hashed, salt, user.id).run();
          }
        }

        if (!isMatch) {
          return json({ success: false, message: '密码错误' }, 401, cors);
        }

        return json({
          success: true,
          user: { username: user.username, email: user.email, created_at: user.created_at }
        }, 200, cors);
      }

      // ========================================================
      // 用户等级
      // ========================================================
      if (path === '/api/user/level' && method === 'GET') {
        const username = url.searchParams.get('username');
        if (!username) return json({ success: false, message: '缺少用户名' }, 400, cors);

        const user = await env.DB.prepare('SELECT created_at FROM users WHERE username = ?')
          .bind(username).first();
        if (!user) return json({ success: false, message: '用户不存在' }, 404, cors);

        const roms = await env.DB.prepare('SELECT COUNT(*) as c FROM roms WHERE author = ?')
          .bind(username).first();
        const hours = (Date.now() - user.created_at) / 3600000;
        let level = 0;
        if (roms.c > 0 && hours >= 1) level = 1;
        if (roms.c >= 3 && hours >= 24) level = 2;
        if (roms.c >= 5 && hours >= 72) level = 3;

        return json({ success: true, level, hours, romCount: roms.c }, 200, cors);
      }

      // ========================================================
      // 获取 ROM 列表
      // ========================================================
      if (path === '/api/roms' && method === 'GET') {
        const { results } = await env.DB.prepare(
          'SELECT * FROM roms ORDER BY created_at DESC'
        ).all();
        return json(results, 200, cors);
      }

      // ========================================================
      // 按 slug 获取单个 ROM（必须在 /api/rom/:id 之前）
      // ========================================================
      if (path.startsWith('/api/rom/by-slug/') && method === 'GET') {
        const slug = path.split('/').pop();
        const rom = await env.DB.prepare('SELECT * FROM roms WHERE slug = ?').bind(slug).first();
        if (!rom) return json({ success: false, message: 'ROM 不存在' }, 404, cors);
        await env.DB.prepare('UPDATE roms SET views = views + 1 WHERE id = ?').bind(rom.id).run();
        return json(rom, 200, cors);
      }

      // ========================================================
      // 按 id 获取单个 ROM
      // ========================================================
      if (path.startsWith('/api/rom/') && method === 'GET') {
        const id = path.split('/').pop();
        const rom = await env.DB.prepare('SELECT * FROM roms WHERE id = ?').bind(id).first();
        if (!rom) return json({ success: false, message: 'ROM 不存在' }, 404, cors);
        await env.DB.prepare('UPDATE roms SET views = views + 1 WHERE id = ?').bind(id).run();
        return json(rom, 200, cors);
      }

      // ========================================================
      // 发布 ROM
      // ========================================================
      if (path === '/api/roms' && method === 'POST') {
        const body = await request.json();
        const { name, version, developer, url: romUrl, condition, code, author } = body;
        if (!name || !version || !developer || !romUrl || !author) {
          return json({ success: false, message: '请填写完整信息' }, 400, cors);
        }

        // 生成唯一 slug
        let slug = null;
        for (let i = 0; i < 5; i++) {
          const candidate = generateSlug();
          const exist = await env.DB.prepare('SELECT id FROM roms WHERE slug = ?').bind(candidate).first();
          if (!exist) { slug = candidate; break; }
        }
        if (!slug) {
          return json({ success: false, message: '生成ID失败，请重试' }, 500, cors);
        }

        const now = Date.now();
        await env.DB.prepare(
          'INSERT INTO roms (name, version, developer, url, condition, code, author, slug, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(name, version, developer, romUrl, condition, code || '', author, slug, now).run();

        return json({ success: true, slug }, 200, cors);
      }

      // ========================================================
      // 我发布的 ROM
      // ========================================================
      if (path === '/api/roms/my' && method === 'GET') {
        const username = url.searchParams.get('username');
        if (!username) return json([], 200, cors);
        const { results } = await env.DB.prepare(
          'SELECT * FROM roms WHERE author = ? ORDER BY created_at DESC'
        ).bind(username).all();
        return json(results, 200, cors);
      }

      // ========================================================
      // 下载计数
      // ========================================================
      if (path === '/api/rom/download' && method === 'POST') {
        const { romId, username } = await request.json();
        if (!romId) return json({ success: false, message: '缺少ROM ID' }, 400, cors);
        await env.DB.prepare(
          'INSERT INTO download_logs (rom_id, username, created_at) VALUES (?, ?, ?)'
        ).bind(romId, username || '', Date.now()).run();
        await env.DB.prepare('UPDATE roms SET downloads = downloads + 1 WHERE id = ?')
          .bind(romId).run();
        const rom = await env.DB.prepare('SELECT url FROM roms WHERE id = ?').bind(romId).first();
        return json({ success: true, url: rom ? rom.url : '' }, 200, cors);
      }

      // ========================================================
      // 收藏切换
      // ========================================================
      if (path === '/api/favorite' && method === 'POST') {
        const { romId, username } = await request.json();
        if (!romId || !username) return json({ success: false, message: '参数缺失' }, 400, cors);

        const exist = await env.DB.prepare(
          'SELECT id FROM favorites WHERE username = ? AND rom_id = ?'
        ).bind(username, romId).first();

        if (exist) {
          await env.DB.prepare('DELETE FROM favorites WHERE username = ? AND rom_id = ?')
            .bind(username, romId).run();
          await env.DB.prepare('UPDATE roms SET favorites_count = favorites_count - 1 WHERE id = ?')
            .bind(romId).run();
          return json({ success: true, favorited: false }, 200, cors);
        } else {
          await env.DB.prepare(
            'INSERT INTO favorites (username, rom_id, created_at) VALUES (?, ?, ?)'
          ).bind(username, romId, Date.now()).run();
          await env.DB.prepare('UPDATE roms SET favorites_count = favorites_count + 1 WHERE id = ?')
            .bind(romId).run();
          return json({ success: true, favorited: true }, 200, cors);
        }
      }

      // ========================================================
      // 检查是否已收藏
      // ========================================================
      if (path === '/api/favorite/check' && method === 'GET') {
        const username = url.searchParams.get('username');
        const romId = url.searchParams.get('romId');
        if (!username || !romId) return json({ favorited: false }, 200, cors);
        const exist = await env.DB.prepare(
          'SELECT id FROM favorites WHERE username = ? AND rom_id = ?'
        ).bind(username, romId).first();
        return json({ favorited: !!exist }, 200, cors);
      }

      // ========================================================
      // 我的收藏
      // ========================================================
      if (path === '/api/favorites/my' && method === 'GET') {
        const username = url.searchParams.get('username');
        if (!username) return json([], 200, cors);
        const { results } = await env.DB.prepare(
          'SELECT r.* FROM favorites f JOIN roms r ON f.rom_id = r.id WHERE f.username = ? ORDER BY f.created_at DESC'
        ).bind(username).all();
        return json(results, 200, cors);
      }

      // ========================================================
      // 评论列表
      // ========================================================
      if (path === '/api/comments' && method === 'GET') {
        const romId = url.searchParams.get('romId');
        if (!romId) return json([], 200, cors);
        const { results } = await env.DB.prepare(
          'SELECT * FROM comments WHERE rom_id = ? ORDER BY created_at DESC'
        ).bind(romId).all();
        return json(results, 200, cors);
      }

      // ========================================================
      // 发布评论
      // ========================================================
      if (path === '/api/comments' && method === 'POST') {
        const { romId, username, content } = await request.json();
        if (!romId || !username || !content) {
          return json({ success: false, message: '参数缺失' }, 400, cors);
        }
        await env.DB.prepare(
          'INSERT INTO comments (rom_id, username, content, created_at) VALUES (?, ?, ?, ?)'
        ).bind(romId, username, content, Date.now()).run();
        return json({ success: true }, 200, cors);
      }

      return json({ success: false, message: 'Not Found' }, 404, cors);

    } catch (e) {
      return json({ success: false, message: e.message }, 500, cors);
    }
  }
};