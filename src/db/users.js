// DAL: users — đăng nhập + phân quyền (seam #A auth, giai đoạn 2).
// Quy tắc: workspace_id ở tham số đầu. role: 'admin' | 'dev' | 'support'.

const { ulid } = require('ulid');
const { open } = require('./connection');

function toPublic(r) {
    if (!r) return null;
    return { id: r.id, email: r.email, name: r.name, role: r.role, active: !!r.active };
}

function getByEmail(workspaceId, email) {
    const db = open();
    return db.prepare(
        'SELECT * FROM users WHERE workspace_id = ? AND lower(email) = lower(?)'
    ).get(workspaceId, String(email || '').trim());
}

function getById(workspaceId, id) {
    const db = open();
    return db.prepare(
        'SELECT * FROM users WHERE workspace_id = ? AND id = ?'
    ).get(workspaceId, id);
}

function list(workspaceId) {
    const db = open();
    return db.prepare(
        'SELECT * FROM users WHERE workspace_id = ? ORDER BY role, name'
    ).all(workspaceId).map(toPublic);
}

function create(workspaceId, { email, name, passwordHash, role }) {
    const db = open();
    const now = new Date().toISOString();
    const id = 'USR-' + ulid();
    db.prepare(`
        INSERT INTO users (id, workspace_id, email, name, password_hash, role, active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(id, workspaceId, String(email).trim(), name || null, passwordHash || null, role || 'support', now, now);
    return getById(workspaceId, id);
}

function setPassword(workspaceId, id, passwordHash) {
    const db = open();
    const now = new Date().toISOString();
    const r = db.prepare(
        'UPDATE users SET password_hash = ?, updated_at = ? WHERE workspace_id = ? AND id = ?'
    ).run(passwordHash, now, workspaceId, id);
    return r.changes > 0;
}

function count(workspaceId) {
    const db = open();
    return db.prepare('SELECT COUNT(*) AS c FROM users WHERE workspace_id = ?').get(workspaceId).c;
}

module.exports = { toPublic, getByEmail, getById, list, create, setPassword, count };
