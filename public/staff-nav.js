(()=>{
  if(!localStorage.getItem('employeeToken'))return;
  if(!document.querySelector('link[href*="font-awesome"]')){const icons=document.createElement('link');icons.rel='stylesheet';icons.href='https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css';document.head.appendChild(icons);}
  const links=[
    ['staff.html','fa-house','الرئيسية'],
    ['student-files.html?source=student','fa-user-graduate','طلبات الطلاب'],
    ['student-files.html?source=staff','fa-print','ملفات الكادر'],
    ['staff-materials.html','fa-book-open','إدارة الملازم'],
    ['admin-upload.html','fa-cloud-arrow-up','رفع ملزمة'],
    ['quick-print.html','fa-bolt','السحب السريع']
  ];
  const style=document.createElement('style');
  style.textContent=`.staff-global-nav{position:fixed;right:12px;top:50%;transform:translateY(-50%);z-index:9998;background:#073b70;padding:9px;border-radius:16px;box-shadow:0 8px 25px #0004;display:grid;gap:6px;width:155px}.staff-global-nav a{display:flex;align-items:center;gap:8px;color:#fff!important;text-decoration:none!important;padding:10px 9px;border-radius:10px;font:bold 13px Tahoma,Arial}.staff-global-nav a:hover,.staff-global-nav a.active{background:#fff;color:#0759a5!important}.staff-global-nav i{width:19px;text-align:center}@media(min-width:900px){body{padding-right:175px!important}}@media(max-width:899px){.staff-global-nav{right:0;left:0;top:auto;bottom:0;transform:none;width:auto;border-radius:14px 14px 0 0;display:flex;overflow-x:auto;justify-content:flex-start}.staff-global-nav a{min-width:92px;display:grid;justify-items:center;gap:4px;font-size:11px}body{padding-bottom:78px!important}}`;
  document.head.appendChild(style);
  const nav=document.createElement('nav');nav.className='staff-global-nav';nav.setAttribute('aria-label','التنقل السريع للكادر');
  const here=location.pathname.split('/').pop()||'staff.html',source=new URLSearchParams(location.search).get('source');
  nav.innerHTML=links.map(([href,icon,label])=>{const target=href.split('?')[0],targetSource=new URL(href,location.origin).searchParams.get('source');const active=here===target&&(!targetSource||targetSource===source);return `<a href="/${href}" class="${active?'active':''}"><i class="fa-solid ${icon}"></i><span>${label}</span></a>`}).join('');
  document.body.appendChild(nav);
})();
