import { expect, test } from "@playwright/test";

// Real shared stylesheet loaded after local component styles, like in the portal.
const html = [
  '<!doctype html><html lang="no"><head><meta name="viewport" content="width=device-width,initial-scale=1">',
  '<style>.dark-panel{background:#0b2b50;color:#fff;padding:22px;display:grid;gap:10px}',
  '.dark-panel .eyebrow,.dark-panel .muted{color:#fff}',
  '.dark-panel .button{display:inline-flex;width:max-content;align-items:center}',
  '.white-panel{background:#fff;color:#0c2340;padding:20px}</style></head><body>',
  '<section class="dark-panel">',
  '<h1 id="contrast-heading">Blindleia Dartklubb</h1>',
  '<h2 id="contrast-subheading">Pågående turnering</h2>',
  '<p id="contrast-eyebrow" class="eyebrow">Klubbadmin</p>',
  '<p id="contrast-muted" class="muted">Velg skive</p>',
  '<button id="contrast-cta" class="button"><strong id="contrast-cta-label">Start innsjekk</strong></button>',
  '<p><strong id="contrast-strong">Fire spillere sjekket inn</strong></p>',
  '</section><section class="white-panel">',
  '<p class="muted" id="regular-muted">Nedtonet tekst på lyst underlag</p>',
  '</section></body></html>',
].join("");

const rgb = value => {
  const channels = value.match(/[\d.]+/g)?.slice(0, 3).map(Number);
  if (!channels || channels.length !== 3) throw Error("Expected RGB: " + value);
  return channels;
};
const luminance = value => {
  const [r,g,b] = rgb(value).map(c => {
    const n=c/255;
    return n<=0.04045 ? n/12.92 : ((n+0.055)/1.055)**2.4;
  });
  return 0.2126*r+0.7152*g+0.0722*b;
};
const ratio = (x,y) => {
  const a=luminance(x),b=luminance(y);
  return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
};

for(const surface of ["admin","player","live","kiosk"]){
  test("Shared foreground contrast on blue surfaces: " + surface, async ({page}) => {
    await page.setViewportSize({width:390,height:844});
    await page.setContent(html.replace("<body>", '<body data-bd-surface="' + surface + '">'));
    await page.addStyleTag({path:"packages/ui-assets/blindleia-system.css"});
    const foreground=await page.locator(".dark-panel").evaluate(el=>getComputedStyle(el).color);
    const background=await page.locator(".dark-panel").evaluate(el=>getComputedStyle(el).backgroundColor);
    for(const id of ["contrast-heading","contrast-subheading","contrast-eyebrow","contrast-muted","contrast-strong"]){
      const color=await page.locator("#"+id).evaluate(el=>getComputedStyle(el).color);
      expect(color,id+" inherits white from navy").toBe(foreground);
      expect(ratio(color,background),id+" has enough contrast").toBeGreaterThanOrEqual(4.5);
    }
    const buttonBg=await page.locator("#contrast-cta").evaluate(el=>getComputedStyle(el).backgroundColor);
    const buttonFg=await page.locator("#contrast-cta").evaluate(el=>getComputedStyle(el).color);
    const labelFg=await page.locator("#contrast-cta-label").evaluate(el=>getComputedStyle(el).color);
    expect(labelFg,"Strong inside primary button inherits white").toBe(buttonFg);
    expect(ratio(labelFg,buttonBg),"Primary button has adequate contrast").toBeGreaterThanOrEqual(4.5);
    const muted=await page.locator("#regular-muted").evaluate(el=>getComputedStyle(el).color);
    expect(ratio(muted,"rgb(255, 255, 255)")).toBeGreaterThanOrEqual(4.5);
  });
}
