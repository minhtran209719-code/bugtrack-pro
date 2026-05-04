// Tách `open`/`close` ra file riêng để tránh circular dependency với DAL modules
// (bugs.js/improvements.js/.../index.js đều require open).

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('../logger');

let _db = null;

function open() {
    if (_db) return _db;

    if (config.db.driver !== 'sqlite') {
        throw new Error(`Unsupported DB driver: ${config.db.driver}`);
    }

    const dir = path.dirname(config.db.path);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    _db = new Database(config.db.path);
    _db.pragma('journal_mode = WAL');
    _db.pragma('synchronous = NORMAL');
    _db.pragma('foreign_keys = ON');

    logger.info({ path: config.db.path }, 'sqlite opened');
    return _db;
}

function close() {
    if (_db) { _db.close(); _db = null; }
}

module.exports = { open, close };
