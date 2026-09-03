import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync('apps/kiosk/scolia-fallback-manual.js', 'utf8');
let hidden = false;
const fallbackNotice = {
  classList: {
    contains(name) {
      assert.equal(name, 'hidden');
      return hidden;
    },
  },
};
const context = {
  document: {
    getElementById(id) {
      assert.equal(id, 'scoliaFallbackNotice');
      return fallbackNotice;
    },
  },
  isManual: () => false,
};
vm.createContext(context);
vm.runInContext(source, context);

assert.equal(context.isManual(), true, 'Visible Scolia fallback must enable manual Sum/Per-pil submit.');
hidden = true;
assert.equal(context.isManual(), false, 'Hidden fallback must preserve canonical Scolia scoring mode.');
context.isManual = () => true;
hidden = false;
vm.runInContext(source, context);
assert.equal(context.isManual(), true, 'Native manual boards must remain manual.');

console.log('Scolia fallback manual submit contract OK');
