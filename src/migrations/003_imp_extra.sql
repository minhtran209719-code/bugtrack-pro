-- Thêm 2 cột cho improvements để khớp pattern với bug:
--   completed_date: ngày xử lí xong (set khi status = 'Đã xong')
--   dev_note:       ghi chú của người xử lí
ALTER TABLE improvements ADD COLUMN completed_date TEXT;
ALTER TABLE improvements ADD COLUMN dev_note TEXT;
