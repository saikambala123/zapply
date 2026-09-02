/**
 * ZAPPLY FORM CAPTURE
 * -------------------
 * Turns the application form on screen into an anonymised skeleton that can be
 * replayed in a test.
 *
 * Every accuracy bug in this project was diagnosed from a photograph of a
 * screen. That is a slow way to work and an unreliable one — I misread the same
 * Workday field twice because I was reasoning about markup I could not see. A
 * fixture is the fix: capture the shape of the form once, and every future
 * change can be checked against it in a second, forever, without anyone opening
 * a browser.
 *
 * WHAT IS CAPTURED
 *   the structure, and the attributes the matcher reads to identify a field:
 *   tag, type, role, name, id, automation ids, aria labels, placeholders,
 *   maxlength, required, the label text, section headings, and the option text
 *   of dropdowns and radio groups.
 *
 * WHAT IS NOT CAPTURED
 *   any value. Not typed text, not a selected option, not a checked box, not a
 *   file name. A fixture describes the *questions* a form asks, never the
 *   answers a person gave it — which means a capture is safe to keep, safe to
 *   attach to a bug report, and safe to commit to a repository.
 *
 * `value`, `checked` and `selectedIndex` are never read here. That is not an
 * oversight to be tidied up later; it is the property that makes the whole
 * mechanism shareable, and there is a test asserting it holds.
 */
(function (global) {
  "use strict";

  /** Attributes the matcher uses to work out what a field is. */
  const KEPT_ATTRIBUTES = [
    "type", "role", "name", "id", "placeholder", "maxlength", "required",
    "aria-label", "aria-labelledby", "aria-describedby", "aria-required",
    "aria-invalid", "aria-valuemax", "data-automation-id", "for",
  ];

  const FIELD_SELECTOR = "input, select, textarea, [contenteditable='true'], [role='combobox'], [role='spinbutton']";

  const text = (node) => String(node?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 300);

  function attributesOf(el) {
    const out = {};
    for (const name of KEPT_ATTRIBUTES) {
      const value = el.getAttribute?.(name);
      if (value !== null && value !== undefined && value !== "") out[name] = String(value).slice(0, 200);
    }
    return out;
  }

  /**
   * Option text for a choice control.
   *
   * The text is the question's vocabulary, not the applicant's answer — which is
   * why it is safe to keep, and necessary: half the bugs in this project were an
   * answer landing on the wrong option, and a fixture without the option list
   * cannot reproduce them.
   */
  function optionsOf(el) {
    try {
      if (el.tagName === "SELECT") {
        return Array.from(el.options ?? []).map((o) => text(o)).filter(Boolean).slice(0, 60);
      }
      const group = el.getAttribute?.("name")
        ? document.querySelectorAll(`input[name="${CSS.escape(el.getAttribute("name"))}"]`)
        : [];
      if (group.length > 1) {
        return Array.from(group)
          .map((r) => text(r.closest("label") || r.parentElement))
          .filter(Boolean)
          .slice(0, 60);
      }
    } catch {}
    return [];
  }

  /** The nearest heading above this field, which is how rows are numbered. */
  function headingFor(el) {
    let node = el.parentElement;
    for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) {
      const heading = node.querySelector?.("h1, h2, h3, h4, h5, legend");
      if (heading) {
        const value = text(heading);
        if (value) return value.slice(0, 160);
      }
    }
    return "";
  }

  function captureForm() {
    const seen = new Set();
    const fields = [];

    for (const el of document.querySelectorAll(FIELD_SELECTOR)) {
      if (seen.has(el)) continue;
      seen.add(el);

      // Hidden and disabled controls are not part of the question set.
      const type = String(el.getAttribute?.("type") ?? "").toLowerCase();
      if (type === "hidden" || el.disabled) continue;

      let label = "";
      try {
        label = global.ZAPPLY_MATCHER?.deriveLabel?.(el) ?? "";
      } catch {}

      fields.push({
        tag: el.tagName.toLowerCase(),
        attrs: attributesOf(el),
        label: String(label).slice(0, 500),
        heading: headingFor(el),
        options: optionsOf(el),
        // Depth is enough to reconstruct which fields share a row without
        // shipping the surrounding markup.
        depth: (() => { let d = 0, n = el; while (n.parentElement && d < 40) { n = n.parentElement; d++; } return d; })(),
      });
    }

    return {
      version: 1,
      capturedAt: new Date().toISOString(),
      ats: global.ZAPPLY_ATS?.detect?.()?.key ?? "unknown",
      // The path identifies the form; the query string can carry a session id,
      // so it is dropped.
      page: `${location.hostname}${location.pathname}`,
      fieldCount: fields.length,
      fields,
    };
  }

  global.ZAPPLY_CAPTURE = { captureForm };
})(typeof window !== "undefined" ? window : globalThis);
