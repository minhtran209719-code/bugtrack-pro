// Seam #D: Migration runner.
// Mỗi file SQL trong thư mục này = 1 migration, đặt tên 'NNN_description.sql'.
// Bảng schema_migrations giữ trạng thái đã apply.
// Chạy: `npm run migrate` (idempotent — đã apply thì bỏ qua).

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../config');
const logger = require('../logger');

function ensureDir() {
    const dir = path.dirname(config.db.path);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function open() {
    ensureDir();
    const db = new Database(config.db.path);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    return db;
}

function ensureMigrationsTable(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            name        TEXT PRIMARY KEY,
            applied_at  TEXT NOT NULL
        );
    `);
}

function listMigrationFiles() {
    const dir = __dirname;
    return fs.readdirSync(dir)
        .filter(f => f.endsWith('.sql'))
        .sort();
}

function applied(db) {
    return new Set(db.prepare('SELECT name FROM schema_migrations').all().map(r => r.name));
}

function run() {
    const db = open();
    ensureMigrationsTable(db);

    const done = applied(db);
    const files = listMigrationFiles();
    const pending = files.filter(f => !done.has(f));

    if (pending.length === 0) {
        logger.info('No pending migrations');
        return;
    }

    for (const file of pending) {
        const sql = fs.readFileSync(path.join(__dirname, file), 'utf8');
        const tx = db.transaction(() => {
            db.exec(sql);
            db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)')
              .run(file, new Date().toISOString());
        });
        try {
            tx();
            logger.info({ file }, 'migration applied');
        } catch (err) {
            logger.error({ file, err: err.message }, 'migration failed');
            process.exit(1);
        }
    }

    db.close();
    logger.info({ count: pending.length }, 'migrations done');
}

if (require.main === module) run();

module.exports = { run };
