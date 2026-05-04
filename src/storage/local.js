// Storage backend: local filesystem.
// Save vào UPLOAD_DIR, expose qua URL relative '/uploads/...' (server.js serve static).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');

const DIR = config.storage.uploadDir;
if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });

function safeFilename(originalName) {
    const ext = (path.extname(originalName) || '.bin').toLowerCase();
    const id = crypto.randomBytes(8).toString('hex');
    return id + ext;
}

async function save(buffer, originalName) {
    const filename = safeFilename(originalName);
    const fp = path.join(DIR, filename);
    await fs.promises.writeFile(fp, buffer);
    return { url: '/uploads/' + filename, size: buffer.length };
}

async function deleteFile(url) {
    if (!url || typeof url !== 'string') return;
    const filename = path.basename(url);
    const fp = path.join(DIR, filename);
    // Chống path traversal: đảm bảo file thực sự nằm trong DIR
    if (!fp.startsWith(DIR)) return;
    if (fs.existsSync(fp)) await fs.promises.unlink(fp);
}

function readStream(url) {
    const filename = path.basename(url);
    const fp = path.join(DIR, filename);
    if (!fp.startsWith(DIR)) throw new Error('Forbidden path');
    return fs.createReadStream(fp);
}

function resolveUrl(url) { return url; } // local: trả thẳng URL relative

module.exports = { save, delete: deleteFile, readStream, resolveUrl };
