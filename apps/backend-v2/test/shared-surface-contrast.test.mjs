import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const css = fs.readFileSync("packages/ui-assets/blindleia-system.css", "utf8");

function luminance(hex) {
  const channels = hex.replace("#", "").match(/.{2}/g).map(v => Number.parseInt(v, 16) / 255)
    .map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}
function contrast(a, b) {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

test("shared typography inherits foreground from colored components", () => {
  // The old selector repainted every strong and heading dark on top of blue CTA
  // surfaces, regardless of the actual foreground of the containing component.
  assert.doesNotMatch(css, /body\[data-bd-surface\] strong\s*\{/);
  const headingStyle = css.match(/body\[data-bd-surface\] h1,[\s\S]*?h4\s*\{([^}]*)\}/)?.[1] || "";
  assert.doesNotMatch(headingStyle, /(?:^|;)\s*color\s*:/);
  assert.doesNotMatch(css, /body\[data-bd-surface\] \.muted\s*\{/);
  assert.doesNotMatch(css, /body\[data-bd-surface\] \.eyebrow\s*\{/);
  assert.match(css, /\.muted\{color:var\(--bd-muted\)\}/);
  assert.match(css, /\.eyebrow\{[^}]*color:var\(--bd-blue-600\)/);
});

test("shared palette meets WCAG AA for normal text on white and primary blue", () => {
  const blue = css.match(/--bd-blue-600:(#[0-9a-f]{6})/i)?.[1];
  const muted = css.match(/--bd-muted:(#[0-9a-f]{6})/i)?.[1];
  assert.ok(blue && muted);
  assert.ok(contrast(blue, "#ffffff") >= 4.5, "white text on branded blue CTA");
  assert.ok(contrast(muted, "#ffffff") >= 4.5, "muted text on light cards");
});
