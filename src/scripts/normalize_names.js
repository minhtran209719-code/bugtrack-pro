// Chuyển assignee/reporter/proposer trên bug & improvement cũ: TÊN (chuỗi) → user ID.
// Chạy SAU khi seed_users.js (tài khoản phải tồn tại để map tên→id).
// Khoan dung dấu: tên ASCII cũ ("Tung") map sang account có dấu ("Tùng") rồi lấy id.
// Idempotent: giá trị đã là 'USR-...' hoặc rỗng → bỏ qua.
// Chạy: node src/scripts/normalize_names.js          (DRY-RUN)
//       node src/scripts/normalize_names.js --apply

const config = require('../config');
const db = require('../db');
const { open } = require('../db/connection');

const WS = config.defaults.workspace;
const APPLY = process.argv.includes('--apply');

// Map tên ASCII (data cũ) → tên account có dấu (để tra id).
const ASCII_TO_DISPLAY = {
    'Tung': 'Tùng', 'Hoang': 'Hoàng', 'Tien': 'Tiến', 'Thuy': 'Thùy', 'Thang': 'Thắng',
    // Quang giữ nguyên
};

function buildResolver() {
    // name(lowercased) → userId, gồm cả tên account + biến thể ASCII.
    const byName = {};
    for (const u of db.users.directory(WS)) {
        if (u.name) byName[u.name.toLowerCase()] = u.id;
    }
    return (val) => {
        if (!val) return val;
        if (String(val).startsWith('USR-')) return val; // đã là id
        const display = ASCII_TO_DISPLAY[val] || val;
        return byName[display.toLowerCase()] || null;    // null = không khớp account
    };
}

function run() {
    const conn = open();
    if (db.users.count(WS) === 0) {
        console.log('⚠️  Chưa có user nào — chạy seed_users.js trước.');
        return;
    }
    const resolve = buildResolver();
    const changes = [], unmatched = new Set();

    const bugs = conn.prepare('SELECT id, assignee, reporter FROM bugs WHERE workspace_id = ?').all(WS);
    const imps = conn.prepare('SELECT id, assignee, proposer FROM improvements WHERE workspace_id = ?').all(WS);

    const plan = (rows, fields) => rows.map(r => {
        const upd = {};
        for (const f of fields) {
            if (!r[f] || String(r[f]).startsWith('USR-')) continue;
            const id = resolve(r[f]);
            if (id) upd[f] = id; else unmatched.add(r[f]);
        }
        return Object.keys(upd).length ? { id: r.id, upd, old: r } : null;
    }).filter(Boolean);

    const bugPlan = plan(bugs, ['assignee', 'reporter']);
    const impPlan = plan(imps, ['assignee', 'proposer']);

    console.log(`\n===== ${APPLY ? 'ÁP DỤNG' : 'DRY-RUN (thêm --apply để ghi)'} =====`);
    [...bugPlan.map(p => ['bug', p]), ...impPlan.map(p => ['imp', p])].forEach(([k, p]) => {
        const parts = Object.entries(p.upd).map(([f, id]) => `${f}: "${p.old[f]}" → ${id}`);
        console.log(`  ${k} ${p.id}: ${parts.join(', ')}`);
    });
    console.log(`Tổng: ${bugPlan.length} bug, ${impPlan.length} imp.`);
    if (unmatched.size) console.log(`⚠️  Tên KHÔNG khớp tài khoản (giữ nguyên): ${[...unmatched].join(', ')} — tạo account tương ứng rồi chạy lại.`);
    console.log('');

    if (!APPLY) return;
    const now = new Date().toISOString();
    const tx = conn.transaction(() => {
        const ub = conn.prepare('UPDATE bugs SET assignee = COALESCE(?, assignee), reporter = COALESCE(?, reporter), updated_at = ? WHERE workspace_id = ? AND id = ?');
        for (const p of bugPlan) ub.run(p.upd.assignee || null, p.upd.reporter || null, now, WS, p.id);
        const ui = conn.prepare('UPDATE improvements SET assignee = COALESCE(?, assignee), proposer = COALESCE(?, proposer), updated_at = ? WHERE workspace_id = ? AND id = ?');
        for (const p of impPlan) ui.run(p.upd.assignee || null, p.upd.proposer || null, now, WS, p.id);
    });
    tx();
    console.log('✅ Đã ghi xong.\n');
}

if (require.main === module) run();
module.exports = { run };
