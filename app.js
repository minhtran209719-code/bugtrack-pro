// ===== BugTrack Pro - Main Application (v2) =====
// Đã refactor sang gọi REST /api/v1/* (xem CLAUDE.md - 8 architecture seams).
// Cache đồng bộ: load full khi mở + delta poll mỗi 10s.

const isServer = location.protocol !== 'file:';
const API = location.origin + '/api/v1';
const PUBLIC_BASE = location.origin;

// In-memory cache (replicate từ server). Render functions đọc từ Cache (đồng bộ)
// nên không cần đổi chữ ký. Mọi mutation cập nhật optimistic ngay vào Cache.
const Cache = {
    bugs: [],
    improvements: [],
    products: [],
    devList: [],
    reporterList: [],
    bugTypes: [],
    activeProduct: '',
    lastSync: null,
};

// Multi-select state cho bulk delete
const Selection = {
    bugs: new Set(),
    imps: new Set(),
};

// ===== Auth (seam #A) =====
const Auth = {
    token: localStorage.getItem('bt_token') || null,
    user: null, // { id, name, role }
    load() {
        try { this.user = JSON.parse(localStorage.getItem('bt_user') || 'null'); } catch { this.user = null; }
    },
    set(token, user) {
        this.token = token; this.user = user;
        localStorage.setItem('bt_token', token);
        localStorage.setItem('bt_user', JSON.stringify(user));
    },
    clear() {
        this.token = null; this.user = null;
        localStorage.removeItem('bt_token'); localStorage.removeItem('bt_user');
    },
    is(...roles) { return !!this.user && roles.includes(this.user.role); },
    canDelete() { return this.is('dev', 'admin'); },         // xoá/khôi phục bug
    canDeleteProduct() { return this.is('admin'); },         // xoá sản phẩm
};

async function apiCall(method, path, body, opts = {}) {
    const headers = {};
    let payload;
    if (body instanceof Blob || body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
        payload = body;
        if (opts.filename) headers['X-Filename'] = encodeURIComponent(opts.filename);
    } else if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        payload = JSON.stringify(body);
    }
    if (Auth.token) headers['Authorization'] = 'Bearer ' + Auth.token;
    const res = await fetch(API + path, { method, headers, body: payload });
    if (!res.ok) {
        // Token hết hạn / không hợp lệ → về màn đăng nhập (trừ chính request login)
        if (res.status === 401 && path !== '/auth/login') {
            Auth.clear();
            if (typeof showLogin === 'function') showLogin();
        }
        let err;
        try { err = (await res.json()).error; } catch { err = `HTTP ${res.status}`; }
        throw new Error(err);
    }
    return res.json();
}

// DataSync: load full + delta poll. Modal mở thì skip để không ghi đè input.
const DataSync = {
    async loadAll() {
        const [meta, bugs, imps] = await Promise.all([
            apiCall('GET', '/meta'),
            apiCall('GET', '/bugs?size=10000'),
            apiCall('GET', '/improvements?size=10000'),
        ]);
        Cache.products = meta.products || [];
        Cache.devList = meta.devList || [];
        Cache.reporterList = meta.reporterList || [];
        Cache.bugTypes = meta.bugTypes || [];
        Cache.activeProduct = meta.activeProduct || Cache.products[0] || '';
        Cache.bugs = bugs.items || [];
        Cache.improvements = imps.items || [];
        Cache.lastSync = new Date().toISOString();
    },

    async pollDelta() {
        if (!Cache.lastSync) return false;
        const since = encodeURIComponent(Cache.lastSync);
        const [bugDelta, impDelta] = await Promise.all([
            apiCall('GET', `/bugs/changed?since=${since}`),
            apiCall('GET', `/improvements/changed?since=${since}`),
        ]);
        let changed = false;
        for (const b of (bugDelta.items || [])) {
            const i = Cache.bugs.findIndex(x => x.id === b.id);
            if (b.deletedAt) {
                // Bị xoá mềm ở máy khác → gỡ khỏi cache
                if (i >= 0) { Cache.bugs.splice(i, 1); changed = true; }
            } else if (i >= 0) { Cache.bugs[i] = b; changed = true; }
            else { Cache.bugs.unshift(b); changed = true; }
        }
        for (const im of (impDelta.items || [])) {
            const i = Cache.improvements.findIndex(x => x.id === im.id);
            if (im.deletedAt) {
                if (i >= 0) { Cache.improvements.splice(i, 1); changed = true; }
            } else if (i >= 0) { Cache.improvements[i] = im; changed = true; }
            else { Cache.improvements.unshift(im); changed = true; }
        }
        Cache.lastSync = bugDelta.now || new Date().toISOString();
        return changed;
    },

    startAutoRefresh(interval = 10000) {
        const poll = async () => {
            const modalOpen = [...document.querySelectorAll('.modal')].some(m => !m.hidden);
            if (modalOpen) return;
            try {
                const changed = await this.pollDelta();
                if (changed) {
                    renderProductSelect();
                    renderDashboard();
                    renderBugTable();
                    renderImprovements();
                    renderAlerts();
                    refreshDeviceSummaryIfActive();
                    renderDevDatalist();
                    toast('🔄 Dữ liệu đã được cập nhật tự động', 'info');
                }
                const el = document.getElementById('sync-time');
                if (el) el.textContent = new Date().toLocaleTimeString('vi-VN');
            } catch (e) {
                console.warn('[AutoRefresh]', e);
            }
        };
        setInterval(poll, interval);
    },
};

// FileStore IndexedDB legacy đã loại bỏ — server SQLite + uploads/ là nguồn duy nhất.

// Pending uploads: file đã upload tạm trong session modal, chưa commit vào bug nào.
// Cancel modal → DELETE để tránh file mồ côi.
let pendingUploads = [];
function commitPendingUploads() { pendingUploads = []; }
async function cleanupPendingUploads() {
    if (pendingUploads.length === 0) return;
    const urls = pendingUploads.slice();
    pendingUploads = [];
    try { await apiCall('DELETE', '/uploads', { urls }); }
    catch (e) { console.warn('Pending cleanup failed:', e.message); }
}

// ===== PRODUCT MANAGEMENT (API-backed, optimistic) =====
const ProductDB = {
    get() { return Cache.products.length ? Cache.products : ['GemCloudPhone']; },
    getActive() { return Cache.activeProduct || this.get()[0]; },
    setActive(name) {
        if (Cache.activeProduct === name) return;
        Cache.activeProduct = name;
        apiCall('PATCH', '/meta', { activeProduct: name }).catch(e => console.warn('setActive sync:', e.message));
    },
    add(name) {
        if (!name || Cache.products.includes(name)) return;
        Cache.products = [...Cache.products, name];
        apiCall('PATCH', '/meta', { products: Cache.products }).catch(e => console.warn('add product sync:', e.message));
    },
    async remove(name) {
        Cache.products = Cache.products.filter(p => p !== name);
        // Xoá bug của sản phẩm này (lần lượt để server tự dọn attachments).
        const productBugs = Cache.bugs.filter(b => b.product === name);
        for (const b of productBugs) {
            try { await apiCall('DELETE', `/bugs/${b.id}`); } catch {}
        }
        Cache.bugs = Cache.bugs.filter(b => b.product !== name);
        await apiCall('PATCH', '/meta', { products: Cache.products }).catch(e => console.warn('remove product sync:', e.message));
    },
};

function renderProductSelect() {
    const products = ProductDB.get();
    const active = ProductDB.getActive();

    // Dashboard selector
    const sel = document.getElementById('product-select');
    sel.innerHTML = products.map(p => `<option value="${esc(p)}" ${p===active?'selected':''}>${esc(p)}</option>`).join('');

    // Bug page selector
    const bugSel = document.getElementById('bug-product-select');
    if (bugSel) {
        bugSel.innerHTML = products.map(p => `<option value="${esc(p)}" ${p===active?'selected':''}>${esc(p)}</option>`).join('');
    }
}

document.getElementById('product-select').addEventListener('change', function() {
    ProductDB.setActive(this.value);
    renderProductSelect();
    renderDashboard();
    renderBugTable();
    refreshDeviceSummaryIfActive();
});

document.getElementById('bug-product-select').addEventListener('change', function() {
    ProductDB.setActive(this.value);
    renderProductSelect();
    renderBugTable();
});

document.getElementById('btn-add-product').addEventListener('click', () => {
    const name = prompt('Nhập tên sản phẩm mới:');
    if (name && name.trim()) {
        ProductDB.add(name.trim());
        ProductDB.setActive(name.trim());
        renderProductSelect();
        renderDashboard();
        renderBugTable();
        refreshDeviceSummaryIfActive();
        toast(`Đã thêm "${name.trim()}"!`, 'success');
    }
});

document.getElementById('btn-del-product').addEventListener('click', () => {
    const products = ProductDB.get();
    const active = ProductDB.getActive();
    if (products.length <= 1) { toast('Phải giữ ít nhất 1 sản phẩm!', 'error'); return; }
    if (!confirm(`Xóa sản phẩm "${active}" và toàn bộ lỗi của nó?`)) return;
    ProductDB.remove(active);
    ProductDB.setActive(ProductDB.get()[0]);
    renderProductSelect();
    renderDashboard();
    renderBugTable();
    refreshDeviceSummaryIfActive();
    toast('Đã xóa!', 'success');
});

// ===== DATA LAYER (API-backed, optimistic Cache update) =====
// API trả về displayId 'BUG-0042' (mỗi workspace) — render dùng displayId làm UI label,
// còn `id` là ULID nội bộ, dùng để tham chiếu bug giữa các API call.
const BugDB = {
    getAll() { return Cache.bugs; },
    get() { const p = ProductDB.getActive(); return Cache.bugs.filter(b => b.product === p); },
    find(id) { return Cache.bugs.find(b => b.id === id); },

    add(input) {
        const tempId = 'tmp-' + Date.now();
        const optimistic = {
            id: tempId,
            displayId: '...',
            product: ProductDB.getActive(),
            ...input,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            history: [{ time: new Date().toISOString(), action: 'Tạo mới', detail: `Tạo lỗi "${input.name}"` }],
        };
        Cache.bugs.unshift(optimistic);

        apiCall('POST', '/bugs', { ...input, product: ProductDB.getActive() })
            .then(bug => {
                const i = Cache.bugs.findIndex(b => b.id === tempId);
                if (i >= 0) Cache.bugs[i] = bug;
                renderBugTable(); renderDashboard(); refreshDeviceSummaryIfActive();
            })
            .catch(e => {
                Cache.bugs = Cache.bugs.filter(b => b.id !== tempId);
                toast('Tạo lỗi thất bại: ' + e.message, 'error');
                renderBugTable();
            });
        return optimistic;
    },

    update(id, patch) {
        const i = Cache.bugs.findIndex(b => b.id === id);
        if (i < 0) return;
        const old = Cache.bugs[i];
        const merged = { ...old, ...patch, updatedAt: new Date().toISOString() };
        if (patch.status === 'Đã xử lí' && old.status !== 'Đã xử lí' && !merged.completedDate) {
            merged.completedDate = merged.updatedAt;
        }
        Cache.bugs[i] = merged;

        apiCall('PATCH', `/bugs/${id}`, patch)
            .then(bug => {
                const j = Cache.bugs.findIndex(b => b.id === id);
                if (j >= 0) Cache.bugs[j] = bug;
            })
            .catch(e => toast('Đồng bộ thất bại: ' + e.message, 'error'));
    },

    delete(id) {
        Cache.bugs = Cache.bugs.filter(b => b.id !== id);
        // Server tự xoá kèm attachments
        apiCall('DELETE', `/bugs/${id}`).catch(e => toast('Xoá thất bại: ' + e.message, 'error'));
    },
};

const ImpDB = {
    get() { return Cache.improvements; },
    find(id) { return Cache.improvements.find(x => x.id === id); },

    add(input) {
        const tempId = 'tmp-' + Date.now();
        const optimistic = { id: tempId, displayId: '...', ...input, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        Cache.improvements.unshift(optimistic);

        apiCall('POST', '/improvements', input)
            .then(imp => {
                const i = Cache.improvements.findIndex(x => x.id === tempId);
                if (i >= 0) Cache.improvements[i] = imp;
                renderImprovements();
            })
            .catch(e => {
                Cache.improvements = Cache.improvements.filter(x => x.id !== tempId);
                toast('Tạo cải tiến thất bại: ' + e.message, 'error');
                renderImprovements();
            });
        return optimistic;
    },

    update(id, patch) {
        const i = Cache.improvements.findIndex(x => x.id === id);
        if (i < 0) return;
        Cache.improvements[i] = { ...Cache.improvements[i], ...patch, updatedAt: new Date().toISOString() };
        apiCall('PATCH', `/improvements/${id}`, patch)
            .then(imp => {
                const j = Cache.improvements.findIndex(x => x.id === id);
                if (j >= 0) Cache.improvements[j] = imp;
            })
            .catch(e => toast('Đồng bộ thất bại: ' + e.message, 'error'));
    },

    delete(id) {
        Cache.improvements = Cache.improvements.filter(x => x.id !== id);
        apiCall('DELETE', `/improvements/${id}`).catch(e => toast('Xoá thất bại: ' + e.message, 'error'));
    },
};

// ===== UTILS =====
function toast(msg, type = '') {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = 'toast ' + type;
    el.hidden = false;
    setTimeout(() => el.hidden = true, 2500);
}

function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }

function fmtDate(iso) {
    if (!iso) return '-';
    const d = new Date(iso);
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yy = String(d.getFullYear()).slice(-2);
    return `${dd}/${mm}/${yy}`;
}

function fmtDateTime(iso) {
    if (!iso) return '-';
    const d = new Date(iso);
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yy = String(d.getFullYear()).slice(-2);
    return `${dd}/${mm}/${yy}`;
}

function hoursOverdue(bug) {
    if (bug.status === 'Đã xử lí') return 0;
    const now = Date.now();
    const created = new Date(bug.createdAt).getTime();
    const elapsed = (now - created) / 3600000;
    const limits = { 'Nghiêm trọng': 24, 'Cao': 48, 'Trung bình': 72, 'Thấp': 168 };
    const limit = limits[bug.severity] || 168;
    return Math.max(0, elapsed - limit);
}

function isOverdue(bug) { return hoursOverdue(bug) > 0; }

function isNearDeadline(bug) {
    if (!bug.deadline || bug.status === 'Đã xử lí') return false;
    const dl = new Date(bug.deadline).getTime();
    const now = Date.now();
    const diff = (dl - now) / 3600000;
    return diff > 0 && diff < 24;
}

function isDeadlinePassed(bug) {
    if (!bug.deadline || bug.status === 'Đã xử lí') return false;
    return new Date(bug.deadline) < new Date();
}

function severityBadge(sev) {
    if (sev === 'Nghiêm trọng') return `<span style="color:var(--danger);font-weight:700">${sev}</span>`;
    return `<span>${sev}</span>`;
}

function statusBadge(st) {
    const colors = { 'Đang xử lí': '#92400e', 'Chưa có P.A': '#991b1b', 'Đã xử lí': '#065f46' };
    const bgs = { 'Đang xử lí': '#fef3c7', 'Chưa có P.A': '#fee2e2', 'Đã xử lí': '#d1fae5' };
    return `<span style="padding:4px 10px;border-radius:14px;font-size:13px;font-weight:700;background:${bgs[st]||'#f1f5f9'};color:${colors[st]||'var(--text)'}">${st}</span>`;
}

function typeBadge(t) {
    return `<span>${t}</span>`;
}

function statusColor(st) {
    const map = { 'Đang xử lí': 'dangxuly', 'Chưa có P.A': 'chuacopa', 'Đã xử lí': 'hoanthanh' };
    return map[st] || 'dangxuly';
}

function rowClass(bug) {
    return '';
}

// ===== NAVIGATION =====
document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => navigateTo(item.dataset.page));
});

function navigateTo(page) {
    document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.page === page));
    document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + page));
    document.getElementById('sidebar').classList.remove('open');

    if (page === 'dashboard') renderDashboard();
    if (page === 'bugs') { renderProductSelect(); renderBugTable(); }
    if (page === 'improvements') renderImprovements();
    if (page === 'alerts') renderAlerts();
}

document.getElementById('mobile-toggle').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('open');
});

// ===== SIDEBAR COLLAPSE =====
const SIDEBAR_KEY = 'bt_sidebar_collapsed';
function applySidebarState() {
    const collapsed = localStorage.getItem(SIDEBAR_KEY) === '1';
    document.getElementById('app').classList.toggle('sidebar-collapsed', collapsed);
    const btn = document.getElementById('sidebar-collapse');
    if (btn) btn.textContent = collapsed ? '»' : '«';
}
applySidebarState();
document.getElementById('sidebar-collapse').addEventListener('click', () => {
    const cur = localStorage.getItem(SIDEBAR_KEY) === '1';
    localStorage.setItem(SIDEBAR_KEY, cur ? '0' : '1');
    applySidebarState();
});

// ===== DASHBOARD =====
// Time filter state
let dashTimeFilter = 'all';

function getFilteredBugs() {
    let bugs = BugDB.get();
    const now = new Date();
    const from = document.getElementById('tf-from').value;
    const to = document.getElementById('tf-to').value;

    if (dashTimeFilter === 'today') {
        const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        bugs = bugs.filter(b => new Date(b.createdAt) >= start);
    } else if (dashTimeFilter === 'week') {
        const day = now.getDay() || 7;
        const start = new Date(now);
        start.setDate(now.getDate() - day + 1);
        start.setHours(0, 0, 0, 0);
        bugs = bugs.filter(b => new Date(b.createdAt) >= start);
    } else if (dashTimeFilter === 'month') {
        const start = new Date(now.getFullYear(), now.getMonth(), 1);
        bugs = bugs.filter(b => new Date(b.createdAt) >= start);
    } else if (dashTimeFilter === 'custom' && (from || to)) {
        if (from) bugs = bugs.filter(b => new Date(b.createdAt) >= new Date(from));
        if (to) {
            const end = new Date(to);
            end.setHours(23, 59, 59);
            bugs = bugs.filter(b => new Date(b.createdAt) <= end);
        }
    }
    return bugs;
}

// Time filter buttons
document.querySelectorAll('.tf-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.tf-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        dashTimeFilter = btn.dataset.tf;
        renderDashboard();
    });
});

// Custom date range
document.getElementById('tf-from').addEventListener('change', () => {
    dashTimeFilter = 'custom';
    document.querySelectorAll('.tf-btn').forEach(b => b.classList.remove('active'));
    renderDashboard();
});
document.getElementById('tf-to').addEventListener('change', () => {
    dashTimeFilter = 'custom';
    document.querySelectorAll('.tf-btn').forEach(b => b.classList.remove('active'));
    renderDashboard();
});

function renderDashboard() {
    const bugs = getFilteredBugs();
    const now = Date.now();
    const total = bugs.length;
    const openBugs = bugs.filter(b => b.status !== 'Đã xử lí');
    const done = total - openBugs.length;
    const priority = openBugs.filter(b =>
        b.severity === 'Nghiêm trọng' || (now - new Date(b.createdAt).getTime()) / 86400000 > 7
    ).length;

    document.getElementById('s-total').textContent = total;
    document.getElementById('s-open').textContent = openBugs.length;
    document.getElementById('s-done').textContent = done;
    document.getElementById('s-priority').textContent = priority;

    renderDevTable(bugs);
    renderSupportTable(bugs);
    updateAlertBadge();
}

function renderSupportTable(bugs) {
    const stats = {};
    bugs.forEach(b => {
        const name = b.reporter || 'Chưa rõ';
        if (!stats[name]) stats[name] = { total: 0, done: 0, untested: 0, waiting: 0, tested: 0 };
        stats[name].total++;
        if (b.status === 'Đã xử lí') stats[name].done++;
        const ts = b.testStatus || 'Chưa test';
        if (ts === 'Đã test') stats[name].tested++;
        else if (ts === 'Chờ test') stats[name].waiting++;
        else stats[name].untested++;
    });
    const rows = Object.entries(stats).sort((a, b) => b[1].total - a[1].total);
    const tbody = document.getElementById('support-table-body');
    if (!tbody) return;
    if (rows.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-light);padding:20px">Chưa có dữ liệu</td></tr>';
        return;
    }
    tbody.innerHTML = rows.map(([name, s]) => {
        const testRate = s.total > 0 ? Math.round(s.tested / s.total * 100) : 0;
        const rateColor = testRate >= 70 ? 'var(--success)' : testRate >= 40 ? '#d97706' : 'var(--danger)';
        return `<tr>
            <td><strong>${esc(name)}</strong></td>
            <td>${s.total}</td>
            <td style="color:var(--text-light)">${s.untested}</td>
            <td style="color:#d97706">${s.waiting}</td>
            <td style="color:var(--success)">${s.tested}</td>
            <td>
                <div class="dev-rate-cell">
                    <div class="dev-rate-bar"><div class="dev-rate-fill" style="width:${testRate}%;background:${rateColor}"></div></div>
                    <span style="color:${rateColor};font-weight:600">${testRate}%</span>
                </div>
            </td>
        </tr>`;
    }).join('');
}

function renderDevTable(bugs) {
    const stats = {};
    const now = Date.now();
    bugs.forEach(b => {
        const name = b.assignee || 'Chưa nhận';
        if (!stats[name]) stats[name] = { total: 0, open: 0, done: 0, overdue: 0 };
        stats[name].total++;
        if (b.status === 'Đã xử lí') {
            stats[name].done++;
        } else {
            stats[name].open++;
            if ((now - new Date(b.createdAt).getTime()) / 86400000 > 7) stats[name].overdue++;
        }
    });
    const rows = Object.entries(stats).sort((a, b) => b[1].total - a[1].total);
    const tbody = document.getElementById('dev-table-body');
    if (rows.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-light);padding:20px">Chưa có dữ liệu</td></tr>';
        return;
    }
    tbody.innerHTML = rows.map(([name, s]) => {
        const rate = s.total > 0 ? Math.round(s.done / s.total * 100) : 0;
        const rateColor = rate >= 70 ? 'var(--success)' : rate >= 40 ? '#d97706' : 'var(--danger)';
        return `<tr>
            <td><strong>${esc(name)}</strong></td>
            <td>${s.total}</td>
            <td>${s.open}</td>
            <td style="color:var(--success)">${s.done}</td>
            <td style="color:${s.overdue > 0 ? 'var(--danger)' : 'var(--text-light)'}">${s.overdue}</td>
            <td>
                <div class="dev-rate-cell">
                    <div class="dev-rate-bar"><div class="dev-rate-fill" style="width:${rate}%;background:${rateColor}"></div></div>
                    <span style="color:${rateColor};font-weight:600">${rate}%</span>
                </div>
            </td>
        </tr>`;
    }).join('');
}

// ===== DUPLICATE DETECTION =====
function textSimilarity(a, b) {
    if (!a || !b) return 0;
    a = a.toLowerCase().trim();
    b = b.toLowerCase().trim();
    if (a === b) return 1;

    // So sánh từ chung
    const wordsA = a.split(/\s+/).filter(w => w.length > 1);
    const wordsB = b.split(/\s+/).filter(w => w.length > 1);
    if (wordsA.length === 0 || wordsB.length === 0) return 0;

    let matches = 0;
    wordsA.forEach(w => { if (wordsB.some(wb => wb.includes(w) || w.includes(wb))) matches++; });
    return matches / Math.max(wordsA.length, wordsB.length);
}

function findDuplicateBugs(name, description) {
    const bugs = BugDB.get();
    const results = [];

    bugs.forEach(b => {
        const nameSim = textSimilarity(name, b.name);
        const descSim = description ? textSimilarity(description, b.description) : 0;
        const score = nameSim * 0.7 + descSim * 0.3; // Tên quan trọng hơn mô tả

        if (score >= 0.5) { // Trùng ≥50%
            results.push({ ...b, similarity: Math.round(score * 100) });
        }
    });

    return results.sort((a, b) => b.similarity - a.similarity).slice(0, 5);
}

// Click severity card → chuyển sang trang Quản lý lỗi với filter mức độ
function showDashDetail(filter) {
    if (filter.startsWith('sev_')) {
        const sevName = filter.replace('sev_', '');
        navigateTo('bugs');
        document.getElementById('filter-severity').value = sevName;
        renderBugTable();
    }
}

// ===== BUG TABLE =====
// Pagination state cho bug table (client-side, hỗ trợ scale 10k+).
let bugTablePage = 1;
const BUG_TABLE_PAGE_SIZE = 200;

function renderBugTable() {
    populateModuleFilter();
    populateTypeFilter();
    let bugs = BugDB.get();
    const search = document.getElementById('bug-search').value.toLowerCase();
    const fStatus = document.getElementById('filter-status').value;
    const fSev = document.getElementById('filter-severity').value;
    const fType = document.getElementById('filter-type').value;
    const fModule = document.getElementById('filter-module').value;

    if (search) bugs = bugs.filter(b => b.name.toLowerCase().includes(search) || b.id.toLowerCase().includes(search) || (b.displayId || '').toLowerCase().includes(search) || (b.description || '').toLowerCase().includes(search));
    if (fStatus !== 'all') bugs = bugs.filter(b => b.status === fStatus);
    if (fSev !== 'all') bugs = bugs.filter(b => b.severity === fSev);
    if (fType !== 'all') bugs = bugs.filter(b => b.type === fType);
    if (fModule !== 'all') bugs = bugs.filter(b => b.module === fModule);

    bugs.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

    const tbody = document.getElementById('bug-tbody');
    const empty = document.getElementById('bug-empty');
    const paginator = document.getElementById('bug-paginator');

    if (bugs.length === 0) {
        tbody.innerHTML = '';
        empty.hidden = false;
        if (paginator) paginator.innerHTML = '';
        return;
    }
    empty.hidden = true;

    // Pagination slice
    const totalPages = Math.max(1, Math.ceil(bugs.length / BUG_TABLE_PAGE_SIZE));
    if (bugTablePage > totalPages) bugTablePage = totalPages;
    const startIdx = (bugTablePage - 1) * BUG_TABLE_PAGE_SIZE;
    const pageItems = bugs.slice(startIdx, startIdx + BUG_TABLE_PAGE_SIZE);

    tbody.innerHTML = pageItems.map((b, idx) => {
        const sttIdx = startIdx + idx;
        const foundTime = b.foundDate ? fmtDateTime(b.foundDate) : fmtDate(b.createdAt);
        return `<tr class="${rowClass(b)}">
            <td class="check-col"><input type="checkbox" class="row-check-bug" data-id="${b.id}" ${Selection.bugs.has(b.id)?'checked':''}></td>
            <td class="bug-stt" title="${esc(b.displayId || b.id)}">${sttIdx + 1}</td>
            <td class="bug-name-cell" onclick="showDetail('${b.id}')"><div class="bug-name-text"><span class="sev-dot sev-dot-${b.severity === 'Nghiêm trọng' ? 'critical' : 'low'}" title="${esc(b.severity)}"></span>${esc(b.name)}</div><div class="bug-name-tooltip">${esc(b.severity)} · ${esc(b.name)}</div></td>
            <td class="bug-desc-cell"><div class="inline-editable" contenteditable="true" data-id="${b.id}" data-field="description" data-placeholder="Nhập mô tả...">${esc(b.description || '')}</div></td>
            <td>${foundTime}</td>
            <td class="reporter-cell">
                <div class="cdrop" data-id="${b.id}" data-field="reporter">
                    <button class="cdrop-btn" type="button">${b.reporter ? esc(b.reporter) : ''} ▾</button>
                </div>
            </td>
            <td class="testtt-cell">
                <select class="inline-test-status" data-id="${b.id}" data-val="${esc(b.testStatus || 'Chưa test')}">
                    <option value="Chưa test" ${(b.testStatus||'Chưa test')==='Chưa test'?'selected':''}>Chưa test</option>
                    <option value="Chờ test" ${b.testStatus==='Chờ test'?'selected':''}>Chờ test</option>
                    <option value="Đã test" ${b.testStatus==='Đã test'?'selected':''}>Đã test</option>
                </select>
            </td>
            <td class="note-cell"><div class="inline-editable" contenteditable="true" data-id="${b.id}" data-field="supportNote" data-placeholder="Ghi chú...">${esc(b.supportNote || '')}</div></td>
            <td class="assignee-cell col-divider">
                <div class="cdrop" data-id="${b.id}">
                    <button class="cdrop-btn" type="button">${b.assignee ? esc(b.assignee) : ''} ▾</button>
                </div>
            </td>
            <td class="status-cell">${b.assignee
                ? `<select class="inline-status" data-id="${b.id}" data-color="${statusColor(b.status)}">
                    <option value="Đang xử lí" ${b.status==='Đang xử lí'?'selected':''}>Đang xử lí</option>
                    <option value="Đã xử lí" ${b.status==='Đã xử lí'?'selected':''}>Đã xử lí</option>
                    <option value="Chưa có P.A" ${b.status==='Chưa có P.A'?'selected':''}>Chưa có P.A</option>
                </select>`
                : '<span class="status-empty">-</span>'}
            </td>
            <td class="completed-cell">${b.status === 'Đã xử lí' && b.completedDate
                ? fmtDate(b.completedDate)
                : '<span class="completed-empty">-</span>'}
            </td>
            <td class="note-cell"><div class="inline-editable" contenteditable="true" data-id="${b.id}" data-field="devNote" data-placeholder="Ghi chú...">${esc(b.devNote || '')}</div></td>
            <td class="action-cell">
                <div class="action-wrap">
                    <button class="action-toggle" type="button" title="Tùy chọn">⚙️</button>
                    <div class="action-menu">
                        <div class="action-item" onclick="editBug('${b.id}')">✏️ Sửa</div>
                        <div class="action-item action-danger" onclick="deleteBug('${b.id}')">🗑️ Xóa</div>
                    </div>
                </div>
            </td>
        </tr>`;
    }).join('');

    // Render pagination bar
    if (paginator) {
        if (totalPages <= 1) {
            paginator.innerHTML = `<span class="pg-info">Tổng ${bugs.length} lỗi</span>`;
        } else {
            const showFrom = startIdx + 1;
            const showTo = Math.min(startIdx + BUG_TABLE_PAGE_SIZE, bugs.length);
            const pages = [];
            const cur = bugTablePage;
            // Build compact pager: first, current ±2, last
            const pageBtn = (n, label, disabled = false, active = false) =>
                `<button class="pg-btn${active ? ' active' : ''}${disabled ? ' disabled' : ''}" ${disabled ? 'disabled' : ''} data-page="${n}">${label}</button>`;
            pages.push(pageBtn(Math.max(1, cur - 1), '‹ Trước', cur === 1));
            const seen = new Set();
            const candidates = [1, 2, cur - 1, cur, cur + 1, totalPages - 1, totalPages];
            const nums = [...new Set(candidates.filter(n => n >= 1 && n <= totalPages))].sort((a, b) => a - b);
            let prev = 0;
            for (const n of nums) {
                if (n - prev > 1) pages.push(`<span class="pg-ellipsis">…</span>`);
                pages.push(pageBtn(n, String(n), false, n === cur));
                prev = n;
            }
            pages.push(pageBtn(Math.min(totalPages, cur + 1), 'Sau ›', cur === totalPages));
            paginator.innerHTML = `<span class="pg-info">Hiển thị ${showFrom}-${showTo} / ${bugs.length} lỗi</span>${pages.join('')}`;
            paginator.querySelectorAll('.pg-btn:not(.disabled)').forEach(btn => {
                btn.addEventListener('click', () => {
                    bugTablePage = parseInt(btn.dataset.page, 10);
                    renderBugTable();
                    document.querySelector('.bug-table').scrollIntoView({ behavior: 'smooth', block: 'start' });
                });
            });
        }
    }

    // Bind row checkbox (multi-select bug)
    tbody.querySelectorAll('.row-check-bug').forEach(cb => {
        cb.addEventListener('change', () => {
            if (cb.checked) Selection.bugs.add(cb.dataset.id);
            else Selection.bugs.delete(cb.dataset.id);
            updateBulkBar('bugs');
        });
    });

    // Bind action menu toggle
    tbody.querySelectorAll('.action-toggle').forEach(btn => {
        btn.addEventListener('click', e => {
            e.stopPropagation();
            closeAllDropdowns();
            const menu = btn.nextElementSibling;
            const rect = btn.getBoundingClientRect();
            menu.style.position = 'fixed';
            menu.style.top = (rect.bottom + 2) + 'px';
            menu.style.right = (window.innerWidth - rect.right) + 'px';
            menu.style.left = 'auto';
            menu.classList.add('open');
        });
    });

    // Save inline editable fields (description, devNote)
    tbody.querySelectorAll('.inline-editable').forEach(el => {
        el.addEventListener('blur', () => {
            const id = el.dataset.id;
            const field = el.dataset.field;
            const val = el.innerText.trim();
            const bug = BugDB.find(id);
            if (bug && bug[field] !== val) { BugDB.update(id, { [field]: val }); refreshDeviceSummaryIfActive(); }
        });
        // Prevent Enter from creating new divs
        el.addEventListener('keydown', e => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); el.blur(); }
        });
    });

    // Bind inline status change
    tbody.querySelectorAll('.inline-status').forEach(sel => {
        sel.addEventListener('change', () => {
            const updates = { status: sel.value };
            if (sel.value === 'Đã xử lí') {
                updates.completedDate = new Date().toISOString();
            } else {
                updates.completedDate = '';
            }
            sel.dataset.color = statusColor(sel.value);
            BugDB.update(sel.dataset.id, updates);
            toast(`Đã chuyển sang "${sel.value}"`, 'success');
            renderBugTable();
            refreshDeviceSummaryIfActive();
        });
    });

    // Bind TT Test select
    tbody.querySelectorAll('.inline-test-status').forEach(sel => {
        sel.addEventListener('change', () => {
            BugDB.update(sel.dataset.id, { testStatus: sel.value });
            sel.dataset.val = sel.value;
            toast(`TT Test: ${sel.value}`, 'success');
        });
    });

    // Bind custom dropdowns (dev, reporter, module, type, severity)
    tbody.querySelectorAll('.cdrop').forEach(wrap => {
        const bugId = wrap.dataset.id;
        const field = wrap.dataset.field || 'assignee';
        const btn = wrap.querySelector('.cdrop-btn');

        btn.addEventListener('click', e => {
            e.stopPropagation();
            closeAllDropdowns();

            let menu = document.createElement('div');
            menu.className = 'cdrop-menu';

            // Fixed-list fields (no add/remove)
            if (field === 'severity') {
                const sevOptions = [
                    { val: 'Nghiêm trọng', icon: '🔴' },
                    { val: 'Thấp', icon: '🟢' }
                ];
                menu.innerHTML = sevOptions.map(s =>
                    `<div class="cdrop-item"><span class="cdrop-name" data-val="${s.val}">${s.icon} ${s.val}</span></div>`
                ).join('');
                _bindSimpleSelect(menu, bugId, field, btn);
            } else if (field === 'type') {
                const types = BugTypeDB.get();
                menu.innerHTML = types.map(t =>
                    `<div class="cdrop-item"><span class="cdrop-name" data-val="${esc(t)}">${esc(t)}</span></div>`
                ).join('') + `<div class="cdrop-item cdrop-add">➕ Thêm loại mới...</div>`;
                _bindSimpleSelect(menu, bugId, field, btn);
                menu.querySelector('.cdrop-add').addEventListener('click', () => {
                    const name = prompt('Nhập tên loại lỗi mới:');
                    if (name && name.trim()) {
                        BugTypeDB.add(name.trim());
                        BugDB.update(bugId, { type: name.trim() });
                        toast(`Đã thêm loại "${name.trim()}"!`, 'success');
                        populateTypeFilter();
                    }
                    closeAllDropdowns();
                    renderBugTable();
                    refreshDeviceSummaryIfActive();
                });
            } else if (field === 'module') {
                menu.innerHTML = moduleOptions.map(m =>
                    `<div class="cdrop-item"><span class="cdrop-name" data-val="${esc(m)}">${esc(m)}</span></div>`
                ).join('') + `<div class="cdrop-item cdrop-add">➕ Thêm thiết bị...</div>`;
                _bindSimpleSelect(menu, bugId, field, btn);
                menu.querySelector('.cdrop-add').addEventListener('click', () => {
                    const name = prompt('Nhập tên thiết bị mới:');
                    if (name && name.trim()) {
                        BugDB.update(bugId, { module: name.trim() });
                        toast(`Đã đổi thiết bị!`, 'success');
                    }
                    closeAllDropdowns();
                    renderBugTable();
                    refreshDeviceSummaryIfActive();
                });
            } else {
                // Dev / Reporter lists (with add/remove)
                const isReporter = field === 'reporter';
                const listDB = isReporter ? ReporterDB : DevListDB;
                const fieldKey = isReporter ? 'reporter' : 'assignee';
                const addLabel = isReporter ? 'Thêm người...' : 'Thêm dev...';

                menu.innerHTML = `<div class="cdrop-item cdrop-clear" data-val="">🗑️ Xóa tên</div>` +
                    listDB.getAll().map(d => `<div class="cdrop-item">
                        <span class="cdrop-name" data-val="${esc(d)}">${esc(d)}</span>
                        <span class="cdrop-edit" data-dev="${esc(d)}" title="Sửa tên">✏️</span>
                        <span class="cdrop-x" data-dev="${esc(d)}" title="Xóa khỏi DS">✕</span>
                    </div>`).join('') +
                    `<div class="cdrop-item cdrop-add">➕ ${addLabel}</div>`;

                const rect2 = btn.getBoundingClientRect();
                menu.style.position = 'fixed';
                menu.style.left = rect2.left + 'px';
                document.body.appendChild(menu);
                // Flip lên trên nếu không đủ chỗ phía dưới
                const menuH = menu.offsetHeight;
                const spaceBelow = window.innerHeight - rect2.bottom;
                if (spaceBelow < menuH + 10 && rect2.top > menuH + 10) {
                    menu.style.top = (rect2.top - menuH - 2) + 'px';
                } else {
                    menu.style.top = (rect2.bottom + 2) + 'px';
                }

                menu.querySelectorAll('.cdrop-name').forEach(n => {
                    n.addEventListener('click', () => {
                        BugDB.update(bugId, { [fieldKey]: n.dataset.val });
                        closeAllDropdowns();
                        renderBugTable();
                        refreshDeviceSummaryIfActive();
                    });
                });

                menu.querySelector('.cdrop-clear').addEventListener('click', () => {
                    BugDB.update(bugId, { [fieldKey]: '' });
                    closeAllDropdowns();
                    renderBugTable();
                    refreshDeviceSummaryIfActive();
                });

                menu.querySelectorAll('.cdrop-x').forEach(x => {
                    x.addEventListener('click', e => {
                        e.stopPropagation();
                        const name = x.dataset.dev;
                        listDB.remove(name);
                        BugDB.get().forEach(bug => {
                            if (bug[fieldKey] === name) BugDB.update(bug.id, { [fieldKey]: '' });
                        });
                        toast(`Đã xóa "${name}"!`, 'success');
                        closeAllDropdowns();
                        renderBugTable();
                        refreshDeviceSummaryIfActive();
                    });
                });

                menu.querySelectorAll('.cdrop-edit').forEach(ed => {
                    ed.addEventListener('click', e => {
                        e.stopPropagation();
                        const oldName = ed.dataset.dev;
                        const newName = prompt(`Sửa tên "${oldName}" thành:`, oldName);
                        if (!newName || !newName.trim() || newName.trim() === oldName) {
                            closeAllDropdowns();
                            return;
                        }
                        renameInList(isReporter ? 'reporter' : 'dev', oldName, newName.trim());
                        toast(`Đã đổi "${oldName}" → "${newName.trim()}"`, 'success');
                        closeAllDropdowns();
                        renderBugTable();
                        renderImprovements();
                    });
                });

                menu.querySelector('.cdrop-add').addEventListener('click', () => {
                    const name = prompt(`Nhập tên ${isReporter ? 'người thông tin' : 'Dev'} mới:`);
                    if (name && name.trim()) {
                        listDB.add(name.trim());
                        BugDB.update(bugId, { [fieldKey]: name.trim() });
                        toast(`Đã thêm "${name.trim()}"!`, 'success');
                    }
                    closeAllDropdowns();
                    renderBugTable();
                    refreshDeviceSummaryIfActive();
                });
                return; // handled
            }

            // Position and show menu (for fixed-list fields handled above)
            const rect = btn.getBoundingClientRect();
            menu.style.position = 'fixed';
            menu.style.top = (rect.bottom + 2) + 'px';
            menu.style.left = rect.left + 'px';
            document.body.appendChild(menu);
        });
    });
}

// Helper: bind simple select dropdown (severity, type, module)
function _bindSimpleSelect(menu, bugId, field, btn) {
    menu.querySelectorAll('.cdrop-name').forEach(n => {
        n.addEventListener('click', () => {
            BugDB.update(bugId, { [field]: n.dataset.val });
            closeAllDropdowns();
            renderBugTable();
            refreshDeviceSummaryIfActive();
        });
    });
}

// Khi đổi filter/search → reset về trang 1.
const _resetPageAndRender = () => { bugTablePage = 1; renderBugTable(); };
document.getElementById('bug-search').addEventListener('input', _resetPageAndRender);
document.getElementById('filter-status').addEventListener('change', _resetPageAndRender);
document.getElementById('filter-severity').addEventListener('change', _resetPageAndRender);
document.getElementById('filter-type').addEventListener('change', _resetPageAndRender);
document.getElementById('filter-module').addEventListener('change', _resetPageAndRender);

// Custom device input toggle
document.getElementById('bug-reporter-select').addEventListener('change', function() {
    if (this.value === '__add') {
        const name = prompt('Nhập tên người thông tin mới:');
        if (name && name.trim()) {
            ReporterDB.add(name.trim());
            const opt = document.createElement('option');
            opt.value = name.trim();
            opt.textContent = name.trim();
            opt.selected = true;
            this.insertBefore(opt, this.querySelector('[value="__add"]'));
        } else {
            this.value = '';
        }
    }
});

document.getElementById('bug-module').addEventListener('change', function() {
    const custom = document.getElementById('bug-module-custom');
    if (this.value === '__custom') {
        custom.hidden = false;
        custom.focus();
    } else {
        custom.hidden = true;
        custom.value = '';
    }
});

// Populate device filter dropdown from existing bugs
function populateModuleFilter() {
    const bugs = BugDB.get();
    const modules = [...new Set(bugs.map(b => b.module).filter(Boolean))];
    const sel = document.getElementById('filter-module');
    const current = sel.value;
    sel.innerHTML = '<option value="all">Tất cả thiết bị</option>' +
        modules.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
    sel.value = current || 'all';
}

// ===== BUG CRUD =====
let bugAttachments = [];

document.getElementById('btn-new-bug').addEventListener('click', () => openBugModal());
document.getElementById('btn-bug-cancel').addEventListener('click', closeBugModal);
document.getElementById('bug-modal-close').addEventListener('click', closeBugModal);

function openBugModal(bug = null) {
    // Mỗi session modal: reset tracking pending uploads.
    // Attachments có sẵn (khi edit) đã được tham chiếu vào bug → không vào pendingUploads.
    pendingUploads = [];
    document.getElementById('bug-modal-title').textContent = bug ? 'Chỉnh sửa lỗi' : 'Tạo lỗi mới';
    document.getElementById('bug-edit-id').value = bug ? bug.id : '';
    document.getElementById('bug-name').value = bug ? bug.name : '';
    // Set device select - if bug.module matches an option use it, otherwise show custom
    const moduleSelect = document.getElementById('bug-module');
    const customInput = document.getElementById('bug-module-custom');
    if (bug && bug.module) {
        const optExists = Array.from(moduleSelect.options).some(o => o.value === bug.module);
        if (optExists) {
            moduleSelect.value = bug.module;
            customInput.hidden = true;
            customInput.value = '';
        } else {
            moduleSelect.value = '__custom';
            customInput.hidden = false;
            customInput.value = bug.module;
        }
    } else {
        moduleSelect.value = 'All';
        customInput.hidden = true;
        customInput.value = '';
    }
    document.getElementById('bug-desc').value = bug ? (bug.description || '') : '';
    renderBugTypeDropdown(bug ? bug.type : 'Giao diện');
    document.getElementById('bug-severity').value = bug ? bug.severity : 'Nghiêm trọng';
    document.getElementById('bug-status').value = bug ? bug.status : 'Đang xử lí';
    document.getElementById('bug-assignee').value = bug ? (bug.assignee || '') : '';

    // Populate reporter select
    const repSel = document.getElementById('bug-reporter-select');
    const reporters = ReporterDB.getAll();
    const currentRep = bug ? (bug.reporter || '') : '';
    repSel.innerHTML = `<option value="">-- Chọn --</option>` +
        reporters.map(r => `<option value="${esc(r)}" ${currentRep===r?'selected':''}>${esc(r)}</option>`).join('') +
        `<option value="__add">➕ Thêm người mới...</option>`;
    document.getElementById('bug-deadline').value = bug ? (bug.deadline || '') : '';
    document.getElementById('bug-note').value = bug ? (bug.devNote || '') : '';

    // Thời gian phát hiện lỗi
    const foundDate = document.getElementById('bug-found-date');
    if (bug && bug.foundDate) {
        foundDate.value = bug.foundDate.slice(0, 10);
    } else if (bug && bug.createdAt) {
        foundDate.value = bug.createdAt.slice(0, 10);
    } else {
        foundDate.value = new Date().toISOString().slice(0, 10);
    }

    bugAttachments = bug ? (bug.attachments || []) : [];
    renderAttachments();
    document.getElementById('bug-modal').hidden = false;
}

function closeBugModal() {
    document.getElementById('bug-modal').hidden = true;
    // Cleanup các file đã upload trong session này nhưng user huỷ → tránh file mồ côi.
    cleanupPendingUploads();
}

function renderAttachments() {
    const container = document.getElementById('bug-attachments');
    container.innerHTML = '';
    for (let i = 0; i < bugAttachments.length; i++) {
        const ref = bugAttachments[i];
        if (!ref) continue;
        const isVideo = ref.startsWith('data:video') || /\.(mp4|webm)$/i.test(ref);
        const div = document.createElement('div');
        div.className = 'att-item';
        div.innerHTML = `${isVideo
            ? `<video src="${ref}" class="att-thumb" muted preload="none"></video><span class="att-play">▶</span>`
            : `<img src="${ref}" class="att-thumb" loading="lazy">`}
            <button class="att-remove" data-idx="${i}" title="Xóa">✕</button>`;
        div.querySelector('.att-remove').addEventListener('click', () => removeAttachment(i));
        container.appendChild(div);
    }
}

function removeAttachment(idx) {
    const ref = bugAttachments[idx];
    bugAttachments.splice(idx, 1);
    // Nếu file này nằm trong pendingUploads (chưa save bug) → DELETE ngay để xoá file server.
    // Nếu file đã thuộc bug đang edit → KHÔNG xoá ngay vì bug DB vẫn ref;
    //   khi user nhấn Save, server sẽ diff attachments cũ/mới và xoá file đã lìa.
    const idxPending = pendingUploads.indexOf(ref);
    if (idxPending >= 0) {
        pendingUploads.splice(idxPending, 1);
        if (ref && ref.startsWith('/uploads/')) {
            apiCall('DELETE', '/uploads', { url: ref }).catch(() => {});
        }
    }
    renderAttachments();
}

// Upload
const uploadZone = document.getElementById('bug-upload-zone');
const fileInput = document.getElementById('bug-file');
uploadZone.addEventListener('click', () => fileInput.click());
uploadZone.addEventListener('dragover', e => { e.preventDefault(); uploadZone.style.borderColor = 'var(--primary)'; });
uploadZone.addEventListener('dragleave', () => { uploadZone.style.borderColor = ''; });
uploadZone.addEventListener('drop', e => { e.preventDefault(); uploadZone.style.borderColor = ''; handleFiles(e.dataTransfer.files); });
fileInput.addEventListener('change', () => handleFiles(fileInput.files));

// Ctrl+V paste ảnh/video
document.addEventListener('paste', e => {
    if (document.getElementById('bug-modal').hidden) return;
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    const files = [];
    for (const item of items) {
        if (item.kind === 'file' && (item.type.startsWith('image/') || item.type.startsWith('video/'))) {
            files.push(item.getAsFile());
        }
    }
    if (files.length > 0) {
        e.preventDefault();
        handleFiles(files);
        toast('Đã dán ' + files.length + ' file!', 'success');
    }
});

function compressImage(file, maxW, quality) {
    return new Promise(resolve => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            let w = img.width, h = img.height;
            if (w > maxW) { h = (maxW / w) * h; w = maxW; }
            canvas.width = w;
            canvas.height = h;
            canvas.getContext('2d').drawImage(img, 0, 0, w, h);
            resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.src = URL.createObjectURL(file);
    });
}

// Upload tới server với progress (XHR), trả URL final.
function uploadToServer(blob, filename, onProgress) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', API + '/uploads');
        xhr.setRequestHeader('X-Filename', encodeURIComponent(filename));
        xhr.upload.onprogress = e => {
            if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
        };
        xhr.onload = () => {
            try {
                const json = JSON.parse(xhr.responseText);
                if (xhr.status >= 200 && xhr.status < 300 && json.url) {
                    pendingUploads.push(json.url);
                    resolve(json.url);
                } else {
                    reject(new Error(json.error || `HTTP ${xhr.status}`));
                }
            } catch (e) { reject(e); }
        };
        xhr.onerror = () => reject(new Error('Network error'));
        xhr.send(blob);
    });
}

// Khớp với MAX_UPLOAD trong src/server.js (100MB do giới hạn Cloudflare free tier).
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

async function handleFiles(files) {
    // Validate trước
    const ok = [];
    for (const f of Array.from(files)) {
        if (!f.type.startsWith('image/') && !f.type.startsWith('video/')) {
            toast(`"${f.name}" không phải ảnh/video, bỏ qua`, 'error');
            continue;
        }
        if (f.size > MAX_UPLOAD_BYTES) {
            toast(`"${f.name}" vượt giới hạn ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)}MB`, 'error');
            continue;
        }
        ok.push(f);
    }
    if (ok.length === 0) return;

    // Upload song song
    await Promise.all(ok.map(async f => {
        try {
            let blob = f;
            let name = f.name || (f.type.startsWith('video/') ? 'video.mp4' : 'image.jpg');
            if (f.type.startsWith('image/')) {
                // Compress ảnh để tiết kiệm băng thông + storage
                const dataUrl = await compressImage(f, 1920, 0.85);
                blob = await (await fetch(dataUrl)).blob();
                name = f.name ? f.name.replace(/\.\w+$/, '.jpg') : 'image.jpg';
            }
            const url = await uploadToServer(blob, name);
            bugAttachments.push(url);
            renderAttachments();
        } catch (e) {
            toast(`Upload "${f.name}" thất bại: ${e.message}`, 'error');
        }
    }));
}

// Save
document.getElementById('btn-bug-save').addEventListener('click', () => {
    try {
    const name = document.getElementById('bug-name').value.trim();
    if (!name) { toast('Vui lòng nhập tên lỗi!', 'error'); return; }

    const moduleSelect = document.getElementById('bug-module').value;
    const moduleValue = moduleSelect === '__custom'
        ? document.getElementById('bug-module-custom').value.trim() || 'All'
        : moduleSelect;

    const data = {
        name,
        module: moduleValue,
        description: document.getElementById('bug-desc').value.trim(),
        type: document.getElementById('bug-type').value,
        severity: document.getElementById('bug-severity').value,
        status: document.getElementById('bug-status').value,
        reporter: document.getElementById('bug-reporter-select').value === '__add' ? '' : document.getElementById('bug-reporter-select').value,
        foundDate: document.getElementById('bug-found-date').value,
        assignee: document.getElementById('bug-assignee').value.trim(),
        deadline: document.getElementById('bug-deadline').value,
        devNote: document.getElementById('bug-note').value.trim(),
        attachments: bugAttachments
    };

    const editId = document.getElementById('bug-edit-id').value;

    // Phát hiện bug trùng (chỉ khi tạo mới)
    if (!editId) {
        const duplicates = findDuplicateBugs(data.name, data.description);
        if (duplicates.length > 0) {
            const dupList = duplicates.map(d => `• ${d.id}: ${d.name} (${d.status})`).join('\n');
            const proceed = confirm(`⚠️ Phát hiện ${duplicates.length} lỗi tương tự:\n\n${dupList}\n\nBạn vẫn muốn tạo mới?`);
            if (!proceed) return;
        }
    }

    if (editId) {
        BugDB.update(editId, data);
        toast('Đã cập nhật lỗi!', 'success');
    } else {
        BugDB.add(data);
        toast('Đã tạo lỗi mới!', 'success');
    }

    // Bug đã save thành công → các file trong pendingUploads đã được tham chiếu vào bug,
    // không phải mồ côi → commit (xoá khỏi tracking) trước khi closeBugModal cleanup.
    commitPendingUploads();
    closeBugModal();
    renderBugTable();
    renderDashboard();
    refreshDeviceSummaryIfActive();
    } catch(err) {
        if (err.message.includes('quota')) {
            toast('Bộ nhớ đầy! Hãy xóa bớt ảnh/video hoặc bug cũ.', 'error');
        } else {
            toast('Lỗi: ' + err.message, 'error');
        }
        console.error(err);
    }
});

function editBug(id) {
    const bug = BugDB.find(id);
    if (bug) openBugModal(bug);
}

async function deleteBug(id) {
    if (!confirm('Xóa lỗi này?')) return;
    // Server tự xoá kèm attachments khi DELETE bug.
    BugDB.delete(id);
    toast('Đã xóa!', 'success');
    renderBugTable();
    renderDashboard();
    refreshDeviceSummaryIfActive();
}

// ===== BUG DETAIL =====
async function showDetail(id) {
    const b = BugDB.find(id);
    if (!b) return;
    document.getElementById('detail-title').textContent = (b.displayId || b.id) + ' - ' + b.name;

    let attachHtml = '';
    if (b.attachments && b.attachments.length > 0) {
        // Mọi attachment giờ đều là URL '/uploads/...' (server-side storage).
        // Vẫn fallback cho 'data:...' legacy phòng case data cũ chưa migrate.
        const resolved = b.attachments.filter(r => r && (r.startsWith('/uploads/') || r.startsWith('data:')));
        if (resolved.length > 0) {
            attachHtml = `<div class="detail-field"><div class="detail-label">Ảnh/Video đính kèm (click để phóng to, click "Copy link" để chia sẻ)</div><div class="attachments" style="margin-top:6px" id="detail-att-container"></div></div>`;
        }
        window._detailAttachments = resolved;
    }

    const completedHtml = b.status === 'Đã xử lí' && (b.completedDate || b.updatedAt)
        ? `<span class="dt-meta-item">✅ Ngày XL: <strong>${fmtDate(b.completedDate || b.updatedAt)}</strong></span>`
        : '';
    const supportNoteHtml = b.supportNote
        ? `<div class="dt-section dt-note-tt"><div class="dt-section-title">📞 Ghi chú TT</div><div class="dt-section-body">${esc(b.supportNote)}</div></div>`
        : '';
    const devNoteHtml = b.devNote
        ? `<div class="dt-section dt-note-xl"><div class="dt-section-title">🛠️ Ghi chú XL</div><div class="dt-section-body">${esc(b.devNote)}</div></div>`
        : '';
    const moduleHtml = b.module && b.module !== 'All' ? `<span class="dt-tag">📱 ${esc(b.module)}</span>` : '';
    const testStatus = b.testStatus || 'Chưa test';
    const testIcon = testStatus === 'Đã test' ? '✅' : testStatus === 'Chờ test' ? '⏳' : '⚪';
    const testTagClass = testStatus === 'Đã test' ? 'dt-tag-test-done' : testStatus === 'Chờ test' ? 'dt-tag-test-wait' : 'dt-tag-test-none';
    const historyCount = b.history ? b.history.length : 0;

    document.getElementById('detail-body').innerHTML = `
        <div class="dt-badges">
            ${b.assignee ? statusBadge(b.status) : ''}
            ${severityBadge(b.severity)}
            <span class="dt-tag ${testTagClass}">${testIcon} ${esc(testStatus)}</span>
            <span class="dt-tag">${esc(b.type)}</span>
            ${moduleHtml}
        </div>

        <div class="dt-section">
            <div class="dt-section-title">📄 Mô tả</div>
            <div class="dt-section-body">${esc(b.description || '(chưa có mô tả)')}</div>
        </div>

        <div class="dt-meta">
            <span class="dt-meta-item">👤 TT: <strong>${esc(b.reporter || 'Chưa rõ')}</strong></span>
            <span class="dt-meta-item">🛠️ Xử lý: <strong>${esc(b.assignee || 'Chưa nhận')}</strong></span>
            <span class="dt-meta-item">📅 Ngày TT: <strong>${b.foundDate ? fmtDate(b.foundDate) : fmtDate(b.createdAt)}</strong></span>
            ${completedHtml}
            ${b.createdBy ? `<span class="dt-meta-item">🆕 Tạo bởi: <strong>${esc(b.createdBy)}</strong></span>` : ''}
            ${b.assignedBy ? `<span class="dt-meta-item">🤝 Nhận bởi: <strong>${esc(b.assignedBy)}</strong>${b.assignedAt ? ' · ' + fmtDate(b.assignedAt) : ''}</span>` : ''}
            ${b.deletedBy ? `<span class="dt-meta-item" style="color:#dc2626">🗑️ Xoá bởi: <strong>${esc(b.deletedBy)}</strong></span>` : ''}
        </div>

        ${supportNoteHtml}
        ${devNoteHtml}
        ${attachHtml}

        <details class="dt-history">
            <summary>📋 Lịch sử thay đổi (${historyCount})</summary>
            <div class="history-list">
                ${(b.history && b.history.length > 0)
                    ? b.history.slice().reverse().map(h => `
                        <div class="history-item">
                            <div class="hi-time">${fmtDateTime(h.time)}</div>
                            <div class="hi-detail">${esc(h.detail)}</div>
                        </div>`).join('')
                    : '<p style="color:var(--text-light);font-size:13px;padding:8px">Chưa có lịch sử</p>'}
            </div>
        </details>
    `;

    // Render attachments + nút Copy link để share ngoài app.
    if (window._detailAttachments && window._detailAttachments.length > 0) {
        const container = document.getElementById('detail-att-container');
        if (container) {
            window._detailAttachments.forEach((data, i) => {
                const isVideo = data.startsWith('data:video') || /\.(mp4|webm)$/i.test(data);
                const wrap = document.createElement('div');
                wrap.className = 'att-wrap';
                const div = document.createElement('div');
                div.className = 'att-item';
                div.style.cssText = 'width:120px;height:90px;cursor:pointer';
                div.innerHTML = isVideo
                    ? `<video src="${data}" class="att-thumb" style="width:120px;height:90px" muted preload="none"></video><span class="att-play">▶</span>`
                    : `<img src="${data}" class="att-thumb" style="width:120px;height:90px" loading="lazy">`;
                div.addEventListener('click', () => openLightbox(window._detailAttachments, i));
                wrap.appendChild(div);

                if (data.startsWith('/uploads/')) {
                    const copyBtn = document.createElement('button');
                    copyBtn.className = 'att-copy';
                    copyBtn.textContent = '🔗 Copy link';
                    copyBtn.title = 'Sao chép link để chia sẻ ngoài app';
                    copyBtn.addEventListener('click', e => {
                        e.stopPropagation();
                        const absolute = PUBLIC_BASE + data;
                        navigator.clipboard.writeText(absolute).then(
                            () => toast('Đã sao chép link!', 'success'),
                            () => {
                                // Fallback cho trình duyệt không cho phép clipboard API
                                const ta = document.createElement('textarea');
                                ta.value = absolute; document.body.appendChild(ta);
                                ta.select(); document.execCommand('copy'); ta.remove();
                                toast('Đã sao chép link!', 'success');
                            }
                        );
                    });
                    wrap.appendChild(copyBtn);
                }
                container.appendChild(wrap);
            });
        }
    }

    document.getElementById('detail-modal').hidden = false;
}
document.getElementById('detail-close').addEventListener('click', () => { document.getElementById('detail-modal').hidden = true; });

// ===== KANBAN =====
function renderKanban() {
    const bugs = BugDB.get();
    const statuses = ['Đang xử lí', 'Chưa có P.A', 'Đã xử lí'];

    statuses.forEach(st => {
        const col = document.getElementById('kanban-' + st);
        const items = bugs.filter(b => b.status === st);

        const countId = { 'Đang xử lí': 'k-progress', 'Chưa có P.A': 'k-testing', 'Đã xử lí': 'k-done' };
        document.getElementById(countId[st]).textContent = items.length;

        col.innerHTML = items.map(b => {
            const overdue = isOverdue(b) || isDeadlinePassed(b);
            return `<div class="kanban-card sev-${b.severity.toLowerCase()}" draggable="true" data-id="${b.id}" onclick="showDetail('${b.id}')" style="cursor:pointer">
                <div class="kc-top">
                    <div class="kc-title">${esc(b.name)}</div>
                    ${b.assignee ? `<span class="kc-assignee">${esc(b.assignee)}</span>` : ''}
                </div>
                <div class="kc-meta">
                    <span>${severityBadge(b.severity)}</span>
                    <span${overdue ? ' class="kc-overdue"' : ''}>${b.deadline ? fmtDate(b.deadline) : ''}</span>
                </div>
            </div>`;
        }).join('');
    });

    // Drag & Drop
    initDragDrop();
}

function initDragDrop() {
    document.querySelectorAll('.kanban-card').forEach(card => {
        card.addEventListener('dragstart', e => {
            e.dataTransfer.setData('text/plain', card.dataset.id);
            card.classList.add('dragging');
        });
        card.addEventListener('dragend', () => card.classList.remove('dragging'));
    });

    document.querySelectorAll('.kanban-cards').forEach(col => {
        col.addEventListener('dragover', e => {
            e.preventDefault();
            col.style.background = 'rgba(79,70,229,0.05)';
        });
        col.addEventListener('dragleave', () => { col.style.background = ''; });
        col.addEventListener('drop', e => {
            e.preventDefault();
            col.style.background = '';
            const bugId = e.dataTransfer.getData('text/plain');
            const newStatus = col.closest('.kanban-col').dataset.status;
            BugDB.update(bugId, { status: newStatus });
            toast(`Đã chuyển sang "${newStatus}"`, 'success');
            renderKanban();
            renderDashboard();
            refreshDeviceSummaryIfActive();
        });
    });
}

// ===== IMPROVEMENTS =====
document.getElementById('btn-new-imp').addEventListener('click', () => openImpModal());
document.getElementById('btn-imp-cancel').addEventListener('click', closeImpModal);
document.getElementById('imp-modal-close').addEventListener('click', closeImpModal);

function openImpModal(imp = null) {
    document.getElementById('imp-modal-title').textContent = imp ? 'Chỉnh sửa hạng mục' : 'Thêm hạng mục';
    document.getElementById('imp-edit-id').value = imp ? imp.id : '';
    document.getElementById('imp-name').value = imp ? imp.name : '';
    document.getElementById('imp-desc').value = imp ? (imp.description || '') : '';
    document.getElementById('imp-priority').value = (imp && normImpPriority(imp.priority)) || 'Cao';
    document.getElementById('imp-status').value = imp ? normImpStatus(imp.status) : 'Mới';
    document.getElementById('imp-proposer').value = imp ? (imp.proposer || '') : '';
    // Populate assignee select
    const impAssignee = document.getElementById('imp-assignee');
    const devs = DevListDB.getAll();
    const currentAssignee = imp ? (imp.assignee || '') : '';
    impAssignee.innerHTML = `<option value="">-- Chọn --</option>` +
        devs.map(d => `<option value="${esc(d)}" ${currentAssignee===d?'selected':''}>${esc(d)}</option>`).join('');
    document.getElementById('imp-modal').hidden = false;
}

function closeImpModal() { document.getElementById('imp-modal').hidden = true; }

document.getElementById('btn-imp-save').addEventListener('click', () => {
    const name = document.getElementById('imp-name').value.trim();
    if (!name) { toast('Nhập tên cải tiến!', 'error'); return; }

    const data = {
        name,
        description: document.getElementById('imp-desc').value.trim(),
        priority: document.getElementById('imp-priority').value,
        status: document.getElementById('imp-status').value,
        proposer: document.getElementById('imp-proposer').value.trim(),
        assignee: document.getElementById('imp-assignee').value
    };

    const editId = document.getElementById('imp-edit-id').value;
    if (editId) { ImpDB.update(editId, data); toast('Đã cập nhật!', 'success'); }
    else { ImpDB.add(data); toast('Đã tạo đề xuất!', 'success'); }

    closeImpModal();
    renderImprovements();
});

// Map trạng thái cũ → 3 trạng thái mới
function normImpStatus(s) {
    if (s === 'Hoàn thành' || s === 'Đã xong') return 'Đã xong';
    if (s === 'Đang làm') return 'Đang làm';
    return 'Mới'; // Ý tưởng / Đã duyệt / fallback
}

// Map priority cũ → 2 mức (Trung bình → Cao)
function normImpPriority(p) {
    if (p === 'Thấp') return 'Thấp';
    return 'Cao';
}

function renderImprovements() {
    let imps = ImpDB.get().map(i => ({ ...i, status: normImpStatus(i.status), priority: normImpPriority(i.priority) }));
    const search = document.getElementById('imp-search').value.toLowerCase();
    const fStatus = document.getElementById('imp-filter-status').value;
    const fPriEl = document.getElementById('imp-filter-priority');
    const fPriority = fPriEl ? fPriEl.value : 'all';

    if (search) imps = imps.filter(i =>
        i.name.toLowerCase().includes(search) ||
        (i.description || '').toLowerCase().includes(search)
    );
    if (fStatus !== 'all') imps = imps.filter(i => i.status === fStatus);
    if (fPriority !== 'all') imps = imps.filter(i => i.priority === fPriority);

    // Sort cố định theo createdAt (cũ nhất lên đầu) — không sort theo status/priority
    // → Đổi trạng thái/ưu tiên KHÔNG làm hàng nhảy vị trí
    imps.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

    const tbody = document.getElementById('imp-tbody');
    const empty = document.getElementById('imp-empty');

    if (imps.length === 0) { tbody.innerHTML = ''; empty.hidden = false; return; }
    empty.hidden = true;

    tbody.innerHTML = imps.map((i, idx) => `
        <tr>
            <td class="check-col"><input type="checkbox" class="row-check-imp" data-id="${i.id}" ${Selection.imps.has(i.id)?'checked':''}></td>
            <td class="bug-stt">${idx + 1}</td>
            <td class="bug-name-cell" onclick="editImp('${i.id}')">
                <div class="bug-name-text">${esc(i.name)}</div>
                <div class="bug-name-tooltip">${esc(i.name)}</div>
            </td>
            <td class="bug-desc-cell"><div class="inline-editable" contenteditable="true" data-id="${i.id}" data-imp-field="description" data-placeholder="Nhập mô tả...">${esc(i.description || '')}</div></td>
            <td>${fmtDate(i.createdAt)}</td>
            <td class="reporter-cell">
                <div class="cdrop" data-imp-id="${i.id}" data-imp-field="proposer" data-imp-list="reporter">
                    <button class="cdrop-btn" type="button">${i.proposer ? esc(i.proposer) : ''} ▾</button>
                </div>
            </td>
            <td class="assignee-cell">
                <div class="cdrop" data-imp-id="${i.id}" data-imp-field="assignee" data-imp-list="dev">
                    <button class="cdrop-btn" type="button">${i.assignee ? esc(i.assignee) : ''} ▾</button>
                </div>
            </td>
            <td class="priority-cell">
                <select class="inline-imp-priority" data-id="${i.id}" data-val="${esc(i.priority || 'Cao')}">
                    <option value="Cao" ${i.priority==='Cao'?'selected':''}>🔴 Cao</option>
                    <option value="Thấp" ${i.priority==='Thấp'?'selected':''}>🟢 Thấp</option>
                </select>
            </td>
            <td class="status-cell">
                <select class="inline-imp-status" data-id="${i.id}" data-color="${impStatusColor(i.status)}">
                    <option value="Mới" ${i.status==='Mới'?'selected':''}>Mới</option>
                    <option value="Đang làm" ${i.status==='Đang làm'?'selected':''}>Đang làm</option>
                    <option value="Đã xong" ${i.status==='Đã xong'?'selected':''}>Đã xong</option>
                </select>
            </td>
            <td class="completed-cell">${i.status === 'Đã xong' && i.completedDate
                ? fmtDate(i.completedDate)
                : '<span class="completed-empty">-</span>'}</td>
            <td class="note-cell"><div class="inline-editable" contenteditable="true" data-id="${i.id}" data-imp-field="devNote" data-placeholder="Ghi chú...">${esc(i.devNote || '')}</div></td>
            <td class="action-cell">
                <div class="action-wrap">
                    <button class="action-toggle" type="button" title="Tùy chọn">⚙️</button>
                    <div class="action-menu">
                        <div class="action-item" onclick="editImp('${i.id}')">✏️ Sửa</div>
                        <div class="action-item action-danger" onclick="deleteImp('${i.id}')">🗑️ Xóa</div>
                    </div>
                </div>
            </td>
        </tr>
    `).join('');

    // Bind row checkbox (multi-select imp)
    tbody.querySelectorAll('.row-check-imp').forEach(cb => {
        cb.addEventListener('change', () => {
            if (cb.checked) Selection.imps.add(cb.dataset.id);
            else Selection.imps.delete(cb.dataset.id);
            updateBulkBar('imps');
        });
    });

    // Bind inline editable (description, devNote)
    tbody.querySelectorAll('.inline-editable[data-imp-field]').forEach(el => {
        el.addEventListener('blur', () => {
            const id = el.dataset.id;
            const field = el.dataset.impField;
            const val = el.innerText.trim();
            const imp = ImpDB.get().find(x => x.id === id);
            if (imp && imp[field] !== val) ImpDB.update(id, { [field]: val });
        });
        el.addEventListener('keydown', e => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); el.blur(); }
        });
    });

    // Bind inline priority change
    tbody.querySelectorAll('.inline-imp-priority').forEach(sel => {
        sel.addEventListener('change', () => {
            sel.dataset.val = sel.value;
            ImpDB.update(sel.dataset.id, { priority: sel.value });
            toast(`Ưu tiên: ${sel.value}`, 'success');
            renderImprovements();
        });
    });

    // Bind inline status change — auto set/clear completedDate
    tbody.querySelectorAll('.inline-imp-status').forEach(sel => {
        sel.addEventListener('change', () => {
            sel.dataset.color = impStatusColor(sel.value);
            const updates = { status: sel.value };
            if (sel.value === 'Đã xong') {
                updates.completedDate = new Date().toISOString();
            } else {
                updates.completedDate = '';
            }
            ImpDB.update(sel.dataset.id, updates);
            toast(`Đã chuyển sang "${sel.value}"`, 'success');
            renderImprovements();
        });
    });

    // Bind action menu toggle
    tbody.querySelectorAll('.action-toggle').forEach(btn => {
        btn.addEventListener('click', e => {
            e.stopPropagation();
            closeAllDropdowns();
            const menu = btn.nextElementSibling;
            const rect = btn.getBoundingClientRect();
            menu.style.position = 'fixed';
            menu.style.top = (rect.bottom + 2) + 'px';
            menu.style.right = (window.innerWidth - rect.right) + 'px';
            menu.style.left = 'auto';
            menu.classList.add('open');
        });
    });

    // Bind cdrop cho người đề xuất + người xử lý
    tbody.querySelectorAll('.cdrop[data-imp-id]').forEach(wrap => {
        const impId = wrap.dataset.impId;
        const field = wrap.dataset.impField; // 'proposer' | 'assignee'
        const listKind = wrap.dataset.impList; // 'reporter' | 'dev'
        const btn = wrap.querySelector('.cdrop-btn');
        btn.addEventListener('click', e => {
            e.stopPropagation();
            closeAllDropdowns();
            const list = listKind === 'reporter' ? ReporterDB.getAll() : DevListDB.getAll();
            const addLabel = listKind === 'reporter' ? 'Thêm người...' : 'Thêm dev...';
            const menu = document.createElement('div');
            menu.className = 'cdrop-menu';
            menu.innerHTML = `<div class="cdrop-item cdrop-clear" data-val="">🗑️ Xóa tên</div>` +
                list.map(d => `<div class="cdrop-item">
                    <span class="cdrop-name" data-val="${esc(d)}">${esc(d)}</span>
                    <span class="cdrop-edit" data-dev="${esc(d)}" title="Sửa tên">✏️</span>
                    <span class="cdrop-x" data-dev="${esc(d)}" title="Xóa khỏi DS">✕</span>
                </div>`).join('') +
                `<div class="cdrop-item cdrop-add">➕ ${addLabel}</div>`;
            const rect = btn.getBoundingClientRect();
            menu.style.position = 'fixed';
            menu.style.top = (rect.bottom + 2) + 'px';
            menu.style.left = rect.left + 'px';
            document.body.appendChild(menu);

            menu.querySelectorAll('.cdrop-name').forEach(n => {
                n.addEventListener('click', () => {
                    ImpDB.update(impId, { [field]: n.dataset.val });
                    closeAllDropdowns();
                    renderImprovements();
                });
            });
            menu.querySelector('.cdrop-clear').addEventListener('click', () => {
                ImpDB.update(impId, { [field]: '' });
                closeAllDropdowns();
                renderImprovements();
            });
            menu.querySelectorAll('.cdrop-x').forEach(x => {
                x.addEventListener('click', e => {
                    e.stopPropagation();
                    const name = x.dataset.dev;
                    if (!confirm(`Xóa tên "${name}" khỏi danh sách?`)) return;
                    if (listKind === 'reporter') ReporterDB.remove(name);
                    else DevListDB.remove(name);
                    // Clear references in bugs + imps
                    if (listKind === 'reporter') {
                        Cache.bugs.forEach(b => { if (b.reporter === name) BugDB.update(b.id, { reporter: '' }); });
                        Cache.improvements.forEach(i => { if (i.proposer === name) ImpDB.update(i.id, { proposer: '' }); });
                    } else {
                        Cache.bugs.forEach(b => { if (b.assignee === name) BugDB.update(b.id, { assignee: '' }); });
                        Cache.improvements.forEach(i => { if (i.assignee === name) ImpDB.update(i.id, { assignee: '' }); });
                    }
                    toast(`Đã xóa "${name}"!`, 'success');
                    closeAllDropdowns();
                    renderImprovements();
                    renderBugTable();
                });
            });
            menu.querySelectorAll('.cdrop-edit').forEach(ed => {
                ed.addEventListener('click', e => {
                    e.stopPropagation();
                    const oldName = ed.dataset.dev;
                    const newName = prompt(`Sửa tên "${oldName}" thành:`, oldName);
                    if (!newName || !newName.trim() || newName.trim() === oldName) {
                        closeAllDropdowns();
                        return;
                    }
                    renameInList(listKind, oldName, newName.trim());
                    toast(`Đã đổi "${oldName}" → "${newName.trim()}"`, 'success');
                    closeAllDropdowns();
                    renderImprovements();
                    renderBugTable();
                });
            });
            menu.querySelector('.cdrop-add').addEventListener('click', () => {
                const name = prompt(listKind === 'reporter' ? 'Nhập tên người mới:' : 'Nhập tên Dev mới:');
                if (name && name.trim()) {
                    if (listKind === 'reporter') ReporterDB.add(name.trim());
                    else DevListDB.add(name.trim());
                    ImpDB.update(impId, { [field]: name.trim() });
                }
                closeAllDropdowns();
                renderImprovements();
            });
        });
    });
}

function impStatusColor(s) {
    if (s === 'Mới') return 'thongbao';
    if (s === 'Đang làm') return 'dangxuly';
    if (s === 'Đã xong') return 'hoanthanh';
    return 'thongbao';
}

document.getElementById('imp-search').addEventListener('input', renderImprovements);
document.getElementById('imp-filter-status').addEventListener('change', renderImprovements);
document.getElementById('imp-filter-priority').addEventListener('change', renderImprovements);

function editImp(id) {
    const imp = ImpDB.get().find(i => i.id === id);
    if (imp) openImpModal(imp);
}

function deleteImp(id) {
    if (!confirm('Xóa đề xuất này?')) return;
    ImpDB.delete(id);
    toast('Đã xóa!', 'success');
    renderImprovements();
}

// ===== ALERTS =====
function renderAlerts() {
    // Chỉ cảnh báo bug NGHIÊM TRỌNG và CHƯA xử lí
    const alerts = BugDB.get().filter(b =>
        b.severity === 'Nghiêm trọng' && b.status !== 'Đã xử lí'
    );

    // Sort: Chưa có P.A trước, sau đó theo ngày tạo cũ trước (lâu nhất ưu tiên)
    const statusOrder = { 'Chưa có P.A': 0, 'Đang xử lí': 1 };
    alerts.sort((a, b) => {
        const sa = statusOrder[a.status] ?? 9;
        const sb = statusOrder[b.status] ?? 9;
        if (sa !== sb) return sa - sb;
        return new Date(a.createdAt) - new Date(b.createdAt);
    });

    const list = document.getElementById('alert-list');
    const empty = document.getElementById('alert-empty');

    if (alerts.length === 0) { list.innerHTML = ''; empty.hidden = false; return; }
    empty.hidden = true;

    const now = Date.now();
    list.innerHTML = alerts.map(b => {
        const hours = Math.floor((now - new Date(b.createdAt).getTime()) / 3600000);
        const days = Math.floor(hours / 24);
        const ageLabel = days > 0 ? `${days} ngày` : `${hours}h`;
        return `<div class="alert-item">
            <div class="alert-icon">🔴</div>
            <div class="alert-info">
                <div class="alert-title">${b.displayId || b.id} - ${esc(b.name)}</div>
                <div class="alert-desc">${severityBadge(b.severity)} · ${statusBadge(b.status)} · Dev: ${esc(b.assignee || 'Chưa phân công')}</div>
            </div>
            <div class="alert-time">Đã ${ageLabel}</div>
            <button class="btn-icon" onclick="editBug('${b.id}')" title="Xử lý">⚡</button>
        </div>`;
    }).join('');

    updateAlertBadge();
}

function updateAlertBadge() {
    const count = BugDB.get().filter(b =>
        b.severity === 'Nghiêm trọng' && b.status !== 'Đã xử lí'
    ).length;
    const badge = document.getElementById('alert-badge');
    if (count > 0) {
        badge.textContent = count;
        badge.hidden = false;
    } else {
        badge.hidden = true;
    }
}

// ===== EXPORT / IMPORT =====
document.getElementById('btn-export').addEventListener('click', () => {
    const data = JSON.stringify({ bugs: BugDB.getAll(), improvements: ImpDB.get(), exportedAt: new Date().toISOString() }, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `bugtrack-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('Đã xuất dữ liệu!', 'success');
});

document.getElementById('btn-import').addEventListener('click', () => document.getElementById('import-file').click());
document.getElementById('import-file').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    if (!confirm('Nhập dữ liệu sẽ TẠO MỚI từng bug/improvement vào server (không ghi đè bug hiện có). Tiếp tục?')) return;
    try {
        const data = JSON.parse(await file.text());
        let nb = 0, ni = 0;
        for (const b of (data.bugs || [])) {
            try { await apiCall('POST', '/bugs', b); nb++; } catch (err) { console.warn('import bug fail', err.message); }
        }
        for (const i of (data.improvements || [])) {
            try { await apiCall('POST', '/improvements', i); ni++; } catch (err) { console.warn('import imp fail', err.message); }
        }
        await DataSync.loadAll();
        toast(`Đã nhập ${nb} bug + ${ni} cải tiến`, 'success');
        renderProductSelect(); renderDashboard(); renderBugTable(); renderImprovements();
    } catch { toast('File không hợp lệ!', 'error'); }
});

// ===== LIGHTBOX =====
let lbImages = [];
let lbIndex = 0;
let lbZoom = 1;
let lbPanX = 0;
let lbPanY = 0;
let lbDragging = false;
let lbDragStartX = 0;
let lbDragStartY = 0;

function openLightbox(images, startIndex) {
    lbImages = images;
    lbIndex = startIndex || 0;
    showLbImage();
    document.getElementById('lightbox').hidden = false;
}

function closeLightbox() {
    document.getElementById('lightbox').hidden = true;
}

function applyImgTransform() {
    const img = document.getElementById('lb-img');
    img.style.transform = `translate(${lbPanX}px, ${lbPanY}px) scale(${lbZoom})`;
    img.style.cursor = lbZoom > 1 ? (lbDragging ? 'grabbing' : 'grab') : 'zoom-in';
    document.getElementById('lb-zoom-level').textContent = Math.round(lbZoom * 100) + '%';
}

function resetZoom() {
    lbZoom = 1;
    lbPanX = 0;
    lbPanY = 0;
    applyImgTransform();
}

function setZoom(z, cx, cy) {
    const newZoom = Math.max(0.5, Math.min(8, z));
    if (newZoom === 1) { resetZoom(); return; }
    // Zoom about a center point (cx, cy in viewport coords) — keeps point under cursor
    if (cx !== undefined && cy !== undefined) {
        const img = document.getElementById('lb-img');
        const rect = img.getBoundingClientRect();
        const ix = rect.left + rect.width / 2;
        const iy = rect.top + rect.height / 2;
        const dx = cx - ix;
        const dy = cy - iy;
        const ratio = newZoom / lbZoom;
        lbPanX = lbPanX * ratio + dx * (1 - ratio);
        lbPanY = lbPanY * ratio + dy * (1 - ratio);
    }
    lbZoom = newZoom;
    applyImgTransform();
}

function showLbImage() {
    const src = lbImages[lbIndex];
    const isVideo = src.startsWith('data:video') || /\.(mp4|webm)$/i.test(src);
    const container = document.querySelector('.lb-content');
    const img = document.getElementById('lb-img');

    // Remove old video if any
    const oldVid = container.querySelector('video');
    if (oldVid) oldVid.remove();

    if (isVideo) {
        img.style.display = 'none';
        const vid = document.createElement('video');
        vid.src = src;
        vid.controls = true;
        vid.autoplay = true;
        vid.style.maxWidth = '90vw';
        vid.style.maxHeight = '85vh';
        vid.style.borderRadius = '6px';
        container.appendChild(vid);
        document.getElementById('lb-zoom-level').parentElement.style.display = 'none';
    } else {
        img.style.display = '';
        img.src = src;
        resetZoom();
        document.getElementById('lb-zoom-level').parentElement.style.display = '';
    }

    document.getElementById('lb-counter').textContent = `${lbIndex + 1} / ${lbImages.length}`;
    document.getElementById('lb-prev').style.visibility = lbIndex > 0 ? 'visible' : 'hidden';
    document.getElementById('lb-next').style.visibility = lbIndex < lbImages.length - 1 ? 'visible' : 'hidden';
}

document.getElementById('lb-close').addEventListener('click', closeLightbox);
document.getElementById('lb-prev').addEventListener('click', () => { if (lbIndex > 0) { lbIndex--; showLbImage(); } });
document.getElementById('lb-next').addEventListener('click', () => { if (lbIndex < lbImages.length - 1) { lbIndex++; showLbImage(); } });
document.getElementById('lb-zoom-in').addEventListener('click', e => { e.stopPropagation(); setZoom(lbZoom * 1.25); });
document.getElementById('lb-zoom-out').addEventListener('click', e => { e.stopPropagation(); setZoom(lbZoom / 1.25); });
document.getElementById('lb-zoom-reset').addEventListener('click', e => { e.stopPropagation(); resetZoom(); });

// Wheel zoom
document.getElementById('lightbox').addEventListener('wheel', e => {
    if (document.getElementById('lightbox').hidden) return;
    if (document.getElementById('lb-img').style.display === 'none') return; // skip on video
    e.preventDefault();
    const delta = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    setZoom(lbZoom * delta, e.clientX, e.clientY);
}, { passive: false });

// Pan when zoomed
document.getElementById('lb-img').addEventListener('mousedown', e => {
    if (lbZoom <= 1) return;
    e.preventDefault();
    lbDragging = true;
    lbDragStartX = e.clientX - lbPanX;
    lbDragStartY = e.clientY - lbPanY;
    applyImgTransform();
});
document.addEventListener('mousemove', e => {
    if (!lbDragging) return;
    lbPanX = e.clientX - lbDragStartX;
    lbPanY = e.clientY - lbDragStartY;
    applyImgTransform();
});
document.addEventListener('mouseup', () => {
    if (lbDragging) { lbDragging = false; applyImgTransform(); }
});

// Double-click toggle 1x ↔ 2x
document.getElementById('lb-img').addEventListener('dblclick', e => {
    e.stopPropagation();
    if (lbZoom > 1) resetZoom();
    else setZoom(2, e.clientX, e.clientY);
});

// Close on background click (only when not zoomed/panning)
document.getElementById('lightbox').addEventListener('click', e => {
    if (lbDragging) return;
    if (e.target.id === 'lightbox' || e.target.classList.contains('lb-content')) closeLightbox();
});

// Keyboard nav
document.addEventListener('keydown', e => {
    if (document.getElementById('lightbox').hidden) return;
    if (e.key === 'Escape') closeLightbox();
    if (e.key === 'ArrowLeft' && lbIndex > 0) { lbIndex--; showLbImage(); }
    if (e.key === 'ArrowRight' && lbIndex < lbImages.length - 1) { lbIndex++; showLbImage(); }
    if (e.key === '+' || e.key === '=') { e.preventDefault(); setZoom(lbZoom * 1.25); }
    if (e.key === '-') { e.preventDefault(); setZoom(lbZoom / 1.25); }
    if (e.key === '0') { e.preventDefault(); resetZoom(); }
});

// ===== DEV LIST (API-backed) =====
const DevListDB = {
    get() { return Cache.devList || []; },
    add(name) {
        if (!name || Cache.devList.includes(name)) return;
        Cache.devList = [...Cache.devList, name].sort();
        apiCall('PATCH', '/meta', { devList: Cache.devList }).catch(e => console.warn('devList sync:', e.message));
    },
    remove(name) {
        Cache.devList = Cache.devList.filter(n => n !== name);
        apiCall('PATCH', '/meta', { devList: Cache.devList }).catch(e => console.warn('devList sync:', e.message));
    },
    getAll() { return [...Cache.devList].sort(); },
};

function renderDevDatalist() {
    let dl = document.getElementById('dev-list');
    if (!dl) {
        dl = document.createElement('datalist');
        dl.id = 'dev-list';
        document.body.appendChild(dl);
    }
    dl.innerHTML = DevListDB.getAll().map(d => `<option value="${esc(d)}">`).join('');
}

// ===== REPORTER LIST (API-backed) =====
const ReporterDB = {
    get() { return Cache.reporterList || []; },
    add(name) {
        if (!name || Cache.reporterList.includes(name)) return;
        Cache.reporterList = [...Cache.reporterList, name].sort();
        apiCall('PATCH', '/meta', { reporterList: Cache.reporterList }).catch(e => console.warn('reporterList sync:', e.message));
    },
    remove(name) {
        Cache.reporterList = Cache.reporterList.filter(n => n !== name);
        apiCall('PATCH', '/meta', { reporterList: Cache.reporterList }).catch(e => console.warn('reporterList sync:', e.message));
    },
    getAll() { return [...Cache.reporterList].sort(); },
};

// ===== BUG TYPE LIST (API-backed) =====
const BugTypeDB = {
    ICONS: { 'Giao diện': '🎨', 'Logic': '⚙️', 'Hiệu năng': '⚡', 'Sập ứng dụng': '💥', 'Khác': '📎' },
    get() { return Cache.bugTypes && Cache.bugTypes.length ? Cache.bugTypes : ['Giao diện', 'Logic', 'Hiệu năng', 'Sập ứng dụng', 'Khác']; },
    add(name) {
        if (!name || Cache.bugTypes.includes(name)) return;
        Cache.bugTypes = [...Cache.bugTypes, name];
        apiCall('PATCH', '/meta', { bugTypes: Cache.bugTypes }).catch(e => console.warn('bugTypes sync:', e.message));
    },
    remove(name) {
        Cache.bugTypes = Cache.bugTypes.filter(n => n !== name);
        apiCall('PATCH', '/meta', { bugTypes: Cache.bugTypes }).catch(e => console.warn('bugTypes sync:', e.message));
    },
    getIcon(name) { return this.ICONS[name] || '🏷️'; },
    setIcon(name, icon) { this.ICONS[name] = icon; },
};

function renderBugTypeDropdown(selectedValue) {
    const btn = document.getElementById('bug-type-btn');
    const input = document.getElementById('bug-type');
    const val = selectedValue || input.value || 'Giao diện';
    input.value = val;
    btn.textContent = `${BugTypeDB.getIcon(val)} ${val} ▾`;

    btn.onclick = e => {
        e.stopPropagation();
        closeAllDropdowns();

        const menu = document.createElement('div');
        menu.className = 'cdrop-menu';

        menu.innerHTML = BugTypeDB.get().map(t =>
            `<div class="cdrop-item${t === val ? ' active' : ''}">
                <span class="cdrop-name" data-val="${esc(t)}">${BugTypeDB.getIcon(t)} ${esc(t)}</span>
                <span class="cdrop-x" data-dev="${esc(t)}" title="Xóa loại lỗi">✕</span>
            </div>`
        ).join('') + `<div class="cdrop-item cdrop-add">➕ Thêm loại mới...</div>`;

        const rect = btn.getBoundingClientRect();
        menu.style.position = 'fixed';
        menu.style.top = (rect.bottom + 2) + 'px';
        menu.style.left = rect.left + 'px';
        document.body.appendChild(menu);

        menu.querySelectorAll('.cdrop-name').forEach(n => {
            n.addEventListener('click', () => {
                input.value = n.dataset.val;
                btn.textContent = `${BugTypeDB.getIcon(n.dataset.val)} ${n.dataset.val} ▾`;
                closeAllDropdowns();
            });
        });

        menu.querySelectorAll('.cdrop-x').forEach(x => {
            x.addEventListener('click', e => {
                e.stopPropagation();
                const name = x.dataset.dev;
                if (BugTypeDB.get().length <= 1) { toast('Phải giữ ít nhất 1 loại!', 'error'); return; }
                BugTypeDB.remove(name);
                toast(`Đã xóa loại "${name}"!`, 'success');
                closeAllDropdowns();
                // Reset if current selected was deleted
                if (input.value === name) {
                    const first = BugTypeDB.get()[0];
                    input.value = first;
                    btn.textContent = `${BugTypeDB.getIcon(first)} ${first} ▾`;
                }
                populateTypeFilter();
            });
        });

        menu.querySelector('.cdrop-add').addEventListener('click', () => {
            const name = prompt('Nhập tên loại lỗi mới:');
            if (name && name.trim()) {
                BugTypeDB.add(name.trim());
                input.value = name.trim();
                btn.textContent = `🏷️ ${name.trim()} ▾`;
                toast(`Đã thêm loại "${name.trim()}"!`, 'success');
                populateTypeFilter();
            }
            closeAllDropdowns();
        });
    };
}

function populateTypeFilter() {
    const sel = document.getElementById('filter-type');
    const current = sel.value;
    sel.innerHTML = '<option value="all">Tất cả loại</option>' +
        BugTypeDB.get().map(t => `<option value="${esc(t)}">${BugTypeDB.getIcon(t)} ${esc(t)}</option>`).join('');
    sel.value = current || 'all';
}

// Close all custom dropdowns
function closeAllDropdowns() {
    document.querySelectorAll('.cdrop-menu').forEach(m => m.remove());
    document.querySelectorAll('.action-menu.open').forEach(m => m.classList.remove('open'));
}
document.addEventListener('click', closeAllDropdowns);

// Đổi tên trong danh sách Dev/Reporter + cập nhật mọi bug/imp dùng tên cũ
function renameInList(listKind, oldName, newName) {
    if (listKind === 'reporter') {
        ReporterDB.remove(oldName);
        ReporterDB.add(newName);
        Cache.bugs.forEach(b => { if (b.reporter === oldName) BugDB.update(b.id, { reporter: newName }); });
        Cache.improvements.forEach(i => { if (i.proposer === oldName) ImpDB.update(i.id, { proposer: newName }); });
    } else {
        DevListDB.remove(oldName);
        DevListDB.add(newName);
        Cache.bugs.forEach(b => { if (b.assignee === oldName) BugDB.update(b.id, { assignee: newName }); });
        Cache.improvements.forEach(i => { if (i.assignee === oldName) ImpDB.update(i.id, { assignee: newName }); });
    }
}

// ===== MULTI-SELECT / BULK DELETE =====
function updateBulkBar(kind) {
    const set = Selection[kind];
    const bar = document.getElementById(kind === 'bugs' ? 'bug-bulk-bar' : 'imp-bulk-bar');
    const cnt = document.getElementById(kind === 'bugs' ? 'bug-bulk-count' : 'imp-bulk-count');
    if (!bar || !cnt) return;
    if (set.size === 0) { bar.hidden = true; }
    else { bar.hidden = false; cnt.textContent = set.size; }
    // Sync master check
    const master = document.getElementById(kind === 'bugs' ? 'bug-check-all' : 'imp-check-all');
    if (master) {
        const rows = document.querySelectorAll(kind === 'bugs' ? '.row-check-bug' : '.row-check-imp');
        const allChecked = rows.length > 0 && Array.from(rows).every(c => c.checked);
        master.checked = allChecked;
        master.indeterminate = !allChecked && set.size > 0;
    }
}

// Master check toggle (chọn/bỏ tất cả hàng đang hiển thị)
const bugCheckAll = document.getElementById('bug-check-all');
if (bugCheckAll) bugCheckAll.addEventListener('change', () => {
    const rows = document.querySelectorAll('.row-check-bug');
    if (bugCheckAll.checked) rows.forEach(c => { c.checked = true; Selection.bugs.add(c.dataset.id); });
    else { rows.forEach(c => c.checked = false); Selection.bugs.clear(); }
    updateBulkBar('bugs');
});
const impCheckAll = document.getElementById('imp-check-all');
if (impCheckAll) impCheckAll.addEventListener('change', () => {
    const rows = document.querySelectorAll('.row-check-imp');
    if (impCheckAll.checked) rows.forEach(c => { c.checked = true; Selection.imps.add(c.dataset.id); });
    else { rows.forEach(c => c.checked = false); Selection.imps.clear(); }
    updateBulkBar('imps');
});

// Bulk clear / delete
document.getElementById('btn-bug-bulk-clear').addEventListener('click', () => {
    Selection.bugs.clear();
    document.querySelectorAll('.row-check-bug').forEach(c => c.checked = false);
    updateBulkBar('bugs');
});
document.getElementById('btn-bug-bulk-delete').addEventListener('click', async () => {
    const ids = Array.from(Selection.bugs);
    if (ids.length === 0) return;
    if (!confirm(`Xóa ${ids.length} lỗi đã chọn? Không thể hoàn tác.`)) return;
    for (const id of ids) await BugDB.delete(id);
    Selection.bugs.clear();
    toast(`Đã xóa ${ids.length} lỗi`, 'success');
    updateBulkBar('bugs');
    renderBugTable();
});

document.getElementById('btn-imp-bulk-clear').addEventListener('click', () => {
    Selection.imps.clear();
    document.querySelectorAll('.row-check-imp').forEach(c => c.checked = false);
    updateBulkBar('imps');
});
document.getElementById('btn-imp-bulk-delete').addEventListener('click', async () => {
    const ids = Array.from(Selection.imps);
    if (ids.length === 0) return;
    if (!confirm(`Xóa ${ids.length} hạng mục đã chọn? Không thể hoàn tác.`)) return;
    for (const id of ids) await ImpDB.delete(id);
    Selection.imps.clear();
    toast(`Đã xóa ${ids.length} hạng mục`, 'success');
    updateBulkBar('imps');
    renderImprovements();
});

// No-op stubs cho code legacy còn gọi tới (đã bỏ trang Tổng hợp thiết bị)
function refreshDeviceSummaryIfActive() {}
function renderDeviceSummary() {}

// ===== Login flow (seam #A) =====
function showLogin() {
    const el = document.getElementById('login-screen'); if (el) el.hidden = false;
    const app = document.getElementById('app'); if (app) app.style.display = 'none';
}
function hideLogin() {
    const el = document.getElementById('login-screen'); if (el) el.hidden = true;
    const app = document.getElementById('app'); if (app) app.style.display = '';
}
function applyRoleUI() {
    const who = document.getElementById('current-user');
    if (who && Auth.user) who.textContent = `${Auth.user.name} · ${Auth.user.role}`;
    document.body.classList.toggle('role-support', Auth.is('support'));
    document.body.classList.toggle('role-dev', Auth.is('dev'));
    document.body.classList.toggle('role-admin', Auth.is('admin'));
    // Footgun: chỉ admin thấy nút xoá sản phẩm
    const delProd = document.getElementById('btn-del-product');
    if (delProd) delProd.style.display = Auth.canDeleteProduct() ? '' : 'none';
    // Thùng rác: chỉ dev/admin
    const trash = document.getElementById('btn-trash');
    if (trash) trash.style.display = Auth.canDelete() ? '' : 'none';
}

async function startApp() {
    try {
        await DataSync.loadAll();
    } catch (e) {
        toast('Không kết nối được server: ' + e.message, 'error');
        console.error('Initial load failed:', e);
        return;
    }
    if (!Cache.products.includes(Cache.activeProduct)) {
        ProductDB.setActive(Cache.products[0] || 'GemCloudPhone');
    }
    applyRoleUI();
    renderProductSelect();
    renderDevDatalist();
    populateTypeFilter();
    populateModuleFilter();
    renderDashboard();
    renderBugTable();
    renderImprovements();
    renderAlerts();
    DataSync.startAutoRefresh(10000);
    console.log('[INIT] User:', Auth.user && Auth.user.name, '| Bugs:', Cache.bugs.length, '| Imps:', Cache.improvements.length);
}

async function doLogin(email, pass) {
    const r = await apiCall('POST', '/auth/login', { email, password: pass });
    Auth.set(r.token, r.user);
    hideLogin();
    await startApp();
}
function logout() { Auth.clear(); location.reload(); }

// ===== Thùng rác (khôi phục bug xoá mềm) — dev/admin =====
async function openTrash() {
    if (!Auth.canDelete()) { toast('Chỉ Dev/Admin xem được thùng rác', 'error'); return; }
    let data;
    try { data = await apiCall('GET', '/bugs?deleted=only&size=500'); }
    catch (e) { toast('Lỗi tải thùng rác: ' + e.message, 'error'); return; }
    const items = data.items || [];
    let modal = document.getElementById('trash-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'trash-modal';
        modal.className = 'modal';
        modal.innerHTML = `<div class="modal-content" style="max-width:640px">
            <div class="modal-header"><h3></h3>
            <button class="modal-close" id="trash-close">✕</button></div>
            <div id="trash-body" style="max-height:60vh;overflow:auto;padding:8px 4px"></div></div>`;
        document.body.appendChild(modal);
        modal.querySelector('#trash-close').addEventListener('click', () => { modal.hidden = true; });
    }
    modal.querySelector('h3').textContent = `🗑️ Thùng rác (${items.length})`;
    const body = modal.querySelector('#trash-body');
    body.innerHTML = items.length ? items.map(b => `
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px;border-bottom:1px solid #eee">
            <div><strong>${b.displayId}</strong> ${esc(b.name)}<br>
            <small style="color:#888">Xoá bởi <b>${esc(b.deletedBy || '?')}</b> · ${b.deletedAt ? fmtDateTime(b.deletedAt) : ''} · SP: ${esc(b.product)}</small></div>
            <button class="btn-small" data-restore="${b.id}">↩️ Khôi phục</button>
        </div>`).join('') : '<p style="padding:16px;color:#888">Thùng rác trống</p>';
    body.querySelectorAll('[data-restore]').forEach(btn => {
        btn.addEventListener('click', async () => {
            try {
                await apiCall('POST', `/bugs/${btn.dataset.restore}/restore`);
                toast('Đã khôi phục lỗi', 'success');
                await DataSync.loadAll();
                renderBugTable(); renderDashboard(); renderAlerts();
                openTrash();
            } catch (e) { toast('Khôi phục lỗi: ' + e.message, 'error'); }
        });
    });
    modal.hidden = false;
}

(async function init() {
    Auth.load();
    const form = document.getElementById('login-form');
    if (form) form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = document.getElementById('login-email').value.trim();
        const pass = document.getElementById('login-password').value;
        const errEl = document.getElementById('login-error');
        if (errEl) errEl.textContent = '';
        try { await doLogin(email, pass); }
        catch (err) { if (errEl) errEl.textContent = err.message; }
    });
    const lo = document.getElementById('btn-logout');
    if (lo) lo.addEventListener('click', logout);
    const tb = document.getElementById('btn-trash');
    if (tb) tb.addEventListener('click', openTrash);

    if (!Auth.token) { showLogin(); return; }
    try {
        await apiCall('GET', '/auth/me');   // validate token
        hideLogin();
        await startApp();
    } catch (e) {
        showLogin();   // token hỏng → apiCall đã clear + showLogin
    }
})();
