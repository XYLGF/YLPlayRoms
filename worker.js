// ============================================================
// 工具：生成 18 位雪花风格 ID
// ============================================================
function generateSlug() {
  const ts = Date.now();
  const rand = Math.floor(Math.random() * 100000);
  return String(ts) + String(rand).padStart(5, '0');
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
// 工具：查用户角色
// ============================================================
async function getUserRole(env, username) {
  if (!username) return 'guest';
  const user = await env.DB.prepare('SELECT role, banned FROM users WHERE username = ?')
    .bind(username).first();
  if (!user) return 'guest';
  if (user.banned === 1) return 'banned';
  return user.role || 'user';
}

// ============================================================
// 工具：生成 6 位验证码
// ============================================================
function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// ============================================================
// 工具：发邮件（Resend）
// ============================================================
async function sendEmail(apiKey, to, code) {
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'YL Play Roms <noreply@xylplay.top>',
        to: [to],
        subject: 'YL Play Roms 注册验证码',
        html: `<div style="font-family:sans-serif;padding:20px;">
          <h2>YL Play Roms 注册验证码</h2>
          <p>你的验证码是：</p>
          <p style="font-size:32px;font-weight:bold;letter-spacing:8px;color:#6750a4;">${code}</p>
          <p style="color:#666;">10 分钟内有效，请勿泄露。</p>
        </div>`
      })
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error('Resend 发送失败:', res.status, errText);
      return false;
    }
    return true;
  } catch (e) {
    console.error('Resend 请求异常:', e.message);
    return false;
  }
}

// ============================================================
// 工具：根据触发次数算拉黑时长（毫秒）
// ============================================================
function getBanDuration(count) {
  if (count <= 3) return 0;
  if (count === 4) return 3600000;
  if (count === 5) return 24 * 3600000;
  if (count === 6) return 3 * 24 * 3600000;
  return 7 * 24 * 3600000;
}

function getBanMessage(count) {
  if (count === 4) return '操作过于频繁，请 1 小时后再试';
  if (count === 5) return '操作过于频繁，请 24 小时后再试';
  if (count === 6) return '操作过于频繁，请 3 天后再试';
  return '操作过于频繁，请 7 天后再试';
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

    // 路由分发
    if (path.startsWith('/api/')) {
      // API 请求
    } else if (path.includes('.')) {
      return env.ASSETS.fetch(request);
    } else {
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

        // ===== 基础校验 =====
        if (!username || !password) return json({ success: false, message: '用户名和密码不能为空' }, 400, cors);
        if (username.length < 2 || username.length > 20) return json({ success: false, message: '用户名长度 2-20 位' }, 400, cors);
        if (password.length < 4) return json({ success: false, message: '密码至少 4 位' }, 400, cors);
        if (['super', 'root', 'admin'].includes(username)) return json({ success: false, message: '该用户名不可注册' }, 403, cors);
        if (username.toLowerCase().startsWith('user')) return json({ success: false, message: '该用户名不可用' }, 403, cors);
        if (!/^[\w\u4e00-\u9fa5]{2,20}$/.test(username)) return json({ success: false, message: '用户名只能包含字母/数字/下划线/中文' }, 400, cors);

        const exist = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
        if (exist) return json({ success: false, message: '用户名已被注册' }, 409, cors);

        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
        const now = Date.now();

        // ===== 黑名单检查 =====
        const blacklisted = await env.DB.prepare(
          'SELECT * FROM ip_blacklist WHERE ip = ? AND expires_at > ?'
        ).bind(ip, now).first();

        if (blacklisted) {
          const remainMs = blacklisted.expires_at - now;
          const remainMin = Math.ceil(remainMs / 60000);
          let remainText;
          if (remainMin < 60) remainText = remainMin + ' 分钟';
          else if (remainMin < 1440) remainText = Math.ceil(remainMin / 60) + ' 小时';
          else remainText = Math.ceil(remainMin / 1440) + ' 天';
          return json({
            success: false,
            message: `您的网络已被限制注册，请 ${remainText}后再试`
          }, 403, cors);
        }

        // ===== 记录本次尝试 =====
        await env.DB.prepare(
          'INSERT INTO ip_request_logs (ip, action, created_at) VALUES (?, ?, ?)'
        ).bind(ip, 'register_attempt', now).run();

        const oneHourAgo = now - 3600000;
        const attempts = await env.DB.prepare(
          'SELECT COUNT(*) as c FROM ip_request_logs WHERE ip = ? AND action = "register_attempt" AND created_at > ?'
        ).bind(ip, oneHourAgo).first();

        const attemptCount = attempts.c;

        // ===== 尝试次数过多，拉黑 =====
        if (attemptCount >= 4) {
          const banDuration = getBanDuration(attemptCount);
          const expiresAt = now + banDuration;
          await env.DB.prepare(
            'INSERT OR REPLACE INTO ip_blacklist (ip, reason, trigger_count, created_at, expires_at) VALUES (?, ?, ?, ?, ?)'
          ).bind(ip, '频繁注册', attemptCount, now, expiresAt).run();

          return json({
            success: false,
            message: getBanMessage(attemptCount)
          }, 429, cors);
        }

        // ===== 判断是否需要邮箱验证 =====
        const recentCount = await env.DB.prepare(
          'SELECT COUNT(*) as c FROM register_logs WHERE ip = ? AND created_at > ?'
        ).bind(ip, oneHourAgo).first();

        const needEmail = recentCount.c >= 1;

        // ===== 同 IP 1 小时内首次：直接注册 =====
        if (!needEmail) {
          const salt = crypto.randomUUID();
          const hashed = await hashPassword(password, salt);
          await env.DB.prepare(
            'INSERT INTO users (username, password, salt, email, role, banned, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)'
          ).bind(username, hashed, salt, email || '', 'user', now).run();
          await env.DB.prepare(
            'INSERT INTO register_logs (ip, email, created_at) VALUES (?, ?, ?)'
          ).bind(ip, email || '', now).run();
          return json({ success: true, message: '注册成功' }, 200, cors);
        }

        // ===== 需要邮箱验证 =====
        if (!email || !email.trim()) {
          return json({ success: false, message: '该网络近期已注册过账号，请填写邮箱' }, 400, cors);
        }
        const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
        if (!emailRegex.test(email)) {
          return json({ success: false, message: '邮箱格式不正确' }, 400, cors);
        }

        const code = generateCode();
        const expiresAt = now + 10 * 60 * 1000;

        await env.DB.prepare('DELETE FROM email_codes WHERE email = ?').bind(email).run();
        await env.DB.prepare(
          'INSERT INTO email_codes (email, code, username, password, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)'
        ).bind(email, code, username, password, now, expiresAt).run();

        const sent = await sendEmail(env.RESEND_API_KEY, email, code);
        if (!sent) {
          return json({
            success: false,
            message: '发送邮件名额用光了，可能是被恶意水军脚本注水了，请联系管理员帮您注册账号。'
          }, 503, cors);
        }

        return json({ success: true, needVerify: true, message: '验证码已发送，请查收' }, 200, cors);
      }

      // ========================================================
      // 验证邮箱并完成注册
      // ========================================================
      if (path === '/api/verify-email' && method === 'POST') {
        const { email, code } = await request.json();
        if (!email || !code) return json({ success: false, message: '参数缺失' }, 400, cors);

        const record = await env.DB.prepare('SELECT * FROM email_codes WHERE email = ?').bind(email).first();
        if (!record) return json({ success: false, message: '验证记录不存在，请重新注册' }, 404, cors);
        if (Date.now() > record.expires_at) return json({ success: false, message: '验证码已过期，请重新注册' }, 410, cors);
        if (record.code !== code) return json({ success: false, message: '验证码错误' }, 401, cors);

        const exist = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(record.username).first();
        if (exist) return json({ success: false, message: '用户名已被注册' }, 409, cors);

        const salt = crypto.randomUUID();
        const hashed = await hashPassword(record.password, salt);
        const now = Date.now();

        await env.DB.prepare(
          'INSERT INTO users (username, password, salt, email, role, banned, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)'
        ).bind(record.username, hashed, salt, email, 'user', now).run();

        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
        await env.DB.prepare(
          'INSERT INTO register_logs (ip, email, created_at) VALUES (?, ?, ?)'
        ).bind(ip, email, now).run();

        await env.DB.prepare('DELETE FROM email_codes WHERE email = ?').bind(email).run();

        return json({ success: true, message: '注册成功，请登录' }, 200, cors);
      }

      // ========================================================
      // 登录
      // ========================================================
      if (path === '/api/login' && method === 'POST') {
        const { username, password } = await request.json();
        if (!username || !password) return json({ success: false, message: '用户名和密码不能为空' }, 400, cors);

        const user = await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(username).first();
        if (!user) return json({ success: false, message: '用户不存在，请先注册' }, 404, cors);

        let isMatch = false;
        if (user.salt && user.password.length === 64) {
          const hashed = await hashPassword(password, user.salt);
          isMatch = (hashed === user.password);
        } else {
          if (user.password === password) {
            isMatch = true;
            const salt = crypto.randomUUID();
            const hashed = await hashPassword(password, salt);
            await env.DB.prepare('UPDATE users SET password = ?, salt = ? WHERE id = ?')
              .bind(hashed, salt, user.id).run();
          }
        }

        if (!isMatch) return json({ success: false, message: '密码错误' }, 401, cors);

        return json({
          success: true,
          user: {
            username: user.username,
            email: user.email,
            created_at: user.created_at,
            role: user.role || 'user',
            banned: user.banned || 0,
            ban_reason: user.ban_reason || ''
          }
        }, 200, cors);
      }

      // ========================================================
      // 用户等级
      // ========================================================
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

      // ========================================================
      // 获取 ROM 列表
      // ========================================================
      if (path === '/api/roms' && method === 'GET') {
        const { results } = await env.DB.prepare('SELECT * FROM roms ORDER BY created_at DESC').all();
        return json(results, 200, cors);
      }

      // ========================================================
      // 按 slug 获取单个 ROM
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
        const { name, version, developer, url: romUrl, condition, code, author, logo, intro } = body;
        if (!name || !version || !developer || !romUrl || !author) {
          return json({ success: false, message: '请填写完整信息' }, 400, cors);
        }

        const role = await getUserRole(env, author);
        if (role === 'banned') {
          return json({ success: false, message: '您已被封禁，无法发布', banned: true }, 403, cors);
        }

        let slug = null;
        for (let i = 0; i < 5; i++) {
          const candidate = generateSlug();
          const exist = await env.DB.prepare('SELECT id FROM roms WHERE slug = ?').bind(candidate).first();
          if (!exist) { slug = candidate; break; }
        }
        if (!slug) return json({ success: false, message: '生成ID失败，请重试' }, 500, cors);

        const now = Date.now();
        await env.DB.prepare(
          'INSERT INTO roms (name, version, developer, url, condition, code, author, slug, logo, intro, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(name, version, developer, romUrl, condition, code || '', author, slug, logo || '', intro || '', now).run();

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
        await env.DB.prepare('INSERT INTO download_logs (rom_id, username, created_at) VALUES (?, ?, ?)')
          .bind(romId, username || '', Date.now()).run();
        await env.DB.prepare('UPDATE roms SET downloads = downloads + 1 WHERE id = ?').bind(romId).run();
        const rom = await env.DB.prepare('SELECT url FROM roms WHERE id = ?').bind(romId).first();
        return json({ success: true, url: rom ? rom.url : '' }, 200, cors);
      }

      // ========================================================
      // 收藏
      // ========================================================
      if (path === '/api/favorite' && method === 'POST') {
        const { romId, username } = await request.json();
        if (!romId || !username) return json({ success: false, message: '参数缺失' }, 400, cors);
        const role = await getUserRole(env, username);
        if (role === 'banned') return json({ success: false, message: '您已被封禁，无法收藏', banned: true }, 403, cors);

        const exist = await env.DB.prepare('SELECT id FROM favorites WHERE username = ? AND rom_id = ?').bind(username, romId).first();
        if (exist) {
          await env.DB.prepare('DELETE FROM favorites WHERE username = ? AND rom_id = ?').bind(username, romId).run();
          await env.DB.prepare('UPDATE roms SET favorites_count = favorites_count - 1 WHERE id = ?').bind(romId).run();
          return json({ success: true, favorited: false }, 200, cors);
        } else {
          await env.DB.prepare('INSERT INTO favorites (username, rom_id, created_at) VALUES (?, ?, ?)').bind(username, romId, Date.now()).run();
          await env.DB.prepare('UPDATE roms SET favorites_count = favorites_count + 1 WHERE id = ?').bind(romId).run();
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
        const exist = await env.DB.prepare('SELECT id FROM favorites WHERE username = ? AND rom_id = ?').bind(username, romId).first();
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
      // 评论
      // ========================================================
      if (path === '/api/comments' && method === 'GET') {
        const romId = url.searchParams.get('romId');
        if (!romId) return json([], 200, cors);
        const { results } = await env.DB.prepare(
          'SELECT * FROM comments WHERE rom_id = ? ORDER BY created_at DESC'
        ).bind(romId).all();
        return json(results, 200, cors);
      }

      if (path === '/api/comments' && method === 'POST') {
        const { romId, username, content } = await request.json();
        if (!romId || !username || !content) return json({ success: false, message: '参数缺失' }, 400, cors);
        const role = await getUserRole(env, username);
        if (role === 'banned') return json({ success: false, message: '您已被封禁，无法评论', banned: true }, 403, cors);
        await env.DB.prepare('INSERT INTO comments (rom_id, username, content, created_at) VALUES (?, ?, ?, ?)')
          .bind(romId, username, content, Date.now()).run();
        return json({ success: true }, 200, cors);
      }

      // ========================================================
      // 管理接口
      // ========================================================
      async function checkAdmin(requester) {
        const role = await getUserRole(env, requester);
        if (role !== 'super' && role !== 'root') return null;
        return role;
      }

      if (path === '/api/admin/ban' && method === 'POST') {
        const { requester, target, reason } = await request.json();
        const adminRole = await checkAdmin(requester);
        if (!adminRole) return json({ success: false, message: '无权限' }, 403, cors);
        const targetUser = await env.DB.prepare('SELECT role FROM users WHERE username = ?').bind(target).first();
        if (!targetUser) return json({ success: false, message: '用户不存在' }, 404, cors);
        if (targetUser.role === 'root') return json({ success: false, message: '不能封禁超级管理员' }, 403, cors);
        if (adminRole === 'super' && targetUser.role === 'super') {
          return json({ success: false, message: '普通管理员不能封禁其他管理员' }, 403, cors);
        }
        await env.DB.prepare('UPDATE users SET banned = 1, ban_reason = ? WHERE username = ?')
          .bind(reason || '违反社区条约', target).run();
        return json({ success: true }, 200, cors);
      }

      if (path === '/api/admin/unban' && method === 'POST') {
        const { requester, target } = await request.json();
        const adminRole = await checkAdmin(requester);
        if (!adminRole) return json({ success: false, message: '无权限' }, 403, cors);
        await env.DB.prepare('UPDATE users SET banned = 0, ban_reason = "" WHERE username = ?').bind(target).run();
        return json({ success: true }, 200, cors);
      }

      if (path === '/api/admin/delete-comment' && method === 'POST') {
        const { requester, commentId } = await request.json();
        const adminRole = await checkAdmin(requester);
        if (!adminRole) return json({ success: false, message: '无权限' }, 403, cors);
        await env.DB.prepare('DELETE FROM comments WHERE id = ?').bind(commentId).run();
        return json({ success: true }, 200, cors);
      }

      if (path === '/api/admin/delete-rom' && method === 'POST') {
        const { requester, romId } = await request.json();
        const adminRole = await checkAdmin(requester);
        if (!adminRole) return json({ success: false, message: '无权限' }, 403, cors);
        await env.DB.prepare('DELETE FROM comments WHERE rom_id = ?').bind(romId).run();
        await env.DB.prepare('DELETE FROM favorites WHERE rom_id = ?').bind(romId).run();
        await env.DB.prepare('DELETE FROM download_logs WHERE rom_id = ?').bind(romId).run();
        await env.DB.prepare('DELETE FROM roms WHERE id = ?').bind(romId).run();
        return json({ success: true }, 200, cors);
      }

      if (path === '/api/admin/delete-user' && method === 'POST') {
        const { requester, target } = await request.json();
        const adminRole = await checkAdmin(requester);
        if (adminRole !== 'root') return json({ success: false, message: '仅超级管理员可删号' }, 403, cors);
        const targetUser = await env.DB.prepare('SELECT id, role FROM users WHERE username = ?').bind(target).first();
        if (!targetUser) return json({ success: false, message: '用户不存在' }, 404, cors);
        if (targetUser.role === 'root') return json({ success: false, message: '不能删除超级管理员' }, 403, cors);

        const { results: userRoms } = await env.DB.prepare('SELECT id FROM roms WHERE author = ?').bind(target).all();
        for (const r of userRoms) {
          await env.DB.prepare('DELETE FROM comments WHERE rom_id = ?').bind(r.id).run();
          await env.DB.prepare('DELETE FROM favorites WHERE rom_id = ?').bind(r.id).run();
          await env.DB.prepare('DELETE FROM download_logs WHERE rom_id = ?').bind(r.id).run();
        }
        await env.DB.prepare('DELETE FROM roms WHERE author = ?').bind(target).run();
        await env.DB.prepare('DELETE FROM comments WHERE username = ?').bind(target).run();
        await env.DB.prepare('DELETE FROM favorites WHERE username = ?').bind(target).run();
        await env.DB.prepare('DELETE FROM users WHERE username = ?').bind(target).run();
        return json({ success: true }, 200, cors);
      }

      if (path === '/api/admin/set-role' && method === 'POST') {
        const { requester, target, role } = await request.json();
        const adminRole = await checkAdmin(requester);
        if (adminRole !== 'root') return json({ success: false, message: '仅超级管理员可操作' }, 403, cors);
        if (!['user', 'super', 'root'].includes(role)) return json({ success: false, message: '角色无效' }, 400, cors);
        const targetUser = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(target).first();
        if (!targetUser) return json({ success: false, message: '用户不存在' }, 404, cors);
        await env.DB.prepare('UPDATE users SET role = ? WHERE username = ?').bind(role, target).run();
        return json({ success: true }, 200, cors);
      }

      if (path === '/api/admin/list-users' && method === 'GET') {
        const requester = url.searchParams.get('requester');
        const adminRole = await checkAdmin(requester);
        if (!adminRole) return json({ success: false, message: '无权限' }, 403, cors);
        const { results } = await env.DB.prepare(
          'SELECT username, role, banned, ban_reason, created_at FROM users ORDER BY created_at DESC'
        ).all();
        return json(results, 200, cors);
      }

      return json({ success: false, message: 'Not Found' }, 404, cors);

    } catch (e) {
      return json({ success: false, message: e.message }, 500, cors);
    }
  }
};