(()=>{
  const token=localStorage.getItem('employeeToken');
  if(!token)return;
  const originalTitle=document.title;
  let audioReady=false,context=null,checking=false;
  const seenKey='engineeringLibrary:lastChatAlert';
  const api=()=>fetch('/api/staff/chats',{headers:{Authorization:`Bearer ${token}`}});
  function unlockAudio(){
    try{context=context||new (window.AudioContext||window.webkitAudioContext)();context.resume();audioReady=true}catch{}
  }
  document.addEventListener('pointerdown',unlockAudio,{once:true});
  document.addEventListener('keydown',unlockAudio,{once:true});
  function beep(){
    if(!audioReady)return;
    try{const gain=context.createGain(),osc=context.createOscillator();osc.type='sine';osc.frequency.setValueAtTime(880,context.currentTime);gain.gain.setValueAtTime(.001,context.currentTime);gain.gain.exponentialRampToValueAtTime(.22,context.currentTime+.02);gain.gain.exponentialRampToValueAtTime(.001,context.currentTime+.5);osc.connect(gain);gain.connect(context.destination);osc.start();osc.stop(context.currentTime+.52)}catch{}
  }
  function ensureUi(){
    if(!document.getElementById('staffChatAlertStyle'))document.head.insertAdjacentHTML('beforeend','<style id="staffChatAlertStyle">#staffChatToast{position:fixed;top:18px;left:18px;z-index:99999;background:#9d1b32;color:#fff;border:0;border-radius:14px;padding:15px 18px;box-shadow:0 8px 28px #0005;max-width:340px;cursor:pointer;font-family:Tahoma,Arial;display:none;animation:chatPulse 1.2s infinite}#staffChatToast b{display:block;font-size:1.05rem;margin-bottom:5px}.staff-chat-count{display:inline-flex;align-items:center;justify-content:center;min-width:24px;height:24px;padding:0 7px;margin-inline-start:6px;border-radius:20px;background:#d7183f;color:#fff;font-weight:bold}@keyframes chatPulse{50%{transform:scale(1.025)}}@media(max-width:600px){#staffChatToast{left:10px;right:10px;top:10px;max-width:none}}</style>');
    if(!document.getElementById('staffChatToast'))document.body.insertAdjacentHTML('beforeend','<button id="staffChatToast" type="button"><b>🔔 رسالة جديدة من طالب</b><span id="staffChatToastText"></span></button>');
    const toast=document.getElementById('staffChatToast');toast.onclick=()=>location.href='/staff-chat.html';
  }
  function setBadges(count){
    document.querySelectorAll('a[href$="staff-chat.html"],a[href="staff-chat.html"]').forEach(link=>{
      let badge=link.querySelector('.staff-chat-count');
      if(!badge){badge=document.createElement('span');badge.className='staff-chat-count';link.appendChild(badge)}
      badge.textContent=String(count);badge.hidden=count<1;
    });
    document.title=count?`(${count}) محادثات جديدة - ${originalTitle}`:originalTitle;
  }
  function alertStaff(count,name,signature){
    ensureUi();beep();
    const toast=document.getElementById('staffChatToast');document.getElementById('staffChatToastText').textContent=`${count} رسالة غير مقروءة${name?` - آخرها من ${name}`:''}. اضغط لفتح المحادثات.`;toast.style.display='block';clearTimeout(window.staffChatToastTimer);window.staffChatToastTimer=setTimeout(()=>toast.style.display='none',12000);
    if('Notification'in window&&Notification.permission==='granted'){const n=new Notification('رسالة جديدة - مكتبة الهندسة',{body:`${count} رسالة غير مقروءة${name?`، آخرها من ${name}`:''}`,tag:'engineering-library-chat'});n.onclick=()=>{window.focus();location.href='/staff-chat.html'}}
    localStorage.setItem(seenKey,signature);
  }
  async function check(){
    if(checking)return;checking=true;
    try{
      const r=await api();if(!r.ok)return;
      const d=await r.json(),items=Array.isArray(d.conversations)?d.conversations:[],unread=items.filter(x=>Number(x.unread_count||0)>0),count=unread.reduce((s,x)=>s+Number(x.unread_count||0),0),latest=unread.reduce((a,x)=>!a||new Date(x.last_message)>new Date(a.last_message)?x:a,null),signature=count?`${latest?.last_message||''}|${count}`:'';
      setBadges(count);
      if(count&&signature!==localStorage.getItem(seenKey))alertStaff(count,latest?.student_name||'',signature);
      if(!count)localStorage.removeItem(seenKey);
    }catch{}finally{checking=false}
  }
  ensureUi();
  if('Notification'in window&&Notification.permission==='default')document.addEventListener('click',()=>Notification.requestPermission().catch(()=>{}),{once:true});
  check();setInterval(check,8000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)check()});
})();
