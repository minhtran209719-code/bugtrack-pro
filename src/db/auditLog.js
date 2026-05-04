// DAL: audit_log
// Schema có sẵn từ giai đoạn 1, ghi khi config.audit.enabled = true.
// Khi cần compliance/tracing, bật env AUDIT_ENABLED=true, không cần migrate.

const { ulid } = require('ulid');
const { open } = require('./connection');
const config = require('../config');

function write({ workspaceId, userId, action, resourceType, resourceId, payload }) {
    if (!config.audit.enabled) return;
    const db = open();
    db.prepare(`
        INSERT INTO audit_log (id, workspace_id, user_id, action, resource_type, resource_id, payload, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        ulid(),
        workspaceId || null,
        userId || null,
        action,
        resourceType || null,
        resourceId || null,
        payload ? JSON.stringify(payload) : null,
        new Date().toISOString()
    );
}

function query(workspaceId, opts = {}) {
    const db = open();
    const where = [];
    const args = [];
    if (workspaceId) { where.push('workspace_id = ?'); args.push(workspaceId); }
    if (opts.resourceType) { where.push('resource_type = ?'); args.push(opts.resourceType); }
    if (opts.resourceId)   { where.push('resource_id = ?');   args.push(opts.resourceId); }
    if (opts.action)       { where.push('action = ?');        args.push(opts.action); }
    if (opts.from)         { where.push('created_at >= ?');   args.push(opts.from); }
    if (opts.to)           { where.push('created_at <= ?');   args.push(opts.to); }
    const wh = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const page = Math.max(1, parseInt(opts.page, 10) || 1);
    const size = Math.min(500, Math.max(1, parseInt(opts.size, 10) || 100));
    const offset = (page - 1) * size;
    return db.prepare(
        `SELECT * FROM audit_log ${wh} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    ).all(...args, size, offset);
}

module.exports = { write, query };
