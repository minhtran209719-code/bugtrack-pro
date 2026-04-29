const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = 3000;
const DIR = __dirname;
const DB_FILE = path.join(DIR, 'data.json');
const UPLOAD_DIR = path.join(DIR, 'uploads');

// Tao thu muc uploads neu chua co
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

// Khoi tao data file neu chua co
if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({
        bugs: [], improvements: [], products: ['GemCloudPhone', 'GemLogin'],
        devList: ['Quang', 'Tung', 'Hoang'], reporterList: ['Tien', 'Thuy', 'Thang'],
        bugTypes: ['Giao dien', 'Logic', 'Hieu nang', 'Sap ung dung', 'Khac'],
        activeProduct: 'GemCloudPhone'
    }, null, 2));
}

const MIME = {
    '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
    '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon', '.mp4': 'video/mp4', '.webm': 'video/webm',
    '.webp': 'image/webp',
};

function readDB() { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
function writeDB(data) { fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8'); }

function parseBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', chunk => {
            size += chunk.length;
            if (size > 50e6) { reject('Too large'); return; }
            chunks.push(chunk);
        });
        req.on('end', () => {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
            catch { resolve({}); }
        });
        req.on('error', reject);
    });
}

function parseRawBody(req, maxSize) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', chunk => {
            size += chunk.length;
            if (size > maxSize) { reject('Too large'); return; }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

function sendJSON(res, data, status = 200) {
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Filename',
    });
    res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, X-Filename',
        });
        res.end();
        return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);

    // ===== API =====
    if (url.pathname === '/api/data' && req.method === 'GET') {
        return sendJSON(res, readDB());
    }

    if (url.pathname === '/api/data' && req.method === 'POST') {
        const body = await parseBody(req);
        writeDB(body);
        return sendJSON(res, { ok: true });
    }

    if (url.pathname === '/api/sync' && req.method === 'POST') {
        const body = await parseBody(req);
        const db = readDB();
        for (const key of Object.keys(body)) {
            const incoming = body[key];
            const existing = db[key];
            // Merge theo ID cho mảng có object (bugs, improvements)
            if (Array.isArray(incoming) && Array.isArray(existing)
                && incoming.length > 0 && incoming[0] && incoming[0].id) {
                const existMap = new Map(existing.map(e => [e.id, e]));
                // Cập nhật/thêm từ client
                for (const item of incoming) {
                    const old = existMap.get(item.id);
                    if (!old || (item.updatedAt && old.updatedAt && item.updatedAt >= old.updatedAt) || !old.updatedAt) {
                        existMap.set(item.id, item);
                    }
                }
                db[key] = Array.from(existMap.values());
            } else {
                db[key] = incoming;
            }
        }
        writeDB(db);
        // Trả về data merged để client cập nhật ngay
        const merged = {};
        for (const key of Object.keys(body)) merged[key] = db[key];
        return sendJSON(res, { ok: true, merged });
    }

    // ===== DELETE BUG/IMPROVEMENT BY ID =====
    if (url.pathname === '/api/delete-item' && req.method === 'POST') {
        const body = await parseBody(req);
        const { type, id } = body;
        if (!type || !id) return sendJSON(res, { error: 'Missing type or id' }, 400);
        const db = readDB();
        if (type === 'bug' && Array.isArray(db.bugs)) {
            db.bugs = db.bugs.filter(b => b.id !== id);
        } else if (type === 'improvement' && Array.isArray(db.improvements)) {
            db.improvements = db.improvements.filter(i => i.id !== id);
        }
        writeDB(db);
        return sendJSON(res, { ok: true });
    }

    // ===== UPLOAD FILE =====
    if (url.pathname === '/api/upload' && req.method === 'POST') {
        try {
            const rawBody = await parseRawBody(req, 25e6);
            const originalName = decodeURIComponent(req.headers['x-filename'] || 'file.jpg');
            const ext = path.extname(originalName) || '.jpg';
            const id = crypto.randomBytes(8).toString('hex');
            const filename = id + ext;
            fs.writeFileSync(path.join(UPLOAD_DIR, filename), rawBody);
            return sendJSON(res, { ok: true, url: '/uploads/' + filename });
        } catch (e) {
            return sendJSON(res, { error: String(e) }, 400);
        }
    }

    // ===== DELETE FILE =====
    if (url.pathname === '/api/delete-file' && req.method === 'POST') {
        const body = await parseBody(req);
        if (body.url) {
            const filename = path.basename(body.url);
            const fp = path.join(UPLOAD_DIR, filename);
            if (fp.startsWith(UPLOAD_DIR) && fs.existsSync(fp)) fs.unlinkSync(fp);
        }
        return sendJSON(res, { ok: true });
    }

    // ===== STATIC FILES =====
    let filePath = path.join(DIR, url.pathname === '/' ? 'index.html' : url.pathname);
    if (!filePath.startsWith(DIR)) { res.writeHead(403); res.end('Forbidden'); return; }

    const ext = path.extname(filePath);
    const contentType = MIME[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not Found'); return; }
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
    });
});

server.listen(PORT, '0.0.0.0', () => {
    const os = require('os');
    const nets = os.networkInterfaces();
    let localIP = 'localhost';
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal) { localIP = net.address; break; }
        }
    }
    console.log('');
    console.log('==========================================');
    console.log('  BugTrack Pro Server - Team Shared');
    console.log('==========================================');
    console.log('  Local:   http://localhost:' + PORT);
    console.log('  Network: http://' + localIP + ':' + PORT);
    console.log('  Data:    ' + DB_FILE);
    console.log('  Uploads: ' + UPLOAD_DIR);
    console.log('');
    console.log('  Mo trinh duyet, nhap link Network o tren');
    console.log('  Ctrl+C de tat server');
    console.log('==========================================');
});
