// Seed tài khoản đăng nhập ban đầu cho workspace 'default'.
// Chạy 1 lần: `node src/scripts/seed_users.js`
// Idempotent: email đã tồn tại thì BỎ QUA (không đổi mật khẩu). In mật khẩu tạm ra stdout.
// Email = tên ascii viết thường (đăng nhập bằng email này). Đổi mật khẩu sau khi login.

const config = require('../config');
const db = require('../db');
const password = require('../auth/password');

const WS = config.defaults.workspace;

const SEED = [
    { email: 'admin', name: 'Admin', role: 'admin' },
    { email: 'quang', name: 'Quang', role: 'dev' },
    { email: 'tung',  name: 'Tùng',  role: 'dev' },
    { email: 'hoang', name: 'Hoàng', role: 'dev' },
    { email: 'tien',  name: 'Tiến',  role: 'support' },
    { email: 'thuy',  name: 'Thùy',  role: 'support' },
    { email: 'thang', name: 'Thắng', role: 'support' },
];

function run() {
    db.open();
    const created = [];
    for (const s of SEED) {
        if (db.users.getByEmail(WS, s.email)) {
            console.log(`SKIP  ${s.email} (đã tồn tại)`);
            continue;
        }
        const temp = password.genTemp(10);
        db.users.create(WS, { email: s.email, name: s.name, role: s.role, passwordHash: password.hash(temp) });
        created.push({ ...s, temp });
    }
    console.log('\n===== TÀI KHOẢN MỚI (mật khẩu tạm — phát cho từng người, đổi sau khi login) =====');
    if (created.length === 0) console.log('(không có tài khoản mới)');
    for (const c of created) {
        console.log(`  ${c.role.padEnd(8)} | đăng nhập: ${c.email.padEnd(8)} | mật khẩu: ${c.temp}  | ${c.name}`);
    }
    console.log('================================================================================\n');
    db.close();
}

if (require.main === module) run();
module.exports = { run, SEED };
