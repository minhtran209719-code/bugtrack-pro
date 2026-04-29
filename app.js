// ===== BugTrack Pro - Main Application =====

// ===== SERVER SYNC =====
const isServer = location.protocol !== 'file:';
const API = location.origin + '/api';

// Wrapper: đọc/ghi data qua server nếu có, fallback localStorage
const DataSync = {
    _cache: null,
    _dirty: false,
    _syncTimers: {},

    async load() {
        if (isServer) {
            try {
                const res = await fetch(API + '/data', { cache: 'no-store' });
                this._cache = await res.json();
                // Mirror to localStorage for offline fallback
                for (const [k, v] of Object.entries(this._cache)) {
                    localStorage.setItem('bt_' + k, JSON.stringify(v));
                }
                return;
            } catch (e) { console.warn('Server offline, using localStorage'); }
        }
        // Fallback: localStorage
        this._cache = null;
    },

    syncToServer(key, data) {
        if (!isServer) return;
        // Debounce riêng cho từng key, tránh cancel lẫn nhau
        clearTimeout(this._syncTimers[key]);
        this._syncTimers[key] = setTimeout(async () => {
            try {
                const res = await fetch(API + '/sync', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ [key]: data })
                });
                const json = await res.json();
                // Cập nhật localStorage với data merged từ server (bao gồm bug của máy khác)
                if (json.merged) {
                    for (const [k, v] of Object.entries(json.merged)) {
                        localStorage.setItem('bt_' + k, JSON.stringify(v));
                    }
                }
            } catch (e) { console.warn('Sync failed:', e); }
        }, 300);
    },

    startAutoRefresh(interval = 10000) {
        if (!isServer) return;
        const poll = async () => {
            // Bỏ qua nếu đang mở modal (người dùng đang chỉnh sửa)
            const modalOpen = [...document.querySelectorAll('.modal')].some(m => !m.hidden);
            if (modalOpen) return;
            try {
                const res = await fetch(API + '/data', { cache: 'no-store' });
                if (!res.ok) return;
                const fresh = await res.json();
                const keys = ['bugs', 'improvements', 'products', 'devList', 'reporterList', 'bugTypes'];
                let changed = false;
                for (const k of keys) {
                    if (fresh[k] === undefined) continue;
                    const cur = localStorage.getItem('bt_' + k);
                    const next = JSON.stringify(fresh[k]);
                    if (cur !== next) {
                        localStorage.setItem('bt_' + k, next);
                        changed = true;
                    }
                }
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
    }
};

// ===== FILE STORAGE (IndexedDB - no size limit) =====
const FileStore = {
    DB_NAME: 'bt_files',
    STORE: 'attachments',
    _db: null,

    open() {
        return new Promise((resolve, reject) => {
            if (this._db) { resolve(this._db); return; }
            const req = indexedDB.open(this.DB_NAME, 1);
            req.onupgradeneeded = e => { e.target.result.createObjectStore(this.STORE); };
            req.onsuccess = e => { this._db = e.target.result; resolve(this._db); };
            req.onerror = e => reject(e);
        });
    },

    async save(id, dataUrl) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.STORE, 'readwrite');
            tx.objectStore(this.STORE).put(dataUrl, id);
            tx.oncomplete = () => resolve();
            tx.onerror = e => reject(e);
        });
    },

    async get(id) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.STORE, 'readonly');
            const req = tx.objectStore(this.STORE).get(id);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = e => reject(e);
        });
    },

    async delete(id) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.STORE, 'readwrite');
            tx.objectStore(this.STORE).delete(id);
            tx.oncomplete = () => resolve();
            tx.onerror = e => reject(e);
        });
    },

    async deleteMultiple(ids) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.STORE, 'readwrite');
            const store = tx.objectStore(this.STORE);
            ids.forEach(id => store.delete(id));
            tx.oncomplete = () => resolve();
            tx.onerror = e => reject(e);
        });
    },

    generateId() {
        return 'file_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    }
};

// ===== PRODUCT MANAGEMENT =====
const ProductDB = {
    KEY: 'bt_products',
    ACTIVE_KEY: 'bt_active_product',
    get() {
        const saved = JSON.parse(localStorage.getItem(this.KEY) || 'null');
        if (saved && saved.length > 0) return saved;
        return ['GemCloudPhone', 'GemLogin'];
    },
    save(d) { localStorage.setItem(this.KEY, JSON.stringify(d)); },
    add(name) {
        const list = this.get();
        if (!list.includes(name)) { list.push(name); this.save(list); }
    },
    remove(name) {
        this.save(this.get().filter(n => n !== name));
        // Remove all bugs of this product
        const allBugs = JSON.parse(localStorage.getItem('bt_bugs') || '[]');
        localStorage.setItem('bt_bugs', JSON.stringify(allBugs.filter(b => b.product !== name)));
    },
    getActive() { return localStorage.getItem(this.ACTIVE_KEY) || this.get()[0] || 'GemCloudPhone'; },
    setActive(name) { localStorage.setItem(this.ACTIVE_KEY, name); }
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

// ===== DATA LAYER =====
const BugDB = {
    KEY: 'bt_bugs',
    getAll() { return JSON.parse(localStorage.getItem(this.KEY) || '[]'); },
    get() { const p = ProductDB.getActive(); return this.getAll().filter(b => b.product === p); },
    save(d) {
        if (d.length === 0 && this.getAll().length > 0) {
            console.warn('BugDB.save: blocked saving empty array');
            return;
        }
        localStorage.setItem(this.KEY, JSON.stringify(d));
        DataSync.syncToServer('bugs', d);
    },
    nextId() {
        const bugs = this.getAll();
        const max = bugs.reduce((m, b) => Math.max(m, parseInt(b.id.replace('BUG-', '')) || 0), 0);
        return 'BUG-' + String(max + 1).padStart(4, '0');
    },
    add(bug) {
        const bugs = this.getAll();
        bug.id = this.nextId();
        bug.product = ProductDB.getActive();
        bug.createdAt = new Date().toISOString();
        bug.updatedAt = bug.createdAt;
        bug.history = [{ time: bug.createdAt, action: 'Tạo mới', detail: `Tạo lỗi "${bug.name}"` }];
        bugs.push(bug);
        this.save(bugs);
        return bug;
    },
    update(id, data) {
        const bugs = this.getAll();
        const i = bugs.findIndex(b => b.id === id);
        if (i === -1) return;
        const old = bugs[i];
        // Ghi lịch sử thay đổi
        if (!old.history) old.history = [];
        const changes = [];
        const fieldLabels = {
            name: 'Tên lỗi', description: 'Mô tả', type: 'Loại lỗi', severity: 'Mức độ',
            status: 'Trạng thái', assignee: 'Người xử lý', reporter: 'Người TT', testStatus: 'TT Test',
            module: 'Thiết bị', devNote: 'Ghi chú XL', supportNote: 'Ghi chú TT', foundDate: 'Ngày phát hiện'
        };
        for (const key of Object.keys(data)) {
            if (fieldLabels[key] && data[key] !== old[key]) {
                changes.push(`${fieldLabels[key]}: "${old[key] || '(trống)'}" → "${data[key] || '(trống)'}"`);
            }
        }
        if (changes.length > 0) {
            old.history.push({
                time: new Date().toISOString(),
                action: 'Cập nhật',
                detail: changes.join(' | ')
            });
        }
        Object.assign(old, data, { updatedAt: new Date().toISOString() });
        this.save(bugs);
    },
    delete(id) {
        const filtered = this.getAll().filter(b => b.id !== id);
        localStorage.setItem(this.KEY, JSON.stringify(filtered));
        // Gọi API delete riêng, không gửi toàn bộ mảng để tránh ghi đè data máy khác
        if (isServer) {
            fetch(API + '/delete-item', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: 'bug', id })
            }).catch(e => console.warn('Delete sync failed:', e));
        }
    },
    find(id) { return this.getAll().find(b => b.id === id); }
};

const ImpDB = {
    KEY: 'bt_improvements',
    get() { return JSON.parse(localStorage.getItem(this.KEY) || '[]'); },
    save(d) { localStorage.setItem(this.KEY, JSON.stringify(d)); DataSync.syncToServer('improvements', d); },
    nextId() {
        const imps = this.get();
        const max = imps.reduce((m, b) => Math.max(m, parseInt(b.id.replace('IMP-', '')) || 0), 0);
        return 'IMP-' + String(max + 1).padStart(4, '0');
    },
    add(imp) {
        const imps = this.get();
        imp.id = this.nextId();
        imp.createdAt = new Date().toISOString();
        imps.push(imp);
        this.save(imps);
        return imp;
    },
    update(id, data) {
        const imps = this.get();
        const i = imps.findIndex(b => b.id === id);
        if (i === -1) return;
        Object.assign(imps[i], data);
        this.save(imps);
    },
    delete(id) {
        const filtered = this.get().filter(b => b.id !== id);
        localStorage.setItem(this.KEY, JSON.stringify(filtered));
        if (isServer) {
            fetch(API + '/delete-item', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: 'improvement', id })
            }).catch(e => console.warn('Delete sync failed:', e));
        }
    }
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
    if (page === 'device-summary') renderDeviceSummary();
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
function renderBugTable() {
    populateModuleFilter();
    populateTypeFilter();
    let bugs = BugDB.get();
    const search = document.getElementById('bug-search').value.toLowerCase();
    const fStatus = document.getElementById('filter-status').value;
    const fSev = document.getElementById('filter-severity').value;
    const fType = document.getElementById('filter-type').value;
    const fModule = document.getElementById('filter-module').value;

    if (search) bugs = bugs.filter(b => b.name.toLowerCase().includes(search) || b.id.toLowerCase().includes(search) || (b.description || '').toLowerCase().includes(search));
    if (fStatus !== 'all') bugs = bugs.filter(b => b.status === fStatus);
    if (fSev !== 'all') bugs = bugs.filter(b => b.severity === fSev);
    if (fType !== 'all') bugs = bugs.filter(b => b.type === fType);
    if (fModule !== 'all') bugs = bugs.filter(b => b.module === fModule);

    bugs.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

    const tbody = document.getElementById('bug-tbody');
    const empty = document.getElementById('bug-empty');

    if (bugs.length === 0) {
        tbody.innerHTML = '';
        empty.hidden = false;
        return;
    }
    empty.hidden = true;

    // Build module list from existing bugs + defaults
    const moduleOptions = [...new Set(bugs.map(b => b.module).filter(Boolean).concat(['All', 'Note 8', 'S7', 'Z Flip 3']))].sort();

    tbody.innerHTML = bugs.map((b, idx) => {
        const foundTime = b.foundDate ? fmtDateTime(b.foundDate) : fmtDate(b.createdAt);
        return `<tr class="${rowClass(b)}">
            <td class="bug-stt">${idx + 1}</td>
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

document.getElementById('bug-search').addEventListener('input', renderBugTable);
document.getElementById('filter-status').addEventListener('change', renderBugTable);
document.getElementById('filter-severity').addEventListener('change', renderBugTable);
document.getElementById('filter-type').addEventListener('change', renderBugTable);
document.getElementById('filter-module').addEventListener('change', renderBugTable);

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

function closeBugModal() { document.getElementById('bug-modal').hidden = true; }

async function renderAttachments() {
    const container = document.getElementById('bug-attachments');
    container.innerHTML = '';
    for (let i = 0; i < bugAttachments.length; i++) {
        const ref = bugAttachments[i];
        // ref: server URL (/uploads/xxx.jpg) or legacy data:url or legacy fileId
        let src = ref;
        if (ref.startsWith('data:')) {
            src = ref;
        } else if (ref.startsWith('/uploads/')) {
            src = ref;
        } else {
            // Legacy IndexedDB fileId - try to load
            const data = await FileStore.get(ref);
            if (!data) continue;
            src = data;
        }
        const isVideo = src.startsWith('data:video') || /\.(mp4|webm)$/i.test(src);
        const div = document.createElement('div');
        div.className = 'att-item';
        div.innerHTML = `${isVideo
            ? `<video src="${src}" class="att-thumb" muted></video><span class="att-play">▶</span>`
            : `<img src="${src}" class="att-thumb">`}
            <button class="att-remove" data-idx="${i}" title="Xóa">✕</button>`;
        div.querySelector('.att-remove').addEventListener('click', () => removeAttachment(i));
        container.appendChild(div);
    }
}

async function removeAttachment(idx) {
    const ref = bugAttachments[idx];
    if (ref && ref.startsWith('/uploads/') && isServer) {
        fetch(API + '/delete-file', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: ref })
        }).catch(() => {});
    } else if (ref && !ref.startsWith('data:') && !ref.startsWith('/')) {
        await FileStore.delete(ref);
    }
    bugAttachments.splice(idx, 1);
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

async function uploadToServer(blob, filename) {
    const res = await fetch(API + '/upload', {
        method: 'POST',
        headers: { 'X-Filename': encodeURIComponent(filename) },
        body: blob
    });
    const json = await res.json();
    if (json.url) return json.url;
    throw new Error(json.error || 'Upload failed');
}

async function handleFiles(files) {
    for (const f of Array.from(files)) {
        if (!f.type.startsWith('image/') && !f.type.startsWith('video/')) {
            toast('Chỉ hỗ trợ ảnh hoặc video!', 'error');
            continue;
        }

        if (f.type.startsWith('video/')) {
            if (f.size > 20 * 1024 * 1024) {
                toast('Video tối đa 20MB!', 'error');
                continue;
            }
            const ok = await new Promise(resolve => {
                const url = URL.createObjectURL(f);
                const video = document.createElement('video');
                video.preload = 'metadata';
                video.onloadedmetadata = () => {
                    URL.revokeObjectURL(url);
                    if (video.duration > 15) {
                        toast('Video tối đa 15 giây! (' + Math.round(video.duration) + 's)', 'error');
                        resolve(false);
                    } else { resolve(true); }
                };
                video.src = url;
            });
            if (!ok) continue;

            if (isServer) {
                try {
                    const url = await uploadToServer(f, f.name || 'video.mp4');
                    bugAttachments.push(url);
                } catch (e) { toast('Upload video lỗi!', 'error'); continue; }
            } else {
                const dataUrl = await new Promise(resolve => {
                    const reader = new FileReader();
                    reader.onload = e => resolve(e.target.result);
                    reader.readAsDataURL(f);
                });
                const fileId = FileStore.generateId();
                await FileStore.save(fileId, dataUrl);
                bugAttachments.push(fileId);
            }
        } else {
            // Compress image
            const compressed = await compressImage(f, 800, 0.6);
            if (isServer) {
                try {
                    const blob = await (await fetch(compressed)).blob();
                    const url = await uploadToServer(blob, f.name || 'image.jpg');
                    bugAttachments.push(url);
                } catch (e) { toast('Upload ảnh lỗi!', 'error'); continue; }
            } else {
                const fileId = FileStore.generateId();
                await FileStore.save(fileId, compressed);
                bugAttachments.push(fileId);
            }
        }
        renderAttachments();
    }
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
    const bug = BugDB.find(id);
    if (bug && bug.attachments) {
        for (const a of bug.attachments) {
            if (a.startsWith('/uploads/') && isServer) {
                fetch(API + '/delete-file', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url: a })
                }).catch(() => {});
            } else if (!a.startsWith('data:') && !a.startsWith('/')) {
                await FileStore.delete(a);
            }
        }
    }
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
    document.getElementById('detail-title').textContent = b.id + ' - ' + b.name;

    let attachHtml = '';
    if (b.attachments && b.attachments.length > 0) {
        const resolved = [];
        for (const ref of b.attachments) {
            if (ref.startsWith('/uploads/')) {
                resolved.push(ref);
            } else if (ref.startsWith('data:')) {
                resolved.push(ref);
            } else {
                const data = await FileStore.get(ref);
                if (data) resolved.push(data);
            }
        }
        if (resolved.length > 0) {
            attachHtml = `<div class="detail-field"><div class="detail-label">Ảnh/Video đính kèm (click để phóng to)</div><div class="attachments" style="margin-top:6px" id="detail-att-container"></div></div>`;
        }
        // Store for lightbox
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

    // Render attachments
    if (window._detailAttachments && window._detailAttachments.length > 0) {
        const container = document.getElementById('detail-att-container');
        if (container) {
            window._detailAttachments.forEach((data, i) => {
                const isVideo = data.startsWith('data:video') || /\.(mp4|webm)$/i.test(data);
                const div = document.createElement('div');
                div.className = 'att-item';
                div.style.cssText = 'width:120px;height:90px;cursor:pointer';
                div.innerHTML = isVideo
                    ? `<video src="${data}" class="att-thumb" style="width:120px;height:90px" muted></video><span class="att-play">▶</span>`
                    : `<img src="${data}" class="att-thumb" style="width:120px;height:90px">`;
                div.addEventListener('click', () => openLightbox(window._detailAttachments, i));
                container.appendChild(div);
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
    document.getElementById('imp-modal-title').textContent = imp ? 'Chỉnh sửa cải tiến' : 'Đề xuất cải tiến';
    document.getElementById('imp-edit-id').value = imp ? imp.id : '';
    document.getElementById('imp-name').value = imp ? imp.name : '';
    document.getElementById('imp-desc').value = imp ? (imp.description || '') : '';
    document.getElementById('imp-priority').value = imp ? imp.priority : 'Trung bình';
    document.getElementById('imp-status').value = imp ? imp.status : 'Ý tưởng';
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

function renderImprovements() {
    let imps = ImpDB.get();
    const search = document.getElementById('imp-search').value.toLowerCase();
    const fStatus = document.getElementById('imp-filter-status').value;

    if (search) imps = imps.filter(i => i.name.toLowerCase().includes(search));
    if (fStatus !== 'all') imps = imps.filter(i => i.status === fStatus);

    imps.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const list = document.getElementById('imp-list');
    const empty = document.getElementById('imp-empty');

    if (imps.length === 0) { list.innerHTML = ''; empty.hidden = false; return; }
    empty.hidden = true;

    const icons = { 'Ý tưởng': '💡', 'Đã duyệt': '✅', 'Đang làm': '🔄', 'Đã xử lí': '🎉' };
    const priBadge = { 'Cao': 'badge-critical', 'Trung bình': 'badge-medium', 'Thấp': 'badge-low' };

    list.innerHTML = imps.map(i => `
        <div class="imp-card">
            <div class="imp-icon">${icons[i.status] || '💡'}</div>
            <div class="imp-info">
                <div class="imp-title">${esc(i.name)}</div>
                ${i.description ? `<div class="imp-desc">${esc(i.description)}</div>` : ''}
                <div class="imp-meta">
                    <span class="badge ${priBadge[i.priority] || ''}">${i.priority}</span>
                    <span>${statusBadge(i.status)}</span>
                    ${i.proposer ? `<span>👤 ${esc(i.proposer)}</span>` : ''}
                    ${i.assignee ? `<span>🔧 ${esc(i.assignee)}</span>` : ''}
                    <span>📅 ${fmtDate(i.createdAt)}</span>
                </div>
            </div>
            <div class="imp-actions">
                <button class="btn-icon" onclick="editImp('${i.id}')" title="Sửa">✏️</button>
                <button class="btn-icon danger" onclick="deleteImp('${i.id}')" title="Xóa">🗑️</button>
            </div>
        </div>
    `).join('');
}

document.getElementById('imp-search').addEventListener('input', renderImprovements);
document.getElementById('imp-filter-status').addEventListener('change', renderImprovements);

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
    const bugs = BugDB.get().filter(b => b.status !== 'Đã xử lí');
    const alerts = [];

    bugs.forEach(b => {
        const hrs = hoursOverdue(b);
        if (hrs > 0) {
            const limits = { 'Nghiêm trọng': 24, 'Cao': 48, 'Trung bình': 72, 'Thấp': 168 };
            alerts.push({
                bug: b,
                hours: Math.round(hrs),
                limit: limits[b.severity],
                type: 'overdue'
            });
        }
        if (isDeadlinePassed(b)) {
            const dlHrs = Math.round((Date.now() - new Date(b.deadline).getTime()) / 3600000);
            alerts.push({
                bug: b,
                hours: dlHrs,
                type: 'deadline'
            });
        }
    });

    // Deduplicate by bug id
    const seen = new Set();
    const unique = alerts.filter(a => {
        if (seen.has(a.bug.id)) return false;
        seen.add(a.bug.id);
        return true;
    });

    unique.sort((a, b) => b.hours - a.hours);

    const list = document.getElementById('alert-list');
    const empty = document.getElementById('alert-empty');

    if (unique.length === 0) { list.innerHTML = ''; empty.hidden = false; return; }
    empty.hidden = true;

    list.innerHTML = unique.map(a => {
        const isCritical = a.bug.severity === 'Nghiêm trọng' || a.bug.severity === 'Cao';
        return `<div class="alert-item ${isCritical ? '' : 'warn'}">
            <div class="alert-icon">${isCritical ? '🔴' : '🟡'}</div>
            <div class="alert-info">
                <div class="alert-title">${a.bug.id} - ${esc(a.bug.name)}</div>
                <div class="alert-desc">${severityBadge(a.bug.severity)} · ${statusBadge(a.bug.status)} · Dev: ${esc(a.bug.assignee || 'Chưa phân công')}</div>
            </div>
            <div class="alert-time">Quá ${a.hours}h</div>
            <button class="btn-icon" onclick="editBug('${a.bug.id}')" title="Xử lý">⚡</button>
        </div>`;
    }).join('');

    updateAlertBadge();
}

function updateAlertBadge() {
    const bugs = BugDB.get().filter(b => b.status !== 'Đã xử lí');
    const count = bugs.filter(b => isOverdue(b) || isDeadlinePassed(b)).length;
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
document.getElementById('import-file').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
        try {
            const data = JSON.parse(ev.target.result);
            if (data.bugs) BugDB.save(data.bugs);
            if (data.improvements) ImpDB.save(data.improvements);
            toast('Đã nhập dữ liệu!', 'success');
            renderDashboard();
            refreshDeviceSummaryIfActive();
        } catch { toast('File không hợp lệ!', 'error'); }
    };
    reader.readAsText(file);
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

// ===== DEV LIST =====
const DEV_DEFAULTS = ['Quang', 'Tùng', 'Hoàng'];
const DevListDB = {
    KEY: 'bt_dev_list',
    get() { return JSON.parse(localStorage.getItem(this.KEY) || '[]'); },
    save(d) { localStorage.setItem(this.KEY, JSON.stringify([...new Set(d)].filter(Boolean).sort())); },
    add(name) {
        if (!name) return;
        const list = this.get();
        if (!list.includes(name)) { list.push(name); this.save(list); }
    },
    remove(name) { this.save(this.get().filter(n => n !== name)); },
    getAll() {
        return [...new Set([...DEV_DEFAULTS, ...this.get()])].sort();
    }
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

// ===== REPORTER LIST =====
const REPORTER_DEFAULTS = ['Tiến', 'Thùy', 'Thắng'];
const ReporterDB = {
    KEY: 'bt_reporter_list',
    get() { return JSON.parse(localStorage.getItem(this.KEY) || '[]'); },
    save(d) { localStorage.setItem(this.KEY, JSON.stringify([...new Set(d)].filter(Boolean).sort())); },
    add(name) {
        if (!name) return;
        const list = this.get();
        if (!list.includes(name)) { list.push(name); this.save(list); }
    },
    remove(name) { this.save(this.get().filter(n => n !== name)); },
    getAll() { return [...new Set([...REPORTER_DEFAULTS, ...this.get()])].sort(); }
};

// ===== BUG TYPE LIST =====
const BugTypeDB = {
    KEY: 'bt_bug_types',
    ICONS: { 'Giao diện': '🎨', 'Logic': '⚙️', 'Hiệu năng': '⚡', 'Sập ứng dụng': '💥', 'Khác': '📎' },
    get() {
        const saved = JSON.parse(localStorage.getItem(this.KEY) || 'null');
        if (saved) return saved;
        return ['Giao diện', 'Logic', 'Hiệu năng', 'Sập ứng dụng', 'Khác'];
    },
    save(d) { localStorage.setItem(this.KEY, JSON.stringify(d)); },
    add(name) {
        const list = this.get();
        if (!list.includes(name)) { list.push(name); this.save(list); }
    },
    remove(name) {
        this.save(this.get().filter(n => n !== name));
    },
    getIcon(name) { return this.ICONS[name] || '🏷️'; },
    setIcon(name, icon) { this.ICONS[name] = icon; }
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


// ===== DEVICE SUMMARY =====
function refreshDeviceSummaryIfActive() {
    const page = document.getElementById('page-device-summary');
    if (page && page.classList.contains('active')) renderDeviceSummary();
}

document.getElementById('ds-product-select').addEventListener('change', function() {
    ProductDB.setActive(this.value);
    renderProductSelect();
    renderDeviceSummary();
});

function renderDeviceSummary() {
    // Sync product selector
    const products = ProductDB.get();
    const active = ProductDB.getActive();
    const dsSel = document.getElementById('ds-product-select');
    dsSel.innerHTML = products.map(p => `<option value="${esc(p)}" ${p===active?'selected':''}>${esc(p)}</option>`).join('');

    const bugs = BugDB.get();

    // Group by device (module)
    const deviceMap = {};
    bugs.forEach(b => {
        const dev = b.module || 'All';
        if (!deviceMap[dev]) deviceMap[dev] = [];
        deviceMap[dev].push(b);
    });

    const devices = Object.keys(deviceMap).sort();

    // Device detail cards
    const devicesEl = document.getElementById('ds-devices');
    devicesEl.innerHTML = devices.map(dev => {
        const devBugs = deviceMap[dev];
        const total = devBugs.length;
        const done = devBugs.filter(b => b.status === 'Đã xử lí').length;
        const rate = total > 0 ? Math.round(done / total * 100) : 0;

        // Sort: unfinished first (critical → medium → low), then finished
        const statusOrder = { 'Chưa có P.A': 0, 'Đang xử lí': 1, 'Đã xử lí': 2 };
        const sevOrder = { 'Nghiêm trọng': 0, 'Trung bình': 1, 'Thấp': 2 };
        devBugs.sort((a, b) => {
            const sa = statusOrder[a.status] ?? 9;
            const sb = statusOrder[b.status] ?? 9;
            if (sa !== sb) return sa - sb;
            return (sevOrder[a.severity] ?? 9) - (sevOrder[b.severity] ?? 9);
        });

        const items = devBugs.map((b, idx) => {
            const isDone = b.status === 'Đã xử lí';

            // Severity tag
            const sevClass = b.severity === 'Nghiêm trọng' ? 'ds-tag-sev-critical' : b.severity === 'Trung bình' ? 'ds-tag-sev-medium' : 'ds-tag-sev-low';

            // Status tag
            const stClass = 'ds-tag-st-' + statusColor(b.status);

            // Action text
            let actionHtml = '';
            if (isDone) {
                actionHtml = `<span class="ds-bug-action ds-bug-action-done">✅ Đã xử lý</span>`;
            } else if (b.status === 'Đang xử lí' && b.assignee) {
                actionHtml = `<span class="ds-bug-action ds-bug-action-progress">🔄 ${esc(b.assignee)}</span>`;
            } else if (b.status === 'Chưa có P.A') {
                actionHtml = `<span class="ds-bug-action ds-bug-action-noplan">❌ Cần PA</span>`;
            } else if (b.assignee) {
                actionHtml = `<span class="ds-bug-action ds-bug-action-assigned">👤 ${esc(b.assignee)}</span>`;
            } else {
                actionHtml = `<span class="ds-bug-action ds-bug-action-none">⏳ Chưa giao</span>`;
            }

            // Result
            let resultHtml = '';
            if (isDone) {
                const cd = b.completedDate ? fmtDate(b.completedDate) : fmtDate(b.updatedAt);
                resultHtml = `<span class="ds-bug-result">✅ ${cd}</span>`;
            }

            // Note
            const noteHtml = b.devNote ? `<div class="ds-bug-note">💬 ${esc(b.devNote)}</div>` : '';

            return `<div class="ds-bug-item ${isDone ? 'ds-bug-done' : ''}" onclick="showDetail('${b.id}')">
                <div class="ds-bug-main">
                    <span class="ds-bug-stt">${idx + 1}</span>
                    <div class="ds-bug-info">
                        <div class="ds-bug-name">${esc(b.name)}</div>
                        <div class="ds-bug-tags">
                            <span class="ds-tag ${sevClass}">${esc(b.severity)}</span>
                            <span class="ds-tag ds-tag-status ${stClass}">${esc(b.status)}</span>
                            ${b.reporter ? `<span class="ds-tag ds-tag-reporter">👤 ${esc(b.reporter)}</span>` : ''}
                            <span class="ds-tag ds-tag-date">📅 ${b.foundDate ? fmtDate(b.foundDate) : fmtDate(b.createdAt)}</span>
                        </div>
                    </div>
                </div>
                <div class="ds-bug-right">
                    ${actionHtml}
                    ${resultHtml}
                </div>
                ${noteHtml}
            </div>`;
        }).join('');

        const rateColor = rate >= 70 ? '#10b981' : rate >= 40 ? '#d97706' : '#ef4444';

        return `<div class="ds-device-card" id="ds-device-${esc(dev)}">
            <div class="ds-device-header">
                <div class="ds-device-left">
                    <span>📱</span>
                    <h3>${esc(dev)}</h3>
                    <span class="ds-device-count">${total} lỗi</span>
                </div>
                <div class="ds-device-right">
                    <div class="ds-device-bar-wrap">
                        <div class="ds-device-bar"><div class="ds-device-bar-fill" style="width:${rate}%;background:${rateColor}"></div></div>
                    </div>
                    <span class="ds-device-rate" style="color:${rateColor}">${done}/${total} (${rate}%)</span>
                </div>
            </div>
            <div class="ds-bug-list">${items}</div>
        </div>`;
    }).join('') || '';
}

// ===== INIT & MIGRATE =====
(async function init() {
    // 0. Load data từ server trước (nếu có)
    await DataSync.load();

    // 1. Dev mặc định
    ['Quang', 'Tùng', 'Hoàng'].forEach(d => DevListDB.add(d));
    ['Tiến', 'Thùy', 'Thắng'].forEach(d => ReporterDB.add(d));
    ['Dev A', 'A'].forEach(d => DevListDB.remove(d));

    // 2. Product hợp lệ
    const prods = ProductDB.get();
    const active = ProductDB.getActive();
    if (!prods.includes(active)) ProductDB.setActive(prods[0] || 'GemCloudPhone');

    // 3. Migrate ALL bugs (dùng getAll, không filter product)
    const statusMap = {
        'New': 'Đang xử lí', 'In Progress': 'Đang xử lí', 'Testing': 'Chưa có P.A', 'Done': 'Đã xử lí',
        'Reopen': 'Đang xử lí', 'Mới': 'Đang xử lí', 'Mở lại': 'Đang xử lí', 'Đang kiểm tra': 'Chưa có P.A',
        // Legacy Vietnamese statuses (4 trạng thái cũ → 3 trạng thái mới)
        'Thông báo': 'Đang xử lí', 'Đang xử lý': 'Đang xử lí', 'Hoàn thành': 'Đã xử lí', 'Chưa có phương án': 'Chưa có P.A'
    };
    const sevMap = { 'Critical': 'Nghiêm trọng', 'High': 'Nghiêm trọng', 'Medium': 'Nghiêm trọng', 'Low': 'Thấp', 'Cao': 'Nghiêm trọng', 'Trung bình': 'Nghiêm trọng' };
    const typeMap = { 'UI': 'Giao diện', 'Performance': 'Hiệu năng', 'Crash': 'Sập ứng dụng', 'Other': 'Khác' };

    const allBugs = BugDB.getAll();
    allBugs.forEach(b => {
        if (!b.product) b.product = 'GemCloudPhone';
        if (statusMap[b.status]) b.status = statusMap[b.status];
        if (sevMap[b.severity]) b.severity = sevMap[b.severity];
        if (typeMap[b.type]) b.type = typeMap[b.type];
        if (b.status === 'Đã xử lí' && !b.completedDate) b.completedDate = b.updatedAt || b.createdAt;
    });
    BugDB.save(allBugs);

    // 4. Migrate improvements
    const impStatusMap = { 'Idea': 'Ý tưởng', 'Approved': 'Đã duyệt', 'Doing': 'Đang làm', 'Done': 'Đã xử lí' };
    const priMap = { 'High': 'Cao', 'Medium': 'Trung bình', 'Low': 'Thấp' };
    const imps = ImpDB.get();
    imps.forEach(i => {
        if (impStatusMap[i.status]) i.status = impStatusMap[i.status];
        if (priMap[i.priority]) i.priority = priMap[i.priority];
    });
    ImpDB.save(imps);

    // 5. Render
    renderProductSelect();
    renderDevDatalist();
    console.log('[INIT] Active:', ProductDB.getActive(), '| All bugs:', BugDB.getAll().length, '| Filtered:', BugDB.get().length);
    renderDashboard();

    // 6. Tự động cập nhật data mỗi 10 giây
    DataSync.startAutoRefresh(10000);

    // 7. Migrate: chuyển attachment cũ (IndexedDB fileId) lên server
    if (isServer) {
        const migrateAllBugs = BugDB.getAll();
        let migrated = false;
        for (const bug of migrateAllBugs) {
            if (!bug.attachments || bug.attachments.length === 0) continue;
            const newAtts = [];
            for (const ref of bug.attachments) {
                if (ref.startsWith('/uploads/') || ref.startsWith('data:')) {
                    newAtts.push(ref);
                    continue;
                }
                // Legacy IndexedDB fileId → tải từ IndexedDB rồi upload lên server
                try {
                    const dataUrl = await FileStore.get(ref);
                    if (!dataUrl) {
                        console.warn('[Migrate] Không tìm thấy file trong IndexedDB:', ref, '- bỏ qua');
                        continue;
                    }
                    const blob = await (await fetch(dataUrl)).blob();
                    const ext = dataUrl.startsWith('data:video') ? '.mp4' : '.jpg';
                    const url = await uploadToServer(blob, ref + ext);
                    newAtts.push(url);
                    migrated = true;
                    console.log('[Migrate] Đã chuyển', ref, '→', url);
                } catch (e) {
                    console.warn('[Migrate] Lỗi migrate file:', ref, e);
                }
            }
            bug.attachments = newAtts;
        }
        if (migrated) {
            BugDB.save(migrateAllBugs);
            renderDashboard();
            toast('🔄 Đã chuyển ảnh/video cũ lên server!', 'success');
        }
    }
})();
