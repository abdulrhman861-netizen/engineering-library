const CACHE_NAME = 'library-app-online-v4-1';

// قائمة الملفات والصفحات الواجب تخزينها للأوفلاين
const urlsToCache = [
  '/',
  '/index.html',
  '/staff.html',
  '/admin.html',
  '/upload.html',
  '/students.html',
  '/stages.html',
  '/files.html',
  '/student-files.html',
  '/print-id.html',
  '/print-ids.html',
  '/admin-upload.html',
  '/fonts/Khalid Art bold.ttf',
  'https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.rtl.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
  'https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js'
];

// 1. تثبيت الـ Service Worker وتخزين الملفات الأساسية
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('PWA: Caching all essential core assets');
      return cache.addAll(urlsToCache);
    })
  );
  self.skipWaiting();
});

// 2. تنظيف التخزين القديم عند التحديث
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

// 3. الاستجابة للطلبات (تخطي طلبات الـ API وإرجاع الملفات المخزنة للواجهات)
self.addEventListener('fetch', (event) => {
  const reqUrl = new URL(event.request.url);

  // عدم تخزين طلبات الـ API أو الرفع لضمان وصول البيانات الحية دائماً
  if (reqUrl.pathname.startsWith('/api/') || reqUrl.pathname.startsWith('/upload')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // صفحات HTML من الشبكة أولاً حتى تصل التحديثات فوراً.
  if (event.request.mode === 'navigate' || reqUrl.pathname.endsWith('.html') || reqUrl.pathname === '/') {
    event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
    return;
  }

  // استراتيجية Cache First للملفات الثابتة فقط
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
