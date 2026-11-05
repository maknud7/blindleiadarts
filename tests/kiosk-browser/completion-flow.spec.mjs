import {test,expect} from "@playwright/test";

// Real KioskWorkspace/React bundle, but every API route is intercepted before
// the browser can access a database or physical board.
const URL="http://127.0.0.1:4173/v2/kiosk/";
const club={id:7,name:"Blindleia Dartklubb",slug:"blindleia-dartklubb"};
const kiosk={id:7,code:"QA-MANUAL",board_number:1,name:"Skive 1",scoring_mode:"manual",club};
const players={
  player_a:{id:101,display_name:"Anna Langnes",remaining:150,legs_won:0},
  player_b:{id:102,display_name:"Bjørn Sørensen",remaining:501,legs_won:0},
};
const firstMatch={id:42,status:"in_progress",current_leg:1,current_player_id:101,
 best_of_legs:1,round_label:"Gruppe A · Runde 3",...players,recent_visits:[]};
const nextMatch={...firstMatch,id:43,status:"assigned",round_label:"Gruppe B · Runde 2",
 current_player_id:102,player_a:{...players.player_a,remaining:501},player_b:{...players.player_b,remaining:501}};
const state=(match)=>({kiosk,active_tournament:{id:10,name:"QA test",status:"in_progress"},match});

async function boot(browser,{nextAssigned=true,staleCompletedMatch=false}={}){
  let latestResultVisible=!staleCompletedMatch;
  const context=await browser.newContext({viewport:{width:768,height:1024},hasTouch:true});
  const page=await context.newPage();
  const calls=[];
  const errors=[];
  let advanced=false;
  page.on("pageerror",e=>errors.push(e.message));
  await page.addInitScript(()=>{
    localStorage.setItem("bd:kioskCode","QA-MANUAL");
    localStorage.setItem("bd:kioskPairingToken","qa-local-mock");
  });
  await page.route("**/api/**",async route=>{
    const request=route.request();
    const p=new URL(request.url()).pathname;
    const method=request.method();
    const body=method==="POST"?JSON.parse(request.postData()||"{}"):{};
    calls.push({p,method,body});
    const ok=(data)=>route.fulfill({status:200,contentType:"application/json",
      body:JSON.stringify({ok:true,data})});
    if(p.endsWith("/health")) return ok({status:"ok",environment:"test"});
    if(p.endsWith("/kiosks/QA-MANUAL/state")) return ok(state(advanced ? (nextAssigned ? nextMatch : null) : firstMatch));
    if(method==="POST"&&p.endsWith("/kiosks/QA-MANUAL/visit")) return ok({recorded:true});
    if(p.endsWith("/kiosks/QA-MANUAL/post-match")) return ok({
      active_match:false,
      last_completed_match:{id:latestResultVisible?42:41,
        player_a_name:latestResultVisible?"Anna Langnes":"Cecilie Eide",
        player_b_name:latestResultVisible?"Bjørn Sørensen":"Dan Birkeland",
        winner_name:latestResultVisible?"Anna Langnes":"Cecilie Eide",
        legs_a:1,legs_b:0},
      reservation:{match_id:43,player_a_name:"Anna Langnes",player_b_name:"Bjørn Sørensen",
        remaining_seconds:24,round_label:"Gruppe B · Runde 2"},
      remaining_seconds:24,
    });
    if(method==="POST"&&p.endsWith("/kiosks/QA-MANUAL/next-match")){
      // A simulated hold: only a deliberate button press with advance_now
      // returns the queued match; automatic background claims do not.
      if(body.advance_now===true){advanced=true;return ok({
        assignment:nextAssigned?{assigned:true}:{assigned:false,reason:"no_ready_match"},
        state:state(nextAssigned?nextMatch:null),
      });}
      return ok({assignment:{assigned:false,reason:"reservation_wait"},state:state(null)});
    }
    return route.fulfill({status:409,contentType:"application/json",
      body:JSON.stringify({ok:false,error:{message:"Unmocked mutation"}})});
  });
  await page.goto(URL);
  await expect(page.getByText("Registrer kast")).toBeVisible();
  return {context,page,calls,errors,revealLatestResult:()=>{latestResultVisible=true;}};
}
async function finish150(page,{expectWinner=true}={}){
  const keypad=page.locator(".keypad");
  for(const digit of ["1","5","0"]) await keypad.getByRole("button",{name:digit,exact:true}).click();
  await keypad.getByRole("button",{name:"Lagre",exact:true}).click();
  await expect(page.getByRole("dialog",{name:"Antall checkout-piler"})).toBeVisible();
  const dialog=page.getByRole("dialog",{name:"Antall checkout-piler"});
  await expect(dialog.getByRole("button",{name:"1 pil",exact:true})).toBeDisabled();
  await expect(dialog.getByRole("button",{name:"2 piler",exact:true})).toBeDisabled();
  await expect(dialog.getByRole("button",{name:"3 piler",exact:true})).toBeEnabled();
  await dialog.getByRole("button",{name:"3 piler",exact:true}).click();
  if(expectWinner) await expect(page.getByText("Anna Langnes vinner")).toBeVisible({timeout:12000});
  else await expect(page.getByText("Bekrefter kampen …")).toBeVisible({timeout:12000});
}
test("150 checkout cannot claim 1 dart and manual next skips the reservation hold",async({browser})=>{
  const {context,page,calls,errors}=await boot(browser);
  try{
    await finish150(page);
    await page.getByRole("button",{name:"Vis neste kamp nå"}).click();
    await expect(page.getByRole("button",{name:"Start kamp",exact:true})).toBeVisible({timeout:12000});
    await expect(page.locator(".assigned-view")).toContainText("Gruppe B · Runde 2");
    await expect(page.getByText("Anna Langnes vinner")).toHaveCount(0);
    // Wait beyond normal status polling. The previous winner must stay dismissed.
    await page.waitForTimeout(3200);
    await expect(page.getByText("Anna Langnes vinner")).toHaveCount(0);
    const manual=calls.filter(c=>c.method==="POST"&&c.p.endsWith("/next-match")&&c.body.advance_now===true);
    expect(manual).toHaveLength(1);
    const checkout=calls.find(c=>c.method==="POST"&&c.p.endsWith("/visit"));
    expect(checkout?.body.darts_used).toBe(3);
    expect(errors).toEqual([]);
  } finally {await context.close();}
});

test("no ready match after checkout shows idle instead of resurrecting the old winner",async({browser})=>{
  const {context,page,calls,errors}=await boot(browser,{nextAssigned:false});
  try {
    await finish150(page);
    await page.getByRole("button",{name:"Vis neste kamp nå"}).click();
    await expect(page.getByText("Venter på kamp i aktiv turnering")).toBeVisible({timeout:12000});
    await page.waitForTimeout(3200);
    await expect(page.getByText("Anna Langnes vinner")).toHaveCount(0);
    expect(calls.some(c=>c.method==="POST"&&c.p.endsWith("/next-match")&&c.body.advance_now===true)).toBe(true);
    expect(errors).toEqual([]);
  } finally {await context.close();}
});


test("an older completed match cannot confirm the current checkout or unlock next match",async({browser})=>{
  const {context,page,calls,errors,revealLatestResult}=await boot(browser,{staleCompletedMatch:true});
  try {
    await finish150(page,{expectWinner:false});
    // Wait until the stale post-match payload is actually served; a transient
    // local pending screen alone would not prove the canonical-ID safeguard.
    await expect.poll(()=>calls.filter(c=>c.method==="GET"&&c.p.endsWith("/post-match")).length,
      {timeout:12000}).toBeGreaterThan(0);
    await page.waitForTimeout(400);
    await expect(page.getByText("Bekrefter kampen …")).toBeVisible();
    await expect(page.getByRole("button",{name:"Vis neste kamp nå"})).toBeDisabled();
    await expect(page.getByText("Cecilie Eide vinner")).toHaveCount(0);
    expect(calls.filter(c=>c.method==="POST"&&c.p.endsWith("/next-match"))).toHaveLength(0);

    // Canonical completion for match 42 becomes visible on the next poll.
    revealLatestResult();
    await expect(page.getByText("Anna Langnes vinner")).toBeVisible({timeout:12000});
    await expect(page.getByRole("button",{name:"Vis neste kamp nå"})).toBeEnabled();
    expect(errors).toEqual([]);
  } finally {await context.close();}
});
