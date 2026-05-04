// Migration 002 (data migration, không phải schema).
// Đọc data.json cũ → INSERT vào SQLite. Chạy 1 lần khi setup datacenter đầu tiên.
//
// Quy tắc:
//   - Idempotent: nếu data.json không tồn tại HOẶC bảng bugs đã có dữ liệu → skip.
//   - Sau khi import xong, đổi tên data.json → data.json.imported để không chạy lại.
//   - Tất cả gán workspace_id = 'default'.
//   - ID cũ ('BUG-0001') giữ nguyên trong cột id (đã unique cho workspace 'default'),
//     display_number = số đuôi cũ. Bug mới sau migration sẽ dùng ULID.

// Ghi chú: file này KHÔNG có đuôi .sql nên runner.js sẽ bỏ qua.
// Chạy thủ công 1 lần: `node src/migrations/002_legacy_import.js`

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../config');
const logger = require('../logger');

function run() {
    const jsonPath = config.legacyJsonPath;
    if (!fs.existsSync(jsonPath)) {
        logger.info({ jsonPath }, 'no legacy json, skip');
        return;
    }

    const db = new Database(config.db.path);
    db.pragma('journal_mode = WAL');

    const existing = db.prepare('SELECT COUNT(*) AS c FROM bugs').get().c;
    if (existing > 0) {
        logger.warn({ existing }, 'bugs table not empty, skip legacy import');
        db.close();
        return;
    }

    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const ws = config.defaults.workspace;
    const now = new Date().toISOString();

    const insertBug = db.prepare(`
        INSERT INTO bugs (
            id, workspace_id, display_number, product, name, description,
            type, severity, status, module, reporter, assignee,
            test_status, support_note, dev_note,
            found_date, deadline, completed_date,
            attachments, history, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertImp = db.prepare(`
        INSERT INTO improvements (
            id, workspace_id, display_number, name, description,
            priority, status, proposer, assignee, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const setMeta = db.prepare(`
        INSERT OR REPLACE INTO meta (workspace_id, key, value, updated_at) VALUES (?, ?, ?, ?)
    `);

    const tx = db.transaction(() => {
        // Bugs
        (data.bugs || []).forEach((b, idx) => {
            const display = parseInt(String(b.id || '').replace(/^BUG-/, ''), 10) || (idx + 1);
            insertBug.run(
                b.id || `BUG-LEGACY-${idx + 1}`,
                ws, display,
                b.product || 'GemCloudPhone',
                b.name || '',
                b.description || null,
                b.type || null, b.severity || null, b.status || null, b.module || null,
                b.reporter || null, b.assignee || null,
                b.testStatus || null, b.supportNote || null, b.devNote || null,
                b.foundDate || null, b.deadline || null, b.completedDate || null,
                JSON.stringify(b.attachments || []),
                JSON.stringify(b.history || []),
                b.createdAt || now, b.updatedAt || now
            );
        });

        // Improvements
        (data.improvements || []).forEach((i, idx) => {
            const display = parseInt(String(i.id || '').replace(/^IMP-/, ''), 10) || (idx + 1);
            insertImp.run(
                i.id || `IMP-LEGACY-${idx + 1}`,
                ws, display,
                i.name || '',
                i.description || null,
                i.priority || null, i.status || null,
                i.proposer || null, i.assignee || null,
                i.createdAt || now, i.updatedAt || now
            );
        });

        // Meta
        for (const key of ['products', 'devList', 'reporterList', 'bugTypes', 'activeProduct']) {
            if (data[key] !== undefined) {
                setMeta.run(ws, key, JSON.stringify(data[key]), now);
            }
        }
    });

    tx();
    db.close();

    fs.renameSync(jsonPath, jsonPath + '.imported');
    logger.info({ bugs: (data.bugs || []).length, improvements: (data.improvements || []).length }, 'legacy import done');
}

if (require.main === module) run();
module.exports = { run };
