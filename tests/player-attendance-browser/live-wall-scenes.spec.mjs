import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

// This serves the real Live HTML/CSS/JS and only mocks read-side JSON.
// No pairing, kiosk POST, database write or physical board can be touched.
const origin = "http://127.0.0.1:4194";
const root = process.cwd();
const rows = (prefix) => Array.from({length: 7}, (_,i) => ({
  position:i+1,display_name:prefix+" spiller "+(i+1),
  played:2,wins:i<2?2:0,draws:0,losses:i<2?0:2,
  leg_diff:i<2?2:-2,three_dart_average:44+i*2,points:i<2?4:0,
}));
const liveData = {
  club:{id:7,name:"Blindleia Dartklubb",slug:"blindleia-dartklubb"},
  tournament:{id:55,name:"Septemberkast",status:"in_progress",start_at:"2026-11-05 18:30:00"},
  progress:{completed:6,total:42,in_progress:3,assigned:1,pending:32,percent:14},
  boards:[1,2,3,4].map((n)=>({
    board_number:n,
    live_match:{status:n===3?"assigned":"in_progress",current_player_id:1,best_of_legs:1,leg_number:1,
      round_label:"Gruppe A · Runde 2",
      player_a:{id:1,display_name:"Sven Einar Davidsen",remaining:200+n,legs_won:0},
      player_b:{id:2,display_name:"Jon-Henning Næss",remaining:320+n,legs_won:0}},
  })),
  next_matches:Array.from({length:5},(_,n)=>({player_a_name:"Spiller "+(n+1),player_b_name:"Motspiller "+(n+1),round_label:"Gruppe B · Runde 3"})),
  recent_results:Array.from({length:3},(_,n)=>({winner_name:"Vinner "+(n+1),player_a_name:"Vinner "+(n+1),player_b_name:"Taper "+(n+1),round_label:"Gruppe A · Runde 2",legs_a:1,legs_b:0})),
  tables:{groups:[{name:"Gruppe A",rows:rows("A")},{name:"Gruppe B",rows:rows("B")}]},
  elo:Array.from({length:6},(_,i)=>({position:i+1,display_name:"ELO spiller "+(i+1),elo_rating:1200-i*20,elo_matches_played:15,tournament_elo_delta:12-i})),
  highlights:{highest_checkout:120,score_180:2,best_average:58.2},
  playoff:null,
};
const highlights = {
  top_visits:[{display_name:"Sven Einar Davidsen",score:180},{display_name:"Thomas Kildal",score:171},{display_name:"Magnus Knudsen",score:160}],
  top_checkouts:[{display_name:"Kjell Moyle",checkout:120},{display_name:"Andreas Hasselgård",checkout:88},{display_name:"Andre Kendrick",checkout:70}],
  top_three_dart_averages:[{display_name:"Thomas Kildal",three_dart_average:65},{display_name:"Bjørn Jarle Jahnsen",three_dart_average:60},{display_name:"Tormod Haga",three_dart_average:58}],
};

async function mountLive(page, size) {
  await page.setViewportSize(size);
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    if (p === "/live/1234") {
      return route.fulfill({contentType:"text/html",body:fs.readFileSync(path.join(root,"apps/live/index.html"),"utf8")});
    }
    if (p.startsWith("/api/")) {
      const data = p.endsWith("/club-live.php")
        ? {club:{id:7,name:"Blindleia Dartklubb",slug:"blindleia-dartklubb",live_display_profile:"blindleia"}}
        : p.endsWith("/check-in-display") ? {active:false}
        : p.endsWith("/live-highlights") ? highlights
        : p.endsWith("/realtime/config") ? {enabled:false}
        : p.endsWith("/live") ? liveData : {};
      return route.fulfill({contentType:"application/json",body:JSON.stringify({ok:true,data})});
    }
    const safe = p.replace(/^\/+/,"");
    const file = path.resolve(root, safe.startsWith("live/")?"apps/"+safe:safe);
    if (file.startsWith(root) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      const contentType=file.endsWith(".css")?"text/css":file.endsWith(".js")?"application/javascript":file.endsWith(".svg")?"image/svg+xml":file.endsWith(".png")?"image/png":"text/plain";
      return route.fulfill({contentType,body:fs.readFileSync(file)});
    }
    return route.fulfill({status:404,body:"not in local read-only fixture"});
  });
  const response=await page.goto(origin+"/live/1234");
  expect(response?.ok()).toBe(true);
  await expect(page.locator("body")).toHaveClass(/phase-live/,{timeout:12000});
  await expect(page.locator("#boards .board-card")).toHaveCount(4);
  await expect(page.locator("#tables .table-card")).toHaveCount(2);
}

test("large venue shows all original information through three readable scenes",async({page},testInfo)=>{
  const errors=[];
  page.on("pageerror",error=>errors.push(error.message));
  await mountLive(page,{width:1668,height:900});
  const nav=page.locator("#wallScenes");
  await expect(nav).toBeVisible();
  await expect(page.locator("#progressCards .stat-card")).toHaveCount(5);
  await expect(page.locator("#liveDashboard")).toHaveAttribute("data-wall-scene","arena");
  await expect(page.locator("#boards")).toBeVisible();
  await expect(page.locator("#queue")).toBeVisible();
  await expect(page.locator("#results")).toBeVisible();
  await expect(page.locator("#tables")).toBeHidden();
  await page.screenshot({path:testInfo.outputPath("arena.png"),animations:"disabled"});
  await nav.getByRole("button",{name:"Tabell og sluttspill"}).click();
  await expect(page.locator("#liveDashboard")).toHaveAttribute("data-wall-scene","tables");
  await expect(page.locator("#tables")).toBeVisible();
  await expect(page.locator("#tables .portal-table tbody tr")).toHaveCount(14);
  await expect(page.locator("#boards")).toBeHidden();
  await page.screenshot({path:testInfo.outputPath("tables.png"),animations:"disabled"});
  await nav.getByRole("button",{name:"Statistikk og ELO"}).click();
  await expect(page.locator("#elo")).toBeVisible();
  await expect(page.locator("#highlights")).toBeVisible();
  await expect(page.locator("#highlights .live-top3-block")).toHaveCount(3,{timeout:12000});
  await expect(page.locator("#boards")).toBeHidden();
  await page.screenshot({path:testInfo.outputPath("statistics.png"),animations:"disabled"});
  await nav.getByRole("button",{name:"Stopp automatisk rotasjon"}).click();
  await expect(nav.getByRole("button",{name:"Start automatisk rotasjon"})).toHaveAttribute("aria-pressed","true");
  // No data is duplicated/lost by scene switching.
  await expect(page.locator("#boards .board-card")).toHaveCount(4);
  await expect(page.locator("#tables .table-card")).toHaveCount(2);
  await expect(page.locator("#elo .list-row")).toHaveCount(6);
  expect(errors).toEqual([]);
});

test("phone keeps every section scrollable with no rotating-TV-only hiding",async({page})=>{
  await mountLive(page,{width:390,height:844});
  await expect(page.locator("#wallScenes")).toBeHidden();
  for (const id of ["#boards","#queue","#results","#tables","#elo","#highlights"]) {
    await expect(page.locator(id)).toBeVisible();
  }
  await expect(page.locator("#boards .board-card")).toHaveCount(4);
});
