// Seam #7: Config qua env. Mọi hằng số đọc từ đây, KHÔNG hardcode trong code.
// Đổi môi trường = đổi .env, không build lại.

require('dotenv').config();

const path = require('path');

function bool(v, def = false) {
    if (v === undefined) return def;
    return /^(1|true|yes|on)$/i.test(String(v));
}

function int(v, def) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : def;
}

const ROOT = path.resolve(__dirname, '..', '..');

module.exports = {
    env: process.env.NODE_ENV || 'development',
    port: int(process.env.PORT, 3000),
    // Bind localhost mặc định: nginx proxy tới 127.0.0.1, KHÔNG phơi cổng trần ra Internet.
    // Chỉ đặt HOST=0.0.0.0 khi cố ý cho truy cập trực tiếp (LAN tin cậy).
    host: process.env.HOST || '127.0.0.1',
    logLevel: process.env.LOG_LEVEL || 'info',

    // Seam bảo mật: chỉ origin trong allowlist mới được CORS (ghi cross-origin).
    // Rỗng = chỉ same-origin (app tự phục vụ) hoạt động — an toàn nhất.
    cors: {
        allowedOrigins: (process.env.CORS_ALLOWED_ORIGINS || '')
            .split(',').map(s => s.trim()).filter(Boolean),
    },

    db: {
        driver: process.env.DB_DRIVER || 'sqlite',
        path: path.resolve(ROOT, process.env.DB_PATH || './data.db'),
        url: process.env.DATABASE_URL || null, // Dùng khi driver = pg
    },

    legacyJsonPath: path.resolve(ROOT, process.env.LEGACY_JSON || './data.json'),

    storage: {
        driver: process.env.STORAGE_DRIVER || 'local',
        uploadDir: path.resolve(ROOT, process.env.UPLOAD_DIR || './uploads'),
        s3: {
            bucket: process.env.S3_BUCKET,
            region: process.env.S3_REGION,
            accessKey: process.env.S3_ACCESS_KEY,
            secretKey: process.env.S3_SECRET_KEY,
            endpoint: process.env.S3_ENDPOINT,
        },
    },

    auth: {
        enabled: bool(process.env.AUTH_ENABLED, false),
        jwtSecret: process.env.JWT_SECRET || 'dev-only-secret',
        jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
    },

    audit: {
        enabled: bool(process.env.AUDIT_ENABLED, false),
    },

    defaults: {
        workspace: process.env.DEFAULT_WORKSPACE || 'default',
    },
};
