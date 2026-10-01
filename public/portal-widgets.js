(async()=>{
  const target=location.pathname.includes('students')?'STUDENTS':'HOME';
  const style=document.createElement('style');
  style.textContent=`
    .portal-ad{position:fixed;left:12px;top:145px;width:min(310px,88vw);max-height:72vh;z-index:900;background:#fff;border:1px solid #dce4ec;border-radius:0 16px 16px 0;padding:10px;text-align:center;box-shadow:0 8px 30px #0003;transition:transform .3s ease;transform:translateX(calc(-100% - 14px))}
    .portal-ad.open{transform:translateX(0)}
    .portal-ad-toggle{position:absolute;right:-49px;top:26px;width:49px;min-height:110px;border:0;border-radius:0 12px 12px 0;background:#0757a8;color:#fff;font-weight:800;cursor:pointer;writing-mode:vertical-rl;box-shadow:5px 4px 12px #0002;padding:9px}
    .portal-ad img{width:100%;max-height:55vh;object-fit:contain;border-radius:10px;cursor:zoom-in;background:#f7f8fa}
    .portal-ad-title{padding:7px;font-weight:700;color:#18324e}
    .portal-ad-close{position:absolute;left:7px;top:7px;border:0;background:#fff;color:#223;font-size:20px;border-radius:50%;width:30px;height:30px;cursor:pointer;box-shadow:0 2px 8px #0002}
    .recent-strip{position:relative;z-index:40;background:#14233c;border-bottom:3px solid #f2b705;padding:8px 0;overflow:hidden;white-space:nowrap;font-weight:800}
    .recent-track{display:inline-flex;align-items:center;gap:14px;padding-left:70px;animation:recentMove 95s linear infinite}
    .recent-strip:hover .recent-track{animation-play-state:paused}
    .recent-label{color:#fff;padding:7px 15px;background:#0757a8;border-radius:9px}
    .recent-item{padding:8px 16px;border-radius:9px;color:#fff;border:1px solid #ffffff55}
    .recent-item:nth-of-type(odd){background:#805100}.recent-item:nth-of-type(even){background:#176347}
    .recent-sep{color:#ffd84d;font-size:20px}
    @keyframes recentMove{from{transform:translateX(-100%)}to{transform:translateX(100vw)}}
    @media(max-width:600px){.portal-ad{left:0;top:115px}.portal-ad-toggle{right:-45px;width:45px}.recent-track{animation-duration:120s}}
    @media(prefers-reduced-motion:reduce){.recent-track{animation-duration:180s}.portal-ad{transition:none}}
  `;
  document.head.appendChild(style);
  let ads=[];try{const r=await fetch(`/api/advertisements?target=${target}`),d=await r.json();ads=d.advertisements||[]}catch{}
  if(!ads.length)ads=[{title:'دليل كلية الهندسة',image_path:'/pic/college-ad.jpg'}];
  const box=document.createElement('aside');box.className='portal-ad';box.setAttribute('aria-label','الإعلانات الجانبية');box.innerHTML='<button class="portal-ad-close" aria-label="إخفاء الإعلان">×</button><button class="portal-ad-toggle" aria-expanded="false">📢 الإعلانات</button><img><div class="portal-ad-title"></div>';document.body.appendChild(box);
  const toggle=box.querySelector('.portal-ad-toggle'),close=box.querySelector('.portal-ad-close');
  const setOpen=open=>{box.classList.toggle('open',open);toggle.setAttribute('aria-expanded',String(open));};
  toggle.onclick=()=>setOpen(!box.classList.contains('open'));close.onclick=()=>setOpen(false);
  let i=0;const show=()=>{const a=ads[i++%ads.length],img=box.querySelector('img');img.src=a.image_path;img.alt=a.title;img.onclick=()=>window.open(a.image_path,'_blank');box.querySelector('.portal-ad-title').textContent=a.title};show();if(ads.length>1)setInterval(show,30000);
  if(target==='HOME'){try{const r=await fetch('/api/materials/recent'),d=await r.json();if(d.materials?.length){const strip=document.createElement('div');strip.className='recent-strip';const items=d.materials.map((x,n)=>`<span class="recent-item">${escapeText(x.title)} — ${escapeText(x.doctor_name||'بدون اسم مدرس')} — ${escapeText(x.department_name)} — ${escapeText(x.stage_name)}</span>${n<d.materials.length-1?'<b class="recent-sep">◆</b>':''}`).join('');strip.innerHTML=`<div class="recent-track"><strong class="recent-label">أضيف خلال 24 ساعة</strong>${items}</div>`;document.body.prepend(strip)}}catch{}}
  function escapeText(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
})();
