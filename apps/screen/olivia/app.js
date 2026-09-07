const API='https://ebbmfynfwiqucsjykbwp.supabase.co/functions/v1/olivia-school-api';
const $=(id)=>document.getElementById(id);
function iso(){const d=new Date(),x=new Date(Date.UTC(d.getFullYear(),d.getMonth(),d.getDate()));const day=x.getUTCDay()||7;x.setUTCDate(x.getUTCDate()+4-day);const y=new Date(Date.UTC(x.getUTCFullYear(),0,1));return {year:x.getUTCFullYear(),week:Math.ceil((((x-y)/86400000)+1)/7)}}
function wd(){return ['Søndag','Mandag','Tirsdag','Onsdag','Torsdag','Fredag','Lørdag'][new Date().getDay()]}
function esc(v=''){return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]))}
function row(icon,title,detail,meta=''){return `<div class="item"><div class="icon">${esc(icon)}</div><div>${meta?`<div class="meta">${esc(meta)}</div>`:''}<strong>${esc(title)}</strong>${detail?`<div class="detail">${esc(detail)}</div>`:''}</div></div>`}
async function main(){
  if('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(()=>{});
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
  $('calendarLink').href=data.calendar_url;
  $('updated').textContent=`Oppdatert ${new Date(w.updated_at||w.fetched_at).toLocaleString('nb-NO',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})}`;
  const ev=s.events||[],hw=s.homework||[],nt=s.notices||[];
  $('events').innerHTML=ev.length?ev.map(e=>row(e.icon||'•',e.title,e.detail,[e.day,e.time].filter(Boolean).join(' · '))).join(''):'<p class="empty">Ingen spesielle hendelser registrert.</p>';
  $('homework').innerHTML=hw.length?hw.map(h=>row('📚',h.subject,h.detail,h.due?`Til ${h.due.toLowerCase()}`:'')).join(''):'<p class="empty">Ingen lekser registrert.</p>';
  if(nt.length){$('noticeCard').classList.remove('hidden');$('notices').innerHTML=nt.map(x=>row('ℹ️','Beskjed',x)).join('')}
  const today=wd(),te=ev.filter(e=>e.day===today),th=hw.filter(h=>(h.due||'').toLowerCase()===today.toLowerCase()),dismiss=s.dismissal?.[today];
  if(te.length||th.length||dismiss){$('todayCard').classList.remove('hidden');$('today').innerHTML=[...te.map(e=>row(e.icon||'•',e.title,e.detail,e.time||'')),...th.map(h=>row('📚',h.subject,h.detail,'Frist i dag')),...(dismiss?[row('🕑','Skolen slutter',dismiss)]:[])].join('')}
  if(/iPhone|iPad|iPod/.test(navigator.userAgent)&&!matchMedia('(display-mode: standalone)').matches) $('installCard').classList.remove('hidden');
  $('notifyBtn').onclick=()=>alert('Pushvarsler kobles på som neste steg. Appen kan installeres og brukes uten innlogging.');
}
main().catch(err=>{console.error(err);$('loadError').classList.remove('hidden')});
