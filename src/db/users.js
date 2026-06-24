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

// Danh bạ nhẹ cho FE: id → {id,name,role} của user ĐANG hoạt động (mọi user login đọc được).
function directory(workspaceId) {
    const db = open();
    return db.prepare(
        'SELECT id, name, role FROM users WHERE workspace_id = ? AND active = 1 ORDER BY role, name'
    ).all(workspaceId);
}

// Map id → name (kể cả user đã khoá) để resolve hiển thị / history.
function nameMap(workspaceId) {
    const db = open();
    const out = {};
    for (const r of db.prepare('SELECT id, name FROM users WHERE workspace_id = ?').all(workspaceId)) {
        out[r.id] = r.name;
    }
    return out;
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

const ROLES = ['admin', 'dev', 'support'];

function setRole(workspaceId, id, role) {
    if (!ROLES.includes(role)) return false;
    const db = open();
    const r = db.prepare('UPDATE users SET role = ?, updated_at = ? WHERE workspace_id = ? AND id = ?')
        .run(role, new Date().toISOString(), workspaceId, id);
    return r.changes > 0;
}

function setActive(workspaceId, id, active) {
    const db = open();
    const r = db.prepare('UPDATE users SET active = ?, updated_at = ? WHERE workspace_id = ? AND id = ?')
        .run(active ? 1 : 0, new Date().toISOString(), workspaceId, id);
    return r.changes > 0;
}

function setName(workspaceId, id, name) {
    const db = open();
    const r = db.prepare('UPDATE users SET name = ?, updated_at = ? WHERE workspace_id = ? AND id = ?')
        .run(String(name).trim(), new Date().toISOString(), workspaceId, id);
    return r.changes > 0;
}

function setEmail(workspaceId, id, email) {
    const db = open();
    const r = db.prepare('UPDATE users SET email = ?, updated_at = ? WHERE workspace_id = ? AND id = ?')
        .run(String(email).trim().toLowerCase(), new Date().toISOString(), workspaceId, id);
    return r.changes > 0;
}

module.exports = { toPublic, getByEmail, getById, list, directory, nameMap, create, setPassword, setRole, setActive, setName, setEmail, count, ROLES };
