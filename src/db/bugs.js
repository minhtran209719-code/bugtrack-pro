// DAL: bugs
// QUY TẮC BẤT BIẾN (đọc CLAUDE.md mục "Architecture seams"):
//   - Mọi function PHẢI nhận workspace_id ở tham số đầu, KHÔNG default.
//   - attachments, history lưu JSON string (cột TEXT). API trả về đã parse.
//   - id = 'BUG-' + ulid(); display_number = MAX+1 per workspace (UI 'BUG-0042').

const { ulid } = require('ulid');
const { open } = require('./connection');

function makeId() { return 'BUG-' + ulid(); }

function nextDisplayNumber(workspaceId) {
    const db = open();
    const row = db.prepare(
        'SELECT COALESCE(MAX(display_number), 0) AS m FROM bugs WHERE workspace_id = ?'
    ).get(workspaceId);
    return row.m + 1;
}

function rowToBug(r) {
    if (!r) return null;
    return {
        id: r.id,
        displayNumber: r.display_number,
        displayId: 'BUG-' + String(r.display_number).padStart(4, '0'),
        product: r.product,
        name: r.name,
        description: r.description,
        type: r.type,
        severity: r.severity,
        status: r.status,
        module: r.module,
        reporter: r.reporter,
        assignee: r.assignee,
        testStatus: r.test_status,
        supportNote: r.support_note,
        devNote: r.dev_note,
        foundDate: r.found_date,
        deadline: r.deadline,
        completedDate: r.completed_date,
        attachments: r.attachments ? JSON.parse(r.attachments) : [],
        history: r.history ? JSON.parse(r.history) : [],
        createdAt: r.created_at,
        updatedAt: r.updated_at,
    };
}

const FIELD_MAP = {
    name: 'name', description: 'description', type: 'type',
    severity: 'severity', status: 'status', module: 'module',
    reporter: 'reporter', assignee: 'assignee',
    testStatus: 'test_status', supportNote: 'support_note', devNote: 'dev_note',
    foundDate: 'found_date', deadline: 'deadline', completedDate: 'completed_date',
    attachments: 'attachments', history: 'history',
    product: 'product',
};

const FIELD_LABELS = {
    name: 'Tên lỗi', description: 'Mô tả', type: 'Loại lỗi', severity: 'Mức độ',
    status: 'Trạng thái', assignee: 'Người xử lý', reporter: 'Người TT',
    testStatus: 'TT Test', module: 'Thiết bị', devNote: 'Ghi chú XL',
    supportNote: 'Ghi chú TT', foundDate: 'Ngày phát hiện',
};

function buildWhere(workspaceId, filters = {}) {
    const where = ['workspace_id = ?'];
    const args = [workspaceId];
    if (filters.product)   { where.push('product = ?');   args.push(filters.product); }
    if (filters.status)    { where.push('status = ?');    args.push(filters.status); }
    if (filters.severity)  { where.push('severity = ?');  args.push(filters.severity); }
    if (filters.type)      { where.push('type = ?');      args.push(filters.type); }
    if (filters.module)    { where.push('module = ?');    args.push(filters.module); }
    if (filters.assignee)  { where.push('assignee = ?');  args.push(filters.assignee); }
    if (filters.reporter)  { where.push('reporter = ?');  args.push(filters.reporter); }
    if (filters.from)      { where.push('created_at >= ?'); args.push(filters.from); }
    if (filters.to)        { where.push('created_at <= ?'); args.push(filters.to); }
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
        `SELECT * FROM bugs WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    ).all(...args, size, offset);

    const total = db.prepare(
        `SELECT COUNT(*) AS c FROM bugs WHERE ${where}`
    ).get(...args).c;

    return {
        items: rows.map(rowToBug),
        page, size, total,
        totalPages: Math.max(1, Math.ceil(total / size)),
    };
}

function get(workspaceId, id) {
    const db = open();
    const row = db.prepare(
        'SELECT * FROM bugs WHERE workspace_id = ? AND id = ?'
    ).get(workspaceId, id);
    return rowToBug(row);
}

function getByDisplayNumber(workspaceId, n) {
    const db = open();
    const row = db.prepare(
        'SELECT * FROM bugs WHERE workspace_id = ? AND display_number = ?'
    ).get(workspaceId, n);
    return rowToBug(row);
}

function create(workspaceId, input) {
    const db = open();
    const now = new Date().toISOString();
    const id = makeId();
    const display = nextDisplayNumber(workspaceId);
    const history = [{ time: now, action: 'Tạo mới', detail: `Tạo lỗi "${input.name || ''}"` }];

    db.prepare(`
        INSERT INTO bugs (
            id, workspace_id, display_number, product, name, description,
            type, severity, status, module, reporter, assignee,
            test_status, support_note, dev_note,
            found_date, deadline, completed_date,
            attachments, history, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        id, workspaceId, display,
        input.product, input.name || '', input.description || null,
        input.type || null, input.severity || null, input.status || 'Đang xử lí',
        input.module || null, input.reporter || null, input.assignee || null,
        input.testStatus || null, input.supportNote || null, input.devNote || null,
        input.foundDate || null, input.deadline || null,
        input.status === 'Đã xử lí' ? now : null,
        JSON.stringify(input.attachments || []),
        JSON.stringify(history),
        now, now
    );

    return get(workspaceId, id);
}

function update(workspaceId, id, patch) {
    const db = open();
    const old = get(workspaceId, id);
    if (!old) return null;

    // Diff để ghi history
    const changes = [];
    for (const key of Object.keys(patch)) {
        if (FIELD_LABELS[key] && patch[key] !== old[key]) {
            const oldV = old[key] === null || old[key] === undefined || old[key] === '' ? '(trống)' : old[key];
            const newV = patch[key] === null || patch[key] === undefined || patch[key] === '' ? '(trống)' : patch[key];
            changes.push(`${FIELD_LABELS[key]}: "${oldV}" → "${newV}"`);
        }
    }
    const now = new Date().toISOString();
    const history = [...(old.history || [])];
    if (changes.length > 0) {
        history.push({ time: now, action: 'Cập nhật', detail: changes.join(' | ') });
    }

    // Build SET clause
    const sets = [];
    const args = [];
    for (const [key, col] of Object.entries(FIELD_MAP)) {
        if (key in patch) {
            sets.push(`${col} = ?`);
            args.push(
                key === 'attachments' || key === 'history'
                    ? JSON.stringify(patch[key])
                    : patch[key]
            );
        }
    }
    // Đảm bảo history luôn cập nhật khi có change
    if (changes.length > 0 && !('history' in patch)) {
        sets.push('history = ?'); args.push(JSON.stringify(history));
    }
    // Auto set completed_date khi chuyển sang 'Đã xử lí'
    if (patch.status === 'Đã xử lí' && old.status !== 'Đã xử lí' && !('completedDate' in patch)) {
        sets.push('completed_date = ?'); args.push(now);
    }
    sets.push('updated_at = ?'); args.push(now);

    if (sets.length === 1) return old; // Không có thay đổi thực sự

    db.prepare(
        `UPDATE bugs SET ${sets.join(', ')} WHERE workspace_id = ? AND id = ?`
    ).run(...args, workspaceId, id);

    return get(workspaceId, id);
}

function remove(workspaceId, id) {
    const db = open();
    const bug = get(workspaceId, id);
    if (!bug) return null;
    db.prepare('DELETE FROM bugs WHERE workspace_id = ? AND id = ?').run(workspaceId, id);
    return bug; // Trả về bug đã xoá để caller có thể cleanup attachments
}

function changedSince(workspaceId, sinceIso) {
    const db = open();
    const rows = db.prepare(
        'SELECT * FROM bugs WHERE workspace_id = ? AND updated_at > ? ORDER BY updated_at ASC'
    ).all(workspaceId, sinceIso);
    return rows.map(rowToBug);
}

function statsByAssignee(workspaceId, opts = {}) {
    const db = open();
    const { where, args } = buildWhere(workspaceId, opts);
    return db.prepare(`
        SELECT
            COALESCE(NULLIF(assignee, ''), '(Chưa giao)') AS assignee,
            COUNT(*) AS total,
            SUM(CASE WHEN status = 'Đã xử lí' THEN 1 ELSE 0 END) AS done,
            SUM(CASE WHEN status = 'Đang xử lí' THEN 1 ELSE 0 END) AS open,
            SUM(CASE WHEN status = 'Chưa có P.A' THEN 1 ELSE 0 END) AS noplan
        FROM bugs WHERE ${where}
        GROUP BY COALESCE(NULLIF(assignee, ''), '(Chưa giao)')
        ORDER BY total DESC
    `).all(...args);
}

function statsByReporter(workspaceId, opts = {}) {
    const db = open();
    const { where, args } = buildWhere(workspaceId, opts);
    return db.prepare(`
        SELECT
            COALESCE(NULLIF(reporter, ''), '(Chưa rõ)') AS reporter,
            COUNT(*) AS total,
            SUM(CASE WHEN test_status = 'Đã test' THEN 1 ELSE 0 END) AS tested,
            SUM(CASE WHEN test_status = 'Chờ test' THEN 1 ELSE 0 END) AS waiting,
            SUM(CASE WHEN test_status IS NULL OR test_status = '' OR test_status = 'Chưa test' THEN 1 ELSE 0 END) AS untested
        FROM bugs WHERE ${where}
        GROUP BY COALESCE(NULLIF(reporter, ''), '(Chưa rõ)')
        ORDER BY total DESC
    `).all(...args);
}

function statsByModule(workspaceId, opts = {}) {
    const db = open();
    const { where, args } = buildWhere(workspaceId, opts);
    return db.prepare(`
        SELECT
            COALESCE(NULLIF(module, ''), '(Không rõ)') AS module,
            COUNT(*) AS total,
            SUM(CASE WHEN status = 'Đã xử lí' THEN 1 ELSE 0 END) AS done
        FROM bugs WHERE ${where}
        GROUP BY COALESCE(NULLIF(module, ''), '(Không rõ)')
        ORDER BY total DESC
    `).all(...args);
}

function summary(workspaceId, opts = {}) {
    const db = open();
    const { where, args } = buildWhere(workspaceId, opts);
    return db.prepare(`
        SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN status = 'Đang xử lí' THEN 1 ELSE 0 END) AS open,
            SUM(CASE WHEN status = 'Đã xử lí' THEN 1 ELSE 0 END) AS done,
            SUM(CASE WHEN status = 'Chưa có P.A' THEN 1 ELSE 0 END) AS noplan,
            SUM(CASE WHEN severity = 'Nghiêm trọng' AND status != 'Đã xử lí' THEN 1 ELSE 0 END) AS critical_open
        FROM bugs WHERE ${where}
    `).get(...args);
}

// Trả về tất cả URL attachments của workspace (dùng cho cron orphan cleanup).
function allAttachmentUrls(workspaceId) {
    const db = open();
    const rows = db.prepare(
        'SELECT attachments FROM bugs WHERE workspace_id = ?'
    ).all(workspaceId);
    const urls = new Set();
    for (const r of rows) {
        try {
            const arr = JSON.parse(r.attachments || '[]');
            for (const u of arr) if (u) urls.add(u);
        } catch {}
    }
    return urls;
}

module.exports = {
    makeId, nextDisplayNumber, rowToBug,
    list, get, getByDisplayNumber,
    create, update, delete: remove,
    changedSince,
    statsByAssignee, statsByReporter, statsByModule, summary,
    allAttachmentUrls,
};
