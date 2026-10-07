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

    if (!path.startsWith('/api/')) return env.ASSETS.fetch(request);

    try {
      // ========== 登录 / 注册 ==========
      if (path === '/api/login' && method === 'POST') {
        const { username, password, email } = await request.json();
        if (!username || !password) return json({ success: false, message: '用户名和密码不能为空' }, 400, cors);

        let user = await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(username).first();
        if (user) {
          if (user.password !== password) return json({ success: false, message: '密码错误' }, 401, cors);
        } else {
          const now = Date.now();
          await env.DB.prepare('INSERT INTO users (username, password, email, created_at) VALUES (?, ?, ?, ?)')
            .bind(username, password, email || '', now).run();
          user = { username, email, created_at: now };
        }
        return json({ success: true, user }, 200, cors);
      }

      // ========== 用户等级 ==========
      if (path === '/api/user/level' && method === 'GET') {
        const username = url.searchParams.get('username');
        if (!username) return json({ success: false, message: '缺少用户名' }, 400, cors);
        const user = await env.DB.prepare('SELECT created_at FROM users WHERE username = ?').bind(username).first();
        if (!user) return json({ success: false, message: '用户不存在' }, 404, cors);

        const roms = await env.DB.prepare('SELECT COUNT(*) as c FROM roms WHERE author = ?').bind(username).first();
        const hours = (Date.now() - user.created_at) / 3600000;
        let level = 0;
        if (roms.c > 0 && hours >= 1) level = 1;
        if (roms.c >= 3 && hours >= 24) level = 2;
        if (roms.c >= 5 && hours >= 72) level = 3;
        return json({ success: true, level, hours, romCount: roms.c }, 200, cors);
      }

      // ========== 获取 ROM 列表 ==========
      if (path === '/api/roms' && method === 'GET') {
        const { results } = await env.DB.prepare('SELECT * FROM roms ORDER BY created_at DESC').all();
        return json(results, 200, cors);
      }

      // ========== 获取单个 ROM ==========
      if (path.startsWith('/api/rom/') && method === 'GET') {
        const id = path.split('/').pop();
        const rom = await env.DB.prepare('SELECT * FROM roms WHERE id = ?').bind(id).first();
        if (!rom) return json({ success: false, message: 'ROM 不存在' }, 404, cors);
        // 浏览 +1
        await env.DB.prepare('UPDATE roms SET views = views + 1 WHERE id = ?').bind(id).run();
        return json(rom, 200, cors);
      }

      // ========== 发布 ROM ==========
      if (path === '/api/roms' && method === 'POST') {
        const body = await request.json();
        const { name, version, developer, url: romUrl, condition, code, author } = body;
        if (!name || !version || !developer || !romUrl || !author) {
          return json({ success: false, message: '请填写完整信息' }, 400, cors);
        }
        const now = Date.now();
        await env.DB.prepare(
          'INSERT INTO roms (name, version, developer, url, condition, code, author, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(name, version, developer, romUrl, condition, code || '', author, now).run();
        return json({ success: true }, 200, cors);
      }

      // ========== 我发布的 ==========
      if (path === '/api/roms/my' && method === 'GET') {
        const username = url.searchParams.get('username');
        if (!username) return json([], 200, cors);
        const { results } = await env.DB.prepare('SELECT * FROM roms WHERE author = ? ORDER BY created_at DESC').bind(username).all();
        return json(results, 200, cors);
      }

      // ========== 下载计数 ==========
      if (path === '/api/rom/download' && method === 'POST') {
        const { romId, username } = await request.json();
        if (!romId) return json({ success: false, message: '缺少ROM ID' }, 400, cors);
        await env.DB.prepare('INSERT INTO download_logs (rom_id, username, created_at) VALUES (?, ?, ?)')
          .bind(romId, username || '', Date.now()).run();
        await env.DB.prepare('UPDATE roms SET downloads = downloads + 1 WHERE id = ?').bind(romId).run();
        const rom = await env.DB.prepare('SELECT url FROM roms WHERE id = ?').bind(romId).first();
        return json({ success: true, url: rom ? rom.url : '' }, 200, cors);
      }

      // ========== 收藏 ==========
      if (path === '/api/favorite' && method === 'POST') {
        const { romId, username } = await request.json();
        if (!romId || !username) return json({ success: false, message: '参数缺失' }, 400, cors);
        const exist = await env.DB.prepare('SELECT id FROM favorites WHERE username = ? AND rom_id = ?').bind(username, romId).first();
        if (exist) {
          await env.DB.prepare('DELETE FROM favorites WHERE username = ? AND rom_id = ?').bind(username, romId).run();
          await env.DB.prepare('UPDATE roms SET favorites_count = favorites_count - 1 WHERE id = ?').bind(romId).run();
          return json({ success: true, favorited: false }, 200, cors);
        } else {
          await env.DB.prepare('INSERT INTO favorites (username, rom_id, created_at) VALUES (?, ?, ?)')
            .bind(username, romId, Date.now()).run();
          await env.DB.prepare('UPDATE roms SET favorites_count = favorites_count + 1 WHERE id = ?').bind(romId).run();
          return json({ success: true, favorited: true }, 200, cors);
        }
      }

      // ========== 检查是否已收藏 ==========
      if (path === '/api/favorite/check' && method === 'GET') {
        const username = url.searchParams.get('username');
        const romId = url.searchParams.get('romId');
        if (!username || !romId) return json({ favorited: false }, 200, cors);
        const exist = await env.DB.prepare('SELECT id FROM favorites WHERE username = ? AND rom_id = ?').bind(username, romId).first();
        return json({ favorited: !!exist }, 200, cors);
      }

      // ========== 我的收藏 ==========
      if (path === '/api/favorites/my' && method === 'GET') {
        const username = url.searchParams.get('username');
        if (!username) return json([], 200, cors);
        const { results } = await env.DB.prepare(
          'SELECT r.* FROM favorites f JOIN roms r ON f.rom_id = r.id WHERE f.username = ? ORDER BY f.created_at DESC'
        ).bind(username).all();
        return json(results, 200, cors);
      }

      // ========== 评论 ==========
      if (path === '/api/comments' && method === 'GET') {
        const romId = url.searchParams.get('romId');
        if (!romId) return json([], 200, cors);
        const { results } = await env.DB.prepare('SELECT * FROM comments WHERE rom_id = ? ORDER BY created_at DESC').bind(romId).all();
        return json(results, 200, cors);
      }

      if (path === '/api/comments' && method === 'POST') {
        const { romId, username, content } = await request.json();
        if (!romId || !username || !content) return json({ success: false, message: '参数缺失' }, 400, cors);
        await env.DB.prepare('INSERT INTO comments (rom_id, username, content, created_at) VALUES (?, ?, ?, ?)')
          .bind(romId, username, content, Date.now()).run();
        return json({ success: true }, 200, cors);
      }

      return json({ success: false, message: 'Not Found' }, 404, cors);

    } catch (e) {
      return json({ success: false, message: e.message }, 500, cors);
    }
  }
};

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  });
}