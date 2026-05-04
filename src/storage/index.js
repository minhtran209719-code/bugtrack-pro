// Seam #6: Storage interface. Handler chỉ gọi storage.save/delete/readStream,
// KHÔNG gọi fs/AWS SDK trực tiếp. Đổi local → S3 (giai đoạn 4) chỉ tốn 1 env var.

const config = require('../config');

let impl;
switch (config.storage.driver) {
    case 'local': impl = require('./local'); break;
    case 's3':    impl = require('./s3');    break;
    default: throw new Error(`Unsupported storage driver: ${config.storage.driver}`);
}

// Contract (mọi backend phải implement):
//   async save(buffer, originalName) → { url, size }
//   async delete(url) → void
//   readStream(url) → ReadableStream
//   resolveUrl(url) → URL public (cho FE render)
module.exports = impl;
