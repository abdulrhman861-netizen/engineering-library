(()=>{
  if(window.__engineeringLibraryV7)return;window.__engineeringLibraryV7=true;
  const addCss=()=>{if(document.querySelector('link[href="/v7-theme.css"]'))return;const l=document.createElement('link');l.rel='stylesheet';l.href='/v7-theme.css';document.head.appendChild(l)};addCss();
  const page=(location.pathname.split('/').pop()||'index.html').toLowerCase();
  const adminPages=['admin.html','admin-system.html','admin-tasks.html','accounting.html','print-reports.html'];
  const staffPages=['staff.html','student-files.html','staff-materials.html','admin-upload.html','quick-print.html','tasks-v2.html','staff-chat.html','material-direct-print.html','material-staff-preview.html','id-editor.html'];
  const title=document.title.replace(/\s*[-–|].*$/,'').trim()||'المكتبة الرقمية';
  function mount(){
    let nav=document.querySelector('.staff-global-nav,.v7-sidebar');
    const isAdmin=adminPages.includes(page),isStaff=staffPages.includes(page);
    if(!nav&&(isAdmin||isStaff)){
      const links=isAdmin?[
        ['admin.html','fa-chart-pie','لوحة الإدارة'],['admin-system.html','fa-sliders','إدارة النظام'],['admin-tasks.html','fa-list-check','المهام والديون'],['accounting.html','fa-calculator','الحسابات'],['print-reports.html','fa-print','تقارير الطباعة'],['staff.html','fa-users-gear','بوابة الكادر'],['index.html','fa-house','الرئيسية']
      ]:[
        ['staff.html','fa-house','الرئيسية'],['student-files.html?source=student','fa-user-graduate','طلبات الطلاب'],['student-files.html?source=staff','fa-print','ملفات الكادر'],['staff-materials.html','fa-book-open','إدارة الملازم'],['admin-upload.html','fa-cloud-arrow-up','رفع ملزمة'],['quick-print.html','fa-bolt','السحب السريع'],['tasks-v2.html','fa-list-check','المهام'],['staff-chat.html','fa-comments','الدردشة'],['index.html','fa-arrow-right','واجهة الطلاب']
      ];
      nav=document.createElement('nav');nav.className='v7-sidebar';nav.setAttribute('aria-label',isAdmin?'تنقل الإدارة':'تنقل الكادر');
      const source=new URLSearchParams(location.search).get('source');
      nav.innerHTML=links.map(([href,icon,label])=>{const u=new URL(href,location.origin),active=u.pathname.endsWith(page)&&(!u.searchParams.get('source')||u.searchParams.get('source')===source);return `<a href="/${href}" class="${active?'active':''}"><i class="fa-solid ${icon}"></i><span>${label}</span></a>`}).join('');document.body.appendChild(nav)
    }
    if(nav){document.body.classList.add('v7-has-sidebar');let head=document.querySelector('.v7-shell-title');if(!head){head=document.createElement('div');head.className='v7-shell-title';head.innerHTML=`<i class="fa-solid fa-layer-group"></i><span>${escapeHtml(title)}</span><b class="v7-version">V7</b>`;document.body.appendChild(head)}}
    document.querySelectorAll('.card').forEach((c,i)=>{if(i<6)c.classList.add('v7-kpi')});
    document.addEventListener('click',e=>{const b=e.target.closest('.btn');if(!b||b.disabled)return;b.classList.remove('v7-click');void b.offsetWidth;b.classList.add('v7-click')});
  }
  function escapeHtml(v){return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
  window.v7Toast=(message,type='ok')=>{const old=document.querySelector('.v7-toast');if(old)old.remove();const t=document.createElement('div');t.className=`v7-toast ${type}`;t.innerHTML=`<i class="fa-solid ${type==='error'?'fa-circle-xmark':'fa-circle-check'}"></i><span>${escapeHtml(message)}</span>`;document.body.appendChild(t);setTimeout(()=>t.remove(),3600)};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount);else mount();
})();
