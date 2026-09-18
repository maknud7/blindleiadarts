const API='https://ebbmfynfwiqucsjykbwp.supabase.co/functions/v1/olivia-school-api';
const NOTIFY='https://ebbmfynfwiqucsjykbwp.supabase.co/functions/v1/olivia-school-notify';
const TIMING_KEY='olivia_reminder_timing';
const DAYS=['Søndag','Mandag','Tirsdag','Onsdag','Torsdag','Fredag','Lørdag'];
const $=(id)=>document.getElementById(id);

function isoForDate(date){const x=new Date(Date.UTC(date.getFullYear(),date.getMonth(),date.getDate()));const day=x.getUTCDay()||7;x.setUTCDate(x.getUTCDate()+4-day);const y=new Date(Date.UTC(x.getUTCFullYear(),0,1));return {year:x.getUTCFullYear(),week:Math.ceil((((x-y)/86400000)+1)/7)}}
function wd(date=new Date()){return DAYS[date.getDay()]}
function esc(v=''){return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]))}
function row(icon,title,detail,meta=''){return `<div class="item"><div class="icon">${esc(icon)}</div><div>${meta?`<div class="meta">${esc(meta)}</div>`:''}<strong>${esc(title)}</strong>${detail?`<div class="detail">${esc(detail)}</div>`:''}</div></div>`}
function b64ToUint8Array(value){const pad='='.repeat((4-value.length%4)%4);const base64=(value+pad).replace(/-/g,'+').replace(/_/g,'/');const raw=atob(base64);return Uint8Array.from([...raw].map(c=>c.charCodeAt(0)))}
function reminderTiming(){return localStorage.getItem(TIMING_KEY)==='evening'?'evening':'morning'}
function setTimingUI(value){document.querySelectorAll('input[name="reminderTiming"]').forEach(el=>{el.checked=el.value===value})}
function nextSchoolDate(from){const d=new Date(from);do{d.setDate(d.getDate()+1)}while(d.getDay()===0||d.getDay()===6);return d}
function weekForDate(node,date){const n=isoForDate(date);return node?.weeks?.find(x=>x.iso_year===n.year&&x.iso_week===n.week)||null}
function parseClock(v){const m=String(v||'').match(/(\d{1,2}):(\d{2})/);return m?{h:Number(m[1]),m:Number(m[2])}:null}
function moreThanHourAfterSchool(date,summary){if(date.getDay()===0||date.getDay()===6)return true;const t=parseClock(summary?.dismissal?.[wd(date)]);if(!t)return false;const end=new Date(date);end.setHours(t.h,t.m,0,0);return Date.now()>end.getTime()+3600000}
function localYmd(date){return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`}
function parseLocalDate(v){const m=String(v||'').match(/^(\d{4})-(\d{2})-(\d{2})$/);return m?new Date(Number(m[1]),Number(m[2])-1,Number(m[3])):null}
function shortDate(v){const d=parseLocalDate(v);return d?d.toLocaleDateString('nb-NO',{day:'numeric',month:'short'}):v}
function eventMeta(e){if(e?.start_date&&e?.end_date&&e.start_date!==e.end_date)return `${shortDate(e.start_date)}–${shortDate(e.end_date)}`;return [e?.day,e?.time].filter(Boolean).join(' · ')}
function sameLocalDay(a,b){return localYmd(a)===localYmd(b)}
function eventMatchesFocusDate(e,date){
  const key=localYmd(date);
  if(e?.start_date){
    const end=e.end_date||e.start_date;
    if(e.start_date===end)return key===e.start_date;
    return key===e.start_date||key===end;
  }
  return e?.day===wd(date);
}
function presentationDate(data,now=new Date()){
  const currentWeek=weekForDate(data,now)||null;
  const summary=currentWeek?.summary||{};
  return moreThanHourAfterSchool(now,summary)?nextSchoolDate(now):new Date(now);
}
function weekDistance(from,to){
  const a=new Date(from.getFullYear(),from.getMonth(),from.getDate());
  const b=new Date(to.getFullYear(),to.getMonth(),to.getDate());
  return Math.floor((b-a)/86400000);
}

async function currentSubscription(){if(!('serviceWorker'in navigator)||!('PushManager'in window))return null;const reg=await navigator.serviceWorker.ready;return reg.pushManager.getSubscription()}
async function saveTiming(value){
  const timing=value==='evening'?'evening':'morning';
  localStorage.setItem(TIMING_KEY,timing);setTimingUI(timing);
  const sub=await currentSubscription().catch(()=>null);
  if(sub){
    const r=await fetch(`${API}/preference`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({endpoint:sub.endpoint,notification_timing:timing})});
    if(!r.ok)throw new Error('Kunne ikke lagre varselvalg');
    $('timingStatus').textContent=timing==='evening'?'Denne telefonen får konkrete påminnelser for barna kvelden før kl. 19:00.':'Denne telefonen får konkrete påminnelser for barna om morgenen kl. 07:00.';
  }else{
    $('timingStatus').textContent='Valget er lagret. Aktiver varsler for å ta det i bruk på denne telefonen.';
  }
}
async function enablePush(){
  const btn=$('notifyBtn');
  if(!('serviceWorker'in navigator)||!('PushManager'in window)||!('Notification'in window)){alert('Denne enheten støtter ikke webvarsler.');return;}
  const isiOS=/iPhone|iPad|iPod/.test(navigator.userAgent);
  const standalone=matchMedia('(display-mode: standalone)').matches||navigator.standalone===true;
  if(isiOS&&!standalone){alert('På iPhone må du først legge Barna til på Hjem-skjermen og åpne appen derfra.');return;}
  const permission=await Notification.requestPermission();
  if(permission!=='granted'){alert('Varsler ble ikke tillatt. Du kan endre dette i iPhone-innstillingene.');return;}
  btn.disabled=true;btn.textContent='Aktiverer …';
  const reg=await navigator.serviceWorker.ready;
  let sub=await reg.pushManager.getSubscription();
  if(!sub){const cfg=await fetch(NOTIFY,{cache:'no-store'}).then(r=>{if(!r.ok)throw new Error('Kunne ikke hente push-oppsett');return r.json()});sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:b64ToUint8Array(cfg.vapid_public_key)})}
  const payload={...sub.toJSON(),notification_timing:reminderTiming()};
  const save=await fetch(`${API}/subscribe`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  if(!save.ok)throw new Error('Kunne ikke lagre varslingsabonnement');
  btn.textContent='Varsler er på';btn.classList.add('enabled');btn.disabled=false;
  $('timingStatus').textContent=reminderTiming()==='evening'?'Denne telefonen får konkrete påminnelser for barna kvelden før kl. 19:00.':'Denne telefonen får konkrete påminnelser for barna om morgenen kl. 07:00.';
}

function renderFocus(data,displayDate){
  const now=new Date();
  const target=sameLocalDay(displayDate,now)?new Date(now):new Date(displayDate);
  let label='I dag';
  if(!sameLocalDay(target,now)){
    const days=weekDistance(now,target);
    label=days===1?'I morgen':wd(target);
  }
  const targetWeek=weekForDate(data,target);
  const targetOthilieWeek=weekForDate(data.othilie,target);
  const summary=targetWeek?.summary||{};
  const day=wd(target);
  const oliviaEvents=(summary.events||[]).filter(e=>eventMatchesFocusDate(e,target));
  const homework=(summary.homework||[]).filter(h=>(h.due||'').toLowerCase()===day.toLowerCase());
  const othilieEvents=(targetOthilieWeek?.summary?.events||[]).filter(e=>eventMatchesFocusDate(e,target));
  const dismissal=summary.dismissal?.[day];
  const items=[
    ...oliviaEvents.map(e=>row(e.icon||'•',`Olivia · ${e.title}`,e.detail,e.time||'')),
    ...homework.map(h=>row('📚',`Olivia · ${h.subject}`,h.task||h.detail,label==='I dag'?'Frist i dag':`Frist ${label.toLowerCase()}`)),
    ...othilieEvents.map(e=>row(e.icon||'•',`Othilie · ${e.title}`,e.detail,e.time||'')),
    ...(dismissal?[row('🕑','Olivia · Skolen slutter',dismissal)]:[])
  ];
  if(items.length){$('focusLabel').textContent=label;$('todayCard').classList.remove('hidden');$('today').innerHTML=items.join('')}
  else{$('todayCard').classList.add('hidden');$('today').innerHTML=''}
}

function renderOthilie(data,date){
  const node=data.othilie;
  if(!node){$('othilieEvents').innerHTML='<p class="empty">Ingen barnehagedata tilgjengelig.</p>';return;}
  const w=weekForDate(node,date);
  const odd=isoForDate(date).week%2===1;
  const s=w?.summary||{};
  const events=s.events||[];
  const notices=s.notices||[];
  if(events.length){
    $('othilieEvents').innerHTML=events.map(e=>row(e.icon||'•',e.title,e.detail,eventMeta(e))).join('');
  }else{
    $('othilieEvents').innerHTML=`<p class="empty">${odd?'Ingen spesielle hendelser registrert i barnehageruta denne uka.':'Kort oversikt i partallsuke – ingen spesielle hendelser registrert.'}</p>`;
  }
  $('othilieNotices').innerHTML=notices.map(x=>row('ℹ️','Borketun',x)).join('');
}

function renderUpcoming(data,displayDate){
  const displayIso=isoForDate(displayDate);
  const from=new Date(displayDate);from.setDate(from.getDate()+1);
  const until=new Date(displayDate);until.setDate(until.getDate()+35);
  const fromKey=localYmd(from),untilKey=localYmd(until);
  const items=[];
  const collect=(node,child)=>{
    for(const w of node?.weeks||[]){
      if(w.iso_year<displayIso.year||(w.iso_year===displayIso.year&&w.iso_week<=displayIso.week))continue;
      for(const e of w.summary?.events||[]){
        if(e.calendar===false)continue;
        const routeEvent=e.source==='lillesand-school-route'||e.source==='lillesand-kindergarten-route'||e.school_free===true;
        if(e.calendar!==true&&!routeEvent)continue;
        const date=e.start_date||e.end_date;
        if(!date||date<fromKey||date>untilKey)continue;
        items.push({date,child,e});
      }
    }
  };
  collect(data,'Olivia');collect(data.othilie,'Othilie');
  items.sort((a,b)=>a.date.localeCompare(b.date));
  const unique=[];const seen=new Set();
  for(const item of items){const k=`${item.child}|${item.e.event_id||item.e.title}|${item.date}`;if(seen.has(k))continue;seen.add(k);unique.push(item);if(unique.length>=8)break;}
  if(!unique.length){$('upcomingCard').classList.add('hidden');$('upcoming').innerHTML='';return;}
  $('upcomingCard').classList.remove('hidden');
  $('upcoming').innerHTML=unique.map(({child,e})=>row(e.icon||'📅',`${child} · ${e.title}`,e.detail,eventMeta(e))).join('');
}

async function main(){
  if('serviceWorker' in navigator) await navigator.serviceWorker.register('./sw.js').catch(()=>{});
  setTimingUI(reminderTiming());
  document.querySelectorAll('input[name="reminderTiming"]').forEach(el=>el.addEventListener('change',()=>{if(el.checked)saveTiming(el.value).catch(()=>{$('timingStatus').textContent='Kunne ikke lagre valget akkurat nå. Prøv igjen.'})}));

  const r=await fetch(API,{cache:'no-store'});if(!r.ok)throw new Error('Kunne ikke hente familiedata');
  const data=await r.json();
  const displayDate=presentationDate(data,new Date());
  const n=isoForDate(displayDate);
  const w=weekForDate(data,displayDate);
  const s=w?.summary||{},odd=n.week%2===1;
  $('weekBadge').textContent=`Uke ${n.week}`;
  $('subhead').textContent=odd?'Detaljert uke – Olivia og Othilie hos dere':'Kort oversikt – partallsuke';
  $('weekTitle').textContent=`Uke ${n.week}`;
  $('sourceLink').href=w?.source_url||data.household.source_url;$('timetableLink').href=data.household.timetable_url;$('schoolRouteLink').href=data.school_route_url||'https://www.lillesand.kommune.no/Skolerute.html';$('barnehageLink').href=data.othilie?.household?.source_url||'https://www.lillesand.kommune.no/Barnehagerute.html';$('calendarLink').href=data.calendar_url.replace(/^https:/,'webcal:');
  const oWeek=weekForDate(data.othilie,displayDate);
  const stamps=[w?.updated_at||w?.fetched_at,oWeek?.updated_at||oWeek?.fetched_at].filter(Boolean).map(x=>new Date(x).getTime());
  const latest=stamps.length?new Date(Math.max(...stamps)):new Date();
  $('updated').textContent=`Oppdatert ${latest.toLocaleString('nb-NO',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})}`;
  const ev=s.events||[],hw=s.homework||[],nt=s.notices||[];
  $('events').innerHTML=ev.length?ev.map(e=>row(e.icon||'•',e.title,e.detail,eventMeta(e))).join(''):`<p class="empty">${w?'Ingen spesielle hendelser registrert.':`Ukeplan for uke ${n.week} er ikke publisert ennå.`}</p>`;
  $('homework').innerHTML=hw.length?hw.map(h=>row('📚',h.subject,h.task||h.detail,h.due?`Til ${h.due.toLowerCase()}`:'')).join(''):`<p class="empty">${w?'Ingen lekser registrert.':'Ingen ukeplan publisert ennå.'}</p>`;
  if(nt.length){$('noticeCard').classList.remove('hidden');$('notices').innerHTML=nt.map(x=>row('ℹ️','Beskjed',x)).join('')}else{$('noticeCard').classList.add('hidden')}
  renderOthilie(data,displayDate);
  renderFocus(data,displayDate);
  renderUpcoming(data,displayDate);
  if(/iPhone|iPad|iPod/.test(navigator.userAgent)&&!matchMedia('(display-mode: standalone)').matches)$('installCard').classList.remove('hidden');
  $('notifyBtn').onclick=()=>enablePush().catch(err=>{console.error(err);$('notifyBtn').disabled=false;$('notifyBtn').textContent='Aktiver varsler';alert('Kunne ikke aktivere varsler akkurat nå. Prøv igjen.');});
  if('serviceWorker'in navigator&&'PushManager'in window&&Notification.permission==='granted'){
    navigator.serviceWorker.ready.then(r=>r.pushManager.getSubscription()).then(sub=>{if(sub){$('notifyBtn').textContent='Varsler er på';$('notifyBtn').classList.add('enabled');$('timingStatus').textContent=reminderTiming()==='evening'?'Denne telefonen får konkrete påminnelser for barna kvelden før kl. 19:00.':'Denne telefonen får konkrete påminnelser for barna om morgenen kl. 07:00.';}}).catch(()=>{});
  }
}
main().catch(err=>{console.error(err);$('loadError').classList.remove('hidden')});
