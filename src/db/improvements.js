// DAL: improvements
// Tuân thủ cùng quy tắc với bugs.js — workspace_id ở tham số đầu, ULID id, display_number per workspace.

const { ulid } = require('ulid');
const { open } = require('./connection');

function makeId() { return 'IMP-' + ulid(); }

function nextDisplayNumber(workspaceId) {
    const db = open();
    const row = db.prepare(
        'SELECT COALESCE(MAX(display_number), 0) AS m FROM improvements WHERE workspace_id = ?'
    ).get(workspaceId);
    return row.m + 1;
}

function rowToImp(r) {
    if (!r) return null;
    return {
        id: r.id,
        displayNumber: r.display_number,
        displayId: 'IMP-' + String(r.display_number).padStart(4, '0'),
        name: r.name,
        description: r.description,
        priority: r.priority,
        status: r.status,
        proposer: r.proposer,
        assignee: r.assignee,
        completedDate: r.completed_date,
        devNote: r.dev_note,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
    };
}

const FIELD_MAP = {
    name: 'name', description: 'description', priority: 'priority',
    status: 'status', proposer: 'proposer', assignee: 'assignee',
    completedDate: 'completed_date', devNote: 'dev_note',
};

function buildWhere(workspaceId, filters = {}) {
    const where = ['workspace_id = ?'];
    const args = [workspaceId];
    if (filters.status)   { where.push('status = ?');   args.push(filters.status); }
    if (filters.priority) { where.push('priority = ?'); args.push(filters.priority); }
    if (filters.search) {
        where.push('(name LIKE ? OR description LIKE ? OR id LIKE ?)');
        const like = '%' + filters.search + '%';
        args.push(like, like, like);
    }
    return { where: where.join(' AND '), args };
}

function list(workspaceId, opts = {}) {
    const db = open();
    const { where, args } = buildWhere(workspaceId, opts);
    const page = Math.max(1, parseInt(opts.page, 10) || 1);
    const size = Math.min(500, Math.max(1, parseInt(opts.size, 10) || 50));
    const offset = (page - 1) * size;

    const rows = db.prepare(
        `SELECT * FROM improvements WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    ).all(...args, size, offset);
    const total = db.prepare(
        `SELECT COUNT(*) AS c FROM improvements WHERE ${where}`
    ).get(...args).c;

    return {
        items: rows.map(rowToImp),
        page, size, total,
        totalPages: Math.max(1, Math.ceil(total / size)),
    };
}

function get(workspaceId, id) {
    const db = open();
    const row = db.prepare(
        'SELECT * FROM improvements WHERE workspace_id = ? AND id = ?'
    ).get(workspaceId, id);
    return rowToImp(row);
}

function create(workspaceId, input) {
    const db = open();
    const now = new Date().toISOString();
    const id = makeId();
    const display = nextDisplayNumber(workspaceId);

    db.prepare(`
        INSERT INTO improvements (
            id, workspace_id, display_number, name, description,
            priority, status, proposer, assignee, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        id, workspaceId, display,
        input.name || '', input.description || null,
        input.priority || 'Trung bình', input.status || 'Ý tưởng',
        input.proposer || null, input.assignee || null,
        now, now
    );

    return get(workspaceId, id);
}

function update(workspaceId, id, patch) {
    const db = open();
    const old = get(workspaceId, id);
    if (!old) return null;

    const sets = [];
    const args = [];
    for (const [key, col] of Object.entries(FIELD_MAP)) {
        if (key in patch) { sets.push(`${col} = ?`); args.push(patch[key]); }
    }
    if (sets.length === 0) return old;

    const now = new Date().toISOString();
    sets.push('updated_at = ?'); args.push(now);

    db.prepare(
        `UPDATE improvements SET ${sets.join(', ')} WHERE workspace_id = ? AND id = ?`
    ).run(...args, workspaceId, id);

    return get(workspaceId, id);
}

function remove(workspaceId, id) {
    const db = open();
    const imp = get(workspaceId, id);
    if (!imp) return null;
    db.prepare('DELETE FROM improvements WHERE workspace_id = ? AND id = ?').run(workspaceId, id);
    return imp;
}

function changedSince(workspaceId, sinceIso) {
    const db = open();
    const rows = db.prepare(
        'SELECT * FROM improvements WHERE workspace_id = ? AND updated_at > ? ORDER BY updated_at ASC'
    ).all(workspaceId, sinceIso);
    return rows.map(rowToImp);
}

module.exports = {
    makeId, nextDisplayNumber, rowToImp,
    list, get, create, update, delete: remove,
    changedSince,
};
