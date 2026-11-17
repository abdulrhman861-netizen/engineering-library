const CACHE_NAME = 'library-app-online-v7-6-1-ios-upload-fix';

// ظ‚ط§ط¦ظ…ط© ط§ظ„ظ…ظ„ظپط§طھ ظˆط§ظ„طµظپط­ط§طھ ط§ظ„ظˆط§ط¬ط¨ طھط®ط²ظٹظ†ظ‡ط§ ظ„ظ„ط£ظˆظپظ„ط§ظٹظ†
const urlsToCache = [
  '/',
  '/index.html',
  '/staff.html',
  '/teacher.html',
  '/attendance-kiosk.html',
  '/staff-chat-alerts.js',
  '/staff-nav.js',
  '/v7-theme.css',
  '/v7-shell.js',
  '/staff-materials.html',
  '/material-direct-print.html',
  '/id-editor.html',
  '/document-studio.html',
  '/document-studio.css',
  '/document-studio.js',
  '/print-reports.html',
  '/material-staff-preview.html',
  '/admin.html',
  '/upload.html',
  '/students.html',
  '/stages.html',
  '/files.html',
  '/student-files.html',
  '/quick-print.html',
  '/print-id.html',
  '/print-ids.html',
  '/admin-upload.html',
  '/tasks-v2.html',
  '/admin-tasks.html',
  '/accounting.html',
  '/student-chat.html',
  '/staff-chat.html',
  '/notifications.js',
  '/assets/department-board-v6.4.jpg',
  '/fonts/Khalid Art bold.ttf',
  'https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.rtl.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
  'https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js'
  ,'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js'
  ,'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'
];

// 1. طھط«ط¨ظٹطھ ط§ظ„ظ€ Service Worker ظˆطھط®ط²ظٹظ† ط§ظ„ظ…ظ„ظپط§طھ ط§ظ„ط£ط³ط§ط³ظٹط©
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('PWA: Caching all essential core assets');
      return cache.addAll(urlsToCache);
    })
  );
  self.skipWaiting();
});

// 2. طھظ†ط¸ظٹظپ ط§ظ„طھط®ط²ظٹظ† ط§ظ„ظ‚ط¯ظٹظ… ط¹ظ†ط¯ ط§ظ„طھط­ط¯ظٹط«
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => {
          if (cache !== CACHE_NAME) {
            console.log('PWA: Clearing Old Cache');
            return caches.delete(cache);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// 3. ط§ظ„ط§ط³طھط¬ط§ط¨ط© ظ„ظ„ط·ظ„ط¨ط§طھ (طھط®ط·ظٹ ط·ظ„ط¨ط§طھ ط§ظ„ظ€ API ظˆط¥ط±ط¬ط§ط¹ ط§ظ„ظ…ظ„ظپط§طھ ط§ظ„ظ…ط®ط²ظ†ط© ظ„ظ„ظˆط§ط¬ظ‡ط§طھ)
self.addEventListener('fetch', (event) => {
  const reqUrl = new URL(event.request.url);

  // ط¹ط¯ظ… طھط®ط²ظٹظ† ط·ظ„ط¨ط§طھ ط§ظ„ظ€ API ط£ظˆ ط§ظ„ط±ظپط¹ ظ„ط¶ظ…ط§ظ† ظˆطµظˆظ„ ط§ظ„ط¨ظٹط§ظ†ط§طھ ط§ظ„ط­ظٹط© ط¯ط§ط¦ظ…ط§ظ‹
  if (event.request.method !== 'GET') {
    return;
  }

  // طلبات API الحية لا تُخزن
  if (reqUrl.pathname.startsWith('/api/')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // طµظپط­ط§طھ HTML ظ…ظ† ط§ظ„ط´ط¨ظƒط© ط£ظˆظ„ط§ظ‹ ط­طھظ‰ طھطµظ„ ط§ظ„طھط­ط¯ظٹط«ط§طھ ظپظˆط±ط§ظ‹.
  if (event.request.mode === 'navigate' || reqUrl.pathname.endsWith('.html') || reqUrl.pathname === '/') {
    event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
    return;
  }

  // ط§ط³طھط±ط§طھظٹط¬ظٹط© Cache First ظ„ظ„ظ…ظ„ظپط§طھ ط§ظ„ط«ط§ط¨طھط© ظپظ‚ط·
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }
      return fetch(event.request).then((networkResponse) => {
        if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') {
          return networkResponse;
        }
        const responseToCache = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, responseToCache);
        });
        return networkResponse;
      });
    })
  );
});


