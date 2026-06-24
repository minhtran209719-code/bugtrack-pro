// Chuẩn hoá tên người (ASCII → có dấu) cho khớp tài khoản đăng nhập.
// Đổi devList/reporterList + assignee/reporter/proposer trên bug & improvement hiện có.
// Idempotent: chạy lại không đổi thêm (tên đã có dấu không khớp key ASCII nữa).
// Chạy: node src/scripts/normalize_names.js          (DRY-RUN: chỉ in ra sẽ đổi gì)
//       node src/scripts/normalize_names.js --apply   (THỰC SỰ ghi)

const config = require('../config');
const db = require('../db');
const { open } = require('../db/connection');

const WS = config.defaults.workspace;
const APPLY = process.argv.includes('--apply');

// Map tên ASCII → có dấu. 'Quang' giữ nguyên nên không cần.
const NAME_MAP = {
    'Tung': 'Tùng',
    'Hoang': 'Hoàng',
    'Tien': 'Tiến',
    'Thuy': 'Thùy',
    'Thang': 'Thắng',
};
// Bổ sung thành viên vào danh sách nếu thiếu (roster đã chốt).
const DEV_ROSTER = ['Quang', 'Tùng', 'Hoàng'];
const REPORTER_ROSTER = ['Tiến', 'Thùy', 'Thắng'];

function mapName(v) { return v && NAME_MAP[v] ? NAME_MAP[v] : v; }

function mergeList(current, mapped, roster) {
    const out = [];
    const seen = new Set();
    for (const n of current.map(mapName)) { if (n && !seen.has(n)) { seen.add(n); out.push(n); } }
    for (const n of roster) { if (!seen.has(n)) { seen.add(n); out.push(n); } } // thêm người còn thiếu
    return out;
}

function run() {
    const conn = open();
    const changes = [];

    // 1) meta lists
    const devList = db.meta.get(WS, 'devList') || [];
    const repList = db.meta.get(WS, 'reporterList') || [];
    const newDev = mergeList(devList, NAME_MAP, DEV_ROSTER);
    const newRep = mergeList(repList, NAME_MAP, REPORTER_ROSTER);
    changes.push(`devList: ${JSON.stringify(devList)} → ${JSON.stringify(newDev)}`);
    changes.push(`reporterList: ${JSON.stringify(repList)} → ${JSON.stringify(newRep)}`);

    // 2) bugs.assignee / bugs.reporter ; improvements.assignee / improvements.proposer
    const bugAssign = conn.prepare('SELECT id, assignee, reporter FROM bugs WHERE workspace_id = ?').all(WS);
    const impAssign = conn.prepare('SELECT id, assignee, proposer FROM improvements WHERE workspace_id = ?').all(WS);
    const bugUpd = bugAssign.filter(b => mapName(b.assignee) !== b.assignee || mapName(b.reporter) !== b.reporter);
    const impUpd = impAssign.filter(i => mapName(i.assignee) !== i.assignee || mapName(i.proposer) !== i.proposer);
    bugUpd.forEach(b => changes.push(`bug ${b.id}: assignee ${JSON.stringify(b.assignee)}→${JSON.stringify(mapName(b.assignee))}, reporter ${JSON.stringify(b.reporter)}→${JSON.stringify(mapName(b.reporter))}`));
    impUpd.forEach(i => changes.push(`imp ${i.id}: assignee ${JSON.stringify(i.assignee)}→${JSON.stringify(mapName(i.assignee))}, proposer ${JSON.stringify(i.proposer)}→${JSON.stringify(mapName(i.proposer))}`));

    console.log(`\n===== ${APPLY ? 'ÁP DỤNG' : 'DRY-RUN (thêm --apply để ghi thật)'} =====`);
    changes.forEach(c => console.log('  ' + c));
    console.log(`Tổng: ${bugUpd.length} bug, ${impUpd.length} imp cần đổi tên.\n`);

    if (!APPLY) { return; }

    const now = new Date().toISOString();
    const tx = conn.transaction(() => {
        db.meta.set(WS, 'devList', newDev);
        db.meta.set(WS, 'reporterList', newRep);
        const ub = conn.prepare('UPDATE bugs SET assignee = ?, reporter = ?, updated_at = ? WHERE workspace_id = ? AND id = ?');
        for (const b of bugUpd) ub.run(mapName(b.assignee), mapName(b.reporter), now, WS, b.id);
        const ui = conn.prepare('UPDATE improvements SET assignee = ?, proposer = ?, updated_at = ? WHERE workspace_id = ? AND id = ?');
        for (const i of impUpd) ui.run(mapName(i.assignee), mapName(i.proposer), now, WS, i.id);
    });
    tx();
    console.log('✅ Đã ghi xong.\n');
}

if (require.main === module) run();
module.exports = { run, NAME_MAP };
