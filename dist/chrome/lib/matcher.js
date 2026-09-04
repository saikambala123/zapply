/**
 * ZAPPLY MATCHER
 * --------------
 * Two jobs:
 *   1. Work out what a form field is actually asking (deriveLabel)
 *   2. Put a value into it so the page's own JS believes a human typed it (setValue)
 *
 * (2) is the part that breaks naive autofill tools. React, Vue and Angular
 * track input state internally; assigning `el.value = x` updates the DOM but
 * not the framework's state, so the value vanishes on submit. The fix is to
 * call the *native* value setter from the prototype, then dispatch the events
 * the framework listens for.
 *
 * Custom dropdowns are the other hard part, and the reason older builds
 * flickered. A portalled listbox renders at the end of <body>, nowhere near the
 * control that owns it, so "find the visible options" used to mean "search the
 * whole document". If a previous menu was still on screen, its options were
 * scored against the *next* field — which is how a Year got 2035 and a Country
 * got a neighbouring row's answer. Every menu interaction now goes through the
 * MENU registry below: exactly one menu is open at a time, its option nodes are
 * scoped to that menu, and the next field does not start until the menu has
 * actually closed.
 */

(function (global) {
  /* ------------------------------------------------------------------ */
  /*  Small helpers                                                      */
  /* ------------------------------------------------------------------ */

  const clean = (s) => (s || "").replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\s+/g, " ").replace(/[*✱]/g, "").trim();
  const norm = (s) => (s || "").toString().toLowerCase().replace(/\s+/g, " ").trim();
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Text of the element, ignoring nested inputs and hidden helper text. */
  function visibleText(el) {
    if (!el) return "";
    const clone = el.cloneNode(true);
    clone.querySelectorAll("input,select,textarea,button,svg,script,style").forEach((n) => n.remove());
    return clean(clone.textContent);
  }

  function onScreen(el) {
    if (!el?.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const h = window.innerHeight || document.documentElement.clientHeight;
    const w = window.innerWidth || document.documentElement.clientWidth;
    return r.bottom > 0 && r.top < h && r.right > 0 && r.left < w;
  }

  /**
   * Scrolling on every single field is what made the page visibly jump around
   * during a fill. Only move when the control is genuinely out of view, and
   * then by the smallest amount that brings it on screen.
   */
  function ensureVisible(el) {
    try {
      if (!el?.getBoundingClientRect) return;
      const r = el.getBoundingClientRect();
      const h = window.innerHeight || document.documentElement.clientHeight;
      if (r.height && r.top >= 8 && r.bottom <= h - 8) return;   // already comfortably visible
      el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    } catch {}
  }

  /* ------------------------------------------------------------------ */
  /*  Label derivation                                                   */
  /* ------------------------------------------------------------------ */

  const HEADING_SELECTOR =
    'h1, h2, h3, h4, h5, h6, legend, [role="heading"], ' +
    '[class*="sectionTitle"], [class*="section-title"], [class*="sectionHeader"], ' +
    '[class*="SectionTitle"], [class*="groupTitle"], [data-automation-id*="Title"], ' +
    '[data-automation-id*="title"], [data-automation-id="formLabel"]';

  /** Section names that change what a generic label like "Location" means. */
  const SECTION_WORDS =
    /\b(work\s*experience|employment|work\s*history|job\s*history|professional\s*experience|experience|education|school|university|college|academic|certification|licen[cs]e|language|reference|skill|address|contact|personal|voluntary|disclosure|application\s*question)\b/i;

  /**
   * Pulls a 1-based row number out of a section heading and returns it 0-based.
   *
   * ATSs number repeated blocks in every style there is:
   *   "Work Experience 2"   "Professional Experience (1)"   "Experience #3"
   *   "Employment 2 of 4"   "Education - 2"
   * The old parser only understood a bare trailing digit, so iCIMS's
   * parenthesised numbering silently produced index null for every row and all
   * of them fell back to the first job in the profile.
   */
  function headingIndex(text) {
    const t = clean(text);
    if (!t) return null;
    const patterns = [
      /(\d+)\s*(?:of|\/)\s*\d+\s*$/i,      // "2 of 4"
      /[(\[]\s*#?\s*(\d+)\s*[)\]]\s*$/,    // "(1)"  "[2]"
      /#\s*(\d+)\s*$/,                     // "#3"
      /[-–—:]\s*(\d+)\s*$/,                // "- 2"
      /(?:^|\s)(\d+)\s*$/,                 // "Work Experience 2"
    ];
    for (const re of patterns) {
      const m = t.match(re);
      if (m) {
        const n = Number(m[1]);
        if (Number.isFinite(n) && n >= 1 && n <= 40) return n - 1;
      }
    }
    return null;
  }

  const sectionCache = typeof WeakMap === "function" ? new WeakMap() : null;

  function sectionContext(el) {
    if (!el) return { title: "", index: null };
    const cached = sectionCache?.get(el);
    if (cached) return cached;
    const result = computeSectionContext(el);
    sectionCache?.set(el, result);
    return result;
  }

  /**
   * Is this heading a section header for the form, or just part of the page
   * around it?
   *
   * A job posting usually shows its own details beside the application —
   * "Location", "Department", and, fatally, "Employment Type / Full time". Those
   * headings share an ancestor with the form, sit before it in document order,
   * and match SECTION_WORDS, so they were accepted as the field's section. The
   * derived label for the Name box became "Name | Employment Type | name", the
   * employmentType rule (weight 12) beat fullName (weight 6), and the applicant
   * got "Full-time" written into their name and email.
   *
   * A heading only counts when it labels the fields themselves: either it sits
   * on the field's own ancestor path, or it is a sibling heading immediately
   * above them. A heading buried inside a separate block of content — a details
   * sidebar, a summary card — is page furniture and is ignored.
   */
  function headingOwnsField(heading, el) {
    let branch = heading;
    while (branch.parentElement && !branch.parentElement.contains(el)) branch = branch.parentElement;

    if (branch === heading) return true;      // a bare heading beside the fields
    if (branch.contains(el)) return true;     // on the field's own path

    // The heading is nested inside a sibling block. That block is a heading
    // wrapper if it carries nothing but the heading, and unrelated content —
    // the posting's details panel — if it carries more.
    const headingText = clean(heading.textContent) || "";
    const branchText = clean(branch.textContent) || "";
    return branchText.length <= headingText.length + 40;
  }

  function computeSectionContext(el) {
    let node = el.parentElement;

    const candidateText = (value) => {
      const text = clean(value);
      if (!text || text.length > 120) return null;
      if (!SECTION_WORDS.test(text)) return null;
      return text;
    };

    for (let depth = 0; node && depth < 14; depth++, node = node.parentElement) {
      if (node === document.body || node === document.documentElement) break;

      let headings;
      try {
        if (node.childElementCount > 0 && node.getElementsByTagName("*").length > 5000) break;
        headings = node.querySelectorAll(HEADING_SELECTOR);
      } catch { headings = []; }

      let nearest = null;
      for (const heading of headings) {
        if (heading.contains(el)) continue;
        const pos = heading.compareDocumentPosition(el);
        if (!(pos & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
        if (!headingOwnsField(heading, el)) continue;
        const text = candidateText(heading.textContent);
        if (text) nearest = text;
      }
      if (nearest) return { title: nearest, index: headingIndex(nearest) };

      // Fallback for Workday/custom ATS labels that are plain div/span text.
      try {
        const local = node.querySelectorAll(
          '[data-automation-id*="section"], [data-automation-id*="Section"], ' +
          '[class*="section"], [class*="Section"], [class*="group"], [class*="Group"], ' +
          'label, legend, h1, h2, h3, h4, h5, h6, p, span, div'
        );
        for (const item of local) {
          if (item.contains(el)) continue;
          const pos = item.compareDocumentPosition(el);
          if (!(pos & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
          if (!headingOwnsField(item, el)) continue;
          const text = candidateText(item.textContent);
          if (!text) continue;
          // Section labels are short. Reject paragraphs that merely mention the
          // words, but accept every numbering style the ATSs actually use.
          if (/^(?:work\s+experience|experience|employment|work\s+history|job\s+history|professional\s+experience|education|school|university|college)\s*(?:[-–—:#(\[]?\s*\d+\s*[)\]]?|\d+\s*(?:of|\/)\s*\d+)?$/i.test(text)) {
            nearest = text;
          }
        }
      } catch {}

      if (nearest) return { title: nearest, index: headingIndex(nearest) };
    }

    return { title: "", index: null };
  }

  /**
   * Which repeated block a field sits in, when the page gives no numbered
   * heading at all (Greenhouse and Oracle both do this).
   *
   * `anchors` are the elements that occur once per row — usually the Company or
   * School field. A row is the largest ancestor of an anchor that still holds
   * only that one anchor, which is exactly the repeated container the ATS
   * clones per entry.
   */
  function rowsFromAnchors(anchorEls) {
    const anchors = anchorEls.filter(Boolean);
    if (anchors.length < 2) return [];
    return anchors.map((anchor) => {
      let node = anchor;
      let best = anchor;
      for (let d = 0; node?.parentElement && d < 14; d++) {
        node = node.parentElement;
        if (node === document.body || node === document.documentElement) break;
        let inside = 0;
        for (const other of anchors) if (node.contains(other)) inside++;
        if (inside > 1) break;
        best = node;
      }
      return best;
    });
  }

  const CONTROL_SELECTOR =
    'input:not([type="hidden"]), select, textarea, [role="combobox"], [role="radio"], ' +
    '[role="checkbox"], [contenteditable="true"], button[aria-haspopup]';

  /**
   * Is `node` a container for this field alone?
   *
   * A radio or checkbox group counts as one field, since its options share a
   * name and a single question. Anything else with two or more controls is a
   * section, and its labels belong to whichever field they sit next to — not
   * necessarily this one.
   */
  function ownsOnlyThisField(node, el) {
    let controls;
    try { controls = node.querySelectorAll(CONTROL_SELECTOR); } catch { return false; }
    if (controls.length <= 1) return true;

    const names = new Set();
    for (const control of controls) {
      const type = (control.type || "").toLowerCase();
      const role = control.getAttribute("role");
      const isChoice = type === "radio" || type === "checkbox" || role === "radio" || role === "checkbox";
      if (!isChoice) return false;
      names.add(control.getAttribute("name") || "");
    }
    return names.size <= 1;
  }

  /**
   * Collects every plausible description of a field, best source first.
   * Returned as a single string so one regex test covers all of them.
   */
  function deriveLabel(el) {
    const parts = [];
    const push = (v) => {
      const c = clean(v);
      if (c && !parts.includes(c)) parts.push(c);
    };

    if (el.type === "radio" || el.type === "checkbox") {
      const fs = el.closest("fieldset");
      const legend = fs?.querySelector("legend");
      if (legend && !legend.contains(el)) push(visibleText(legend));
    }

    // 1. <label for="id">
    if (el.id) {
      const escaped = (window.CSS && CSS.escape) ? CSS.escape(el.id) : el.id.replace(/["\\]/g, "\\$&");
      try { document.querySelectorAll(`label[for="${escaped}"]`).forEach((l) => push(visibleText(l))); } catch {}
    }

    // 2. aria-labelledby -> the referenced nodes
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      labelledBy.split(/\s+/).forEach((id) => {
        const node = document.getElementById(id);
        if (node) push(visibleText(node));
      });
    }

    // 3. Direct attributes
    push(el.getAttribute("aria-label"));
    push(el.getAttribute("placeholder"));
    push(el.getAttribute("title"));
    push(el.getAttribute("data-label"));
    push(el.getAttribute("data-automation-id"));   // Workday / Oracle / SAP
    push(el.getAttribute("data-qa"));              // Lever / Ashby
    push(el.getAttribute("data-testid"));          // React / MUI / custom ATS
    push(el.getAttribute("data-test-id"));
    push(el.getAttribute("data-field"));
    push(el.getAttribute("autocomplete"));

    // 4. Wrapping <label>
    const wrapping = el.closest("label");
    if (wrapping) push(visibleText(wrapping));

    // 5. Nearest labelled container.
    //
    // Only ever a container that holds this one field. Walking up blindly and
    // taking the first label in the subtree is how a question inherited the
    // *previous* question's label on Greenhouse and Lever, which put "Immediately"
    // into a "full legal name" box and a date into "Years of relevant experience".
    // The moment an ancestor contains a second field, its labels stop being ours.
    let node = el.parentElement;
    for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
      if (node === document.body || node === document.documentElement) break;
      if (!ownsOnlyThisField(node, el)) break;

      const heading = node.querySelector(
        'label, legend, .label, [class*="label"], [class*="question"], [class*="Label"], h3, h4, p'
      );
      if (heading && !heading.contains(el)) {
        const t = visibleText(heading);
        if (t && t.length < 300) { push(t); break; }
      }
      if (node.tagName === "FIELDSET") {
        const legend = node.querySelector("legend");
        if (legend) { push(visibleText(legend)); break; }
      }
    }

    // 6. Group label — the "Start Date (Month / Day / Year)" wrapper around a
    //    bare Month/Day/Year control. Without it a lone "Year" select has no
    //    idea which date it belongs to.
    const group = groupLabel(el);
    if (group) push(group);

    // 7. Section context — which part of the form this field belongs to.
    const section = sectionContext(el);
    if (section.title) push(section.title);

    // 8. Machine names, split into words so /first name/ matches "firstName"
    push(humanize(el.getAttribute("name")));
    push(humanize(el.id));

    return parts.join(" | ").slice(0, 400);
  }

  /**
   * The label of the *group* a sub-control belongs to.
   *
   * iCIMS and Oracle render a date as three controls labelled only "Month",
   * "Day" and "Year" under one heading that says "Start Date (Month / Day /
   * Year)". That heading is the only thing distinguishing a start year from an
   * end year, so it has to make it into the derived label.
   */
  function groupLabel(el) {
    let node = el.parentElement;
    for (let d = 0; node && d < 5; d++, node = node.parentElement) {
      if (node === document.body || node === document.documentElement) break;
      // Only a container that wraps this field alone, or the two or three
      // controls of one date. Any wider and its headings belong to other
      // questions: a Greenhouse block holding "What is your earliest available
      // start date?" next to five unrelated boxes handed that question's text
      // to every one of them.
      if (!ownsOnlyThisField(node, el) && !isDateGroup(node)) break;

      const own = clean(node.getAttribute?.("aria-label") || "");
      if (own && /\b(start|end|from|to|graduat)\b/i.test(own) && own.length < 120) return own;
      for (const cand of node.querySelectorAll(":scope > label, :scope > legend, :scope > span, :scope > div, :scope > p, :scope > h3, :scope > h4, :scope > h5")) {
        if (cand.contains(el)) continue;
        const t = clean(cand.textContent);
        if (!t || t.length > 120) continue;
        if (/\b(start|end|from|to|thru|through|graduat|completion|expected)\b/i.test(t) && /\b(date|month|year|day)\b/i.test(t)) return t;
      }
    }
    return "";
  }

  /**
   * A container whose every control is one piece of a single date — the
   * Month / Day / Year trio that iCIMS and Oracle render under one heading.
   */
  function isDateGroup(node) {
    let controls;
    try { controls = Array.from(node.querySelectorAll(CONTROL_SELECTOR)); } catch { return false; }
    if (!controls.length || controls.length > 4) return false;
    return controls.every((control) => {
      const text = [
        control.getAttribute("aria-label"), control.getAttribute("name"), control.id,
        control.getAttribute("placeholder"), accessibleName(control),
      ].filter(Boolean).join(" ").replace(/[_\-.]+/g, " ");
      return /\b(mm|dd|yy|yyyy|month|day|year)\b/i.test(text);
    });
  }

  /** firstName / first_name / first-name -> "first name" */
  function humanize(s) {
    if (!s) return "";
    return s
      .replace(/[_\-.]+/g, " ")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/\d{4,}/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  /* ------------------------------------------------------------------ */
  /*  Rule matching                                                      */
  /* ------------------------------------------------------------------ */

  /** The normalized "kind" of a control, used to filter which rules may apply. */
  /**
   * Canonical saved-answer control types. Old releases wrote native input
   * types such as email/tel/url/number directly to Saved Answers, and some
   * pages used aliases such as dropdown/combobox/choice. Keeping one canonical
   * vocabulary prevents the popup from ever showing "unsupported" for a type
   * that the autofill engine can actually handle.
   */
  function canonicalInputType(raw) {
    const t = String(raw ?? "").trim().toLowerCase();
    if (!t) return "text";
    if (t === "textarea" || t === "long text" || t === "long-text") return "textarea";
    if (["select", "dropdown", "combobox", "menu", "listbox"].includes(t)) return "select";
    if (["radio", "choice", "choices", "radiogroup"].includes(t)) return "radio";
    if (["checkbox", "checkboxes", "check", "checkgroup", "checkbox-group"].includes(t)) return "checkbox";
    if (["date", "month", "number"].includes(t)) return t;
    // email/tel/url/password/text and unknown legacy values are plain fields.
    return "text";
  }

  function fieldKind(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === "textarea") return "textarea";
    if (tag === "select") return "select";
    if (el.getAttribute("role") === "checkbox") return "checkbox";
    if (el.getAttribute("role") === "radio") return "radio";
    if (choiceButtonGroup(el)) return "radio";
    if (
      el.getAttribute("role") === "combobox" ||
      el.getAttribute("aria-haspopup") === "listbox" ||
      el.getAttribute("aria-haspopup") === "menu" ||
      el.getAttribute("aria-haspopup") === "true" ||
      (el.tagName === "BUTTON" && /dropdown|select|prompt/i.test(el.getAttribute("data-automation-id") || ""))
    ) {
      return "select";
    }
    if (el.getAttribute("role") === "textbox" || el.isContentEditable) return "text";
    const type = (el.type || "text").toLowerCase();
    if (["checkbox", "radio", "file", "date", "month", "number", "email", "tel", "url"].includes(type)) return type;
    return "text";
  }

  function matchRule(el, label, rules) {
    const kind = fieldKind(el);
    // deriveLabel joins several descriptions with " | ". Testing only the joined
    // string made every anchored pattern in the table unreachable: a box
    // labelled exactly "Name" derives "Name | f name", so /^name$/ never fired
    // and the applicant's name was left blank on any form that labels it that
    // way. Each description is now tested in its own right.
    //
    // The joined string is still tested too, because some rules deliberately
    // span two of them — "Work Experience 2" from the section heading plus
    // "Location" from the field's own label. Denials keep working against the
    // whole label, so a disqualifying word anywhere still disqualifies.
    const haystacks = [label, ...String(label ?? "").split("|").map((s) => s.trim()).filter(Boolean)];
    let best = null;
    let bestScore = -1;

    for (const rule of rules) {
      const types = rule.type ?? ["text"];
      const typeOk =
        types.includes(kind) ||
        (kind === "email" && types.includes("text")) ||
        (kind === "tel" && types.includes("text")) ||
        (kind === "url" && types.includes("text")) ||
        (kind === "number" && types.includes("text")) ||
        (kind === "radio" && types.includes("select")) ||
        (kind === "date" && types.includes("text")) ||
        (kind === "month" && types.includes("text"));
      if (!typeOk) continue;

      // A denial may be a pattern or a predicate. The predicate form exists
      // because some disqualifying words are only disqualifying in context:
      // "Hispanic or Latino" next to a race dropdown is the category list, but
      // on its own it is a separate yes/no question. See the `race` rule.
      if (rule.deny?.some((d) => (typeof d === "function" ? d(label) : d.test(label)))) continue;

      // `require` is the positive counterpart to `deny`: tested against the
      // whole label, including the section heading. It is what lets a rule say
      // "a bare Date, but only inside a Voluntary Self-Identification block" —
      // a condition no single pattern in `match` can express, because those are
      // OR'd against each description separately.
      if (rule.require && !rule.require.test(label)) continue;

      /**
       * Where the match landed decides how much it counts.
       *
       * `haystacks[0]` is the joined label — the field's own text *plus* the
       * section heading and whatever the portal renders nearby. The rest are
       * the individual descriptions, and `haystacks[1]` is the field's own.
       *
       * Matching only the joined string used to count exactly as much as
       * matching the field's own label, and that is how Workday's phone block
       * broke: it renders "Country Phone Code" directly above "Phone Number",
       * that text lands in the joined label, and `phoneCountryCode` — two
       * weights above `phone` — claimed the Phone Number box on the strength of
       * its neighbour's name. The number then went into the country-code box and
       * the phone box fell through to whatever the saved answers offered.
       *
       * A rule that matches the field's own description now outranks one that
       * only matched the surroundings. Rules that deliberately span two
       * descriptions still work — "Work Experience 2" plus "Location" — because
       * a joined-only match still counts, just for less.
       */
      let hitIndex = -1;
      let placeBonus = 0;
      haystacks.forEach((hay, position) => {
        const i = rule.match.findIndex((re) => re.test(hay));
        if (i === -1) return;
        // haystacks[0] is the joined text, [1] is the field's own primary
        // description, and the rest are the surroundings — the section heading
        // and the labels of neighbouring fields.
        const bonus = position === 1 ? 40 : position > 1 ? 12 : 0;
        if (bonus > placeBonus) placeBonus = bonus;
        if (hitIndex === -1 || i < hitIndex) hitIndex = i;
      });
      if (hitIndex === -1) continue;

      const score = (rule.weight ?? 5) * 10 - hitIndex + placeBonus;
      if (score > bestScore) {
        bestScore = score;
        best = rule;
      }
    }
    return best;
  }

  /* ------------------------------------------------------------------ */
  /*  Choice normalisation                                               */
  /* ------------------------------------------------------------------ */

  function normalizeChoiceText(s) {
    return norm(s)
      .replace(/[’‘`]/g, "'")
      .replace(/\s*&\s*/g, " and ")
      .replace(/\bmasters?\b/g, "master's")
      .replace(/\bbachelors?\b/g, "bachelor's")
      .replace(/\bph\.?d\.?\b/g, "doctorate")
      .replace(/\bdoctor of philosophy\b/g, "doctorate")
      .replace(/\bhigh school diploma\b/g, "high school")
      .replace(/\bunited states of america\b/g, "united states")
      .replace(/\busa\b/g, "united states")
      .replace(/\bus\b/g, "united states")
      .replace(/\bmobile phone\b/g, "mobile")
      .replace(/\bcell phone\b/g, "mobile")
      .replace(/\bfull time\b/g, "full-time")
      .replace(/\bpart time\b/g, "part-time")
      .replace(/\bnon binary\b/g, "non-binary")
      .replace(/\s+/g, " ")
      .trim();
  }

  /**
   * How well one option matches a set of targets, on a fixed ladder of
   * confidence. Callers pass a lower ladder for synonym-derived targets so an
   * exact hit on the answer itself can never lose to a looser alias.
   */
  function tieredScore(text, value, targets, tiers) {
    let best = 0;
    for (const raw of targets || []) {
      const target = normalizeChoiceText(raw);
      if (!target) continue;
      if (text === target || value === target) best = Math.max(best, tiers.exact);
      else if (text.startsWith(target) || value.startsWith(target) || target.startsWith(text)) best = Math.max(best, tiers.prefix);
      else if (text.includes(target) || value.includes(target) || target.includes(text)) best = Math.max(best, tiers.contains);
      else best = Math.max(best, Math.round(choiceSimilarity(text, target) * tiers.fuzzy));
    }
    return best;
  }

  function choiceSimilarity(a, b) {
    const A = new Set(normalizeChoiceText(a).split(/\W+/).filter((x) => x.length > 1));
    const B = new Set(normalizeChoiceText(b).split(/\W+/).filter((x) => x.length > 1));
    if (!A.size || !B.size) return 0;
    let hits = 0;
    A.forEach((x) => { if (B.has(x)) hits++; });
    return hits / Math.max(A.size, B.size);
  }

  /* ------------------------------------------------------------------ */
  /*  EEO answers                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * Voluntary-disclosure questions are the ones every portal words
   * differently and the ones where a near-miss is genuinely harmful: picking
   * "I identify as one or more of the classifications of protected veteran"
   * when the answer is "I am not a protected veteran" is a false statement on
   * a federal form.
   *
   * Each answer is reduced to a canonical id. Two ids that differ inside the
   * same question are a hard block (score 0), never a fuzzy near-match.
   */
  const DECLINE_RE =
    /(decline|prefer\s+not|prefer\s+to\s+not|do\s*n[o']?t\s+wish|don'?t\s+wish|not\s+wish\s+to|wish\s+not\s+to|choose\s+not\s+to|rather\s+not|not\s+to\s+(?:disclose|answer|identify|say)|not\s+disclose|no\s+response|i\s+do(?:\s+not|n'?t)\s+want\s+to\s+(?:answer|say|disclose|identify)|i\s+do\s+not\s+wish\s+to\s+(?:answer|disclose|identify)|not\s+want\s+to\s+answer|opt\s+out|self[-\s]?identify\s+later)/i;

  const EEO_DOMAINS = [
    /**
     * VEVRAA lists FOUR answers, not two, and two of them contain the words
     * "not a protected veteran":
     *
     *   I identify as one or more of the classifications of a protected veteran
     *   I identify as a veteran, just not a protected veteran
     *   I am not a protected veteran  (or: I am not a veteran)
     *   I don't wish to answer
     *
     * The middle one is an assertion that the applicant *is* a veteran. It used
     * to reduce to the same id as "I am not a protected veteran", so a
     * non-veteran was given it whenever the portal happened to list it first —
     * which is a false statement on a federal form. It is now its own branch,
     * and a branch mismatch is a hard block, so the answer either lands on the
     * matching wording or the question is left for the applicant.
     *
     * Ordering matters: the narrower wordings are tested before the broader
     * ones so "…just not a protected veteran" can never fall through to "not".
     */
    ["veteran", [
      ["unprotected", /(identify\s+as\s+a\s+veteran|veteran[,\s]+(?:but|just)\s+not|am\s+a\s+veteran[,\s]+(?:but|just)\s+not|veteran\s+but\s+not\s+a\s+protected)/i],
      ["protected", /(identify\s+as\s+one\s+or\s+more|one\s+or\s+more\s+of\s+the\s+classification|i\s+am\s+a\s+protected\s+veteran|i\s+am\s+one\s+or\s+more|yes[,\s].{0,30}veteran|am\s+a\s+veteran)/i],
      ["not", /(not\s+a\s+protected\s+veteran|i\s+am\s+not\s+a\s+veteran|i\s+am\s+not\s+a\s+protected|no[,\s].{0,30}not\s+a\s+.{0,20}veteran|non[-\s]?protected|not\s+a\s+veteran|no[,\s].{0,20}veteran)/i],
    ], /veteran|military/i],

    ["disability", [
      ["yes", /(yes[,\s].{0,60}disab|i\s+have\s+a\s+disab|do\s+have\s+a\s+disab|have\s+had\s+a\s+disab|history\s+of\s+a\s+disab|or\s+have\s+a\s+history)/i],
      ["no", /(no[,\s].{0,60}(?:do\s+not|don'?t|have\s+not)|i\s+do\s+not\s+have\s+a\s+disab|don'?t\s+have\s+a\s+disab|no\s+disability|have\s+not\s+had\s+a\s+disab)/i],
    ], /disabilit|section\s*503|cc-?305/i],

    ["gender", [
      ["male", /(^|[^a-z])male\b|(^|[^a-z])man\b|identify\s+as\s+male/i],
      ["female", /(^|[^a-z])female\b|(^|[^a-z])woman\b|identify\s+as\s+female/i],
      ["nonbinary", /non[-\s]?binary|genderqueer|gender\s*non[-\s]?conform|another\s+gender/i],
    ], /gender|\bsex\b/i],

    /**
     * Race / ethnicity had no domain at all, so it was answered by token
     * overlap — and "Asian" against a list containing "American Indian or
     * Alaska Native (Not Hispanic or Latino)" is exactly the kind of near-miss
     * that produces. Every EEO-1 category is now its own branch, so a race
     * answer lands on its own category or on nothing.
     *
     * "American Indian" is tested first: it is the one category whose wording
     * contains another category's name, and an applicant from India describing
     * themselves as "Indian" or "Asian Indian" must never be routed into it.
     */
    ["race", [
      ["americanindian", /(american\s+indian|alaska(n)?\s+native|native\s+american)/i],
      ["nativehawaiian", /(native\s+hawaiian|pacific\s+islander)/i],
      ["black", /(black|african\s+american|afro[-\s]?caribbean)/i],
      ["asian", /(^|[^a-z])asian\b|asian\s+indian|south\s+asian|east\s+asian|indian\s+subcontinent/i],
      ["white", /(^|[^a-z])white\b|caucasian/i],
      ["twoormore", /(two\s+or\s+more|multi[-\s]?racial|mixed\s+race)/i],
      ["hispanic", /(hispanic|latino|latina|latinx)/i],
    ], /\brace\b|ethnic|racial|eeo[-\s]?1/i],

    ["yesno", [
      ["yes", /^\s*yes\b/i],
      ["no", /^\s*no\b/i],
    ], /hispanic|latino/i],
  ];

  /**
   * Reduces an answer or option to `domain:id`, or `decline`, or null when the
   * text carries no canonical meaning. `hint` (the field label) disambiguates
   * a bare "Yes"/"No" that could belong to several questions.
   */
  function eeoId(text, hint = "") {
    // Every EEO-1 race option but one is suffixed "(Not Hispanic or Latino)".
    // That qualifier says what the category is *not*, so leaving it in made
    // "Two or More Races (Not Hispanic or Latino)" reduce to `race:hispanic`.
    // It carries no category of its own and is dropped before branch testing.
    const t = norm(text).replace(/\(?\s*not\s+hispanic\s+or\s+latino\s*\)?/g, " ").replace(/\s+/g, " ").trim();
    if (!t) return null;
    if (DECLINE_RE.test(t)) return "decline";
    const h = norm(hint);
    for (const [domain, branches, hintRe] of EEO_DOMAINS) {
      const relevant = hintRe.test(t) || (h && hintRe.test(h));
      if (!relevant) continue;
      for (const [id, re] of branches) {
        if (re.test(t)) return `${domain}:${id}`;
      }
    }
    return null;
  }

  /** Kept for callers that still use the old name. */
  function canonicalChoice(value, hint) {
    const id = eeoId(value, hint);
    return id ? id : norm(value);
  }

  /**
   * Score for an option that is on the right EEO branch.
   *
   * A flat score for every same-branch option is what put "I IDENTIFY AS A
   * VETERAN, JUST NOT A PROTECTED VETERAN" into a form whose answer was "I am
   * not a protected veteran": both reduced to the same id, both scored 130, and
   * the winner came down to which one the portal listed first. Splitting those
   * two into separate branches fixes that particular pair, but any list can
   * word one branch two ways — "No, I do not have a disability" and "No, I do
   * not have a disability and have not had one in the past" are the same answer
   * — so the branch decides *whether* an option is eligible and closeness to
   * the stored answer decides *which* eligible option wins.
   */
  const EEO_BRANCH_BASE = 118;
  function eeoBranchScore(optionText, wantText) {
    return EEO_BRANCH_BASE + Math.round(choiceSimilarity(optionText, wantText) * 15);
  }

  /* ------------------------------------------------------------------ */
  /*  Value setting (framework-safe)                                     */
  /* ------------------------------------------------------------------ */

  function nativeSetter(el) {
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    return Object.getOwnPropertyDescriptor(proto, "value")?.set;
  }

  function fire(el, ...types) {
    types.forEach((type) => {
      let evt;
      if (type.startsWith("key")) {
        evt = new KeyboardEvent(type, { bubbles: true, cancelable: true });
      } else if (type.startsWith("pointer") && typeof PointerEvent !== "undefined") {
        evt = new PointerEvent(type, { bubbles: true, cancelable: true });
      } else if (type.startsWith("mouse") || type === "click") {
        evt = new MouseEvent(type, { bubbles: true, cancelable: true, view: window });
      } else if (type.startsWith("focus") || type === "blur") {
        evt = new FocusEvent(type, { bubbles: true, cancelable: true });
      } else {
        evt = new Event(type, { bubbles: true, cancelable: true });
      }
      el.dispatchEvent(evt);
    });
  }

  /**
   * The longest value a control will accept, or 0 when it does not say.
   *
   * Oracle Recruiting caps Suffix at 80 characters and Tax District at 150 and
   * rejects anything longer with a validation message. Writing past the cap
   * leaves the applicant with a red field they have to find and clear by hand,
   * so an over-long value is refused here instead of written and rejected.
   */
  function maxLengthOf(el) {
    const raw = Number(el?.getAttribute?.("maxlength") ?? el?.maxLength ?? 0);
    return Number.isFinite(raw) && raw > 0 ? raw : 0;
  }

  /**
   * Workday's date control is not one box, it is two or three.
   *
   * `From *` renders as separate `MM` and `YYYY` inputs inside one wrapper,
   * each a spinbutton with its own two- or four-character cap. Writing
   * "12/2019" at it put the whole string into a segment that could not hold it,
   * and the page came back "Invalid Date: /2019" — the year had landed and the
   * month never had.
   *
   * Segments are found through the wrapper rather than by guessing from the
   * element handed in, because either segment may be the one the field scan
   * picked up.
   */
  const DATE_SEGMENT_SELECTOR =
    '[data-automation-id*="dateSection" i] input, input[data-automation-id*="dateSection" i], ' +
    'input[role="spinbutton"], input[aria-label*="Month" i], input[aria-label*="Year" i], input[aria-label*="Day" i]';

  function dateSegments(el) {
    if (!el) return null;
    const wrapper = el.closest?.(
      '[data-automation-id*="dateInput" i], [data-automation-id*="datePicker" i], [data-automation-id*="dateWidget" i], .css-dateinput, [role="group"], [class*="dateInput" i]'
    ) || el.parentElement;
    if (!wrapper) return null;

    let inputs = [];
    try {
      inputs = Array.from(wrapper.querySelectorAll(DATE_SEGMENT_SELECTOR));
    } catch {}
    if (inputs.length < 2) return null;

    // Only short numeric boxes count. A wrapper that also holds a free-text
    // field is not a segmented date and must not be treated as one.
    /**
     * A segment is identified by what it says it is, not by having a cap.
     *
     * The filter used to require `maxlength` between 1 and 4. Workday's date
     * spinbuttons do not carry one — they bound themselves with `aria-valuemax`
     * — so every segment was dropped, detection returned null, and the whole
     * "12/2022" string went into a single box again. That is the `MM/2022` and
     * "Invalid Date: /2022" still showing after the first date fix.
     *
     * A cap is now only used to *reject*: anything that admits to holding more
     * than four characters is a free-text field, not a date segment.
     */
    const looksLikeSegment = (node) => {
      const cap = Number(node.getAttribute?.("maxlength") ?? node.maxLength ?? 0);
      if (cap > 4) return false;
      const hint = `${node.getAttribute?.("data-automation-id") || ""} ${node.getAttribute?.("aria-label") || ""} ${node.getAttribute?.("placeholder") || ""} ${node.getAttribute?.("name") || ""} ${node.getAttribute?.("id") || ""}`;
      if (/datesection|\bmonth\b|\byear\b|\bday\b|\bmm\b|\byyyy\b|\bdd\b/i.test(hint)) return true;
      if (node.getAttribute?.("role") === "spinbutton") return true;
      return cap > 0 && cap <= 4;
    };

    const segs = inputs.filter(looksLikeSegment);
    if (segs.length < 2 || segs.length > 3) return null;
    if (!segs.includes(el) && !wrapper.contains(el)) return null;

    const kindOf = (node) => {
      const hint = `${node.getAttribute?.("data-automation-id") || ""} ${node.getAttribute?.("aria-label") || ""} ${node.getAttribute?.("placeholder") || ""} ${node.getAttribute?.("name") || ""}`;
      if (/month|\bmm\b/i.test(hint)) return "month";
      if (/year|\byyyy\b|\byy\b/i.test(hint)) return "year";
      if (/\bday\b|\bdd\b/i.test(hint)) return "day";
      const cap = Number(node.getAttribute?.("maxlength") ?? node.maxLength ?? 0);
      if (cap === 4) return "year";
      // No cap and no name: a segment whose upper bound is a four-digit number
      // is the year box.
      const max = Number(node.getAttribute?.("aria-valuemax") ?? 0);
      if (max >= 1000) return "year";
      return null;
    };

    const mapped = segs.map((node) => ({ node, kind: kindOf(node) }));
    if (!mapped.some((s) => s.kind === "year")) return null;

    // Segments with no usable hint are assigned by document order: on a
    // US-locale Workday form that is month, then day, then year.
    const order = ["month", "day", "year"];
    let next = 0;
    for (const seg of mapped) {
      if (seg.kind) { next = Math.max(next, order.indexOf(seg.kind) + 1); continue; }
      while (next < order.length && mapped.some((s) => s.kind === order[next])) next++;
      seg.kind = order[next] ?? null;
      next++;
    }
    return mapped.filter((s) => s.kind);
  }

  /** Pull month / day / year out of the formats a profile date arrives in. */
  function dateParts(value) {
    const raw = String(value ?? "").trim();
    if (!raw) return null;

    let m = raw.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/);        // 2019-12-05
    if (m) return { year: m[1], month: m[2], day: m[3] ?? "" };

    m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);                // 12/05/2019
    if (m) return { month: m[1], day: m[2], year: m[3] };

    m = raw.match(/^(\d{1,2})\/(\d{4})$/);                           // 12/2019
    if (m) return { month: m[1], year: m[2], day: "" };

    m = raw.match(/^(\d{4})$/);                                      // 2019
    if (m) return { year: m[1], month: "", day: "" };

    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) {
      return {
        year: String(parsed.getFullYear()),
        month: String(parsed.getMonth() + 1),
        day: String(parsed.getDate()),
      };
    }
    return null;
  }

  function setSegmentedDate(el, value) {
    const segs = dateSegments(el);
    if (!segs) return false;
    const parts = dateParts(value);
    if (!parts || !parts.year) return false;

    // Month before year, matching the reading order. Workday advances focus
    // itself once a segment is full, so each write starts by taking focus back
    // rather than trusting where the caret ended up.
    const order = { month: 0, day: 1, year: 2 };
    const sorted = [...segs].sort((a, b) => order[a.kind] - order[b.kind]);

    let wrote = 0;
    for (const { node, kind } of sorted) {
      const cap = Number(node.getAttribute?.("maxlength") ?? node.maxLength ?? 0) || (kind === "year" ? 4 : 2);
      const raw = parts[kind];
      if (!raw) continue;
      const text = cap === 4 ? String(raw).padStart(4, "0") : String(raw).padStart(2, "0").slice(-2);

      try {
        ensureVisible(node);
        node.focus?.({ preventScroll: true });
        const writer = nativeSetter(node);
        const put = (v) => { if (writer) writer.call(node, v); else node.value = v; };
        put("");
        fire(node, "input");
        put(text);
        const tracker = node._valueTracker;
        if (tracker && typeof tracker.setValue === "function") tracker.setValue("");
        fire(node, "keydown", "beforeinput", "input", "keyup", "change");
        if (String(node.value ?? "") === text) wrote++;
      } catch {}
    }

    try { sorted[sorted.length - 1]?.node.blur?.(); } catch {}
    for (const { node } of sorted) fire(node, "blur");
    return wrote > 0;
  }

  function setTextValue(el, value) {
    const text = String(value ?? "");
    if (!text) return false;

    // A date split across MM / DD / YYYY boxes is written segment by segment.
    if (setSegmentedDate(el, text)) return true;

    const cap = maxLengthOf(el);
    if (cap && text.length > cap) return false;

    ensureVisible(el);
    try { el.focus?.({ preventScroll: true }); } catch { try { el.focus?.(); } catch {} }

    let changed = false;
    const previous = String(el.value ?? "");
    const setter = nativeSetter(el);
    const isRichEditor = el.isContentEditable && el.tagName !== "INPUT" && el.tagName !== "TEXTAREA";

    /**
     * Type it, rather than assign it.
     *
     * `execCommand("insertText")` runs through the browser's own editing
     * pipeline, so the page receives the same native `beforeinput` and `input`
     * events a person's keystrokes produce. Assigning `.value` and dispatching
     * synthetic events does not: the text appears, but Workday's model never
     * records it, and pressing Next reports "The field First Name is required
     * and must have a value" under a box plainly containing a name.
     *
     * The giveaway was which fields failed. Every dropdown committed — State,
     * Phone Device Type — and every required *text* box did not. Dropdowns are
     * answered by clicking, which is already a real interaction. Text boxes were
     * the only things being written by assignment.
     *
     * This was already here as a fallback, reached only when assignment failed
     * to change the value. Assignment always succeeded, so it never ran.
     */
    if (!isRichEditor) {
      try {
        const length = String(el.value ?? "").length;
        el.setSelectionRange?.(0, length);
        if (!length && typeof el.select === "function") el.select();
        if (document.execCommand && document.execCommand("insertText", false, text)) {
          changed = String(el.value ?? "") === text;
        }
      } catch {}
    }

    if (!changed) {
      try {
        if (isRichEditor) {
          el.textContent = text;
          changed = clean(el.textContent) === clean(text);
        } else if (setter) {
          setter.call(el, text);
          changed = String(el.value ?? "") === text;
        } else {
          el.value = text;
          changed = String(el.value ?? "") === text;
        }
      } catch {}
    }

    if (!changed && typeof el.setRangeText === "function") {
      try {
        const current = String(el.value ?? "");
        el.setSelectionRange?.(0, current.length);
        el.setRangeText(text, 0, current.length, "end");
        changed = String(el.value ?? "") === text;
      } catch {}
    }

    // React keeps the last value it knows about in a tracker on the node and
    // drops any change event that agrees with it. Normally writing through the
    // prototype setter is enough to leave that tracker stale — but if anything
    // has re-synced it, onChange never fires, the framework's model stays empty,
    // and the applicant sees the text on screen while the page insists the field
    // is required. Resetting it makes the change unmissable.
    try {
      const tracker = el._valueTracker;
      if (tracker && typeof tracker.setValue === "function") tracker.setValue(previous);
    } catch {}

    // Key events bracket the input for the same reason they do in
    // `retypeValue`: Workday will not consider a field answered until it has
    // seen keyboard activity on it, whatever the box contains.
    fire(el, "keydown", "beforeinput", "input", "keyup", "change");
    // A blur is what commits the value on most ATS validators, but stealing
    // focus back afterwards is what made the page jitter. Blur once, silently.
    try { el.blur?.(); } catch {}
    fire(el, "blur");

    const isRich = el.isContentEditable && el.tagName !== "INPUT" && el.tagName !== "TEXTAREA";
    const settled = isRich ? clean(el.textContent) : String(el.value ?? "");
    if (isRich ? settled === clean(text) : settled === text) return true;

    /**
     * The field ended up holding something other than what was written.
     *
     * On Oracle Recruiting this was not a failed write but an *appended* one:
     * the box kept its old contents and gained the new value on the end, over
     * and over, producing ".WashingtonWashingtonMy address is in Bellevue…" in
     * a Suffix box capped at 80 characters, and the street, ZIP, city and state
     * run together in Address Line 3. Whatever the page is doing to cause it —
     * a typeahead that re-inserts at the caret, a component that echoes its own
     * model back — the result is the same and the applicant then has to find and
     * clear every one of them by hand.
     *
     * So: one clean retry through an explicit empty transition, and if the field
     * still will not hold exactly the intended value it is emptied rather than
     * left holding a concatenation. An empty box is a box the applicant can see
     * is theirs to fill. A corrupted one looks answered.
     */
    const contaminated =
      settled.length > text.length && (settled.includes(text) || (previous && settled.includes(previous)));

    try {
      const writer = nativeSetter(el);
      const put = (v) => { if (isRich) el.textContent = v; else if (writer) writer.call(el, v); else el.value = v; };
      put("");
      fire(el, "input");
      put(text);
      const tracker = el._valueTracker;
      if (tracker && typeof tracker.setValue === "function") tracker.setValue("");
      fire(el, "beforeinput", "input", "change", "blur");

      const after = isRich ? clean(el.textContent) : String(el.value ?? "");
      if (isRich ? after === clean(text) : after === text) return true;

      if (contaminated || after.length > text.length) {
        put("");
        fire(el, "input", "change", "blur");
      }
    } catch {}

    return false;
  }

  /**
   * Write a value a second time, through a transition the page cannot ignore.
   *
   * A framework that keeps a record of the last value it saw will drop a change
   * event that agrees with that record. Clearing the field first and writing
   * again produces two unmistakable transitions — something to empty, empty to
   * the value — so there is nothing for it to dedupe against. Used only where
   * the page has told us it is unhappy, because it costs an extra round of
   * events per field.
   */
  function retypeValue(el, value) {
    const text = String(value ?? "");
    if (!text) return false;

    // A segmented date is rewritten segment by segment; retyping the whole
    // string at one segment is what produced "Invalid Date: /2019".
    if (setSegmentedDate(el, text)) return true;

    ensureVisible(el);
    try { el.focus?.({ preventScroll: true }); } catch {}

    const setter = nativeSetter(el);
    const write = (next) => {
      try {
        if (setter) setter.call(el, next); else el.value = next;
        const tracker = el._valueTracker;
        if (tracker && typeof tracker.setValue === "function") {
          tracker.setValue(next === "" ? text : "");
        }
      } catch {}
    };

    // Same reasoning as `setTextValue`: type it through the editing pipeline
    // first, because that is what Workday's model actually listens to.
    let typed = false;
    try {
      el.setSelectionRange?.(0, String(el.value ?? "").length);
      if (document.execCommand && document.execCommand("insertText", false, text)) {
        typed = String(el.value ?? "") === text;
      }
    } catch {}

    if (!typed) {
      write("");
      fire(el, "input");
      write(text);
    }
    /**
     * Key events either side of the input.
     *
     * Workday takes its value from `input` but only treats a field as *touched*
     * once it has seen keyboard activity, and an untouched field is reported
     * empty by its validator however much text is in the box. That is the
     * "Azure DevOps Engineer" sitting under "The field Job Title is required
     * and must have a value" — the text was there, the field had never been
     * typed in, and the model stayed empty.
     */
    fire(el, "keydown", "keypress", "beforeinput", "input", "keyup", "change");
    try { el.blur?.(); } catch {}
    fire(el, "blur", "focusout");
    return String(el.value ?? "") === text;
  }

  /** Has the page itself marked this control as unacceptable? */
  /**
   * Is the page complaining about this field?
   *
   * Only `aria-invalid` and `aria-describedby` were checked. Workday marks
   * neither: it renders the message as a sibling node inside the field's
   * wrapper, so "The field Job Title is required and must have a value" sat
   * under a box containing "Azure DevOps Engineer" and nothing here noticed.
   * The retype that would have committed the value therefore never ran.
   */
  /**
   * Does the page insist on an answer here?
   *
   * Checked three ways because portals mark it differently: the native
   * attribute, the ARIA one, and — Workday's way — an asterisk rendered next to
   * the label with no attribute at all.
   */
  function isRequired(el) {
    try {
      if (el.required === true) return true;
      if (el.getAttribute?.("aria-required") === "true") return true;
      const described = `${el.getAttribute?.("aria-labelledby") || ""} ${el.getAttribute?.("aria-describedby") || ""}`.trim();
      for (const id of described.split(/\s+/).filter(Boolean)) {
        const node = document.getElementById(id);
        if (node && /\*|\brequired\b/i.test(node.textContent || "")) return true;
      }
      let node = el.parentElement;
      for (let depth = 0; node && depth < 3; depth++, node = node.parentElement) {
        if (node.querySelectorAll?.("input, select, textarea").length > 1) break;
        const label = node.querySelector?.("label, legend");
        if (label && /\*|\brequired\b/i.test(label.textContent || "")) return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  function flaggedInvalid(el) {
    try {
      if (el.getAttribute?.("aria-invalid") === "true") return true;
      const described = el.getAttribute?.("aria-describedby");
      if (described) {
        for (const id of described.split(/\s+/)) {
          const node = document.getElementById(id);
          if (node && /\brequired\b|\berror\b|\binvalid\b/i.test(node.textContent || "")) return true;
        }
      }

      // Workday, Oracle and iCIMS all render the message near the field rather
      // than linking it. Walk up a few levels and look for an error node that
      // belongs to this control and no other.
      let node = el.parentElement;
      for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
        if (node.querySelectorAll?.("input, select, textarea").length > 1) break;
        const errors = node.querySelectorAll?.(
          '[data-automation-id*="error" i], [id*="error" i], [class*="error" i], [role="alert"], [aria-live="assertive"]'
        );
        for (const err of errors ?? []) {
          const text = err.textContent || "";
          if (/\b(is required|must have a value|invalid|enter a (valid|maximum)|cannot be blank)\b/i.test(text)) return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Native <select>                                                    */
  /* ------------------------------------------------------------------ */

  /**
   * Is this choice a prompt rather than an answer?
   *
   * Portals decorate their prompts: iCIMS writes "— Make a Selection —" with em
   * dashes, and a dropdown that depends on another one reads "Please select a
   * country" until its parent is answered. A regex anchored on bare words
   * matched none of those, so an unanswered Country box looked filled — and
   * under the never-overwrite rule that meant it was skipped entirely.
   */
  function isPlaceholderChoice(text) {
    const t = normalizeChoiceText(text)
      .replace(/[‒-―−]/g, "-")          // figure / en / em dash, minus sign
      .replace(/^[\s\-_*.·•>«]+|[\s\-_*.·•<»]+$/g, "")
      .replace(/\.{2,}$/, "")
      .trim();
    if (!t) return true;
    if (/^(n\/a|na|none|null|nil)$/.test(t)) return true;
    if (/^(type\s+to\s+search|start\s+typing|search)$/.test(t)) return true;
    return /^(please\s+)?(select|choose|pick|make\s+a\s+selection)\b/.test(t);
  }

  // Kept as a callable for older call sites that expect a regex-like `.test`.
  const PLACEHOLDER_RE = { test: (value) => isPlaceholderChoice(value) };

  /** Synonyms keyed by the exact answer, matched without regard to case. */
  /**
   * Score a value against a synonym ladder, respecting its order.
   *
   * tieredScore takes the best match across the whole list, so every synonym
   * that matched exactly scored the same and the winner came down to which
   * option the page happened to list first. A list offering both "Job Board"
   * and "Social Media" therefore answered LinkedIn with "Job Board".
   *
   * Position now costs a little, so a rule can state its preference: the
   * closest description of the real answer goes first.
   */
  function rankedSynonymScore(text, val, list, ladder) {
    let best = 0;
    for (let i = 0; i < list.length; i++) {
      const raw = tieredScore(text, val, [list[i]], ladder);
      if (!raw) continue;
      const adjusted = raw - Math.min(i, 12);
      if (adjusted > best) best = adjusted;
    }
    return best;
  }

  function synonymsFor(synonyms, value) {
    if (!synonyms || typeof synonyms !== "object") return [];
    const direct = synonyms[value] ?? synonyms[String(value)];
    if (Array.isArray(direct)) return direct;
    const want = norm(value);
    for (const key of Object.keys(synonyms)) {
      if (norm(key) === want && Array.isArray(synonyms[key])) return synonyms[key];
    }
    return [];
  }

  function setSelectValue(el, value, synonyms, hint) {
    if (value === undefined || value === null || String(value).trim() === "") return false;
    const options = Array.from(el.options ?? []);
    if (!options.length) return false;

    const want = normalizeChoiceText(value);
    const rawWant = norm(value);
    const accepted = synonymsFor(synonyms, value).map(normalizeChoiceText).filter(Boolean);
    const primary = [want, rawWant].filter(Boolean);
    const wantId = eeoId(value, hint);

    const score = (opt) => {
      const text = normalizeChoiceText(opt.textContent);
      const val = normalizeChoiceText(opt.value);
      if (!text && !val) return 0;
      if (isPlaceholderChoice(text)) return 0;

      // Voluntary-disclosure answers must land on the same branch or nowhere,
      // and among options on the right branch the closest wording wins rather
      // than whichever the portal happened to list first.
      if (wantId) {
        const optId = eeoId(opt.textContent, hint) || eeoId(opt.value, hint);
        if (optId) return optId === wantId ? eeoBranchScore(opt.textContent || opt.value, value) : 0;
      }

      // The stored answer outranks anything it is merely a synonym of. A rule
      // may map "LinkedIn" onto the category "Job Board" for portals that only
      // offer categories — but where the list actually contains "LinkedIn",
      // that is the answer, and the category must not win the tie.
      return Math.max(
        tieredScore(text, val, primary, { exact: 130, prefix: 95, contains: 78, fuzzy: 70 }),
        rankedSynonymScore(text, val, accepted, { exact: 100, prefix: 74, contains: 70, fuzzy: 55 })
      );
    };

    let best = null, bestScore = 0;
    options.forEach((opt) => {
      const sc = score(opt);
      if (sc > bestScore) { bestScore = sc; best = opt; }
    });
    if (!best || bestScore < 55) return false;

    try { el.focus?.({ preventScroll: true }); } catch {}
    try {
      const setter = nativeSetter(el);
      if (setter) setter.call(el, best.value);
      else el.value = best.value;
      if (el.value !== best.value) el.selectedIndex = best.index;
    } catch { return false; }

    notifyWidget(el);
    // Several ATS validators only clear a "required" message on blur. Blur is
    // safe here because nothing takes focus back afterwards.
    try { el.blur?.(); } catch {}

    const selected = el.options?.[el.selectedIndex];
    return Boolean(selected) &&
      !PLACEHOLDER_RE.test(normalizeChoiceText(selected.textContent).trim()) &&
      (normalizeChoiceText(selected.textContent) === normalizeChoiceText(best.textContent) ||
       normalizeChoiceText(selected.value) === normalizeChoiceText(best.value));
  }

  /* ------------------------------------------------------------------ */
  /*  Radio groups                                                       */
  /* ------------------------------------------------------------------ */

  function radioOptionText(radio) {
    if (!radio) return "";
    // A segmented button carries its option text directly. Falling through to
    // the sibling scan below would pick up the *other* choice as well.
    if (isChoiceButton(radio)) {
      return clean(visibleText(radio) || radio.getAttribute("aria-label") || "");
    }
    const candidates = [];
    const add = (node) => {
      if (!node) return;
      const t = visibleText(node);
      if (t && t.length <= 240 && !candidates.includes(t)) candidates.push(t);
    };

    if (radio.id) {
      try { document.querySelectorAll(`label[for="${CSS.escape(radio.id)}"]`).forEach(add); } catch {}
    }
    add(radio.closest("label"));
    const aria = radio.getAttribute("aria-label");
    if (aria) candidates.push(clean(aria));

    const parent = radio.parentElement;
    if (parent) {
      Array.from(parent.children || []).filter((n) => n !== radio).forEach((n) => {
        const t = visibleText(n);
        if (t && t.length <= 160) candidates.push(t);
      });
    }

    let sib = radio.nextElementSibling;
    for (let i = 0; sib && i < 2; i++, sib = sib.nextElementSibling) {
      const t = visibleText(sib);
      if (t && t.length <= 160) candidates.push(t);
    }

    return candidates.map(clean).filter(Boolean).sort((a, b) => a.length - b.length)[0] || "";
  }

  function choiceScore(optionText, optionValue, target, hint) {
    const label = norm(optionText);
    const val = norm(optionValue);
    const want = norm(target);
    if ((!label && !val) || !want) return 0;

    const wantId = eeoId(want, hint);
    if (wantId) {
      const optId = eeoId(label, hint) || eeoId(val, hint);
      if (optId) return optId === wantId ? eeoBranchScore(label || val, want) : 0;
    }

    if (label === want || val === want) return 115;
    if (label && label.includes(want)) return 75;
    if (val && val.includes(want)) return 70;

    const tokens = want.split(/\W+/).filter((x) => x.length > 2);
    if (!tokens.length) return 0;
    const hits = tokens.filter((t) => label.includes(t) || val.includes(t)).length;
    return hits === tokens.length ? 65 : 0;
  }

  /**
   * Runs a real click and only synthesises input/change if the click did not
   * already produce one.
   *
   * Clicking a <label for> checks its radio and the browser fires `change`
   * itself; firing another one afterwards ran the site's handler twice for a
   * single answer — a double write the user sees as the option blinking.
   */
  /**
   * Would clicking this open the operating system's file chooser?
   *
   * Choice controls are answered by clicking, and a `<label>` is clicked when
   * the input itself will not take one. If that label happens to be bound to a
   * file input — which on an application page means the résumé box — the click
   * opens a native file dialog over the form. The applicant did not ask to
   * upload anything; they asked for the form to be filled in.
   *
   * Nothing here ever needs to open that dialog: an attachment is set through
   * DataTransfer, never through a picker. So any click that would reach a file
   * input is refused outright.
   */
  function opensFilePicker(el) {
    try {
      if (!el) return false;
      if (el.tagName === "INPUT" && String(el.type).toLowerCase() === "file") return true;
      if (el.querySelector?.('input[type="file" i]')) return true;
      const bound = el.getAttribute?.("for");
      if (bound) {
        const target = document.getElementById(bound);
        if (target?.tagName === "INPUT" && String(target.type).toLowerCase() === "file") return true;
      }
      if (el.tagName === "LABEL" && el.control?.type === "file") return true;
      return false;
    } catch {
      return false;
    }
  }

  function clickCommitting(el, action) {
    if (opensFilePicker(el)) return false;
    let sawChange = false;
    const onChange = () => { sawChange = true; };
    el.addEventListener("change", onChange, true);
    try { action(); } finally { el.removeEventListener("change", onChange, true); }
    if (!sawChange) fire(el, "input", "change");
    return sawChange;
  }

  /* ------------------------------------------------------------------ */
  /*  Segmented choice buttons (Yes | No)                                */
  /* ------------------------------------------------------------------ */

  /**
   * The sibling buttons of a segmented choice control, or null.
   *
   * A great many portals render a yes/no question as two plain <button>s rather
   * than radios. The engine only ever accepted a button when it opened a menu,
   * so these were not collected, not filled, and not even reported as needing an
   * answer — the applicant saw an unfilled question and a status pill that did
   * not mention it. This is what "did not answering other fields" refers to.
   *
   * Kept deliberately strict: a small set of siblings, each with short, distinct
   * text, none of them a form action, and none of them a dropdown trigger.
   */
  function choiceButtonGroup(el) {
    if (!el) return null;
    const role = el.getAttribute?.("role");
    if (el.tagName !== "BUTTON" && role !== "button") return null;
    const type = (el.getAttribute?.("type") || "").toLowerCase();
    if (type === "submit" || type === "reset") return null;
    // A button that opens a listbox is a dropdown; that path already works.
    if (el.getAttribute("aria-haspopup") || el.getAttribute("aria-expanded") !== null) return null;

    const parent = el.parentElement;
    if (!parent) return null;

    const siblings = Array.from(parent.children).filter(
      (n) => n.tagName === "BUTTON" || n.getAttribute?.("role") === "button"
    );
    if (siblings.length < 2 || siblings.length > 8) return null;
    if (!siblings.includes(el)) return null;
    if (siblings.length !== parent.children.length) return null;

    const texts = siblings.map((b) => clean(visibleText(b) || b.getAttribute("aria-label") || ""));
    if (texts.some((t) => !t || t.length > 60)) return null;
    // Navigation and file pickers also come in rows of buttons.
    if (texts.some((t) => /^(submit|next|back|previous|continue|save|cancel|close|upload|browse|add|remove|delete|edit|apply now|sign in)\b/i.test(t))) return null;
    if (new Set(texts.map((t) => t.toLowerCase())).size !== texts.length) return null;

    return siblings;
  }

  function isChoiceButton(el) {
    return Boolean(choiceButtonGroup(el));
  }

  /** Has this segmented button been chosen? Libraries signal it several ways. */
  function choiceButtonSelected(el) {
    if (!el) return false;
    if (el.getAttribute("aria-pressed") === "true") return true;
    if (el.getAttribute("aria-checked") === "true") return true;
    if (el.getAttribute("aria-selected") === "true") return true;
    if (el.getAttribute("data-state") === "checked" || el.getAttribute("data-state") === "on") return true;
    if (el.getAttribute("data-selected") === "true" || el.getAttribute("data-active") === "true") return true;
    const cls = el.getAttribute("class") || "";
    return /(^|[\s_-])(selected|active|checked|is-selected|is-active)([\s_-]|$)/i.test(cls);
  }

  function choiceButtonGroupValue(el) {
    const group = choiceButtonGroup(el);
    if (!group) return "";
    const picked = group.find(choiceButtonSelected);
    return picked ? clean(visibleText(picked) || picked.getAttribute("aria-label") || "") : "";
  }

  function radioGroup(el) {
    const buttons = choiceButtonGroup(el);
    if (buttons) return buttons;
    const name = el.getAttribute("name");
    const role = el.getAttribute("role");
    if (role === "radio") {
      return name
        ? Array.from(document.querySelectorAll(`[role="radio"][name="${CSS.escape(name)}"]`))
        : Array.from(el.closest('fieldset, [role="radiogroup"], [role="group"]')?.querySelectorAll('[role="radio"]') || [el]);
    }
    return name
      ? Array.from(document.querySelectorAll(`input[type="radio"][name="${CSS.escape(name)}"]`))
      : Array.from(el.closest('fieldset, [role="radiogroup"], [role="group"]')?.querySelectorAll('input[type="radio"]') || [el]);
  }

  function setRadioValue(el, value, synonyms, hint) {
    if (value === undefined || value === null || String(value).trim() === "") return false;
    const role = el.getAttribute("role");
    let group = radioGroup(el);
    if (!group.length) group = [el];

    const want = norm(value);
    const accepted = synonymsFor(synonyms, value).map(norm).filter(Boolean);
    const targets = [want, ...accepted];
    let best = null, bestScore = 0;

    for (const radio of group) {
      const label = radioOptionText(radio);
      const option = radio.getAttribute("value") || "";
      let score = 0;
      for (let i = 0; i < targets.length; i++) {
        const raw = choiceScore(label, option, targets[i], hint);
        if (!raw) continue;
        // targets[0] is the answer itself; the rest are the rule's synonyms in
        // order of closeness. The penalty is small so it only breaks ties.
        const adjusted = i === 0 ? raw : raw - Math.min(i - 1, 8);
        if (adjusted > score) score = adjusted;
      }
      if (score > bestScore) { bestScore = score; best = radio; }
    }

    // Never guess between radio options. A wrong answer is worse than leaving
    // the question unanswered for the user.
    if (!best || bestScore < 65) return false;

    ensureVisible(best);

    if (isChoiceButton(best)) {
      clickCommitting(best, () => {
        try { best.focus?.({ preventScroll: true }); } catch {}
        best.click?.();
      });
      // Some segmented controls track selection only in framework state, with
      // nothing readable in the DOM. The click is the commit, so a group that
      // reports no selection at all is still treated as answered rather than
      // being clicked a second time.
      return choiceButtonSelected(best) || !group.some(choiceButtonSelected);
    }

    if (best.getAttribute("role") === "radio") {
      try { best.focus?.({ preventScroll: true }); } catch {}
      clickCommitting(best, () => {
        best.click?.();
        if (best.getAttribute("aria-checked") !== "true") {
          best.dispatchEvent(new KeyboardEvent("keydown", { key: " ", code: "Space", bubbles: true }));
          best.dispatchEvent(new KeyboardEvent("keyup", { key: " ", code: "Space", bubbles: true }));
        }
      });
    } else {
      const labelEl = best.id
        ? document.querySelector(`label[for="${CSS.escape(best.id)}"]`)
        : best.closest("label");
      clickCommitting(best, () => {
        const clickable = opensFilePicker(labelEl) ? best : (labelEl || best);
        if (!best.checked) clickable.click?.();
        if (!best.checked && !opensFilePicker(best)) best.click?.();
      });
    }

    return role === "radio" ? best.getAttribute("aria-checked") === "true" : best.checked === true;
  }

  /* ================================================================== */
  /*  MENU REGISTRY — one open dropdown at a time                        */
  /* ================================================================== */

  const OPTION_SELECTOR =
    '[role="option"], [role="menuitem"], [role="menuitemradio"], [role="treeitem"], ' +
    '[role="listbox"] li, [role="menu"] li, li[data-value], ' +
    '[data-automation-id*="promptOption"], [data-automation-id="promptLeafNode"], ' +
    '[class*="menu"] [class*="option"], [class*="dropdown"] li, [class*="select__option"], ' +
    '[class*="Dropdown"] li, ul[class*="option"] li, [class*="autocomplete"] li';

  const POPUP_SELECTOR =
    '[role="listbox"], [role="menu"], [role="tree"], [data-automation-id="menuList"], ' +
    '[data-automation-id="promptOptions"], [class*="popover"], [class*="Popover"], ' +
    '[class*="menuList"], [class*="dropdown-menu"], [class*="select__menu"], [class*="MuiPopper"]';

  const MAX_SCANNED_OPTIONS = 400;

  function optionNodesIn(root) {
    let nodes;
    try { nodes = Array.from((root || document).querySelectorAll(OPTION_SELECTOR)); }
    catch { return []; }
    const out = [];
    for (const n of nodes) {
      if (out.length >= MAX_SCANNED_OPTIONS) break;
      if (n.getAttribute("aria-disabled") === "true" || n.hasAttribute("disabled")) continue;
      const r = n.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const s = getComputedStyle(n);
      if (s.visibility === "hidden" || s.display === "none") continue;
      out.push(n);
    }
    return out;
  }

  /** Every option-shaped node currently on screen, anywhere in the document. */
  function visibleOptions() {
    return optionNodesIn(document);
  }

  /** The menu that belongs to this control, when the page says so explicitly. */
  function declaredPopup(el) {
    for (const attr of ["aria-controls", "aria-owns"]) {
      const ids = (el.getAttribute(attr) || "").split(/\s+/).filter(Boolean);
      for (const id of ids) {
        const node = document.getElementById(id);
        if (node && optionNodesIn(node).length) return node;
      }
    }
    const activeId = el.getAttribute("aria-activedescendant");
    if (activeId) {
      const active = document.getElementById(activeId);
      const popup = active?.closest(POPUP_SELECTOR);
      if (popup && optionNodesIn(popup).length) return popup;
    }
    return null;
  }

  /** The smallest popup container that holds all of `nodes`. */
  function popupAround(nodes) {
    if (!nodes.length) return null;
    let node = nodes[0];
    for (let d = 0; node && d < 12; d++, node = node.parentElement) {
      if (!node.matches?.(POPUP_SELECTOR)) continue;
      if (nodes.every((n) => node.contains(n))) return node;
    }
    return nodes[0].closest(POPUP_SELECTOR) || null;
  }

  /**
   * The single source of truth for "is a dropdown on screen right now".
   * The engine refuses to touch the next field until this is empty.
   */
  const MENU = { el: null, popup: null, baseline: new Set(), pageBaseline: new Set() };

  /**
   * Records what already looked option-shaped before the fill began.
   *
   * Plenty of sites ship permanently-visible markup that matches the option
   * selectors — a site header built from `.dropdown > li`, a styled list of
   * radio cards. Without this the engine would believe a menu was open for the
   * entire run, wait for it before every dropdown, and try to close somebody
   * else's navigation. Anything present at the start is the page's own and is
   * ignored from then on.
   */
  function beginFillSession() {
    MENU.pageBaseline = new Set(visibleOptions());
    MENU.el = null;
    MENU.popup = null;
    MENU.baseline = new Set();
  }

  function menusOpen() {
    const nodes = visibleOptions();
    if (!nodes.length) return false;
    for (const n of nodes) if (!MENU.pageBaseline.has(n)) return true;
    return false;
  }

  async function waitForMenusClosed(timeoutMs = 700) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!menusOpen()) return true;
      await wait(40);
    }
    return !menusOpen();
  }

  /**
   * Closes whatever is open, gently first.
   *
   * The old implementation called `document.body.click()`, a synthetic click
   * whose target is <body>. SPA forms treat that as a click-outside on every
   * open widget at once, which on SAP SuccessFactors reverted the value that
   * had just been committed — the "Master's Degree flips back to No Selection"
   * behaviour. Escape is tried first, then re-toggling the control itself, and
   * only as a last resort a pointerdown on the document (never a click).
   */
  async function closeOpenMenu() {
    const el = MENU.el;
    const popup = MENU.popup;
    const esc = () => new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true, cancelable: true });

    if (!menusOpen()) { MENU.el = null; MENU.popup = null; return true; }
    // Something option-shaped is on screen that we did not open. It belongs to
    // the page, not to us, and closing it is not our business.
    if (!el) return false;

    try { el?.dispatchEvent(esc()); } catch {}
    try { popup?.dispatchEvent(esc()); } catch {}
    if (await waitForMenusClosed(220)) { MENU.el = null; MENU.popup = null; return true; }

    try { document.dispatchEvent(esc()); } catch {}
    if (await waitForMenusClosed(180)) { MENU.el = null; MENU.popup = null; return true; }

    // Re-toggle the owning control — the normal way a user closes a listbox.
    try { el?.click?.(); } catch {}
    if (await waitForMenusClosed(220)) { MENU.el = null; MENU.popup = null; return true; }

    // Last resort: an outside pointerdown, without generating a click event.
    try {
      const target = document.documentElement;
      ["pointerdown", "mousedown", "pointerup", "mouseup"].forEach((type) => {
        try { fire(target, type); } catch {}
      });
    } catch {}
    const closed = await waitForMenusClosed(260);
    MENU.el = null;
    MENU.popup = null;
    return closed;
  }

  /**
   * Opens the menu for one control and returns only *its* options.
   *
   * `baseline` is the set of option nodes that were already on screen before we
   * touched anything. Anything in the baseline is somebody else's menu and is
   * excluded from scoring — this is what stops a neighbouring row's year list
   * being read as this field's choices.
   */
  async function openMenu(el, waitMs = 900) {
    await closeOpenMenu();

    const baseline = new Set([...MENU.pageBaseline, ...visibleOptions()]);
    // Inputs on screen before we opened anything: a search box that is not
    // in this set appeared because of us and belongs to this menu.
    MENU.baselineInputs = new Set(
      Array.from(document.querySelectorAll('input')).filter((i) => {
        const r = i.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      })
    );
    MENU.el = el;
    MENU.popup = null;
    MENU.baseline = baseline;

    ensureVisible(el);
    try { el.focus?.({ preventScroll: true }); } catch {}
    try { fire(el, "pointerdown", "mousedown", "pointerup", "mouseup"); } catch {}
    try { el.click?.(); } catch {}

    const collect = () => {
      const declared = declaredPopup(el);
      if (declared) {
        MENU.popup = declared;
        return optionNodesIn(declared);
      }
      const fresh = visibleOptions().filter((n) => !baseline.has(n));
      if (fresh.length) {
        MENU.popup = popupAround(fresh);
        return MENU.popup ? optionNodesIn(MENU.popup) : fresh;
      }
      return [];
    };

    const deadline = Date.now() + Math.max(300, waitMs);
    let options = collect();
    while (!options.length && Date.now() < deadline) {
      await wait(50);
      options = collect();
    }

    if (!options.length) {
      // Workday and Oracle buttons only render the list on a keyboard opening.
      for (const key of [
        { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
        { key: " ", code: "Space", keyCode: 32 },
        { key: "Enter", code: "Enter", keyCode: 13 },
      ]) {
        try {
          el.dispatchEvent(new KeyboardEvent("keydown", { ...key, which: key.keyCode, bubbles: true, cancelable: true }));
          el.dispatchEvent(new KeyboardEvent("keyup", { ...key, which: key.keyCode, bubbles: true, cancelable: true }));
        } catch {}
        const until = Date.now() + 400;
        while (!options.length && Date.now() < until) {
          await wait(50);
          options = collect();
        }
        if (options.length) break;
      }
    }

    return { options, popup: MENU.popup, baseline };
  }

  /** Re-reads this menu's options after typing changed the filtered list. */
  function menuOptions(session) {
    if (!session) return [];
    if (MENU.popup && document.contains(MENU.popup)) return optionNodesIn(MENU.popup);
    const declared = declaredPopup(session.el || MENU.el || document.body);
    if (declared) { MENU.popup = declared; return optionNodesIn(declared); }
    return visibleOptions().filter((n) => !session.baseline.has(n));
  }

  /**
   * Waits for this control's options. Kept for callers that only need a
   * yes/no on "did anything open", but scoped to the current menu session.
   */
  async function waitForOptions(timeoutMs = 1200) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = visibleOptions();
      if (found.length) return found;
      await wait(60);
    }
    return visibleOptions();
  }

  /**
   * The real `<select>` hiding behind a custom dropdown.
   *
   * Select2, Chosen, jQuery UI and iCIMS's own "— Make a Selection —" control
   * are all decoration over an ordinary `<select>` that still holds the value
   * the form submits. Setting that select is instant, cannot pick the wrong
   * row of a 250-country list, and never opens a menu — so it is tried before
   * any clicking. Only an unambiguous match counts: if a wrapper holds two
   * selects we do not guess which one belongs to this widget.
   */
  function backingSelect(el) {
    if (!el) return null;
    if (el.tagName === "SELECT") return el;
    // Only a dropdown can have one. Asking on behalf of a text box would walk
    // up and adopt whatever unrelated select happens to share its section.
    if (fieldKind(el) !== "select") return null;

    const usable = (s) =>
      s && s.tagName === "SELECT" && !s.disabled && (s.options?.length ?? 0) > 1;
    // A select the user can see and use is a field in its own right, never
    // somebody else's hidden value store.
    const replaced = (s) => usable(s) && !isFillable(s);

    for (const attr of ["aria-controls", "aria-owns", "data-select-id", "data-for", "for"]) {
      const raw = el.getAttribute?.(attr);
      if (!raw) continue;
      for (const id of raw.split(/\s+/)) {
        const found = document.getElementById(id);
        if (usable(found)) return found;
      }
    }

    // Widget-id conventions: "<id>_chosen", "s2id_<id>", "<id>-container".
    const id = el.id || "";
    for (const guess of [
      id.replace(/_chosen$/, ""),
      id.replace(/^s2id_/, ""),
      id.replace(/^select2-/, "").replace(/-container$/, ""),
      id.replace(/[-_]container$/, ""),
      id.replace(/[-_]widget$/, ""),
      id.replace(/[-_]display$/, ""),
    ]) {
      if (!guess || guess === id) continue;
      const found = document.getElementById(guess);
      if (usable(found)) return found;
    }

    let node = el;
    for (let d = 0; node && d < 4; d++, node = node.parentElement) {
      if (node === document.body || node === document.documentElement) break;
      let selects;
      try { selects = Array.from(node.querySelectorAll("select")).filter(replaced); } catch { break; }
      if (selects.length === 1) return selects[0];
      if (selects.length > 1) break;
    }
    return null;
  }

  /**
   * Tells a widget library that its underlying select changed.
   *
   * Content scripts run in an isolated world, so the page's jQuery is out of
   * reach — but jQuery binds real listeners, so dispatching these event names
   * natively still reaches handlers registered with `.on(...)`.
   */
  function notifyWidget(select) {
    fire(select, "input", "change");
    for (const type of ["chosen:updated", "select2:select", "liszt:updated"]) {
      try { select.dispatchEvent(new CustomEvent(type, { bubbles: true })); } catch {}
    }
  }

  /** Does this choice control have any real answer to offer yet? */
  function hasRealOptions(el) {
    const select = backingSelect(el);
    if (!select) return true;   // custom widget with no select — can't tell without opening
    return Array.from(select.options || [])
      .some((o) => o.value && !isPlaceholderChoice(o.textContent));
  }

  /**
   * The search box a portal shows once a dropdown is open.
   *
   * iCIMS floats it above the list rather than inside it, so looking only
   * inside the popup found nothing and a 250-row country list was never
   * filtered. Anything that appeared since the menu opened counts.
   */
  function findSearchInput(el, popup, baselineInputs) {
    const SEARCH_SELECTOR =
      'input[type="text"], input[type="search"], input:not([type]), input[role="combobox"], ' +
      '[data-automation-id="searchBox"] input, input[class*="search" i]';

    const usable = (input) => {
      if (!input || input.disabled || input.readOnly) return false;
      const r = input.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };

    if (popup) {
      for (const input of popup.querySelectorAll(SEARCH_SELECTOR)) if (usable(input)) return input;
    }

    // Newly visible inputs — the floating "— Type to Search —" box.
    if (baselineInputs) {
      for (const input of document.querySelectorAll(SEARCH_SELECTOR)) {
        if (baselineInputs.has(input) || !usable(input)) continue;
        if (input === el) continue;
        return input;
      }
    }

    // A search box the widget keeps mounted, sitting next to the control.
    let node = el;
    for (let d = 0; node && d < 4; d++, node = node.parentElement) {
      if (node === document.body) break;
      for (const input of node.querySelectorAll(SEARCH_SELECTOR)) {
        if (!usable(input) || input === el) continue;
        const hint = `${input.getAttribute("placeholder") || ""} ${input.getAttribute("aria-label") || ""} ${input.className || ""}`;
        if (/search|type to/i.test(hint)) return input;
      }
    }

    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable) return el;
    return null;
  }

  /** Back-compat wrapper for the popup-only lookup. */
  function popupSearchInput(popup) {
    return findSearchInput(popup || document.body, popup, null);
  }

  function setComboboxText(el, text) {
    const value = String(text ?? "");
    try {
      const setter = nativeSetter(el);
      if (el.isContentEditable && el.tagName !== "INPUT") el.textContent = value;
      else if (setter) setter.call(el, value);
      else el.value = value;
    } catch {
      try { el.value = value; } catch {}
    }
    fire(el, "input");
  }

  /* ---------------- nested menus ---------------- */

  const CATEGORY_HINTS = [
    [/linkedin/i, ["social media", "job board", "online", "internet", "website", "professional network"]],
    [/indeed|glassdoor|monster|dice|ziprecruiter|naukri|seek/i, ["job board", "online", "internet", "job site"]],
    [/referr?al|employee|friend|colleague/i, ["referral", "employee referral", "word of mouth", "personal"]],
    [/company\s*(web)?site|our\s*web\s*site|careers?\s*(page|site)/i, ["our web site", "company website", "website", "online"]],
    [/recruiter|agency|head\s*hunter/i, ["recruiter", "agency", "direct sourcing", "search firm"]],
    [/career\s*fair|job\s*fair|campus|university|college/i, ["career fair", "event", "campus", "university"]],
    [/twitter|facebook|instagram|x\.com|social/i, ["social media", "online", "internet"]],
    [/conference|meetup|event|webinar/i, ["event", "conference", "professional associations"]],
    [/newspaper|magazine|print|radio|tv/i, ["advertisement", "print", "media", "other"]],
  ];

  function categoryHintsFor(value) {
    const v = String(value ?? "");
    const hints = [];
    for (const [pattern, list] of CATEGORY_HINTS) if (pattern.test(v)) hints.push(...list);
    hints.push("other");
    return hints;
  }

  function isParentOption(option) {
    if (!option) return false;
    if (option.getAttribute("aria-haspopup")) return true;
    if (option.getAttribute("aria-expanded") !== null) return true;
    if (/submenu|has-children|expandable|parent/i.test(option.className || "")) return true;
    if (option.querySelector('[class*="chevron"], [class*="arrow"], [class*="caret"], svg')) return true;
    if (/[›»>❯]\s*$/.test(clean(option.textContent))) return true;
    return false;
  }

  function optionScoreForTarget(option, targets, hint, primaryCount) {
    const rawText = option.textContent || option.getAttribute("aria-label") || option.getAttribute("data-value") || "";
    const text = normalizeChoiceText(rawText);
    const value = normalizeChoiceText(option.getAttribute("value") || option.getAttribute("data-value") || "");
    if (!text && !value) return 0;
    if (/^(select|choose|please select|please choose|no results found|loading|select one)$/i.test(text)) return 0;

    // Same hard branch rule as the radio path: a voluntary-disclosure answer
    // matches its own branch or nothing at all.
    for (const target of targets) {
      const wantId = eeoId(target, hint);
      if (!wantId) continue;
      const optId = eeoId(rawText, hint) || eeoId(option.getAttribute("value") || "", hint);
      if (optId) return optId === wantId ? eeoBranchScore(rawText, target) : 0;
    }

    // `primaryCount` marks how many of the targets are the answer itself
    // rather than a synonym of it; the rest score on a lower ladder.
    const split = Number.isInteger(primaryCount) ? primaryCount : targets.length;
    return Math.max(
      tieredScore(text, value, targets.slice(0, split), { exact: 130, prefix: 100, contains: 82, fuzzy: 72 }),
      // Ranked, so a rule's ordering of its synonyms decides which category
      // wins when a list offers several that all match.
      rankedSynonymScore(text, value, targets.slice(split), { exact: 104, prefix: 78, contains: 72, fuzzy: 58 })
    );
  }

  async function drillForOption(session, topOptions, targets, rawValue, waitMs, hint, depth = 0) {
    if (depth > 1) return null;

    const hints = categoryHintsFor(rawValue);
    const parents = topOptions
      .filter(isParentOption)
      .map((option) => ({ option, rank: optionScoreForTarget(option, hints, hint) }))
      .sort((a, b) => b.rank - a.rank)
      .slice(0, 4);

    for (const { option } of parents) {
      if (!document.contains(option)) continue;
      const parentText = normalizeChoiceText(option.textContent || "");
      const beforeCount = menuOptions(session).length;

      try { option.scrollIntoView?.({ block: "nearest" }); } catch {}
      try { option.click?.(); } catch {}
      await wait(120);

      let children = menuOptions(session);
      if (children.length === beforeCount) {
        try {
          option.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
        } catch {}
        await wait(200);
        children = menuOptions(session);
      }

      const leaves = children.filter((child) => normalizeChoiceText(child.textContent || "") !== parentText);

      let bestChild = null, bestChildScore = 0;
      for (const child of leaves) {
        const score = optionScoreForTarget(child, targets, hint);
        if (score > bestChildScore) { bestChildScore = score; bestChild = child; }
      }
      if (bestChild && bestChildScore >= 55) return { option: bestChild, score: bestChildScore };

      const deeper = await drillForOption(session, leaves, targets, rawValue, waitMs, hint, depth + 1);
      if (deeper) return deeper;
    }

    return null;
  }

  /* ---------------- the combobox writer ---------------- */

  /**
   * Custom dropdowns — react-select, Workday, Oracle, SAP, MUI, Ashby.
   *
   * One open, one pick, one close, verified. The control is never opened twice
   * for the same value and the function does not return until the menu is off
   * the screen, so the next field always starts from a clean page.
   */
  async function setComboboxValue(el, value, waitMs = 900, synonyms, hint) {
    if (value === undefined || value === null || String(value).trim() === "") return false;

    // Already correct — opening it again would only make the page flicker.
    if (valuesEquivalent(el, value)) return true;

    const want = norm(value);
    const before = comboboxDisplayValue(el);

    // A widget backed by a real select is answered without touching the menu.
    // This is the whole of iCIMS's "— Make a Selection —" country picker: a
    // 250-row list that has to be searched to be reachable, over a plain
    // <select> that takes the value directly.
    const backing = backingSelect(el);
    if (backing && backing !== el) {
      if (setSelectValue(backing, value, synonyms, hint)) {
        await wait(90);
        el.__zapplyNoMatch = false;
        return true;
      }
      // The select exists but holds nothing usable yet — a dependent dropdown
      // waiting on its parent. Say so rather than opening an empty menu.
      if (!hasRealOptions(backing)) return false;
    }

    const session = { el };
    const opened = await openMenu(el, waitMs);
    session.baseline = opened.baseline;
    let options = opened.options;

    const accepted = synonymsFor(synonyms, value);
    const targets = [String(value), want, ...accepted].filter(Boolean);
    const primaryCount = [String(value), want].filter(Boolean).length;

    const pick = (list) => {
      let best = null, bestScore = 0;
      for (const opt of list) {
        const score = optionScoreForTarget(opt, targets, hint, primaryCount);
        if (score > bestScore) { bestScore = score; best = opt; }
      }
      return { best, bestScore };
    };

    let { best, bestScore } = pick(options);

    // Long lists (country, state, school) are virtualised — only the first
    // rows exist in the DOM. Typing is the only way to reach the rest.
    if (!best || bestScore < 100) {
      const search = findSearchInput(el, MENU.popup, MENU.baselineInputs);
      if (search) {
        setComboboxText(search, "");
        await wait(40);
        setComboboxText(search, String(value));
        await wait(Math.min(500, Math.max(220, waitMs / 3)));
        const filtered = menuOptions(session);
        if (filtered.length) {
          const retry = pick(filtered);
          if (retry.best && retry.bestScore >= bestScore) {
            best = retry.best;
            bestScore = retry.bestScore;
            options = filtered;
          }
        }
        // A filter that matched nothing must be cleared, or the control is
        // left holding junk text after we close it.
        if (!best || bestScore < 55) {
          setComboboxText(search, "");
          await wait(180);
          options = menuOptions(session);
          const cleared = pick(options);
          best = cleared.best; bestScore = cleared.bestScore;
        }
      }
    }

    if (!best || bestScore < 55) {
      const drilled = await drillForOption(session, options, targets, value, waitMs, hint);
      if (drilled) { best = drilled.option; bestScore = drilled.score; }
    }

    if (!best || bestScore < 55) {
      // The menu opened and none of its choices fit. Reopening it later cannot
      // change that, so flag the control: the reconcile pass skips it and sends
      // it straight to the user instead of opening the same list a second time.
      //
      // Unless it barely offered anything — a dependent dropdown that is still
      // waiting on its parent looks identical to a dead end at this point, and
      // that one does deserve a second try once the parent is answered.
      const realOptions = options.filter((o) => !isPlaceholderChoice(o.textContent || ""));
      el.__zapplyNoMatch = realOptions.length >= 3;
      await closeOpenMenu();
      return false;
    }
    el.__zapplyNoMatch = false;

    try { best.scrollIntoView?.({ block: "nearest" }); } catch {}
    try { fire(best, "pointerdown", "mousedown", "pointerup", "mouseup"); } catch {}
    try { best.click?.(); } catch {}
    await wait(90);

    // Some listboxes commit on Enter rather than click, but only try that while
    // the menu is genuinely still open — pressing Enter on a closed Workday
    // control submits the page.
    if (menusOpen() && document.contains(best)) {
      try {
        best.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
        best.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      } catch {}
      await wait(90);
    }

    const bestText = normalizeChoiceText(best.textContent || best.getAttribute("aria-label") || "");
    const chosenInPopup = (MENU.popup || document).querySelector?.('[aria-selected="true"], [aria-checked="true"]');
    const chosenText = normalizeChoiceText(chosenInPopup?.textContent || "");

    await closeOpenMenu();

    // Tell the page the value moved — but carefully. On a search-style combobox
    // (react-select and everything that copies it, which is most of the web)
    // the control IS a text input, and an `input` event there means "the user
    // is typing": it reopens the menu we just closed, leaves it hanging over
    // the next field, and can wipe the answer that was just committed. `change`
    // carries the same news to jQuery-era widgets without saying that.
    const isTextEntry = el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable;
    fire(el, ...(isTextEntry ? ["change"] : ["input", "change"]));

    // A widget that reopens on any interaction at all gets one more quiet
    // close, so the next field never starts with a menu on top of it.
    if (menusOpen()) {
      MENU.el = MENU.el || el;
      await closeOpenMenu();
    }

    const shown = normalizeChoiceText(comboboxDisplayValue(el));
    const wantNorm = normalizeChoiceText(want);

    return Boolean(
      (shown && shown !== normalizeChoiceText(before) &&
        (shown.includes(bestText) || bestText.includes(shown) || shown.includes(wantNorm))) ||
      (shown && (shown === bestText || shown === wantNorm)) ||
      (chosenText && (chosenText === bestText || chosenText.includes(bestText)))
    );
  }

  /* ------------------------------------------------------------------ */
  /*  Reading a decorated dropdown's answer                              */
  /* ------------------------------------------------------------------ */

  /**
   * The markup a dropdown library renders its *chosen* answer into.
   *
   * This matters far more than it looks. On react-select — which is what
   * Greenhouse, Ashby, Lever and a long tail of custom portals use — the
   * control itself is an `<input>` whose `value` is the *search text*, so it is
   * empty whenever the menu is closed. The answer is painted into a sibling
   * node instead. A reader that only inspects the control therefore sees an
   * answered question as blank, and everything downstream goes wrong at once:
   * the field is planned again, written again, fails to verify, gets retried,
   * and is finally handed to the AI pass — which is exactly the "autofill goes
   * back to completed fields and edits them" report.
   */
  const CHOICE_VALUE_SELECTOR = [
    '[class*="singleValue" i]',               // react-select (emotion class names)
    '[class*="single-value" i]',              // react-select with a classNamePrefix
    '[class*="multiValue__label" i]',
    '[class*="multi-value__label" i]',
    '[class*="selectedValue" i]',
    '[class*="selected-value" i]',
    '[class*="selection-item" i]',            // Ant Design
    '[class*="selection__rendered" i]',       // Select2 v4
    '[class*="select2-chosen" i]',            // Select2 v3
    '[class*="chosen-single" i] span',        // Chosen
    '[class*="vs__selected" i]',              // vue-select
    '[class*="MuiSelect-select" i]',          // MUI
    '[class*="v-select__selection" i]',       // Vuetify
    '[class*="ss-single" i]',                 // slim-select
    '[class*="filter-option-inner-inner" i]', // bootstrap-select
    '[data-automation-id="selectedItem"]',    // Workday
    '[data-testid*="selectedValue" i]',
  ].join(", ");

  const IN_MENU = '[role="listbox"], [role="menu"], [role="tree"], [role="dialog"]';

  /** Is this node actually on the page (not a hidden or collapsed leftover)? */
  function isShowing(node) {
    if (!node || node.hidden) return false;
    try {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    } catch { return false; }
    return true;
  }

  /**
   * The wrapper a decorated dropdown renders itself into.
   *
   * Walks up only while the ancestor still belongs to this one control, so a
   * section holding several questions is never mistaken for one widget — that
   * would let a neighbouring question's answer be read as this one's.
   */
  function widgetContainer(el) {
    let node = el?.parentElement;
    let found = null;
    for (let d = 0; node && d < 5; d++, node = node.parentElement) {
      if (node === document.body || node === document.documentElement) break;
      if (!ownsOnlyThisField(node, el)) break;
      found = node;
    }
    return found;
  }

  /** Is the widget still showing its "Select…" placeholder rather than an answer? */
  function showsPlaceholder(el) {
    const container = widgetContainer(el);
    if (!container) return false;
    let nodes;
    try { nodes = container.querySelectorAll('[class*="placeholder" i]'); } catch { return false; }
    for (const node of nodes) {
      if (node === el || node.contains?.(el)) continue;
      if (node.closest?.(IN_MENU)) continue;
      if (!isShowing(node)) continue;
      if (clean(node.textContent)) return true;
    }
    return false;
  }

  /** The answer the widget has painted, read from the control or its wrapper. */
  function renderedChoiceText(el) {
    const scopes = [];
    if (el?.querySelectorAll) scopes.push(el);
    const container = widgetContainer(el);
    if (container) scopes.push(container);

    for (const scope of scopes) {
      let nodes;
      try { nodes = scope.querySelectorAll(CHOICE_VALUE_SELECTOR); } catch { continue; }
      const texts = [];
      for (const node of nodes) {
        if (node === el || node.contains?.(el)) continue;
        // An option sitting in an open menu is a candidate, not a committed
        // answer, and the menu is often rendered inside the same wrapper.
        if (node.closest?.(IN_MENU)) continue;
        if (/placeholder/i.test(node.className || "")) continue;
        if (!isShowing(node)) continue;
        const text = clean(node.textContent);
        if (!text || isPlaceholderChoice(text)) continue;
        if (!texts.includes(text)) texts.push(text);
      }
      if (texts.length) return texts.join(", ");
    }
    return "";
  }

  /**
   * Where a decorated dropdown keeps the value it will actually submit.
   *
   * Usually a real `<select>`. When there isn't one, react-select and friends
   * post a hidden `<input>` instead — and Greenhouse puts an internal option id
   * in it, not the label. So this answers "is this question answered?", never
   * "what does it say".
   */
  function backingValueHolder(el) {
    const select = backingSelect(el);
    if (select && select !== el) return select;
    if (!el || fieldKind(el) !== "select") return null;

    const container = widgetContainer(el);
    if (!container) return null;
    let hidden;
    try { hidden = Array.from(container.querySelectorAll('input[type="hidden"]')); } catch { return null; }
    const candidates = hidden.filter(
      (input) => input !== el && !/csrf|token|authenticity|utf8|_method|nonce/i.test(`${input.name || ""} ${input.id || ""}`)
    );
    // Two hidden inputs in one wrapper is ambiguous; guessing would be worse
    // than reporting nothing.
    return candidates.length === 1 ? candidates[0] : null;
  }

  /** Does the widget's own value store hold a real answer? */
  function backingHasValue(el) {
    const holder = backingValueHolder(el);
    if (!holder) return false;
    if (holder.tagName === "SELECT") {
      const opt = holder.options?.[holder.selectedIndex];
      return Boolean(opt?.value) && !isPlaceholderChoice(opt.textContent);
    }
    const raw = String(holder.value ?? "").trim();
    if (!raw || isPlaceholderChoice(raw)) return false;
    // The "nothing chosen" sentinels widgets post before anyone touches them.
    if (/^(-1|0|null|undefined|false)$/i.test(raw)) return false;
    // And whatever the hidden field holds, a control still showing "Select…"
    // has not been answered. Believing otherwise would skip a blank question.
    return !showsPlaceholder(el);
  }

  /**
   * What a custom dropdown is currently showing.
   *
   * Deliberately does not fall back to the button's whole text: on Workday the
   * button label includes the question ("Country United States"), which made
   * an *unset* control look filled.
   */
  function comboboxDisplayValue(el) {
    if (!el) return "";

    // The select underneath is the value the form will actually submit, and it
    // updates before the decoration does.
    const backing = backingSelect(el);
    if (backing && backing !== el) {
      const opt = backing.options?.[backing.selectedIndex];
      const text = clean(opt?.textContent || "");
      if (opt?.value && text && !isPlaceholderChoice(text)) return text;
      return "";
    }

    // What the widget has painted as the answer. Checked before the control's
    // own value because on a search-style combobox that value is the filter
    // text, not the answer.
    const rendered = renderedChoiceText(el);
    if (rendered) return rendered;

    // A widget still showing "Select…" is unanswered, whatever half-typed
    // search text happens to be sitting in its input.
    if (showsPlaceholder(el)) return "";

    const semantic =
      el.getAttribute("aria-valuetext") ||
      el.getAttribute("data-value") ||
      el.getAttribute("data-uxi-widget-value") ||
      (el.tagName === "INPUT" || el.tagName === "TEXTAREA" ? el.value : "");
    if (semantic && String(semantic).trim()) return String(semantic).trim();

    const selected = el.querySelector?.('[aria-selected="true"]');
    if (selected && !selected.closest?.(IN_MENU)) {
      const t = clean(selected.textContent);
      if (t && !isPlaceholderChoice(t)) return t;
    }

    const activeId = el.getAttribute("aria-activedescendant");
    if (activeId) {
      const active = document.getElementById(activeId);
      if (active) {
        const t = clean(active.textContent);
        if (t) return t;
      }
    }

    // A button whose text is short and not a placeholder is the value itself —
    // unless it is just repeating the question. Workday renders an unset
    // dropdown as a button reading "Country", and treating that as a filled
    // value means the field is skipped and never answered.
    if (el.tagName === "BUTTON" || el.getAttribute("role") === "button" || el.getAttribute("role") === "combobox") {
      const t = clean(el.textContent);
      if (!t || t.length > 80) return "";
      if (PLACEHOLDER_RE.test(t) || /\b(select|choose)\b/i.test(t)) return "";
      return norm(t) === norm(accessibleName(el)) ? "" : t;
    }
    return "";
  }

  /** The control's own question text, as a screen reader would read it. */
  function accessibleName(el) {
    const direct = el.getAttribute("aria-label");
    if (direct) return clean(direct);
    const ids = (el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean);
    if (ids.length) {
      return clean(ids.map((id) => document.getElementById(id)?.textContent || "").join(" "));
    }
    if (el.id) {
      try {
        const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (label) return visibleText(label);
      } catch {}
    }
    return "";
  }

  /* ------------------------------------------------------------------ */
  /*  Checkboxes                                                         */
  /* ------------------------------------------------------------------ */

  function setCheckboxValue(el, answer, synonyms, hint) {
    if (answer === undefined || answer === null || answer === "") return false;

    const isCustom = el.getAttribute("role") === "checkbox";
    const name = el.getAttribute("name");
    const customContainer = el.closest("fieldset, [role='group']");
    const group = isCustom
      ? (name
          ? Array.from(document.querySelectorAll(`[role="checkbox"][name="${CSS.escape(name)}"]`))
          : Array.from(customContainer?.querySelectorAll('[role="checkbox"]') || [el]))
      : (name
          ? Array.from(document.querySelectorAll(`input[type="checkbox"][name="${CSS.escape(name)}"]`))
          : [el]);

    let wants;
    if (Array.isArray(answer)) {
      wants = answer.map(norm).filter(Boolean);
    } else {
      const raw = String(answer).trim();
      if (/^(yes|true|checked|selected|1)$/i.test(raw)) wants = ["yes"];
      else if (/^(no|false|unchecked|not selected|0|none)$/i.test(raw)) wants = [];
      else wants = raw.split(/\s*(?:,|;|\n|\|)\s*/).map(norm).filter(Boolean);
    }

    const checked = (cb) =>
      cb.getAttribute("role") === "checkbox" ? cb.getAttribute("aria-checked") === "true" : Boolean(cb.checked);

    const setChecked = (cb, shouldCheck) => {
      if (checked(cb) === shouldCheck) return;   // already right — leave it alone
      clickCommitting(cb, () => {
        cb.click?.();
        if (cb.getAttribute("role") === "checkbox") cb.setAttribute("aria-checked", String(shouldCheck));
      });
    };

    if (group.length === 1) {
      const rawAnswer = String(answer).trim();
      const shouldCheck = !/^(no|false|unchecked|not selected|0|none)$/i.test(rawAnswer);
      setChecked(el, shouldCheck);
      return checked(el) === shouldCheck;
    }

    /**
     * A group of boxes where exactly one is the answer — the CC-305 disability
     * question is three of them — is a radio group wearing a checkbox costume,
     * and it must be answered the same way.
     *
     * It was not. `wants` reduced a stored "Yes" to the bare token "yes", and
     * every box whose text contained the word "yes" was then ticked. On the
     * CC-305 that is "Yes, I have a disability, or have had one in the past" —
     * a declaration under a federal form, ticked on a word match. The mirror
     * case was just as bad: a stored "No" produced an empty `wants`, so the
     * "No, I do not have a disability…" box could never be ticked at all.
     *
     * Voluntary-disclosure groups now resolve through the same branch rule as
     * every other EEO control: right branch or nothing.
     */
    const groupLabels = group.map((cb) =>
      clean(`${radioOptionText(cb)} ${cb.getAttribute("aria-label") || ""} ${cb.value || ""}`)
    );
    const rawAnswer = String(Array.isArray(answer) ? answer.join(", ") : answer).trim();
    const answerId = eeoId(rawAnswer, hint);
    const optionIds = groupLabels.map((t) => eeoId(t, hint));
    const isDisclosureGroup = optionIds.filter(Boolean).length >= 2;

    if (isDisclosureGroup) {
      if (!answerId) return false;   // no canonical answer — leave it for the user
      let best = -1, bestScore = 0;
      optionIds.forEach((id, i) => {
        if (id !== answerId) return;
        const sc = eeoBranchScore(groupLabels[i], rawAnswer);
        if (sc > bestScore) { bestScore = sc; best = i; }
      });
      if (best === -1) return false;
      group.forEach((cb, i) => setChecked(cb, i === best));
      return checked(group[best]);
    }

    let matched = 0;
    for (const cb of group) {
      const label = norm(`${radioOptionText(cb)} ${cb.getAttribute("aria-label") || ""} ${cb.value || ""}`);
      const shouldCheck = wants.some((w) => {
        if (w === "yes") return /\byes\b|\bagree\b|\baccept\b/i.test(label);
        const accepted = synonyms?.[w]?.map(norm) ?? [w];
        return accepted.some((x) => x && (label === x || label.includes(x) || x.includes(label)));
      });
      if (shouldCheck) matched++;
      setChecked(cb, shouldCheck);
    }
    return matched > 0 && group.some(checked);
  }

  /* ------------------------------------------------------------------ */
  /*  Files                                                              */
  /* ------------------------------------------------------------------ */

  function fileFromDataUrl(doc) {
    const [meta, b64] = doc.dataUrl.split(",");
    const mime = /:(.*?);/.exec(meta)?.[1] || doc.mimeType || "application/pdf";
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new File([bytes], doc.name || "resume.pdf", { type: mime });
  }

  function setFileValue(el, doc) {
    if (!doc?.dataUrl) return false;

    let file;
    try { file = fileFromDataUrl(doc); }
    catch (err) { console.warn("[Zapply] couldn't rebuild the resume file:", err); return false; }

    const dt = (() => {
      try { const t = new DataTransfer(); t.items.add(file); return t; } catch { return null; }
    })();
    if (!dt) return false;

    try {
      el.files = dt.files;
      if (el.files?.length) { fire(el, "input", "change"); return true; }
    } catch {}

    try {
      Object.defineProperty(el, "files", { value: dt.files, configurable: true });
      fire(el, "input", "change");
      if (el.files?.length) return true;
    } catch {}

    try {
      const zone =
        el.closest('[class*="dropzone"], [class*="drop-zone"], [class*="upload"], [data-testid*="upload"]') ||
        el.parentElement || el;
      ["dragenter", "dragover", "drop"].forEach((type) => {
        zone.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
      });
      return true;
    } catch (err) {
      console.warn("[Zapply] file attach failed:", err);
    }
    return false;
  }

  /* ------------------------------------------------------------------ */
  /*  Saved-answer matching (shared with the server)                     */
  /* ------------------------------------------------------------------ */

  const STOPWORDS =
    /\b(please|kindly|the|a|an|your|you|us|our|this|that|is|are|do|does|did|of|to|for|in|on|at|we|and|or|if|will|would|can|could|may)\b/g;

  /** Must stay in sync with normalizeQuestion() in src/models/SavedResponse.ts */
  function normalizeQuestion(q) {
    return (q || "")
      .toLowerCase()
      .replace(/\(.*?\)/g, " ")
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(STOPWORDS, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 180);
  }

  function stem(word) {
    return word
      .replace(/(ations?|ation)$/, "ate")
      .replace(/(ings?)$/, "")
      .replace(/(ed)$/, "")
      .replace(/(ies)$/, "y")
      .replace(/(es)$/, "")
      .replace(/s$/, "")
      .replace(/e$/, "");
  }

  function tokenize(normalized) {
    return new Set(
      normalized.split(" ").filter((w) => w.length > 2).map(stem).filter((w) => w.length > 1)
    );
  }

  function similarity(a, b) {
    const A = tokenize(a);
    const B = tokenize(b);
    if (!A.size || !B.size) return 0;
    let shared = 0;
    A.forEach((w) => { if (B.has(w)) shared++; });
    // Symmetric overlap only.
    //
    // Scoring containment as well looks appealing — it rescues "Work
    // authorization" against "Are you legally authorized to work in the United
    // States?" — but it also means every token of a short saved question being
    // present anywhere in a long one counts as a full match. A saved "Full
    // name" then answers "Confidentiality Agreement Designee full legal name".
    // Reusing an answer on the wrong question is worse than not reusing it, so
    // a genuine reword is handled by storing an alias, not by loosening this.
    return shared / Math.max(A.size, B.size);
  }

  /**
   * Picks the best saved answer for a question, or null.
   * The threshold stays high: filling the wrong answer into a real application
   * is far worse than leaving a field for the user.
   */
  function findSavedAnswer(question, responses, threshold = 0.62) {
    if (!responses?.length) return null;
    const key = normalizeQuestion(question);
    if (!key) return null;

    const exact = responses.find(
      (r) => r.normalizedKey === key || (r.aliases || []).some((a) => normalizeQuestion(a) === key)
    );
    if (exact?.answer) return { ...exact, confidence: 1 };

    let best = null;
    let bestScore = threshold;
    responses.forEach((r) => {
      if (!r.answer) return;
      const aliasScores = [r.normalizedKey || normalizeQuestion(r.question), ...(r.aliases || [])]
        .map((a) => similarity(key, normalizeQuestion(a)));
      const score = Math.max(...aliasScores, 0);
      if (score > bestScore) { bestScore = score; best = r; }
    });
    return best ? { ...best, confidence: bestScore } : null;
  }

  /* ------------------------------------------------------------------ */
  /*  State reading                                                      */
  /* ------------------------------------------------------------------ */

  function isFillable(el) {
    if (!el || el.disabled || el.readOnly || el.getAttribute("aria-disabled") === "true") return false;
    if (el.type === "hidden") return false;
    if (el.getAttribute("aria-hidden") === "true") return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0 && el.type !== "file") return false;
    return true;
  }

  function valuesEquivalent(el, expected, hint) {
    if (expected === undefined || expected === null || String(expected).trim() === "") return false;
    const kind = fieldKind(el);
    const target = norm(expected);
    if (kind === "radio") {
      const role = el.getAttribute("role");
      if (choiceButtonGroup(el)) {
        const picked = choiceButtonGroupValue(el);
        return Boolean(picked) && choiceScore(normalizeChoiceText(picked), "", target, hint) >= 65;
      }
      return radioGroup(el).some((r) => {
        const selected = role === "radio" ? r.getAttribute("aria-checked") === "true" : r.checked;
        if (!selected) return false;
        return choiceScore(radioOptionText(r), r.getAttribute("value") || "", expected, hint) >= 65;
      });
    }
    if (kind === "checkbox") return verifyCheckboxEquivalent(el, expected);
    if (kind === "select") {
      if (el.tagName === "SELECT") {
        const opt = el.options?.[el.selectedIndex];
        if (!opt) return false;
        if (PLACEHOLDER_RE.test(normalizeChoiceText(opt.textContent).trim())) return false;
        return choiceScore(opt.textContent || "", opt.value || "", expected, hint) >= 65;
      }
      const shown = normalizeChoiceText(comboboxDisplayValue(el));
      if (!shown) return false;
      const wantId = eeoId(expected, hint);
      if (wantId) {
        const shownId = eeoId(shown, hint);
        if (shownId) return shownId === wantId;
      }
      const t = normalizeChoiceText(target);
      return shown === t || shown.includes(t) || t.includes(shown);
    }
    return norm(el.value ?? el.textContent ?? "") === target;
  }

  function verifyCheckboxEquivalent(el, expected) {
    const name = el.getAttribute("name");
    const role = el.getAttribute("role");
    const group = role === "checkbox"
      ? (name ? Array.from(document.querySelectorAll(`[role="checkbox"][name="${CSS.escape(name)}"]`)) : Array.from(el.closest('fieldset,[role="group"]')?.querySelectorAll('[role="checkbox"]') || [el]))
      : (name ? Array.from(document.querySelectorAll(`input[type="checkbox"][name="${CSS.escape(name)}"]`)) : [el]);
    const raw = String(expected).trim();
    const wantNone = /^(no|false|unchecked|not selected|0|none)$/i.test(raw);
    if (wantNone) return !group.some((c) => role === "checkbox" ? c.getAttribute("aria-checked") === "true" : c.checked);
    const target = norm(raw);
    return group.some((c) => {
      const isChecked = role === "checkbox" ? c.getAttribute("aria-checked") === "true" : c.checked;
      if (!isChecked) return false;
      const label = norm(radioOptionText(c));
      return target === "yes" || label === target || label.includes(target) || target.includes(label);
    });
  }

  function hasValue(el) {
    const role = el.getAttribute("role");
    const type = (el.type || "").toLowerCase();
    if (role === "checkbox" || type === "checkbox") {
      const name = el.getAttribute("name");
      const group = name
        ? Array.from(document.querySelectorAll(role === "checkbox" ? `[role="checkbox"][name="${CSS.escape(name)}"]` : `input[type="checkbox"][name="${CSS.escape(name)}"]`))
        : [el];
      return group.some((x) => role === "checkbox" ? x.getAttribute("aria-checked") === "true" : x.checked);
    }
    if (role === "radio" || type === "radio") {
      return radioGroup(el).some((x) => role === "radio" ? x.getAttribute("aria-checked") === "true" : x.checked);
    }
    if (type === "file") return el.files?.length > 0;
    if (choiceButtonGroup(el)) return radioGroup(el).some(choiceButtonSelected);
    if (el.tagName === "SELECT") {
      const opt = el.options[el.selectedIndex];
      return Boolean(opt?.value) && !PLACEHOLDER_RE.test(normalizeChoiceText(opt.textContent).trim());
    }
    if (el.tagName === "BUTTON" || role === "button" || role === "combobox" || el.getAttribute("aria-haspopup")) {
      // Read what the widget shows first, then what it would actually submit.
      // A react-select posts a hidden input holding an internal option id, so
      // the second check is the only proof some questions are answered at all.
      return Boolean(comboboxDisplayValue(el)) || backingHasValue(el);
    }
    return Boolean(String(el.value ?? "").trim());
  }

  function optionTextsFor(el) {
    if (!el) return [];
    const segmented = choiceButtonGroup(el);
    if (segmented) return segmented.map((b) => radioOptionText(b)).filter(Boolean);
    if (el.tagName === "SELECT") {
      return Array.from(el.options || [])
        .map((o) => (o.textContent || "").trim())
        .filter(Boolean)
        .slice(0, 50);
    }
    if (el.type === "radio" || el.type === "checkbox" ||
        el.getAttribute("role") === "radio" || el.getAttribute("role") === "checkbox") {
      const role = el.getAttribute("role");
      const type = el.type;
      const name = el.getAttribute("name");
      const group = (role === "radio" || role === "checkbox")
        ? (name
            ? Array.from(document.querySelectorAll(`[role="${role}"][name="${CSS.escape(name)}"]`))
            : Array.from(el.closest(`fieldset, [role="${role === "radio" ? "radiogroup" : "group"}"]`)?.querySelectorAll(`[role="${role}"]`) || [el]))
        : (name ? Array.from(document.querySelectorAll(`input[type="${type}"][name="${CSS.escape(name)}"]`)) : [el]);
      return group.map(radioOptionText).map((x) => String(x).trim()).filter(Boolean).slice(0, 50);
    }
    return visibleOptions().map((x) => (x.textContent || "").trim()).filter(Boolean).slice(0, 50);
  }

  /**
   * Reads a custom dropdown's choices without leaving the menu open.
   * Used when asking the model to answer a question we couldn't map.
   */
  async function readComboboxOptions(el, waitMs = 800) {
    const opened = await openMenu(el, waitMs);
    const texts = opened.options
      .map((x) => {
        const text = clean(x.textContent || x.getAttribute?.("aria-label") || "").replace(/[›»>❯]\s*$/, "").trim();
        if (!text) return "";
        return isParentOption(x) ? `${text} (category, has sub-options)` : text;
      })
      .filter(Boolean)
      .filter((v, i, a) => a.indexOf(v) === i)
      .slice(0, 60);
    await closeOpenMenu();
    return texts;
  }

  global.ZAPPLY_MATCHER = {
    retypeValue, flaggedInvalid, isRequired, opensFilePicker,
    choiceButtonGroup, isChoiceButton, choiceButtonSelected, choiceButtonGroupValue,
    deriveLabel,
    groupLabel,
    sectionContext,
    headingIndex,
    rowsFromAnchors,
    isParentOption,
    humanize,
    fieldKind,
    canonicalInputType,
    matchRule,
    setTextValue,
    setSelectValue,
    setRadioValue,
    setCheckboxValue,
    setComboboxValue,
    comboboxDisplayValue,
    readComboboxOptions,
    visibleOptions,
    backingSelect,
    backingValueHolder,
    backingHasValue,
    widgetContainer,
    renderedChoiceText,
    hasRealOptions,
    isPlaceholderChoice,
    findSearchInput,
    menusOpen,
    beginFillSession,
    waitForMenusClosed,
    closeOpenMenu,
    openMenu,
    waitForOptions,
    optionTextsFor,
    radioOptionText,
    setFileValue,
    isFillable,
    ensureVisible,
    onScreen,
    hasValue,
    valuesEquivalent,
    visibleText,
    norm,
    clean,
    eeoId,
    canonicalChoice,
    normalizeChoiceText,
    normalizeQuestion,
    similarity,
    tokenize,
    findSavedAnswer,
  };
})(typeof window !== "undefined" ? window : globalThis);
