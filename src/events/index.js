// Seam #B: Domain events. Logic chính emit, không quan tâm ai nghe.
// Giai đoạn 1: chỉ subscriber là logger.
// Giai đoạn 2+: thêm subscriber email, Slack, webhook, audit log... mà không sửa logic chính.

const { EventEmitter } = require('events');
const logger = require('../logger');
const auditLog = require('../db/auditLog');

const bus = new EventEmitter();
bus.setMaxListeners(50);

// Subscribers mặc định
bus.on('bug.created',     (e) => logger.info({ event: 'bug.created', ...e.meta },     'bug created'));
bus.on('bug.updated',     (e) => logger.info({ event: 'bug.updated', ...e.meta },     'bug updated'));
bus.on('bug.deleted',     (e) => logger.info({ event: 'bug.deleted', ...e.meta },     'bug deleted'));
bus.on('improvement.created', (e) => logger.info({ event: 'improvement.created', ...e.meta }, 'improvement created'));

// Audit log subscriber (no-op nếu AUDIT_ENABLED=false, kiểm tra trong auditLog.write)
function auditSubscriber(action) {
    return (e) => {
        try {
            auditLog.write({
                workspaceId: e.ctx?.workspace,
                userId: e.ctx?.userId,
                action,
                resourceType: e.resourceType,
                resourceId: e.resourceId,
                payload: e.payload,
            });
        } catch (err) {
            logger.warn({ err: err.message, action }, 'audit log failed');
        }
    };
}

bus.on('improvement.updated', (e) => logger.info({ event: 'improvement.updated', ...e.meta }, 'improvement updated'));
bus.on('improvement.deleted', (e) => logger.info({ event: 'improvement.deleted', ...e.meta }, 'improvement deleted'));

bus.on('bug.created', auditSubscriber('bug.create'));
bus.on('bug.updated', auditSubscriber('bug.update'));
bus.on('bug.deleted', auditSubscriber('bug.delete'));
bus.on('improvement.created', auditSubscriber('improvement.create'));
bus.on('improvement.updated', auditSubscriber('improvement.update'));
bus.on('improvement.deleted', auditSubscriber('improvement.delete'));

// API: emit({ type, ctx, resourceType, resourceId, payload, meta })
function emit(type, payload) {
    bus.emit(type, payload);
}

module.exports = { bus, emit };
