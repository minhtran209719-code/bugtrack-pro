# BugTrack Pro — Hướng dẫn cho Claude Code

> File này commit vào git, share cho mọi dev cùng dùng Claude Code trong dự án này.

## Tổng quan
Web app quản lý lỗi & cải tiến sản phẩm, UI tiếng Việt. Vanilla JS FE + Node BE.

**Đối tượng:** Support tạo bug → Dev xử lý. Team chia sẻ qua LAN hoặc datacenter Ubuntu.

**Hai giai đoạn của codebase:**
- **Legacy (`server.js` ở root + `data.json`):** code MVP, vanilla JS không framework, không npm dep. Vẫn chạy được.
- **v2 (`src/` + SQLite):** đang refactor sang kiến trúc có 8 seam để scale tới 10k bug, đa team, SaaS sau này. Phải đọc mục "Architecture seams" bên dưới TRƯỚC khi sửa code trong `src/`.

## ⚠️ 8 Architecture Seams — KHÔNG được bypass

Mỗi seam là 1 ranh giới được đặt CỐ Ý để tương lai migrate không phải đập đi làm lại. Vi phạm 1 seam = phá compat của giai đoạn sau.

| # | Seam | Vị trí | Quy tắc bất biến |
|---|------|--------|------------------|
| 1 | **DAL** | `src/db/*.js` | Mọi SQL nằm ở đây. Handler/middleware KHÔNG `require('better-sqlite3')` trực tiếp. Đổi DB → sửa file này, không sửa handler. |
| 2 | **SQL chuẩn ANSI** | `src/migrations/*.sql` | Tránh AUTOINCREMENT, WITHOUT ROWID, STRICT (SQLite-only). Boolean = INTEGER 0/1. Để pgloader chuyển Postgres không vướng. |
| 3 | **workspace_id mọi bảng** | schema | Mọi bảng business có `workspace_id TEXT NOT NULL DEFAULT 'default'`. Mọi DAL function NHẬN `workspace_id` ở **tham số đầu**, KHÔNG default. |
| 4 | **ID = ULID + display_number per workspace** | `src/db/bugs.js`, `improvements.js` | `id` = `'BUG-' + ulid()` lưu nội bộ (globally unique). `display_number` = MAX+1 per workspace, hiển thị UI giữ UX cũ `BUG-0042`. |
| 5 | **API versioning `/api/v1/`** | `src/server.js` | Mọi route mới đặt dưới prefix này. Sau v2 thì v1 vẫn chạy → client cũ không vỡ. |
| 6 | **Storage interface** | `src/storage/index.js` | Handler chỉ gọi `storage.save/delete/readStream`, KHÔNG `fs` thẳng. Đổi local → S3 = đổi env `STORAGE_DRIVER`, code không sửa. |
| 7 | **Config qua env** | `src/config/index.js` + `.env` | KHÔNG hardcode hằng số (PORT, đường dẫn, secret). Đổi môi trường = đổi `.env`. |
| 8 | **Structured logging** | `src/logger.js` (pino) | Logic dùng `logger.info({ event, ...meta })`, KHÔNG `console.log`. Output JSON line, ship Loki/ELK dễ. |

**Seam bổ sung (chưa implement, có chỗ trống):**
- **A. Auth middleware** (`src/middleware/auth.js`): stub trả `workspace='default'`. Bật JWT ở giai đoạn 2, **không sửa handler**.
- **B. Domain events** (`src/events/index.js`): emit `bug.created` etc. Subscriber thêm sau (email, Slack, webhook) **không đụng logic chính**.
- **C. Audit log** (`src/db/auditLog.js`): bảng có sẵn, chỉ ghi khi `AUDIT_ENABLED=true`.
- **D. Migration framework** (`src/migrations/runner.js`): mỗi schema change = 1 file `NNN_*.sql`, idempotent, có bảng `schema_migrations`.

## Lộ trình giai đoạn (đừng phá lộ trình này)

| Giai đoạn | Scope | Đã chuẩn bị |
|-----------|-------|-------------|
| 1 (hiện tại) | Internal team, 10k bugs, datacenter Ubuntu | SQLite + WAL + 8 seam |
| 2 | Public Internet, JWT auth, email notify | Stub auth + events đã có |
| 3 | Multi-tenant SaaS | `workspace_id` + ULID đã sẵn |
| 4 | Postgres + S3 + scale lớn | DAL + storage interface đã sẵn |

Mỗi bước nhảy chỉ thay 1 lớp. KHÔNG được làm "tiện thể refactor luôn cho đẹp" — sẽ phá lộ trình.

## Stack
**Legacy (root):**
- FE: `index.html` + `app.js` + `style.css` (vanilla).
- BE: `server.js` (Node core, không dependency).
- DB: `data.json`.

**v2 (`src/` + npm dep tối thiểu):**
- BE: `src/server.js` (entry mỏng) → `src/db/` (DAL) → `better-sqlite3` (WAL mode).
- File: `src/storage/` interface (local hôm nay, S3 sau).
- Config: `src/config/` + `.env`.
- Log: `src/logger.js` (pino JSON).
- Migration: `src/migrations/runner.js` + file `NNN_*.sql`.
- Dependencies: `better-sqlite3`, `dotenv`, `pino`, `ulid`. KHÔNG thêm Express/ORM.

**Layout `src/`:**
```
src/
├── config/index.js          # env loader (Seam #7)
├── logger.js                # pino (Seam #8)
├── db/
│   ├── index.js             # connection + DAL re-export (Seam #1)
│   ├── bugs.js              # workspace_id ở tham số đầu (Seam #3, #4)
│   ├── improvements.js
│   ├── meta.js              # products, devList, ...
│   └── auditLog.js          # ghi khi AUDIT_ENABLED=true (Seam #C)
├── storage/
│   ├── index.js             # facade theo STORAGE_DRIVER (Seam #6)
│   ├── local.js             # filesystem
│   └── s3.js                # stub giai đoạn 4
├── middleware/
│   └── auth.js              # stub giai đoạn 1, JWT giai đoạn 2 (Seam #A)
├── events/
│   └── index.js             # bus + audit subscriber (Seam #B)
├── migrations/
│   ├── runner.js            # `npm run migrate` (Seam #D)
│   ├── 001_init.sql         # schema baseline ANSI (Seam #2)
│   └── 002_legacy_import.js # import data.json → SQLite 1 lần
└── server.js                # HTTP entry, route /api/v1/... (Seam #5)
```

## Cấu trúc app.js (theo thứ tự đọc)
1. `DataSync` (~L8) — load/sync server, auto refresh poll 10s.
2. `FileStore` (~L93) — IndexedDB legacy.
3. `ProductDB` (~L155), `BugDB` (~L235), `ImpDB` (~L306) — CRUD.
4. Utils (~L344): `toast`, `esc`, `fmtDate`, `hoursOverdue`, badges.
5. Render: `renderDashboard`, `renderBugTable`, `renderImprovements`, `renderAlerts`, `renderDeviceSummary`, `renderDevTable`, `renderSupportTable`.
6. Modal: `openBugModal`, `openImpModal`, `showDetail`, lightbox.
7. File: `compressImage`, `uploadToServer`, `handleFiles` (paste/drag-drop).
8. `init()` IIFE cuối file — load + migrate + render + start auto refresh.

## Server API (server.js)
| Endpoint | Method | Ghi chú |
|----------|--------|---------|
| `/api/data` | GET/POST | Đọc/ghi đè toàn bộ DB |
| `/api/sync` | POST | **Merge by id+updatedAt** cho mảng có id; ghi đè mảng khác |
| `/api/delete-item` | POST | `{type, id}` — xoá 1 item, không gửi cả mảng |
| `/api/upload` | POST | raw bytes, header `X-Filename`, max 25MB |
| `/api/delete-file` | POST | `{url}` — validate path traversal |

**Body limit:** 50MB JSON, 25MB upload. **CORS:** `*`. **Auth:** không có.

## Sync strategy
- **Write:** debounce 300ms per-key (`DataSync.syncToServer`). Mỗi key timer riêng — không cancel lẫn nhau.
- **Read:** poll `/api/data` mỗi 10s; so sánh JSON.stringify với localStorage; khác → re-render hết + toast.
- **Skip poll khi modal mở** (`!m.hidden`) — tránh ghi đè input user.
- **Delete riêng:** không sync mảng đã filter (sẽ ghi đè data máy khác); gọi `/api/delete-item`.

## Data model
**Top-level `data.json`:** `bugs`, `improvements`, `products`, `devList`, `reporterList`, `bugTypes`, `activeProduct`.

**Bug:**
```
id: 'BUG-XXXX' (auto), product, name, description,
type: 'Giao diện'|'Logic'|'Hiệu năng'|'Sập ứng dụng'|'Khác',
severity: 'Nghiêm trọng'|'Thấp',          // CHỈ 2 mức
status: 'Đang xử lí'|'Đã xử lí'|'Chưa có P.A',  // CHỈ 3 trạng thái
module, reporter, assignee, foundDate, deadline, completedDate,
testStatus, supportNote, devNote,
attachments: string[],                     // '/uploads/xxx' | 'data:...' | 'file_xxx' (IndexedDB legacy)
createdAt, updatedAt, history: [{time, action, detail}]
```

**Improvement:** `IMP-XXXX`, priority `Cao|Trung bình|Thấp`, status `Ý tưởng|Đã duyệt|Đang làm|Hoàn thành`.

**SLA giờ quá hạn (severity → giờ):** `Nghiêm trọng:24, Cao:48, Trung bình:72, Thấp:168`. Tính từ `createdAt`. Đã xử lí → 0.

## Bảng quản lý lỗi: 2 nhóm cột
- **Support điền (7):** STT | Tên lỗi | Mô tả | Ngày TT | Người TT | TT Test | Ghi chú TT
- **Dev điền (5):** Người xử lý | Trạng thái | Ngày XL | Ghi chú XL | (action)

KHÔNG trộn 2 nhóm khi thêm field.

## Inline edit (Dev không cần mở modal)
Dropdown trong bug table → `_bindSimpleSelect(menu, bugId, field, btn)` → gọi `BugDB.update(id, {field: value})` → tự push history + updatedAt + sync.

## ⚠️ Gotchas — đọc TRƯỚC khi sửa code

1. **KHÔNG `BugDB.save([])`** — guard ở app.js block save mảng rỗng (tránh 1 client lỗi state ghi đè data team). Cần clear → loop `delete(id)`.

2. **KHÔNG sync mảng khi delete** — phải `/api/delete-item`. Sync mảng filter sẽ xoá bug máy khác vừa thêm.

3. **Poll auto-refresh BỎ QUA khi modal mở** — đừng hack hidden để giữ data, dùng flag riêng.

4. **Enum tiếng Việt: `'Đang xử lí'` (i ngắn, KHÔNG phải `'Đang xử lý'`)**. Migration map cả hai về `'Đang xử lí'`. Convention đã chốt — thay sẽ phá filter.

5. **Severity chỉ 2 mức `Nghiêm trọng|Thấp`** — đã gộp từ 4. SLA map vẫn còn 4 mức để tương thích migration cũ.

6. **Attachment 3 loại prefix:** `/uploads/`, `data:`, `file_` (IndexedDB). Render phải check prefix.

7. **`product` bắt buộc** — `BugDB.add` tự gán `ProductDB.getActive()`. Bug thiếu product → init migration gán `'GemCloudPhone'`.

8. **KHÔNG `DOMContentLoaded`** — script ở cuối `<body>`, DOM sẵn, bind event top-level.

9. **KHÔNG thêm npm dependency, KHÔNG đề xuất Express/React/Vue, KHÔNG tách app.js.** Single-file là chủ ý.

10. **Server không auth, CORS `*`** — chỉ chạy LAN tin cậy. Đừng expose Internet trần.

11. **`fs.writeFileSync` đồng bộ** — concurrent write 2 request gần nhau có thể race; team nhỏ chấp nhận được.

12. **Khi grep enum dùng đúng dấu tiếng Việt** (`'Đang xử lí'` không phải `'dang xu li'`).

## Migration legacy (chạy ở init)
- Status EN/cũ → mới: `New/In Progress/Mở lại/Đang xử lý → Đang xử lí`; `Done/Hoàn thành → Đã xử lí`; `Testing/Chưa có phương án → Chưa có P.A`.
- Severity: `Critical/High/Medium/Cao/Trung bình → Nghiêm trọng`; `Low → Thấp`.
- Type: `UI→Giao diện, Performance→Hiệu năng, Crash→Sập ứng dụng, Other→Khác`.
- Bug thiếu `product` → `GemCloudPhone`.
- Bug `Đã xử lí` thiếu `completedDate` → set = `updatedAt`.
- Attachment IndexedDB → upload server → thay bằng URL `/uploads/...`.

## Convention sửa code
- Thêm field: xác định Support hay Dev → cột nào → render fn nào.
- Thêm enum: đồng bộ `severityBadge`/`statusColor`/`statusBadge`/`typeBadge` + `<select>` filter trong `index.html`.
- Update bug: dùng `BugDB.update(id, data)` (tự history + updatedAt), KHÔNG `Object.assign` thẳng.
- ID mới: `BugDB.nextId()` / `ImpDB.nextId()`, không tự sinh.
- Re-render sau update: gọi đúng `render*` thay vì reload trang.

## Dev mặc định / Support mặc định
- Dev: `Quang, Tùng, Hoàng`
- Support (reporter): `Tiến, Thùy, Thắng`
- Sản phẩm: `GemCloudPhone, GemLogin`
