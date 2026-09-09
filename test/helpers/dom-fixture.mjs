// Small event-driven DOM fixture for unit tests when no browser is installed.
// It models only the DOM operations used by these prompt/selection tests.
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

class FixtureEvent {
  constructor(type, options = {}) { this.type = type; Object.assign(this, options); }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this.stopped = true; }
}
const split = (selector) => selector.match(/(?:\[[^\]]*\]|[^,])+/g) || [];
function simple(node, selector) {
  selector = selector.trim();
  if (!selector || selector === '*') return true;
  if (selector.startsWith(':scope')) return false;
  let ok = true;
  selector = selector.replace(/:not\(([^)]+)\)/g, (_, inner) => { if (simple(node, inner)) ok = false; return ''; });
  selector = selector.replace(/\[([\w-]+)(?:(\*=|\^=|=)["']?([^"'\]]*?)["']?(?:\s+(i))?)?\]/g,
    (_, attr, op, value, insensitive) => {
      let actual = node.getAttribute(attr);
      if (actual === null) { ok = false; return ''; }
      if (insensitive) { actual = actual.toLowerCase(); value = value.toLowerCase(); }
      if (op === '=' && actual !== value || op === '*=' && !actual.includes(value) || op === '^=' && !actual.startsWith(value)) ok = false;
      return '';
    });
  selector = selector.replace(/\.([\w-]+)/g, (_, name) => { if (!node.classList.contains(name)) ok = false; return ''; });
  selector = selector.replace(/#([\w-]+)/g, (_, id) => { if (node.id !== id) ok = false; return ''; });
  return ok && (!selector.trim() || node.tagName === selector.trim().toUpperCase());
}
function matches(node, selector) {
  return split(selector).some((part) => {
    
    // Split descendant selectors while retaining spaces inside attributes.
    const tokens = part.trim().match(/(?:\[[^\]]*\]|[^\s])+/g) || [];
    if (!tokens.length || !simple(node, tokens.pop())) return false;
    let parent = node.parentElement;
    while (tokens.length) {
      const token = tokens.pop();
      while (parent && !simple(parent, token)) parent = parent.parentElement;
      if (!parent) return false;
      parent = parent.parentElement;
    }
    return true;
  });
}
export class FixtureNode {
  constructor(tag = 'div', attrs = {}, text = '') {
    this.nodeType = 1; this.tagName = tag.toUpperCase(); this.attrs = { ...attrs };
    this.children = []; this.parentElement = null; this._text = text; this._value = '';
    this.events = []; this.listeners = new Map(); this.dataset = {};
    this.type = attrs.type || (tag === 'button' ? 'button' : 'text'); this.disabled = false; this.checked = false;
    this.classList = { contains: (x) => this.className.split(/\s+/).includes(x), add: (...xs) => this.className = [...new Set([...this.className.split(/\s+/), ...xs])].join(' '), remove: (...xs) => this.className = this.className.split(/\s+/).filter((x) => !xs.includes(x)).join(' ') };
  }
  get id() { return this.attrs.id || ''; } set id(v) { this.attrs.id = v; }
  get className() { return this.attrs.class || ''; } set className(v) { this.attrs.class = v; }
  get textContent() { return this._text + this.children.map((n) => n.textContent).join(''); }
  set textContent(v) { this._text = String(v); this.replaceChildren(); }
  get innerText() { return this.textContent; }
  get childElementCount() { return this.children.length; }
  get options() { return this.tagName === 'SELECT' ? this.querySelectorAll('option') : undefined; }
  get value() { return this.tagName === 'SELECT' ? this.options[this.selectedIndex ?? 0]?.value || '' : this._value; }
  set value(v) { if (this.tagName === 'SELECT') this.selectedIndex = this.options.findIndex((o) => o.value === String(v)); else this._value = String(v); }
  getAttribute(k) { return k in this.attrs ? String(this.attrs[k]) : null; }
  hasAttribute(k) { return k in this.attrs; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  removeAttribute(k) { delete this.attrs[k]; }
  appendChild(node) { node.remove(); this.children.push(node); node.parentElement = this; return node; }
  append(...nodes) { nodes.forEach((n) => this.appendChild(n)); }
  replaceChildren(...nodes) { this.children.forEach((n) => n.parentElement = null); this.children = []; this.append(...nodes); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((n) => n !== this); this.parentElement = null; }
  contains(node) { return node === this || this.children.some((n) => n.contains(node)); }
  matches(selector) { return matches(this, selector); }
  closest(selector) { for (let n = this; n; n = n.parentElement) if (n.matches(selector)) return n; return null; }
  querySelectorAll(selector) { return this.children.flatMap((n) => [...(n.matches(selector) ? [n] : []), ...n.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  getElementsByTagName(tag) { return this.querySelectorAll(tag); }
  cloneNode(deep) { const copy = new FixtureNode(this.tagName, this.attrs, this._text); if (deep) this.children.forEach((n) => copy.appendChild(n.cloneNode(true))); return copy; }
  getBoundingClientRect() { const hidden = this.hidden || this.closest('[hidden]'); return { width: hidden ? 0 : 120, height: hidden ? 0 : 24, top: 0, bottom: 24, left: 0, right: 120 }; }
  scrollIntoView() {} focus() {} blur() {} select() {}
  compareDocumentPosition() { return 4; }
  addEventListener(type, fn) { const list = this.listeners.get(type) || []; list.push(fn); this.listeners.set(type, list); }
  removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter((f) => f !== fn)); }
  dispatchEvent(event) { this.events.push(event.type); event.target ||= this; event.currentTarget = this; for (const fn of this.listeners.get(event.type) || []) fn(event); if (event.bubbles && !event.stopped) this.parentElement?.dispatchEvent(event); return !event.defaultPrevented; }
  click() { if (this.disabled) return; if (this.type === 'checkbox' || this.type === 'radio') this.checked = !this.checked; this.dispatchEvent(new FixtureEvent('click', { bubbles: true })); }
}
export function boot() {
  const doc = new FixtureNode('document'); doc.nodeType = 9; doc.readyState = 'loading';
  doc.documentElement = doc.appendChild(new FixtureNode('html'));
  doc.body = doc.documentElement.appendChild(new FixtureNode('body'));
  doc.getElementById = (id) => doc.querySelectorAll('*').find((n) => n.id === id) || null;
  doc.createElement = (tag) => new FixtureNode(tag);
  doc.execCommand = () => false;
  const sentMessages = [];
  const context = { document: doc, console, setTimeout, clearTimeout, setInterval: (...args) => { const timer = setInterval(...args); timer.unref(); return timer; }, clearInterval, URL,
    performance, location: { hostname: 'fixture.test', pathname: '/apply', href: 'https://fixture.test/apply', search: '' },
    Event: FixtureEvent, KeyboardEvent: FixtureEvent, MouseEvent: FixtureEvent, FocusEvent: FixtureEvent, CustomEvent: FixtureEvent,
    Node: { DOCUMENT_POSITION_FOLLOWING: 4 }, CSS: { escape: (x) => x },
    HTMLInputElement: class {}, HTMLSelectElement: class {}, HTMLTextAreaElement: class {},
    getComputedStyle: (n) => ({ display: n.hidden ? 'none' : 'block', visibility: 'visible', opacity: '1' }),
    chrome: { runtime: { onMessage: { addListener() {} }, sendMessage(msg, cb) { sentMessages.push(msg); cb?.({ ok: false }); } } },
    __ZAPPLY_TEST: true, innerHeight: 1000, innerWidth: 1400, addEventListener() {} };
  context.window = context; context.top = context; context.globalThis = context;
  vm.createContext(context);
  for (const file of ['lib/field-map.js', 'lib/matcher.js', 'lib/ats.js', 'content/autofill.js'])
    vm.runInContext(readFileSync(new URL('../../extension/' + file, import.meta.url), 'utf8'), context);
  return { context, doc, M: context.ZAPPLY_MATCHER, rules: context.ZAPPLY_FIELD_MAP, app: context.__zapply, sentMessages };
}
export function select(doc, labels, attrs = {}) {
  const el = doc.body.appendChild(new FixtureNode('select', attrs));
  labels.forEach((label, index) => { const option = new FixtureNode('option', {}, label); option.value = index ? label : ''; option.index = index; el.append(option); });
  el.selectedIndex = 0;
  return el;
}
