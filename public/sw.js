// Shows Web Push alerts while the page is closed; tapping one opens the live map.
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data.json(); } catch { d = { title: 'Rath Yatra', body: e.data?.text() || '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Rath Yatra', {
    body: d.body || '', tag: d.tag, icon: '/icon.svg', badge: '/icon.svg', data: { url: d.url || '/' }, vibrate: [120, 60, 120],
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const w = list.find((c) => new URL(c.url).origin === location.origin);
    return w ? w.focus() : clients.openWindow(e.notification.data.url);
  }));
});
