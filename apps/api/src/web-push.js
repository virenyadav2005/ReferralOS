import webPush from 'web-push';

const nowSql = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

export async function dispatchPushOutbox(db, config, { sender = webPush, logger = console } = {}) {
  if (!config.webPushPublicKey || !config.webPushPrivateKey || !config.webPushSubject) {
    // In-app notifications remain durable; never queue stale push messages for a later device subscription.
    db.prepare('DELETE FROM notification_push_outbox').run();
    return { enabled: false, processed: 0 };
  }
  try { sender.setVapidDetails(config.webPushSubject, config.webPushPublicKey, config.webPushPrivateKey); }
  catch { logger.error?.('ReferralOS browser push configuration invalid {category:vapid_configuration}'); return { enabled: false, processed: 0 }; }
  const pending = db.prepare(`SELECT o.notification_id,n.user_id,n.title,n.body,n.href FROM notification_push_outbox o
    JOIN notifications n ON n.id=o.notification_id WHERE o.next_attempt_at<=${nowSql} ORDER BY n.created_at LIMIT 50`).all();
  let processed=0;
  for (const notification of pending) {
    const subscriptions=db.prepare('SELECT id,endpoint,p256dh,auth FROM web_push_subscriptions WHERE user_id=?').all(notification.user_id);
    let retry=false;
    for (const subscription of subscriptions) {
      const previous=db.prepare('SELECT attempts,status,next_attempt_at FROM notification_push_deliveries WHERE notification_id=? AND subscription_id=?').get(notification.notification_id,subscription.id);
      if(previous?.status==='sent'||previous?.status==='abandoned')continue;
      if(previous&&previous.next_attempt_at>new Date().toISOString()) {retry=true;continue;}
      try {
        const href=typeof notification.href==='string'&&notification.href.startsWith('/')&&!notification.href.startsWith('//')?notification.href:'/notifications';
        // Keep names, messages, job titles, and other account data out of lock-screen previews.
        await sender.sendNotification({endpoint:subscription.endpoint,keys:{p256dh:subscription.p256dh,auth:subscription.auth}},JSON.stringify({title:'ReferralOS update',body:'You have a new private update. Open ReferralOS to review it.',href}),{TTL:3600,urgency:'normal'});
        db.prepare(`INSERT INTO notification_push_deliveries(notification_id,subscription_id,attempts,status,updated_at) VALUES(?,?,1,'sent',${nowSql})
          ON CONFLICT(notification_id,subscription_id) DO UPDATE SET attempts=notification_push_deliveries.attempts+1,status='sent',updated_at=${nowSql}`).run(notification.notification_id,subscription.id);
      } catch(error) {
        const status=Number(error?.statusCode)||0;
        if(status===404||status===410){db.prepare('DELETE FROM web_push_subscriptions WHERE id=?').run(subscription.id);continue;}
        const attempts=(previous?.attempts??0)+1;
        const nextStatus=attempts>=5?'abandoned':'pending';
        const delay=Math.min(3600,30*2**Math.min(attempts,7));
        const nextAttempt=new Date(Date.now()+delay*1000).toISOString();
        db.prepare(`INSERT INTO notification_push_deliveries(notification_id,subscription_id,attempts,next_attempt_at,status,updated_at) VALUES(?,?,?,?,?,${nowSql})
          ON CONFLICT(notification_id,subscription_id) DO UPDATE SET attempts=excluded.attempts,next_attempt_at=excluded.next_attempt_at,status=excluded.status,updated_at=${nowSql}`)
          .run(notification.notification_id,subscription.id,attempts,nextAttempt,nextStatus);
        if(nextStatus==='pending')retry=true;
        logger.warn?.(`ReferralOS browser push delivery failed {category:provider_error,status:${status||'unknown'}}`);
      }
    }
    if(retry) db.prepare(`UPDATE notification_push_outbox SET next_attempt_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+30 seconds') WHERE notification_id=?`).run(notification.notification_id);
    else db.prepare('DELETE FROM notification_push_outbox WHERE notification_id=?').run(notification.notification_id);
    processed++;
  }
  return { enabled:true,processed };
}
