import { randomUUID } from 'node:crypto';

export const id = () => randomUUID();

export function audit(db, actorId, action, entityType, entityId, metadata = {}) {
  db.prepare(`INSERT INTO audit_events(id, actor_id, action, entity_type, entity_id, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?)`).run(id(), actorId ?? null, action, entityType, entityId ?? null, JSON.stringify(metadata));
}

export function notify(db, userId, type, title, body, href = null) {
  db.prepare(`INSERT INTO notifications(id, user_id, type, title, body, href)
    VALUES (?, ?, ?, ?, ?, ?)`).run(id(), userId, type, title, body, href);
}
