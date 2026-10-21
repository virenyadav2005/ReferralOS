self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch { payload = {}; }
  const title = typeof payload.title === 'string' ? payload.title.slice(0, 100) : 'ReferralOS update';
  const body = typeof payload.body === 'string' ? payload.body.slice(0, 240) : 'You have a new referral update.';
  const href = typeof payload.href === 'string' && payload.href.startsWith('/') && !payload.href.startsWith('//') ? payload.href : '/notifications';
  event.waitUntil(self.registration.showNotification(title, { body, icon: '/favicon.svg', badge: '/favicon.svg', data: { href } }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const href = event.notification.data?.href;
  const target = typeof href === 'string' && href.startsWith('/') && !href.startsWith('//') ? href : '/notifications';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
    const existing = windows.find((client) => new URL(client.url).origin === self.location.origin);
    if (existing) return existing.navigate(target).then(() => existing.focus());
    return self.clients.openWindow(target);
  }));
});
