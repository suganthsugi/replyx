/* global self */
/*
 * ReplyX service worker: desktop notifications for staff (US15, T245).
 *
 * The worker sends a Web Push message as JSON { title, body, url, tag } (apps/api
 * notifications/channels/push.channel.ts). This shows it, and a click focuses an open ReplyX tab
 * on the same host (navigating it to the ticket) or opens a new one. It caches nothing and never
 * intercepts requests.
 */

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

function readMessage(event) {
  try {
    const data = event.data ? event.data.json() : {};
    return {
      title: typeof data.title === 'string' && data.title !== '' ? data.title : 'ReplyX',
      body: typeof data.body === 'string' ? data.body : '',
      url: typeof data.url === 'string' && data.url.startsWith('/') ? data.url : '/desk/notifications',
      tag: typeof data.tag === 'string' ? data.tag : undefined,
    };
  } catch {
    return { title: 'ReplyX', body: '', url: '/desk/notifications', tag: undefined };
  }
}

self.addEventListener('push', (event) => {
  const message = readMessage(event);
  event.waitUntil(
    self.registration.showNotification(message.title, {
      body: message.body,
      tag: message.tag,
      // A later message of the same burst replaces the shown one and alerts again.
      renotify: message.tag !== undefined,
      icon: '/favicon.svg',
      data: { url: message.url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const path = event.notification.data && typeof event.notification.data.url === 'string' ? event.notification.data.url : '/desk/notifications';
  const target = new URL(path, self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const desk = windows.find((client) => new URL(client.url).pathname.startsWith('/desk'));
      if (desk) {
        await desk.focus();
        if ('navigate' in desk) await desk.navigate(target);
        return;
      }
      await self.clients.openWindow(target);
    })(),
  );
});
