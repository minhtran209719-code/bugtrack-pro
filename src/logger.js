// Seam #8: Structured logging. Mọi log qua đây, KHÔNG dùng console.log trong logic.
// Output JSON line — dễ ship sang Loki/ELK/Datadog ở giai đoạn 2+.

const pino = require('pino');
const config = require('./config');

const logger = pino({
    level: config.logLevel,
    base: { service: 'bugtrack', env: config.env },
    timestamp: pino.stdTimeFunctions.isoTime,
});

module.exports = logger;
