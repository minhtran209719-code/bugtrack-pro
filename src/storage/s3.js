// Storage backend: S3 / S3-compatible (MinIO, Backblaze, R2, ...).
// Stub cho giai đoạn 4. KHÔNG dùng cho tới khi config.storage.driver = 's3'.

// Cài thêm dependency khi enable:
//   npm i @aws-sdk/client-s3 @aws-sdk/s3-request-presigner

module.exports = {
    async save(buffer, originalName) {
        throw new Error('TODO giai đoạn 4: implement S3.save');
    },
    async delete(url) {
        throw new Error('TODO giai đoạn 4: implement S3.delete');
    },
    readStream(url) {
        throw new Error('TODO giai đoạn 4: implement S3.readStream');
    },
    resolveUrl(url) {
        // Trả presigned URL hoặc public CDN URL.
        throw new Error('TODO giai đoạn 4: implement S3.resolveUrl');
    },
};
