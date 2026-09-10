import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';

// Uses Playwright's installed browser by default; CI may supply its own binary.
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setContent(`
    <form><label for="name">First Name</label><input id="name">
    <label for="source">How Did You Hear About Us?</label>
    <button type="button" id="source" aria-haspopup="listbox"
      aria-controls="choices" aria-expanded="false">Select</button>
    <div id="choices" role="listbox"></div></form>`);
  await page.evaluate(() => {
    window.accepted = { name: '', source: '', submissions: 0 };
    const name = document.querySelector('#name');
    name.addEventListener('input', () => { window.accepted.name = name.value; });
    document.querySelector('form').addEventListener('submit', event => {
      event.preventDefault(); window.accepted.submissions++;
    });
    const source = document.querySelector('#source');
    const menu = document.querySelector('#choices');
    function close() { menu.replaceChildren(); source.setAttribute('aria-expanded', 'false'); }
    function option(text, parent, action) {
      const node = document.createElement('div');
      node.setAttribute('role', 'option'); node.textContent = text;
      if (parent) node.setAttribute('aria-expanded', 'false');
      node.addEventListener('click', action); menu.append(node);
    }
    source.addEventListener('click', () => {
      if (source.getAttribute('aria-expanded') === 'true') return close();
      source.setAttribute('aria-expanded', 'true');
      option('Job Board', true, () => {
        menu.replaceChildren(); menu.setAttribute('aria-busy', 'true');
        setTimeout(() => {
          menu.removeAttribute('aria-busy');
          option('LinkedIn', false, () => {
            window.accepted.source = 'LinkedIn'; source.textContent = 'LinkedIn'; close();
          });
        }, 1100);
      });
    });
    source.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
  });
  await page.addScriptTag({ content: await readFile(new URL('../extension/lib/matcher.js', import.meta.url), 'utf8') });
  const result = await page.evaluate(async () => {
    const m = window.ZAPPLY_MATCHER;
    m.beginFillSession();
    return {
      name: m.setTextValue(document.querySelector('#name'), 'Test'),
      source: await m.setComboboxValue(document.querySelector('#source'), 'LinkedIn', 450, {}, 'How Did You Hear About Us?'),
    };
  });
  assert.deepEqual(result, { name: true, source: true });
  assert.deepEqual(await page.evaluate(() => window.accepted), { name: 'Test', source: 'LinkedIn', submissions: 0 });
  assert.equal(await page.locator('[role="option"]').count(), 0);
  assert.deepEqual(errors, []);
  console.log('PASS browser: delayed source selection, committed values, closed menu, no submission or page errors');
} finally {
  await browser.close();
}
