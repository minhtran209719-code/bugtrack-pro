#!/usr/bin/env node
// Cron orphan cleanup: xoá file uploads/ không tham chiếu trong DB, tuổi > 7 ngày.
// Đây là lưới an toàn — flow bình thường (Cách C) FE đã DELETE khi cancel modal.
// File mồ côi chỉ còn lại khi browser crash hoặc network rớt giữa lúc cleanup chủ động.

const fs = require('fs');
const path = require('path');

// Cho phép chạy từ /opt/bugtrack hoặc từ thư mục con
const ROOT = path.resolve(__dirname, '..', '..');
process.chdir(ROOT);

const config = require(path.join(ROOT, 'src/config'));
const db = require(path.join(ROOT, 'src/db'));
const logger = require(path.join(ROOT, 'src/logger'));

const ORPHAN_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 ngày
const UPLOAD_DIR = config.storage.uploadDir;

function listAllFiles(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).map(name => ({
        name,
        path: path.join(dir, name),
        stat: fs.statSync(path.join(dir, name)),
    })).filter(x => x.stat.isFile());
}

function collectReferencedUrls() {
    const referenced = new Set();

    db.open();

    // Hôm nay 1 workspace 'default'; tương lai loop tất cả workspaces.
    // Lấy attachments từ bugs và improvements (nếu sau này có cột attachments).
    const dbConn = db.open();
    const wsRows = dbConn.prepare('SELECT id FROM workspaces').all();
    const workspaces = wsRows.length ? wsRows.map(r => r.id) : [config.defaults.workspace];

    for (const ws of workspaces) {
        const urls = db.bugs.allAttachmentUrls(ws);
        for (const u of urls) referenced.add(u);
    }
    return referenced;
}

function main() {
    const referenced = collectReferencedUrls();
    const files = listAllFiles(UPLOAD_DIR);
    const now = Date.now();

    let deleted = 0;
    let kept = 0;
    let skipped = 0;

    for (const f of files) {
        const url = '/uploads/' + f.name;
        if (referenced.has(url)) { kept++; continue; }
        const ageMs = now - f.stat.mtimeMs;
        if (ageMs < ORPHAN_AGE_MS) { skipped++; continue; }
        try {
            fs.unlinkSync(f.path);
            deleted++;
            logger.info({ file: f.name, ageDays: Math.floor(ageMs / 86400000) }, 'orphan deleted');
        } catch (e) {
            logger.warn({ file: f.name, err: e.message }, 'orphan delete failed');
        }
    }

    logger.info({ deleted, kept, skipped, scanned: files.length }, 'orphan cleanup done');
    db.close();
}

if (require.main === module) {
    try { main(); }
    catch (e) { logger.error({ err: e.message, stack: e.stack }, 'orphan cleanup failed'); process.exit(1); }
}
