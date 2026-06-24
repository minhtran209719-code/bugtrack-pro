// Băm mật khẩu bằng scrypt (crypto core) — KHÔNG thêm dependency.
// Format lưu DB: 'scrypt$<salt_hex>$<derived_hex>'. So sánh hằng-thời-gian.

const crypto = require('crypto');

const KEYLEN = 32;

function hash(password) {
    const salt = crypto.randomBytes(16);
    const dk = crypto.scryptSync(String(password), salt, KEYLEN);
    return 'scrypt$' + salt.toString('hex') + '$' + dk.toString('hex');
}

function verify(password, stored) {
    if (typeof stored !== 'string') return false;
    const parts = stored.split('$');
    if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
    let salt, expected;
    try {
        salt = Buffer.from(parts[1], 'hex');
        expected = Buffer.from(parts[2], 'hex');
    } catch { return false; }
    if (expected.length === 0) return false;
    const dk = crypto.scryptSync(String(password), salt, expected.length);
    return dk.length === expected.length && crypto.timingSafeEqual(dk, expected);
}

// Sinh mật khẩu tạm dễ đọc (cho seed user).
function genTemp(len = 10) {
    const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = crypto.randomBytes(len);
    let out = '';
    for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
    return out;
}

module.exports = { hash, verify, genTemp };
