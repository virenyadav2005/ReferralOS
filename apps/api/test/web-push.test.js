import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDatabase, migrateDatabase, openDatabase } from '../src/database.js';
import { dispatchPushOutbox } from '../src/web-push.js';

function fixture(t){
  const directory=mkdtempSync(path.join(os.tmpdir(),'referralos-push-'));
  const db=openDatabase(path.join(directory,'push.sqlite'));migrateDatabase(db);t.after(()=>{closeDatabase(db);rmSync(directory,{recursive:true,force:true});});
  db.prepare('INSERT INTO users(id,email,password_hash) VALUES (?,?,?)').run('push-user','push@example.test','test-hash');
  db.prepare('INSERT INTO profiles(user_id,display_name) VALUES (?,?)').run('push-user','Private User');
  return db;
}

test('push outbox delivers generic lock-screen text and records durable delivery state',async(t)=>{
  const db=fixture(t);const notificationId='push-notification';
  db.prepare('INSERT INTO notifications(id,user_id,type,title,body,href) VALUES (?,?,?,?,?,?)')
    .run(notificationId,'push-user','referral_request','New referral request','Private candidate and role details','/referral-requests/private-request');
  db.prepare('INSERT INTO web_push_subscriptions(id,user_id,endpoint,p256dh,auth) VALUES (?,?,?,?,?)')
    .run('push-subscription','push-user','https://fcm.googleapis.com/fcm/send/test','p'.repeat(65),'a'.repeat(24));
  let payload='';let vapidCalls=0;
  const sender={setVapidDetails(subject,publicKey,privateKey){assert.equal(subject,'mailto:ops@example.test');assert.ok(publicKey);assert.ok(privateKey);vapidCalls++;},async sendNotification(_subscription,body){payload=body;}};
  const result=await dispatchPushOutbox(db,{webPushPublicKey:'public-test-key',webPushPrivateKey:'private-test-key',webPushSubject:'mailto:ops@example.test'},{sender,logger:{warn(){},error(){}}});
  assert.deepEqual(result,{enabled:true,processed:1});assert.equal(vapidCalls,1);
  const parsed=JSON.parse(payload);assert.equal(parsed.title,'ReferralOS update');assert.equal(parsed.body,'You have a new private update. Open ReferralOS to review it.');assert.equal(parsed.href,'/referral-requests/private-request');
  assert.equal(payload.includes('Private candidate'),false);assert.equal(payload.includes('Private User'),false);
  assert.equal(db.prepare('SELECT status FROM notification_push_deliveries WHERE notification_id=?').get(notificationId).status,'sent');
  assert.equal(db.prepare('SELECT COUNT(*) count FROM notification_push_outbox').get().count,0);
});

test('unconfigured browser push discards only the push queue and keeps in-app notifications',async(t)=>{
  const db=fixture(t);
  db.prepare('INSERT INTO notifications(id,user_id,type,title,body) VALUES (?,?,?,?,?)')
    .run('in-app-only','push-user','referral_status','Status changed','Read this in the app');
  const result=await dispatchPushOutbox(db,{webPushPublicKey:'',webPushPrivateKey:'',webPushSubject:''},{logger:{warn(){},error(){}}});
  assert.deepEqual(result,{enabled:false,processed:0});
  assert.equal(db.prepare('SELECT COUNT(*) count FROM notification_push_outbox').get().count,0);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM notifications WHERE id=?').get('in-app-only').count,1);
});

test('expired browser push subscriptions are removed without leaking provider details',async(t)=>{
  const db=fixture(t);
  db.prepare('INSERT INTO notifications(id,user_id,type,title,body) VALUES (?,?,?,?,?)').run('expired-note','push-user','x','x','x');
  db.prepare('INSERT INTO web_push_subscriptions(id,user_id,endpoint,p256dh,auth) VALUES (?,?,?,?,?)').run('expired-sub','push-user','https://fcm.googleapis.com/fcm/send/expired','p'.repeat(65),'a'.repeat(24));
  const messages=[];const sender={setVapidDetails(){},async sendNotification(){const error=new Error('secret provider response');error.statusCode=410;throw error;}};
  const result=await dispatchPushOutbox(db,{webPushPublicKey:'public',webPushPrivateKey:'private',webPushSubject:'mailto:ops@example.test'},{sender,logger:{warn(message){messages.push(message);},error(){}}});
  assert.deepEqual(result,{enabled:true,processed:1});assert.equal(db.prepare('SELECT COUNT(*) count FROM web_push_subscriptions').get().count,0);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM notification_push_outbox').get().count,0);
  assert.equal(messages.length,0,'expired subscriptions are pruned without logging provider content');
});
