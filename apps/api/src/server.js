import { randomUUID } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { createApp } from './app.js';
import { readConfig } from './config.js';
import { closeDatabase, migrateDatabase, openDatabase } from './database.js';

const config = readConfig();
const db = openDatabase(config.databasePath);
migrateDatabase(db);
function purgeExpiredImportImages(){
  const expired=db.prepare(`SELECT i.id,i.storage_key,i.draft_id FROM job_import_images i WHERE i.keep_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now')`).all();
  if(!expired.length)return;
  db.exec('BEGIN IMMEDIATE');try{for(const image of expired){const file=`${config.jobImportStoragePath}/${image.storage_key}`;if(existsSync(file)){try{unlinkSync(file);}catch{}}db.prepare('DELETE FROM job_import_images WHERE id=?').run(image.id);}
    const byDraft=new Map();for(const image of expired)byDraft.set(image.draft_id,(byDraft.get(image.draft_id)??0)+1);
    for(const [draftId,count] of byDraft)db.prepare("INSERT INTO audit_events(id,actor_id,action,entity_type,entity_id,metadata_json) VALUES(?,NULL,'job_import.source_images_expired','job_import_draft',?,?)").run(randomUUID(),draftId,JSON.stringify({deletedImageCount:count,retentionDays:30}));db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
}
purgeExpiredImportImages();
const importCleanupTimer=setInterval(purgeExpiredImportImages,6*60*60*1000);importCleanupTimer.unref();
const now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
db.exec('BEGIN IMMEDIATE');
try {
  const expired = db.prepare(`SELECT id,title FROM jobs WHERE status IN ('published','paused') AND expires_at <= ${now}`).all();
  for (const job of expired) {
    db.prepare(`UPDATE jobs SET status='expired',updated_at=${now} WHERE id=?`).run(job.id);
    const requests = db.prepare(`SELECT id,candidate_id,status FROM referral_requests WHERE job_id=? AND status IN ('pending','accepted','candidate_action_needed','employee_action_needed','candidate_reported_applied')`).all(job.id);
    for (const request of requests) {
      db.prepare(`UPDATE referral_requests SET status='expired',updated_at=${now} WHERE id=?`).run(request.id);
      db.prepare(`INSERT INTO referral_status_history(id,request_id,actor_id,from_status,to_status,note) VALUES(?,?,NULL,?,'expired','Listing expired')`).run(randomUUID(),request.id,request.status);
      db.prepare(`INSERT INTO notifications(id,user_id,type,title,body,href) VALUES(?,?,'referral_status','Opportunity expired',?,'/referral-requests/'||?)`).run(randomUUID(),request.candidate_id,`The listing “${job.title}” expired. This request is now closed.`,request.id);
      const employee = db.prepare('SELECT employee_id FROM referral_requests WHERE id=?').get(request.id);
      if (employee) db.prepare(`INSERT INTO notifications(id,user_id,type,title,body,href) VALUES(?,?,'referral_status','Opportunity expired',?,'/referral-requests/'||?)`).run(randomUUID(),employee.employee_id,`The listing “${job.title}” expired. This request is now closed.`,request.id);
    }
    db.prepare(`INSERT INTO audit_events(id,actor_id,action,entity_type,entity_id,metadata_json) VALUES(?,NULL,'job.expired','job',?,'{}')`).run(randomUUID(),job.id);
  }
  db.prepare(`DELETE FROM sessions WHERE expires_at <= ${now}`).run();
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
}

const app = createApp({ db, config });
const server = app.listen(config.port, config.host, () => {
  console.log(`ReferralOS API listening at ${config.host}:${config.port}`);
  console.log(`SQLite database: ${config.databasePath}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => { clearInterval(importCleanupTimer);closeDatabase(db); process.exit(0); }));
}
