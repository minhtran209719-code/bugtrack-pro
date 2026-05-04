-- Migration 001: Schema khởi đầu.
-- Quy tắc: SQL chuẩn ANSI để pgloader migrate sang Postgres ở giai đoạn 4 không vướng.
-- Tránh AUTOINCREMENT, WITHOUT ROWID, STRICT (SQLite-only).
-- Boolean dùng INTEGER 0/1.

-- ============ BUGS ============
CREATE TABLE IF NOT EXISTS bugs (
    id              TEXT    PRIMARY KEY,                 -- ULID-based, vd 'BUG-01HXYZ...'
    workspace_id    TEXT    NOT NULL DEFAULT 'default',
    display_number  INTEGER NOT NULL,                    -- Hiển thị 'BUG-0042', unique per workspace
    product         TEXT    NOT NULL,
    name            TEXT    NOT NULL,
    description     TEXT,
    type            TEXT,                                -- 'Giao diện' | 'Logic' | 'Hiệu năng' | 'Sập ứng dụng' | 'Khác'
    severity        TEXT,                                -- 'Nghiêm trọng' | 'Thấp'
    status          TEXT,                                -- 'Đang xử lí' | 'Đã xử lí' | 'Chưa có P.A'
    module          TEXT,                                -- Tên thiết bị
    reporter        TEXT,
    assignee        TEXT,
    test_status     TEXT,                                -- 'Chưa test' | 'Chờ test' | 'Đã test'
    support_note    TEXT,
    dev_note        TEXT,
    found_date      TEXT,                                -- ISO date
    deadline        TEXT,
    completed_date  TEXT,
    attachments     TEXT    NOT NULL DEFAULT '[]',       -- JSON array URL
    history         TEXT    NOT NULL DEFAULT '[]',       -- JSON array { time, action, detail }
    created_at      TEXT    NOT NULL,                    -- ISO timestamp
    updated_at      TEXT    NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_bugs_ws_display ON bugs(workspace_id, display_number);
CREATE INDEX IF NOT EXISTS idx_bugs_ws_product   ON bugs(workspace_id, product);
CREATE INDEX IF NOT EXISTS idx_bugs_ws_status    ON bugs(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_bugs_ws_assignee  ON bugs(workspace_id, assignee);
CREATE INDEX IF NOT EXISTS idx_bugs_ws_reporter  ON bugs(workspace_id, reporter);
CREATE INDEX IF NOT EXISTS idx_bugs_ws_module    ON bugs(workspace_id, module);
CREATE INDEX IF NOT EXISTS idx_bugs_ws_updated   ON bugs(workspace_id, updated_at);

-- ============ IMPROVEMENTS ============
CREATE TABLE IF NOT EXISTS improvements (
    id              TEXT    PRIMARY KEY,                 -- 'IMP-{ulid}'
    workspace_id    TEXT    NOT NULL DEFAULT 'default',
    display_number  INTEGER NOT NULL,
    name            TEXT    NOT NULL,
    description     TEXT,
    priority        TEXT,                                -- 'Cao' | 'Trung bình' | 'Thấp'
    status          TEXT,                                -- 'Ý tưởng' | 'Đã duyệt' | 'Đang làm' | 'Hoàn thành'
    proposer        TEXT,
    assignee        TEXT,
    created_at      TEXT    NOT NULL,
    updated_at      TEXT    NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_imp_ws_display ON improvements(workspace_id, display_number);
CREATE INDEX IF NOT EXISTS idx_imp_ws_status  ON improvements(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_imp_ws_updated ON improvements(workspace_id, updated_at);

-- ============ META (key-value scoped per workspace) ============
-- Giữ products, devList, reporterList, bugTypes, activeProduct.
-- value lưu JSON string.
CREATE TABLE IF NOT EXISTS meta (
    workspace_id    TEXT    NOT NULL,
    key             TEXT    NOT NULL,
    value           TEXT    NOT NULL,
    updated_at      TEXT    NOT NULL,
    PRIMARY KEY (workspace_id, key)
);

-- ============ AUDIT LOG (seam giai đoạn 2+) ============
CREATE TABLE IF NOT EXISTS audit_log (
    id              TEXT    PRIMARY KEY,
    workspace_id    TEXT,
    user_id         TEXT,
    action          TEXT    NOT NULL,                    -- 'bug.create', 'bug.update', 'login', ...
    resource_type   TEXT,
    resource_id     TEXT,
    payload         TEXT,                                -- JSON diff
    created_at      TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_ws_created    ON audit_log(workspace_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_resource      ON audit_log(resource_type, resource_id);

-- ============ USERS (seam giai đoạn 2 — bật khi enable auth) ============
CREATE TABLE IF NOT EXISTS users (
    id              TEXT    PRIMARY KEY,                 -- ULID
    workspace_id    TEXT    NOT NULL DEFAULT 'default',
    email           TEXT    NOT NULL,
    name            TEXT,
    password_hash   TEXT,                                -- bcrypt
    role            TEXT    NOT NULL DEFAULT 'member',   -- 'admin' | 'member' | 'viewer'
    active          INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT    NOT NULL,
    updated_at      TEXT    NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_ws_email ON users(workspace_id, email);

-- ============ WORKSPACES (seam giai đoạn 3 — multi-tenant SaaS) ============
CREATE TABLE IF NOT EXISTS workspaces (
    id              TEXT    PRIMARY KEY,
    name            TEXT    NOT NULL,
    plan            TEXT    NOT NULL DEFAULT 'free',
    created_at      TEXT    NOT NULL,
    updated_at      TEXT    NOT NULL
);

INSERT OR IGNORE INTO workspaces (id, name, plan, created_at, updated_at)
VALUES ('default', 'Default Workspace', 'internal', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
