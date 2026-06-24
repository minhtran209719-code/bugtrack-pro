// JWT HS256 tự cài bằng crypto core — KHÔNG thêm npm dependency (gotcha #9).
// Dùng cho seam #A auth. Token = base64url(header).base64url(payload).base64url(HMAC-SHA256).

const crypto = require('crypto');
const config = require('../config');

function b64url(buf) {
    return Buffer.from(buf).toString('base64')
        .replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function b64urlJson(obj) { return b64url(Buffer.from(JSON.stringify(obj), 'utf8')); }
function fromB64url(s) { return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'); }

// '7d' | '12h' | '30m' | '3600' (giây) → số giây
function parseDuration(v, def = 7 * 24 * 3600) {
    if (v == null) return def;
    const m = String(v).trim().match(/^(\d+)([smhd])?$/);
    if (!m) return def;
    const n = parseInt(m[1], 10);
    const unit = { s: 1, m: 60, h: 3600, d: 86400 }[m[2] || 's'];
    return n * unit;
}

function hmac(data) {
    return crypto.createHmac('sha256', config.auth.jwtSecret).update(data).digest();
}

function sign(payload, opts = {}) {
    const now = Math.floor(Date.now() / 1000);
    const exp = now + parseDuration(opts.expiresIn || config.auth.jwtExpiresIn);
    const body = { ...payload, iat: now, exp };
    const data = b64urlJson({ alg: 'HS256', typ: 'JWT' }) + '.' + b64urlJson(body);
    return data + '.' + b64url(hmac(data));
}

function verify(token) {
    if (typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const data = parts[0] + '.' + parts[1];
    const expected = b64url(hmac(data));
    const a = Buffer.from(parts[2]);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    let body;
    try { body = JSON.parse(fromB64url(parts[1]).toString('utf8')); } catch { return null; }
    if (body.exp && Math.floor(Date.now() / 1000) >= body.exp) return null;
    return body;
}

module.exports = { sign, verify, parseDuration };
