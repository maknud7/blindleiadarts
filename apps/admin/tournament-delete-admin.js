const API_ROOT="../api/v1";
let current={id:0,status:"",name:""};

function token(){return localStorage.getItem("bd:token")||""}

async function api(path,{method="GET",body}={}){
  const headers={Authorization:`Bearer ${token()}`};
  if(body!==undefined)headers["Content-Type"]="application/json";
  const r=await fetch(`${API_ROOT}${path}`,{
    method,
    headers,
    body:body===undefined?undefined:JSON.stringify(body),
    cache:"no-store"
  });
  const p=await r.json().catch(()=>null);
  if(!r.ok||!p?.ok)throw new Error(p?.error?.message||`Forespørselen feilet (${r.status})`);
  return p.data;
}

function ensure(){
  const stage=document.getElementById("tcStageCheckin");
  if(!stage)return null;
  let box=document.getElementById("tcDeleteDanger");
  if(!box){
    box=document.createElement("details");
    box.id="tcDeleteDanger";
    box.className="tc-disclosure";
    box.innerHTML=`
      <summary>Flere valg</summary>
      <div class="tc-disclosure-body">
        <div style="border:1px solid rgba(255,107,107,.35);border-radius:14px;padding:14px;background:rgba(255,107,107,.06)">
          <strong style="display:block;margin-bottom:5px">Slett turnering permanent</strong>
          <p class="muted" style="margin:0 0 12px">
            Rå sletting fjerner turneringen med grupper, kamper, legs/kast, påmeldinger, resultater og andre turneringsdata.
            ELO-effekten fra kampene reverseres før dataene slettes. Dette kan ikke angres.
          </p>
          <button id="tcDeleteTournament" type="button" class="button quiet" style="border-color:rgba(255,107,107,.55);color:#ffb7b7">
            Slett turnering permanent
          </button>
        </div>
      </div>`;
    stage.appendChild(box);
    box.querySelector("#tcDeleteTournament")?.addEventListener("click",remove);
  }
  return box;
}

async function render(context){
  current={id:Number(context?.id||0),status:String(context?.status||""),name:""};
  const box=ensure();
  if(!box)return;
  box.classList.toggle("hidden",!current.id);
  if(!current.id)return;
  try{
    const detail=await api(`/tournaments/${current.id}`);
    current.name=String(detail?.tournament?.name||"");
  }catch{}
}

async function remove(){
  if(!current.id)return;
  const id=current.id;
  const name=current.name||`turnering #${id}`;

  if(!window.confirm(
    `Slette «${name}» permanent?\n\nDette sletter også grupper, kamper, scoring, resultater og påmeldinger. Handlingen kan ikke angres.`
  ))return;

  const typed=window.prompt(`Skriv SLETT for å bekrefte rå sletting av «${name}».`,"");
  if(String(typed||"").trim().toUpperCase()!=="SLETT")return;

  const button=document.getElementById("tcDeleteTournament");
  if(button){
    button.disabled=true;
    button.textContent="Sletter …";
  }

  try{
    await api(`/tournaments/${id}/hard-delete`,{
      method:"DELETE",
      body:{confirm_delete:true}
    });
    window.dispatchEvent(new CustomEvent("bd:tournament-deleted",{detail:{id,name}}));
    document.getElementById("tcRefresh")?.click();
    document.getElementById("refreshAllButton")?.click();
    window.alert(`«${name}» er slettet permanent.`);
  }catch(error){
    window.alert(error.message);
  }finally{
    if(button){
      button.disabled=false;
      button.textContent="Slett turnering permanent";
    }
  }
}

window.addEventListener("bd:tournament-context",e=>render(e.detail));
if(window.__bdTournamentContext)render(window.__bdTournamentContext);
else ensure();
