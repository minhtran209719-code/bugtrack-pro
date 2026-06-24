// DAL: bugs
// QUY TẮC BẤT BIẾN (đọc CLAUDE.md mục "Architecture seams"):
//   - Mọi function PHẢI nhận workspace_id ở tham số đầu, KHÔNG default.
//   - attachments, history lưu JSON string (cột TEXT). API trả về đã parse.
//   - id = 'BUG-' + ulid(); display_number = MAX+1 per workspace (UI 'BUG-0042').
// SOFT-DELETE (migration 004): xoá = set deleted_at/deleted_by, KHÔNG xoá row.
//   - Mọi read path lọc `deleted_at IS NULL` (trừ changedSince: phát tín hiệu xoá cho client khác).
//   - nextDisplayNumber tính MAX trên CẢ row đã xoá mềm → không tái dùng số, không reset.
// ATTRIBUTION: created_by / assigned_by+assigned_at / deleted_by lưu TÊN người (nhất quán assignee/reporter là tên).

const { ulid } = require('ulid');
const { open } = require('./connection');
const users = require('./users');

function makeId() { return 'BUG-' + ulid(); }
// LƯU THEO ID: created_by/assigned_by/deleted_by + assignee/reporter = userId. Hiển thị resolve qua nameMap.
function actorId(actor) { return (actor && actor.userId) || null; }
function actorLabel(actor) { return (actor && (actor.name || actor.userId)) || null; } // tên cho history (point-in-time)

function nextDisplayNumber(workspaceId) {
    const db = open();
    // KHÔNG lọc deleted_at: giữ MAX trên mọi row (kể cả xoá mềm) để số không bị tái dùng.
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
        createdBy: r.created_by,
        assignedBy: r.assigned_by,
        assignedAt: r.assigned_at,
        deletedAt: r.deleted_at,
        deletedBy: r.deleted_by,
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

// deletedMode: 'active' (mặc định, chưa xoá) | 'only' (chỉ đã xoá) | 'all'
function deletedClause(deletedMode) {
    if (deletedMode === 'only') return 'deleted_at IS NOT NULL';
    if (deletedMode === 'all') return null;
    return 'deleted_at IS NULL';
}

function buildWhere(workspaceId, filters = {}) {
    const where = ['workspace_id = ?'];
    const args = [workspaceId];
    const dc = deletedClause(filters.deletedMode);
    if (dc) where.push(dc);
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

// Lấy 1 bug. Mặc định KHÔNG trả bug đã xoá mềm (opts.includeDeleted=true để restore/admin).
function get(workspaceId, id, opts = {}) {
    const db = open();
    const row = db.prepare(
        'SELECT * FROM bugs WHERE workspace_id = ? AND id = ?'
    ).get(workspaceId, id);
    if (!row) return null;
    if (!opts.includeDeleted && row.deleted_at) return null;
    return rowToBug(row);
}

function getByDisplayNumber(workspaceId, n) {
    const db = open();
    const row = db.prepare(
        'SELECT * FROM bugs WHERE workspace_id = ? AND display_number = ? AND deleted_at IS NULL'
    ).get(workspaceId, n);
    return rowToBug(row);
}

function create(workspaceId, input, actor) {
    const db = open();
    const now = new Date().toISOString();
    const id = makeId();
    const display = nextDisplayNumber(workspaceId);
    const who = actorId(actor);          // lưu id vào cột
    const wholabel = actorLabel(actor);  // tên cho history
    const history = [{ time: now, action: 'Tạo mới', detail: `Tạo lỗi "${input.name || ''}"${wholabel ? ' (bởi ' + wholabel + ')' : ''}` }];
    const hasAssignee = !!(input.assignee && String(input.assignee).trim());

    db.prepare(`
        INSERT INTO bugs (
            id, workspace_id, display_number, product, name, description,
            type, severity, status, module, reporter, assignee,
            test_status, support_note, dev_note,
            found_date, deadline, completed_date,
            attachments, history, created_by, assigned_by, assigned_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        who,
        hasAssignee ? who : null,
        hasAssignee ? now : null,
        now, now
    );

    return get(workspaceId, id);
}

function update(workspaceId, id, patch, actor) {
    const db = open();
    const old = get(workspaceId, id); // không cho update bug đã xoá mềm
    if (!old) return null;
    const wholabel = actorLabel(actor);
    const nm = users.nameMap(workspaceId); // resolve id→tên cho history của assignee/reporter

    // Diff để ghi history (assignee/reporter là id → hiện tên)
    const changes = [];
    for (const key of Object.keys(patch)) {
        if (FIELD_LABELS[key] && patch[key] !== old[key]) {
            const resolve = (v) => (key === 'assignee' || key === 'reporter') && v ? (nm[v] || v) : v;
            let oldV = resolve(old[key]), newV = resolve(patch[key]);
            oldV = oldV === null || oldV === undefined || oldV === '' ? '(trống)' : oldV;
            newV = newV === null || newV === undefined || newV === '' ? '(trống)' : newV;
            changes.push(`${FIELD_LABELS[key]}: "${oldV}" → "${newV}"`);
        }
    }
    const now = new Date().toISOString();
    const history = [...(old.history || [])];
    if (changes.length > 0) {
        history.push({ time: now, action: 'Cập nhật', detail: changes.join(' | ') + (wholabel ? ` (bởi ${wholabel})` : '') });
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
    // "Nhận bởi ai": khi assignee đổi sang người mới → ghi người gán (id) + thời điểm
    if ('assignee' in patch && (patch.assignee || '') !== (old.assignee || '')) {
        sets.push('assigned_by = ?'); args.push(patch.assignee ? actorId(actor) : null);
        sets.push('assigned_at = ?'); args.push(patch.assignee ? now : null);
    }
    sets.push('updated_at = ?'); args.push(now);

    if (sets.length === 1) return old; // Không có thay đổi thực sự

    db.prepare(
        `UPDATE bugs SET ${sets.join(', ')} WHERE workspace_id = ? AND id = ?`
    ).run(...args, workspaceId, id);

    return get(workspaceId, id);
}

// Xoá MỀM: giữ row + attachments (để khôi phục). Trả bug đã xoá.
function remove(workspaceId, id, actor) {
    const db = open();
    const bug = get(workspaceId, id);
    if (!bug) return null;
    const now = new Date().toISOString();
    const history = [...(bug.history || []), { time: now, action: 'Xoá', detail: `Xoá mềm${actorLabel(actor) ? ' (bởi ' + actorLabel(actor) + ')' : ''}` }];
    db.prepare(
        'UPDATE bugs SET deleted_at = ?, deleted_by = ?, history = ?, updated_at = ? WHERE workspace_id = ? AND id = ?'
    ).run(now, actorId(actor), JSON.stringify(history), now, workspaceId, id);
    return bug;
}

// Khôi phục bug đã xoá mềm.
function restore(workspaceId, id, actor) {
    const db = open();
    const row = db.prepare('SELECT * FROM bugs WHERE workspace_id = ? AND id = ?').get(workspaceId, id);
    if (!row || !row.deleted_at) return null;
    const now = new Date().toISOString();
    const bug = rowToBug(row);
    const history = [...(bug.history || []), { time: now, action: 'Khôi phục', detail: `Khôi phục${actorLabel(actor) ? ' (bởi ' + actorLabel(actor) + ')' : ''}` }];
    db.prepare(
        'UPDATE bugs SET deleted_at = NULL, deleted_by = NULL, history = ?, updated_at = ? WHERE workspace_id = ? AND id = ?'
    ).run(JSON.stringify(history), now, workspaceId, id);
    return get(workspaceId, id);
}

// changedSince: KHÔNG lọc deleted → trả cả bug vừa bị xoá mềm (deletedAt set) để client khác gỡ khỏi cache.
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
// Gồm CẢ bug đã xoá mềm — attachments của chúng KHÔNG phải orphan (còn khôi phục được).
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
    create, update, delete: remove, restore,
    changedSince,
    statsByAssignee, statsByReporter, statsByModule, summary,
    allAttachmentUrls,
};
