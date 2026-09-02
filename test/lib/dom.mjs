/**
 * A DOM small enough to run the matcher against, and no larger.
 *
 * Four of the suites in this directory grew their own throwaway version of this,
 * each slightly different, which meant a fixture that passed in one could fail
 * in another for reasons that had nothing to do with the code under test. This
 * is the one implementation they all use.
 *
 * It implements only what `matcher.js` actually calls: attribute reads, the
 * ancestor walk, `closest`, `querySelector(All)` for a useful subset of
 * selectors, and the value-setting surface. It is not a browser and is not
 * trying to be — anything needing real layout or real events belongs in a
 * browser test, not here.
 */

let sequence = 0;

export class El {
  constructor(tag, attrs = {}, children = []) {
    this.tagName = String(tag).toUpperCase();
    this.attrs = { ...attrs };
    this.children = [];
    this.parentElement = null;
    this.order = sequence++;
    this.events = [];
    this._text = "";
    this.isContentEditable = attrs.contenteditable === "true";
    this.disabled = false;
    children.forEach((c) => this.append(c));

    if (this.tagName === "SELECT") this.selectedIndex = 0;
    else this.value = "";
  }

  append(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  /* ---- attributes ---- */
  getAttribute(name) {
    if (name === "type" && this.attrs.type === undefined && this.tagName === "INPUT") return "text";
    return this.attrs[name] ?? null;
  }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  hasAttribute(name) { return name in this.attrs; }

  get type() { return this.attrs.type ?? (this.tagName === "INPUT" ? "text" : ""); }
  get id() { return this.attrs.id ?? ""; }
  get name() { return this.attrs.name ?? ""; }
  get maxLength() { return Number(this.attrs.maxlength ?? 0) || 0; }
  get required() { return this.attrs.required === "true" || this.attrs.required === ""; }

  /* ---- text ---- */
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() {
    if (this.children.length) return this.children.map((c) => c.textContent).join(" ");
    return this._text;
  }

  /* ---- tree ---- */
  get descendants() { return this.children.flatMap((c) => [c, ...c.descendants]); }

  contains(other) {
    let node = other;
    while (node) { if (node === this) return true; node = node.parentElement; }
    return false;
  }

  compareDocumentPosition(other) {
    return other.order > this.order ? 4 : other.order < this.order ? 2 : 0;
  }

  /** Supports the selector forms the matcher actually uses. */
  matches(selector) {
    const sel = selector.trim();
    if (sel === "*") return true;

    const tagOnly = sel.match(/^([a-z0-9]+)$/i);
    if (tagOnly) return this.tagName === tagOnly[1].toUpperCase();

    const attrStar = sel.match(/\[([a-z-]+)\*=["']([^"']+)["']\s*i?\]/i);
    if (attrStar) {
      const value = String(this.attrs[attrStar[1]] ?? "").toLowerCase();
      if (!value.includes(attrStar[2].toLowerCase())) return false;
    }

    const attrEq = sel.match(/\[([a-z-]+)=["']([^"']+)["']\s*i?\]/i);
    if (attrEq && !attrStar) {
      const value = String(this.attrs[attrEq[1]] ?? "").toLowerCase();
      if (value !== attrEq[2].toLowerCase()) return false;
    }

    const tagPrefix = sel.match(/^([a-z0-9]+)\[/i);
    if (tagPrefix && this.tagName !== tagPrefix[1].toUpperCase()) return false;

    const cls = sel.match(/^\.([\w-]+)$/);
    if (cls) return String(this.attrs.class ?? "").split(/\s+/).includes(cls[1]);

    return Boolean(attrStar || attrEq || tagPrefix);
  }

  querySelectorAll(selector) {
    const parts = String(selector).split(",").map((s) => s.trim()).filter(Boolean);
    return this.descendants.filter((node) => parts.some((p) => node.matches(p)));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }

  closest(selector) {
    const parts = String(selector).split(",").map((s) => s.trim()).filter(Boolean);
    let node = this;
    while (node) {
      if (parts.some((p) => node.matches(p))) return node;
      node = node.parentElement;
    }
    return null;
  }

  /* ---- interaction surface ---- */
  focus() {}
  blur() {}
  click() { this.events.push("click"); }
  select() {}
  setSelectionRange() {}
  scrollIntoView() {}
  dispatchEvent(e) { this.events.push(e?.type ?? String(e)); return true; }
  getBoundingClientRect() { return { top: 0, left: 0, width: 200, height: 30, bottom: 30, right: 200 }; }
}

/** A `<select>` whose `.value` moves `selectedIndex`, as a real one does. */
export function makeSelect(optionTexts, attrs = {}) {
  const node = new El("select", attrs);
  node.options = optionTexts.map((t, i) => ({ textContent: t, value: t, index: i, getAttribute: () => null }));
  Object.defineProperty(node, "value", {
    get() { return node.options[node.selectedIndex]?.value ?? ""; },
    set(v) {
      const i = node.options.findIndex((o) => o.value === v);
      if (i !== -1) node.selectedIndex = i;
    },
    configurable: true,
  });
  return node;
}

/** The globals `matcher.js` and `field-map.js` expect to find. */
export function makeWindow(root) {
  const win = {
    document: {
      documentElement: root,
      body: root,
      addEventListener() {},
      getElementById: (id) => root.descendants.find((n) => n.attrs.id === id) ?? null,
      querySelector: (s) => root.querySelector(s),
      querySelectorAll: (s) => root.querySelectorAll(s),
      execCommand: () => false,
      contains: (n) => root.contains(n),
    },
    setTimeout, clearTimeout, console,
    HTMLInputElement: class {}, HTMLTextAreaElement: class {}, HTMLSelectElement: class {},
    Event: class { constructor(t) { this.type = t; } },
    KeyboardEvent: class { constructor(t) { this.type = t; } },
    MouseEvent: class { constructor(t) { this.type = t; } },
    FocusEvent: class { constructor(t) { this.type = t; } },
    CSS: { escape: (s) => String(s).replace(/["\\]/g, "\\$&") },
    Node: { DOCUMENT_POSITION_FOLLOWING: 4, DOCUMENT_POSITION_PRECEDING: 2 },
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
  };
  win.window = win;
  win.globalThis = win;
  return win;
}

/**
 * Rebuild a captured fixture as a tree.
 *
 * Each field becomes a control inside a wrapper carrying its label and heading,
 * which is the structure `deriveLabel` walks. The fixture stores no values, so
 * nothing here can reintroduce one.
 */
export function buildFixture(fixture) {
  const root = new El("form");
  const controls = [];

  let currentHeading = null;
  for (const field of fixture.fields ?? []) {
    if (field.heading && field.heading !== currentHeading?.text) {
      currentHeading = { text: field.heading, node: root.append(new El("section")) };
      const h = currentHeading.node.append(new El("h3"));
      h.textContent = field.heading;
    }
    const parent = currentHeading?.node ?? root;
    const wrapper = parent.append(new El("div"));

    if (field.label) {
      const label = wrapper.append(new El("label"));
      // The fixture's label is the derived one, which already includes the
      // heading; only the field's own part belongs on the <label>.
      label.textContent = String(field.label).split("|")[0].trim();
    }

    const control =
      field.tag === "select"
        ? makeSelect(field.options ?? [], field.attrs)
        : new El(field.tag, field.attrs);
    wrapper.append(control);
    controls.push({ el: control, field });
  }

  return { root, controls };
}
