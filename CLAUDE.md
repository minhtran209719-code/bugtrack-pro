# BugTrack Pro — Hướng dẫn cho Claude Code

> File này commit vào git, share cho mọi dev cùng dùng Claude Code trong dự án này.

## Tổng quan
Web app quản lý lỗi & cải tiến sản phẩm, UI tiếng Việt. Vanilla JS + Node `http` server, **không framework, không build step, không npm dependency**. Mở `node server.js` là chạy.

**Đối tượng:** Support tạo bug → Dev xử lý. Team chia sẻ qua LAN (`0.0.0.0:3000`).

## Stack
- FE: `index.html` + `app.js` (~2.2k dòng, single-file) + `style.css`.
- BE: `server.js` (~200 dòng, chỉ dùng Node core: `http`, `fs`, `path`, `crypto`).
- DB: `data.json` ở root.
- File upload: `uploads/` (mới) + IndexedDB browser (legacy, đang migrate).

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
