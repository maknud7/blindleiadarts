const API='https://ebbmfynfwiqucsjykbwp.supabase.co/functions/v1/olivia-school-api';
const NOTIFY='https://ebbmfynfwiqucsjykbwp.supabase.co/functions/v1/olivia-school-notify';
const $=(id)=>document.getElementById(id);
function iso(){const d=new Date(),x=new Date(Date.UTC(d.getFullYear(),d.getMonth(),d.getDate()));const day=x.getUTCDay()||7;x.setUTCDate(x.getUTCDate()+4-day);const y=new Date(Date.UTC(x.getUTCFullYear(),0,1));return {year:x.getUTCFullYear(),week:Math.ceil((((x-y)/86400000)+1)/7)}}
function wd(){return ['Søndag','Mandag','Tirsdag','Onsdag','Torsdag','Fredag','Lørdag'][new Date().getDay()]}
function esc(v=''){return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]))}
function row(icon,title,detail,meta=''){return `<div class="item"><div class="icon">${esc(icon)}</div><div>${meta?`<div class="meta">${esc(meta)}</div>`:''}<strong>${esc(title)}</strong>${detail?`<div class="detail">${esc(detail)}</div>`:''}</div></div>`}
function b64ToUint8Array(value){const pad='='.repeat((4-value.length%4)%4);const base64=(value+pad).replace(/-/g,'+').replace(/_/g,'/');const raw=atob(base64);return Uint8Array.from([...raw].map(c=>c.charCodeAt(0)))}
async function enablePush(){
  const btn=$('notifyBtn');
  if(!('serviceWorker'in navigator)||!('PushManager'in window)||!('Notification'in window)){
    alert('Denne enheten støtter ikke webvarsler.');return;
  }
  const isiOS=/iPhone|iPad|iPod/.test(navigator.userAgent);
  const standalone=matchMedia('(display-mode: standalone)').matches||navigator.standalone===true;
  if(isiOS&&!standalone){alert('På iPhone må du først legge Olivia skole til på Hjem-skjermen og åpne appen derfra.');return;}
  const permission=await Notification.requestPermission();
  if(permission!=='granted'){alert('Varsler ble ikke tillatt. Du kan endre dette i iPhone-innstillingene.');return;}
  btn.disabled=true;btn.textContent='Aktiverer …';
  const reg=await navigator.serviceWorker.ready;
  let sub=await reg.pushManager.getSubscription();
  if(!sub){
    const cfg=await fetch(NOTIFY,{cache:'no-store'}).then(r=>{if(!r.ok)throw new Error('Kunne ikke hente push-oppsett');return r.json()});
    sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:b64ToUint8Array(cfg.vapid_public_key)});
  }
  const payload=sub.toJSON();
  const save=await fetch(`${API}/subscribe`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  if(!save.ok) throw new Error('Kunne ikke lagre varslingsabonnement');
  btn.textContent='Varsler er på';btn.classList.add('enabled');btn.disabled=false;
}
async function main(){
  if('serviceWorker' in navigator) await navigator.serviceWorker.register('./sw.js').catch(()=>{});
  const r=await fetch(API,{cache:'no-store'});
  if(!r.ok) throw new Error('Kunne ikke hente skoledata');
  const data=await r.json();
  const n=iso();
  const w=data.weeks.find(x=>x.iso_year===n.year&&x.iso_week===n.week)||data.weeks[0];
  if(!w) throw new Error('Ingen ukeplan tilgjengelig');
  const s=w.summary||{},odd=w.iso_week%2===1;
  $('weekBadge').textContent=`Uke ${w.iso_week}`;
  $('subhead').textContent=odd?'Detaljert uke – Olivia hos dere':'Kort oversikt – partallsuke';
  $('weekTitle').textContent=`Uke ${w.iso_week}`;
  $('sourceLink').href=w.source_url||data.household.source_url;
  $('timetableLink').href=data.household.timetable_url;
  $('calendarLink').href=data.calendar_url.replace(/^https:/,'webcal:');
  $('updated').textContent=`Oppdatert ${new Date(w.updated_at||w.fetched_at).toLocaleString('nb-NO',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})}`;
  const ev=s.events||[],hw=s.homework||[],nt=s.notices||[];
  $('events').innerHTML=ev.length?ev.map(e=>row(e.icon||'•',e.title,e.detail,[e.day,e.time].filter(Boolean).join(' · '))).join(''):'<p class="empty">Ingen spesielle hendelser registrert.</p>';
  $('homework').innerHTML=hw.length?hw.map(h=>row('📚',h.subject,h.detail,h.due?`Til ${h.due.toLowerCase()}`:'')).join(''):'<p class="empty">Ingen lekser registrert.</p>';
  if(nt.length){$('noticeCard').classList.remove('hidden');$('notices').innerHTML=nt.map(x=>row('ℹ️','Beskjed',x)).join('')}
  const today=wd(),te=ev.filter(e=>e.day===today),th=hw.filter(h=>(h.due||'').toLowerCase()===today.toLowerCase()),dismiss=s.dismissal?.[today];
  if(te.length||th.length||dismiss){$('todayCard').classList.remove('hidden');$('today').innerHTML=[...te.map(e=>row(e.icon||'•',e.title,e.detail,e.time||'')),...th.map(h=>row('📚',h.subject,h.detail,'Frist i dag')),...(dismiss?[row('🕑','Skolen slutter',dismiss)]:[])].join('')}
  if(/iPhone|iPad|iPod/.test(navigator.userAgent)&&!matchMedia('(display-mode: standalone)').matches) $('installCard').classList.remove('hidden');
  $('notifyBtn').onclick=()=>enablePush().catch(err=>{console.error(err);$('notifyBtn').disabled=false;$('notifyBtn').textContent='Aktiver varsler';alert('Kunne ikke aktivere varsler akkurat nå. Prøv igjen.');});
  if('serviceWorker'in navigator&&'PushManager'in window&&Notification.permission==='granted'){
    navigator.serviceWorker.ready.then(r=>r.pushManager.getSubscription()).then(sub=>{if(sub){$('notifyBtn').textContent='Varsler er på';$('notifyBtn').classList.add('enabled')}}).catch(()=>{});
  }
}
main().catch(err=>{console.error(err);$('loadError').classList.remove('hidden')});
