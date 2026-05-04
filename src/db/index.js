// DAL entry — re-export từ các module con để handler chỉ require('./db') 1 chỗ.
// Connection (open/close) ở `connection.js` tránh circular dep.

const { open, close } = require('./connection');

module.exports = {
    open,
    close,
    get db() { return open(); },
    bugs: require('./bugs'),
    improvements: require('./improvements'),
    meta: require('./meta'),
    auditLog: require('./auditLog'),
};
