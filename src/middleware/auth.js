// Seam #A: Auth middleware (stub giai đoạn 1).
// MỌI handler PHẢI gọi `const ctx = await resolveContext(req)` ở đầu, rồi truyền
// `ctx.workspace` xuống DAL. Không gọi DAL không qua ctx — sẽ vỡ multi-tenant sau.
//
// Giai đoạn 1: trả về workspace mặc định, role admin.
// Giai đoạn 2: parse JWT từ Authorization header / cookie, lookup user, trả ctx thật.

const config = require('../config');

async function resolveContext(req) {
    if (!config.auth.enabled) {
        return {
            workspace: config.defaults.workspace,
            userId: 'system',
            role: 'admin',
            authenticated: false,
        };
    }

    // TODO giai đoạn 2:
    //   const token = extractToken(req);
    //   const payload = jwt.verify(token, config.auth.jwtSecret);
    //   return { workspace: payload.workspace, userId: payload.sub, role: payload.role, authenticated: true };
    throw new Error('TODO giai đoạn 2: implement JWT auth');
}

// Helper cho route public (login, health) bỏ qua auth.
async function resolvePublic() {
    return { workspace: null, userId: null, role: 'anonymous', authenticated: false };
}

module.exports = { resolveContext, resolvePublic };
