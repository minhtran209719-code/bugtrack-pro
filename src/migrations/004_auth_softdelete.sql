-- Migration 004: Soft-delete + attribution (ai tạo / ai nhận / ai xoá). Bật cùng JWT auth (giai đoạn 2).
-- ANSI: ALTER TABLE ADD COLUMN, không default động. Cột NULL = chưa có dữ liệu (tương thích row cũ).

-- ===== BUGS =====
ALTER TABLE bugs ADD COLUMN deleted_at  TEXT;   -- ISO timestamp khi xoá mềm; NULL = đang hoạt động
ALTER TABLE bugs ADD COLUMN deleted_by  TEXT;   -- user_id người xoá
ALTER TABLE bugs ADD COLUMN created_by  TEXT;   -- user_id người tạo
ALTER TABLE bugs ADD COLUMN assigned_by TEXT;   -- user_id người gán assignee gần nhất ("nhận bởi ai")
ALTER TABLE bugs ADD COLUMN assigned_at TEXT;   -- thời điểm gán assignee gần nhất

-- ===== IMPROVEMENTS =====
ALTER TABLE improvements ADD COLUMN deleted_at  TEXT;
ALTER TABLE improvements ADD COLUMN deleted_by  TEXT;
ALTER TABLE improvements ADD COLUMN created_by  TEXT;
ALTER TABLE improvements ADD COLUMN assigned_by TEXT;
ALTER TABLE improvements ADD COLUMN assigned_at TEXT;

-- Index lọc nhanh row chưa xoá (mọi read path dùng deleted_at IS NULL)
CREATE INDEX IF NOT EXISTS idx_bugs_ws_deleted ON bugs(workspace_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_imp_ws_deleted  ON improvements(workspace_id, deleted_at);
