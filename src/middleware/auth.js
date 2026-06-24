// Seam #A: Auth middleware.
// Giai đoạn 1: AUTH_ENABLED=false → trả workspace mặc định, role admin (ẩn danh).
// Giai đoạn 2: AUTH_ENABLED=true → parse JWT từ Authorization: Bearer, trả ctx thật.
//
// ctx = { workspace, userId, name, role, authenticated }
//   - userId: id user (USR-...) cho audit_log.
//   - name:  tên hiển thị (ghi vào created_by/assigned_by/deleted_by — nhất quán assignee là tên).
//   - role:  'admin' | 'dev' | 'support' (RBAC ở handler).

const config = require('../config');
const jwt = require('../auth/jwt');

function extractToken(req) {
    const h = req.headers['authorization'] || req.headers['Authorization'];
    if (h && /^Bearer\s+/i.test(h)) return h.replace(/^Bearer\s+/i, '').trim();
    return null;
}

async function resolveContext(req) {
    if (!config.auth.enabled) {
        return {
            workspace: config.defaults.workspace,
            userId: 'system',
            name: 'system',
            role: 'admin',
            authenticated: false,
        };
    }

    const token = extractToken(req);
    if (!token) return null;
    const payload = jwt.verify(token);
    if (!payload || !payload.sub) return null;

    return {
        workspace: payload.ws || config.defaults.workspace,
        userId: payload.sub,
        name: payload.name || payload.sub,
        role: payload.role || 'support',
        authenticated: true,
    };
}

// Helper cho route public (login, health) bỏ qua auth.
async function resolvePublic() {
    return { workspace: null, userId: null, name: null, role: 'anonymous', authenticated: false };
}

module.exports = { resolveContext, resolvePublic, extractToken };
