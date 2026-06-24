// HTTP server entry — refactor v2 dùng SQLite + DAL + 8 seam.
// Routes dưới /api/v1/* (Seam #5). Static FE phục vụ từ root.
// Graceful shutdown bắt buộc để SQLite flush WAL.

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const config = require('./config');
const logger = require('./logger');
const db = require('./db');
const storage = require('./storage');
const { resolveContext } = require('./middleware/auth');
const events = require('./events');
const { run: runMigrations } = require('./migrations/runner');

const ROOT = path.resolve(__dirname, '..');
const API = '/api/v1';

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.js':   'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif':  'image/gif',
    '.svg':  'image/svg+xml',
    '.ico':  'image/x-icon',
    '.mp4':  'video/mp4',
    '.webm': 'video/webm',
    '.webp': 'image/webp',
};

// Magic bytes → mime. Validate upload file thật, không tin tên file.
function detectMime(buf) {
    if (!buf || buf.length < 12) return null;
    if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
        && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
    if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) return 'video/mp4';
    if (buf[0] === 0x1A && buf[1] === 0x45 && buf[2] === 0xDF && buf[3] === 0xA3) return 'video/webm';
    return null;
}

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/mp4', 'video/webm']);

// Cloudflare free tier giới hạn 100MB/request — đặt 100MB để báo lỗi ở app trước CF.
// Khi nâng CF Pro ($20/tháng) hoặc bypass CF (DNS-only subdomain), có thể tăng lên.
const MAX_UPLOAD = 100 * 1024 * 1024; // 100MB
const MAX_JSON   = 10 * 1024 * 1024;  // 10MB JSON body

// ===== Helpers =====

function send(res, status, body, contentType = 'application/json; charset=utf-8') {
    // CORS headers KHÔNG đặt ở đây nữa — applyCors() set có điều kiện theo Origin
    // (allowlist) ngay đầu handleRequest. Wildcard '*' cũ là lỗ hổng cho ghi cross-origin.
    res.writeHead(status, {
        'Content-Type': contentType,
        'Cache-Control': 'no-store',
    });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function sendJSON(res, body, status = 200) { send(res, status, body); }

// CORS có điều kiện: chỉ phản hồi Allow-Origin cho origin trong allowlist.
// Same-origin (app tự phục vụ) không cần CORS nên không ảnh hưởng. Origin lạ →
// không có header → trình duyệt chặn preflight PATCH/POST trước khi gửi.
function applyCors(req, res) {
    const origin = req.headers.origin;
    if (origin && config.cors.allowedOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Filename, Authorization');
    }
}

function readBody(req, max) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', c => {
            size += c.length;
            if (size > max) { reject(new Error('Payload too large')); req.destroy(); return; }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

async function readJSON(req) {
    const buf = await readBody(req, MAX_JSON);
    if (buf.length === 0) return {};
    try { return JSON.parse(buf.toString('utf8')); }
    catch { throw new Error('Invalid JSON'); }
}

function sanitizeUrlPath(rel) {
    // Chống path traversal cho URL tham chiếu attachment
    if (typeof rel !== 'string') return null;
    if (!rel.startsWith('/uploads/')) return null;
    if (rel.includes('..') || rel.includes('\\')) return null;
    return rel;
}

async function deleteAttachments(urls) {
    if (!Array.isArray(urls)) return;
    for (const u of urls) {
        const safe = sanitizeUrlPath(u);
        if (!safe) continue;
        try { await storage.delete(safe); }
        catch (e) { logger.warn({ url: safe, err: e.message }, 'attachment delete failed'); }
    }
}

// Serve static file từ ROOT (không cho thoát ROOT).
function serveStatic(res, relPath) {
    let filePath = path.join(ROOT, relPath);
    filePath = path.normalize(filePath);
    if (!filePath.startsWith(ROOT)) {
        return send(res, 403, 'Forbidden', 'text/plain');
    }
    fs.stat(filePath, (err, stat) => {
        if (err || !stat.isFile()) {
            // Fallback index.html (SPA-friendly cho future)
            return send(res, 404, 'Not Found', 'text/plain');
        }
        const ext = path.extname(filePath).toLowerCase();
        const ct = MIME[ext] || 'application/octet-stream';
        res.writeHead(200, {
            'Content-Type': ct,
            'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=3600',
        });
        fs.createReadStream(filePath).pipe(res);
    });
}

// ===== Route handlers =====

const routes = [];
function route(method, pattern, handler) {
    routes.push({ method, pattern, handler });
}

// Health check (no auth)
route('GET', /^\/api\/health$/, async (req, res) => {
    try {
        db.open(); // touch DB
        sendJSON(res, { ok: true, time: new Date().toISOString(), env: config.env });
    } catch (e) {
        sendJSON(res, { ok: false, err: e.message }, 500);
    }
});

// ===== BUGS =====

route('GET', new RegExp(`^${API}/bugs$`), async (req, res, ctx, q) => {
    const result = db.bugs.list(ctx.workspace, q);
    sendJSON(res, result);
});

route('GET', new RegExp(`^${API}/bugs/changed$`), async (req, res, ctx, q) => {
    const since = q.since || '1970-01-01T00:00:00Z';
    const items = db.bugs.changedSince(ctx.workspace, since);
    sendJSON(res, { items, now: new Date().toISOString() });
});

route('GET', new RegExp(`^${API}/bugs/stats/by-assignee$`), async (req, res, ctx, q) => {
    sendJSON(res, db.bugs.statsByAssignee(ctx.workspace, q));
});
route('GET', new RegExp(`^${API}/bugs/stats/by-reporter$`), async (req, res, ctx, q) => {
    sendJSON(res, db.bugs.statsByReporter(ctx.workspace, q));
});
route('GET', new RegExp(`^${API}/bugs/stats/by-module$`), async (req, res, ctx, q) => {
    sendJSON(res, db.bugs.statsByModule(ctx.workspace, q));
});
route('GET', new RegExp(`^${API}/bugs/summary$`), async (req, res, ctx, q) => {
    sendJSON(res, db.bugs.summary(ctx.workspace, q));
});

route('GET', new RegExp(`^${API}/bugs/([\\w-]+)$`), async (req, res, ctx, q, m) => {
    const bug = db.bugs.get(ctx.workspace, m[1]);
    if (!bug) return sendJSON(res, { error: 'Not found' }, 404);
    sendJSON(res, bug);
});

route('POST', new RegExp(`^${API}/bugs$`), async (req, res, ctx) => {
    const body = await readJSON(req);
    if (!body.name) return sendJSON(res, { error: 'name required' }, 400);
    if (!body.product) return sendJSON(res, { error: 'product required' }, 400);
    const bug = db.bugs.create(ctx.workspace, body);
    events.emit('bug.created', { ctx, resourceType: 'bug', resourceId: bug.id, meta: { id: bug.id, name: bug.name } });
    sendJSON(res, bug, 201);
});

route('PATCH', new RegExp(`^${API}/bugs/([\\w-]+)$`), async (req, res, ctx, q, m) => {
    const body = await readJSON(req);
    const old = db.bugs.get(ctx.workspace, m[1]);
    if (!old) return sendJSON(res, { error: 'Not found' }, 404);

    // Khi attachments thay đổi, xoá file đã lìa khỏi bug.
    if (Array.isArray(body.attachments)) {
        const oldSet = new Set(old.attachments || []);
        const newSet = new Set(body.attachments);
        const removed = [...oldSet].filter(u => !newSet.has(u));
        if (removed.length) await deleteAttachments(removed);
    }

    const bug = db.bugs.update(ctx.workspace, m[1], body);
    events.emit('bug.updated', { ctx, resourceType: 'bug', resourceId: bug.id, meta: { id: bug.id }, payload: { patch: body } });
    sendJSON(res, bug);
});

route('DELETE', new RegExp(`^${API}/bugs/([\\w-]+)$`), async (req, res, ctx, q, m) => {
    const bug = db.bugs.delete(ctx.workspace, m[1]);
    if (!bug) return sendJSON(res, { error: 'Not found' }, 404);
    await deleteAttachments(bug.attachments || []);
    events.emit('bug.deleted', { ctx, resourceType: 'bug', resourceId: bug.id, meta: { id: bug.id } });
    sendJSON(res, { ok: true });
});

// ===== IMPROVEMENTS =====

route('GET', new RegExp(`^${API}/improvements$`), async (req, res, ctx, q) => {
    sendJSON(res, db.improvements.list(ctx.workspace, q));
});

route('GET', new RegExp(`^${API}/improvements/changed$`), async (req, res, ctx, q) => {
    const since = q.since || '1970-01-01T00:00:00Z';
    sendJSON(res, { items: db.improvements.changedSince(ctx.workspace, since), now: new Date().toISOString() });
});

route('GET', new RegExp(`^${API}/improvements/([\\w-]+)$`), async (req, res, ctx, q, m) => {
    const imp = db.improvements.get(ctx.workspace, m[1]);
    if (!imp) return sendJSON(res, { error: 'Not found' }, 404);
    sendJSON(res, imp);
});

route('POST', new RegExp(`^${API}/improvements$`), async (req, res, ctx) => {
    const body = await readJSON(req);
    if (!body.name) return sendJSON(res, { error: 'name required' }, 400);
    const imp = db.improvements.create(ctx.workspace, body);
    events.emit('improvement.created', { ctx, resourceType: 'improvement', resourceId: imp.id, meta: { id: imp.id, name: imp.name } });
    sendJSON(res, imp, 201);
});

route('PATCH', new RegExp(`^${API}/improvements/([\\w-]+)$`), async (req, res, ctx, q, m) => {
    const body = await readJSON(req);
    const imp = db.improvements.update(ctx.workspace, m[1], body);
    if (!imp) return sendJSON(res, { error: 'Not found' }, 404);
    sendJSON(res, imp);
});

route('DELETE', new RegExp(`^${API}/improvements/([\\w-]+)$`), async (req, res, ctx, q, m) => {
    const imp = db.improvements.delete(ctx.workspace, m[1]);
    if (!imp) return sendJSON(res, { error: 'Not found' }, 404);
    sendJSON(res, { ok: true });
});

// ===== META =====

// Backstop chống ghi rác (email OTP, credential) vào meta — kể cả client không phải
// trình duyệt (CORS không chặn được). Chỉ nhận đúng 5 key app dùng; tên là chuỗi ngắn,
// cấm ký tự dấu hiệu email/credential/injection (@ | ; < >). Sai → 400.
const META_LIST_KEYS = new Set(['products', 'devList', 'reporterList', 'bugTypes']);
const META_STR_KEYS  = new Set(['activeProduct']);
const META_BAD_CHARS = /[@|;<>]/;

function cleanMetaName(v, label) {
    if (typeof v !== 'string') throw new Error(`${label}: phải là chuỗi`);
    const t = v.trim();
    if (!t) throw new Error(`${label}: rỗng`);
    if (t.length > 80) throw new Error(`${label}: quá 80 ký tự`);
    if (META_BAD_CHARS.test(t)) throw new Error(`${label}: chứa ký tự không hợp lệ (@ | ; < >)`);
    return t;
}

function sanitizeMetaPatch(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Body không hợp lệ');
    const out = {};
    for (const [k, v] of Object.entries(patch)) {
        if (META_LIST_KEYS.has(k)) {
            if (!Array.isArray(v)) throw new Error(`${k}: phải là mảng`);
            if (v.length > 100) throw new Error(`${k}: quá 100 phần tử`);
            const seen = new Set(); const arr = [];
            for (const item of v) {
                const t = cleanMetaName(item, k);
                if (!seen.has(t)) { seen.add(t); arr.push(t); }
            }
            out[k] = arr;
        } else if (META_STR_KEYS.has(k)) {
            out[k] = cleanMetaName(v, k);
        } else {
            throw new Error(`Key meta không hợp lệ: ${k}`);
        }
    }
    if (Object.keys(out).length === 0) throw new Error('Không có trường meta hợp lệ');
    return out;
}

route('GET', new RegExp(`^${API}/meta$`), async (req, res, ctx) => {
    sendJSON(res, db.meta.getAll(ctx.workspace));
});

route('PATCH', new RegExp(`^${API}/meta$`), async (req, res, ctx) => {
    const body = await readJSON(req);
    let clean;
    try {
        clean = sanitizeMetaPatch(body);
    } catch (e) {
        logger.warn({ err: e.message, origin: req.headers.origin, ws: ctx.workspace }, 'meta patch rejected');
        return sendJSON(res, { error: e.message }, 400);
    }
    const out = db.meta.setMany(ctx.workspace, clean);
    sendJSON(res, out);
});

// ===== UPLOADS =====

route('POST', new RegExp(`^${API}/uploads$`), async (req, res) => {
    let buf;
    try { buf = await readBody(req, MAX_UPLOAD); }
    catch (e) {
        const msg = e.message === 'Payload too large'
            ? `Tệp vượt giới hạn ${MAX_UPLOAD / 1024 / 1024}MB`
            : e.message;
        return sendJSON(res, { error: msg }, 413);
    }
    if (buf.length === 0) return sendJSON(res, { error: 'Empty body' }, 400);

    const mime = detectMime(buf);
    if (!mime || !ALLOWED_MIME.has(mime)) {
        return sendJSON(res, { error: 'Loại tệp không được hỗ trợ (chỉ jpeg/png/gif/webp/mp4/webm)' }, 415);
    }

    const original = decodeURIComponent(req.headers['x-filename'] || ('file' + Date.now()));
    try {
        const result = await storage.save(buf, original);
        sendJSON(res, { url: result.url, size: result.size, mime }, 201);
    } catch (e) {
        logger.error({ err: e.message }, 'upload save failed');
        sendJSON(res, { error: 'Save failed' }, 500);
    }
});

route('DELETE', new RegExp(`^${API}/uploads$`), async (req, res) => {
    const body = await readJSON(req);
    const urls = Array.isArray(body.urls) ? body.urls : (body.url ? [body.url] : []);
    if (urls.length === 0) return sendJSON(res, { error: 'urls required' }, 400);
    await deleteAttachments(urls);
    sendJSON(res, { ok: true, count: urls.length });
});

// ===== ROUTER =====

async function handleRequest(req, res) {
    const start = Date.now();
    const u = url.parse(req.url, true);
    const pathname = u.pathname;
    let ctx = null;

    applyCors(req, res);

    if (req.method === 'OPTIONS') {
        send(res, 204, '', 'text/plain');
        return;
    }

    try {
        // Static: /uploads/* → storage backend
        if (req.method === 'GET' && pathname.startsWith('/uploads/')) {
            const safe = sanitizeUrlPath(pathname);
            if (!safe) return send(res, 403, 'Forbidden', 'text/plain');
            try {
                const stream = storage.readStream(safe);
                const ext = path.extname(safe).toLowerCase();
                res.writeHead(200, {
                    'Content-Type': MIME[ext] || 'application/octet-stream',
                    'Cache-Control': 'public, max-age=86400',
                });
                stream.on('error', () => { try { res.end(); } catch {} });
                stream.pipe(res);
                return;
            } catch {
                return send(res, 404, 'Not Found', 'text/plain');
            }
        }

        // API
        if (pathname.startsWith('/api/')) {
            // Resolve auth context cho mọi /api/*
            ctx = await resolveContext(req).catch(err => {
                logger.warn({ err: err.message }, 'auth failed');
                return null;
            });

            // Health public
            if (pathname === '/api/health') {
                const hcRoute = routes.find(r => r.method === 'GET' && r.pattern.test(pathname));
                if (hcRoute) return await hcRoute.handler(req, res, ctx, u.query);
            }

            if (!ctx) return sendJSON(res, { error: 'Unauthorized' }, 401);

            for (const r of routes) {
                if (r.method !== req.method) continue;
                const m = r.pattern.exec(pathname);
                if (m) return await r.handler(req, res, ctx, u.query, m);
            }
            return sendJSON(res, { error: 'Not found', path: pathname }, 404);
        }

        // Static FE (root)
        if (req.method === 'GET') {
            const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
            return serveStatic(res, rel);
        }

        sendJSON(res, { error: 'Method not allowed' }, 405);
    } catch (err) {
        logger.error({ err: err.message, stack: err.stack, path: pathname }, 'request failed');
        if (!res.headersSent) sendJSON(res, { error: 'Internal error' }, 500);
    } finally {
        logger.info({
            method: req.method, path: pathname,
            status: res.statusCode, ms: Date.now() - start,
            ws: ctx?.workspace,
        }, 'request');
    }
}

// ===== Bootstrap =====

function start() {
    // Migrate trước khi mở server
    runMigrations();
    db.open();

    // Auto-import data.json legacy (1 lần) nếu tồn tại và bugs còn rỗng
    try {
        if (fs.existsSync(config.legacyJsonPath)) {
            const dbConn = db.open();
            const cnt = dbConn.prepare('SELECT COUNT(*) AS c FROM bugs').get().c;
            if (cnt === 0) {
                logger.info('legacy data.json detected, running import');
                require('./migrations/002_legacy_import').run();
            }
        }
    } catch (e) {
        logger.warn({ err: e.message }, 'legacy import skipped');
    }

    const server = http.createServer(handleRequest);
    server.listen(config.port, config.host, () => {
        logger.info({ port: config.port, host: config.host, env: config.env }, 'server listening');
    });

    function shutdown(sig) {
        logger.info({ sig }, 'shutting down');
        server.close(() => { db.close(); process.exit(0); });
        setTimeout(() => process.exit(1), 10000).unref();
    }
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT',  () => shutdown('SIGINT'));

    return server;
}

if (require.main === module) start();
module.exports = { start, handleRequest };
