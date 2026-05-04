# Deploy

```bash
# 1. Code + deps
git clone <repo> /opt/bugtrack && cd /opt/bugtrack
npm install --omit=dev
cp .env.example .env  # sửa nếu cần

# 2. Migrate DB
node src/migrations/runner.js
# (nếu có data.json cũ): node src/migrations/002_legacy_import.js

# 3. PM2
pm2 start deploy/ecosystem.config.js
pm2 save && pm2 startup    # auto-start khi boot

# 4. Nginx
cp deploy/nginx.conf /etc/nginx/sites-available/bugtrack
ln -s /etc/nginx/sites-available/bugtrack /etc/nginx/sites-enabled/
# sửa server_name + bật cert: certbot --nginx -d <domain>
nginx -t && systemctl reload nginx
```

## Files

- [`nginx.conf`](nginx.conf) — reverse proxy + 500MB body + cache static
- [`ecosystem.config.js`](ecosystem.config.js) — PM2 config
- [`scripts/cleanup-orphans.js`](scripts/cleanup-orphans.js) — xoá file `uploads/` không tham chiếu (chạy weekly tuỳ ý)

## Lệnh thường dùng

```bash
pm2 logs bugtrack          # log
pm2 restart bugtrack       # restart
curl localhost:3000/api/health
sqlite3 data.db
```
