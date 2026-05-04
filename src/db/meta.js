// DAL: meta — products, devList, reporterList, bugTypes, activeProduct.
// Lưu key-value JSON, scoped theo workspace_id.

const { open } = require('./connection');

const DEFAULTS = {
    products: ['GemCloudPhone', 'GemLogin'],
    devList: ['Quang', 'Tùng', 'Hoàng'],
    reporterList: ['Tiến', 'Thùy', 'Thắng'],
    bugTypes: ['Giao diện', 'Logic', 'Hiệu năng', 'Sập ứng dụng', 'Khác'],
    activeProduct: 'GemCloudPhone',
};

function get(workspaceId, key) {
    const db = open();
    const row = db.prepare(
        'SELECT value FROM meta WHERE workspace_id = ? AND key = ?'
    ).get(workspaceId, key);
    if (!row) return DEFAULTS[key] !== undefined ? DEFAULTS[key] : null;
    try { return JSON.parse(row.value); }
    catch { return null; }
}

function set(workspaceId, key, value) {
    const db = open();
    const now = new Date().toISOString();
    db.prepare(`
        INSERT INTO meta (workspace_id, key, value, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(workspace_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(workspaceId, key, JSON.stringify(value), now);
    return value;
}

function getAll(workspaceId) {
    const db = open();
    const rows = db.prepare(
        'SELECT key, value FROM meta WHERE workspace_id = ?'
    ).all(workspaceId);
    const out = { ...DEFAULTS };
    for (const r of rows) {
        try { out[r.key] = JSON.parse(r.value); } catch {}
    }
    return out;
}

function setMany(workspaceId, patch) {
    const db = open();
    const now = new Date().toISOString();
    const stmt = db.prepare(`
        INSERT INTO meta (workspace_id, key, value, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(workspace_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);
    const tx = db.transaction(() => {
        for (const [k, v] of Object.entries(patch)) {
            stmt.run(workspaceId, k, JSON.stringify(v), now);
        }
    });
    tx();
    return getAll(workspaceId);
}

module.exports = { get, set, getAll, setMany, DEFAULTS };
