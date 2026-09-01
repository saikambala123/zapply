/**
 * ZAPPLY FIELD MAP
 * ----------------
 * The table that turns a form field's label into a value from the user's profile.
 *
 * Each rule has:
 *   key      unique id, used for logging and for the "skipped" report
 *   match    regexes tested against the field's derived label (label text,
 *            aria-label, placeholder, name, id — see matcher.js)
 *   deny     regexes that disqualify a match even if `match` hit. This is how
 *            "First name" is kept from stealing "First name of your reference".
 *   type     which input types this rule is allowed to fill
 *   value    (profile) => string | null
 *   options  for select/radio: how to pick among the available choices
 *   weight   tie-breaker when two rules match; higher wins
 *
 * Order matters only as a tie-break of last resort — scoring in matcher.js
 * decides, so put specific rules above general ones for readability.
 */

(function (global) {
  const P = (p) => p?.personal ?? {};
  const W = (p) => p?.workAuth ?? {};
  const C = (p) => p?.compensation ?? {};
  const E = (p) => p?.eeo ?? {};

  /**
   * Words that mean the question is about somebody else.
   *
   * "Confidentiality Agreement Designee full legal name" is not the applicant's
   * name, and "Designee email" is not the applicant's email — but both matched
   * the identity rules, so the form came back filled with the wrong person's
   * details. Any rule that answers with the applicant's own identity carries
   * this guard; a question about a reference, a designee or an emergency
   * contact is left for the applicant to answer.
   */
  const THIRD_PARTY =
    /\b(reference|referee|referrer|emergency|supervisor|manager|colleague|co-?worker|designee|designated?|witness|guardian|next\s*of\s*kin|beneficiar(?:y|ies)|attorney|counsel|notary|spouse|parent|contact\s*person|recruiter|representative|third\s*part(?:y|ies)|relative|dependent)\b/i;

  const site = (p, ...labels) => {
    const list = p?.websites ?? [];
    for (const label of labels) {
      const hit = list.find((w) => (w.label || "").toLowerCase().includes(label));
      if (hit?.url) return hit.url;
    }
    return null;
  };

  /**
   * The nth saved role / school, or null.
   *
   * The old version fell back to entry #0 for any index past the end, so a form
   * with three Work Experience blocks and a profile with one job copied that
   * same job into all three rows. An out-of-range row now returns nothing and
   * is left for the applicant instead of being filled with the wrong employer.
   */
  const jobAt = (p, index = 0) => {
    const list = p?.experience ?? [];
    const i = Math.max(0, Number(index) || 0);
    return list[i] ?? (i === 0 ? list[0] ?? null : null);
  };
  const schoolAt = (p, index = 0) => {
    const list = p?.education ?? [];
    const i = Math.max(0, Number(index) || 0);
    return list[i] ?? (i === 0 ? list[0] ?? null : null);
  };

  // Kept for callers/rules that only ever want the first entry's shape.
  const latestJob = (p, index = 0) => jobAt(p, index) ?? {};
  const latestSchool = (p, index = 0) => schoolAt(p, index) ?? {};

  const MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];

  /**
   * Month pickers disagree on wording: "April", "Apr", "04", "4".
   * One synonym table covers every variant so a select/listbox in any of those
   * styles resolves to the same month.
   */
  const MONTH_SYNONYMS = MONTH_NAMES.reduce((acc, name, i) => {
    const n = i + 1;
    acc[name] = [name, name.slice(0, 3), String(n).padStart(2, "0"), String(n)];
    return acc;
  }, {});

  const datePart = (raw, part) => {
    const value = String(raw ?? "").trim();
    if (!value) return null;
    const m = value.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?/);
    if (!m) return value;
    if (part === "year") return m[1];
    if (part === "month") return String(m[2]).padStart(2, "0");
    if (part === "day") return m[3] ? String(Number(m[3])) : "1";
    if (part === "monthName") return MONTH_NAMES[Math.max(0, Number(m[2]) - 1)] || null;
    return value;
  };

  /* ------------------------------------------------------------------ */
  /*  Split date controls                                                */
  /* ------------------------------------------------------------------ */

  /**
   * iCIMS, Oracle and several Workday questionnaires split one date into three
   * controls labelled only "Month", "Day" and "Year", grouped under a heading
   * that says "Start Date (Month / Day / Year)".
   *
   * Without this, the Year box matched the generic experience-date rule and was
   * handed the whole stored value — which is why a start year read "2025-04" —
   * and the Month box could pick up the *other* date's heading entirely.
   */
  const PART_WORDS = {
    month: /^(mm|month|month\s*of\s*\w+)$/i,
    year: /^(yy|yyyy|year)$/i,
    day: /^(dd|day)$/i,
  };

  const dateSlot = (label, el) => {
    const segments = String(label ?? "").split("|").map((s) => s.trim()).filter(Boolean);

    const partOf = (text) => {
      const t = String(text ?? "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
      if (!t) return null;
      for (const [part, re] of Object.entries(PART_WORDS)) if (re.test(t)) return part;
      return null;
    };

    // The most specific label sources come first, so a standalone "Year"
    // segment beats the group heading that lists all three parts.
    let part = null;
    for (const segment of segments) {
      part = partOf(segment);
      if (part) break;
    }
    if (!part) {
      const machine = `${el?.getAttribute?.("name") || ""} ${el?.id || ""} ${el?.getAttribute?.("placeholder") || ""}`;
      part = partOf(machine.replace(/[_\-.]+/g, " "));
    }
    if (!part) {
      const joined = segments.join(" ").toLowerCase();
      const hasMonth = /\bmonth\b|\bmm\b/.test(joined);
      const hasYear = /\byear\b|\byyyy\b/.test(joined);
      const hasDay = /\bday\b|\bdd\b/.test(joined);
      if (hasMonth && !hasYear && !hasDay) part = "month";
      else if (hasYear && !hasMonth && !hasDay) part = "year";
      else if (hasDay && !hasMonth && !hasYear) part = "day";
    }

    // Which of the two dates this control belongs to. The first label source
    // that says so wins, so the field's own group heading beats the section.
    let which = null;
    for (const segment of segments) {
      const s = segment.toLowerCase();
      if (/\b(end|to|thru|through|until|left|completion|graduat|expected)\b/.test(s)) { which = "end"; break; }
      if (/\b(start|from|begin|began|joined|joining|hire[d]?)\b/.test(s)) { which = "start"; break; }
    }

    return { part, which };
  };

  const valueForSlot = (raw, part, el) => {
    if (!raw) return null;
    if (part === "year") return datePart(raw, "year");
    if (part === "day") return datePart(raw, "day");
    if (part === "month") {
      const type = (el?.type || "").toLowerCase();
      if (type === "number") return datePart(raw, "month");
      if (el?.tagName === "SELECT") {
        // Pick the wording this particular select actually uses.
        const texts = Array.from(el.options || []).map((o) => (o.textContent || "").trim());
        const numeric = texts.filter(Boolean).every((t) => /^\d{1,2}$/.test(t));
        if (numeric) return datePart(raw, "month");
      }
      return datePart(raw, "monthName");
    }
    return null;
  };

  /**
   * Today, in the format the control actually accepts.
   *
   * A native <input type="date"> only takes YYYY-MM-DD; everything else on a
   * US application expects MM/DD/YYYY. Shared by `todayDate` and `selfIdDate`
   * so the two can never drift apart.
   */
  const todayFor = (el) => {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const type = (el?.getAttribute?.("type") || el?.type || "").toLowerCase();
    if (type === "date") return `${yyyy}-${mm}-${dd}`;
    if (type === "month") return `${yyyy}-${mm}`;
    return `${mm}/${dd}/${yyyy}`;
  };

  const dateForField = (raw, el) => {
    const type = (el?.type || "").toLowerCase();
    if (type === "month") return datePart(raw, "month");
    if (type === "date") return raw ? String(raw).slice(0, 10) : null;
    return raw;
  };

  const dateMonth = (raw) => datePart(raw, "monthName") || datePart(raw, "month");
  const dateYear = (raw) => datePart(raw, "year");

  const fullName = (p) =>
    [P(p).firstName, P(p).lastName].filter(Boolean).join(" ") || null;

  /**
   * Street plus any second line — but only when the second line adds something.
   *
   * Résumé parsing sometimes copies the street into both, and joining those
   * produced "4685 Old Oaks Dr, 4685 Old Oaks Dr" in Address Line 1 and the
   * street again in Address Line 2.
   */
  const fullAddress = (p) => {
    const line1 = P(p).address;
    const line2 = P(p).addressLine2;
    const same = (a, b) =>
      String(a ?? "").trim().toLowerCase().replace(/[.,]/g, "") ===
      String(b ?? "").trim().toLowerCase().replace(/[.,]/g, "");
    return [line1, same(line1, line2) ? null : line2].filter(Boolean).join(", ") || null;
  };

  /**
   * A street-address box wants the street, not the whole postal address.
   *
   * Résumé parsing usually stores one flat line ("4685 Old Oaks Dr, Lisle, IL,
   * 60532"), and dropping that into a form that also has its own City, State
   * and Zip boxes produced the duplicated address seen on iCIMS. Trailing
   * postal parts are peeled off; the street itself is never touched.
   */
  const streetOnly = (p) => {
    const raw = fullAddress(p);
    if (!raw) return null;
    const parts = raw.split(/\s*,\s*/).map((s) => s.trim()).filter(Boolean);
    if (parts.length < 2) return raw;

    const lower = (s) => String(s ?? "").toLowerCase().trim();
    const city = lower(P(p).city);
    const state = lower(P(p).state);
    const zip = lower(P(p).zip);

    let removed = 0;
    let sawPostcode = false;
    while (parts.length > 1 && removed < 3) {
      const tail = lower(parts[parts.length - 1]);
      const isZip = /^\d{5}(-\d{4})?$/.test(tail) || /^[a-z]\d[a-z]\s*\d[a-z]\d$/.test(tail) || (zip && tail === zip);
      const isState = (state && tail === state) || /^[a-z]{2}$/.test(tail);
      const isCity = city && tail === city;
      // Only strip a plain place name once a postcode has already been seen —
      // that is what tells us this line is "street, city, ST zip" and not a
      // street name that happens to contain a comma.
      const isTrailingPlace = sawPostcode && /^[a-z][a-z .'-]{1,28}$/.test(tail);

      if (!(isZip || isState || isCity || isTrailingPlace)) break;
      if (isZip || isState) sawPostcode = true;
      parts.pop();
      removed++;
    }
    return parts.join(", ") || raw;
  };

  const yearsExperience = (p) => {
    const roles = p?.experience ?? [];
    if (!roles.length) return null;
    let months = 0;
    roles.forEach((r) => {
      if (!r.startDate) return;
      const start = new Date(`${r.startDate}-01`);
      const end = r.current || !r.endDate ? new Date() : new Date(`${r.endDate}-01`);
      months += Math.max(0, (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth()));
    });
    return String(Math.max(1, Math.round(months / 12)));
  };

  /**
   * Phrasings that ask whether the applicant can work *without* sponsorship,
   * which is the inverse of whether they require it.
   */
  const SPONSORSHIP_INVERTED =
    /\bwithout\s+(?:the\s+need\s+for\s+)?(?:any\s+)?(?:a\s+)?(?:visa\s+|employment\s+|work\s+|immigration\s+)?sponsor/i;

  /**
   * The voluntary self-identification block — CC-305 and its equivalents.
   *
   * Three fields inside it look generic and are not: a bare "Name" is the
   * applicant's legal name, a bare "Date" is today, and "Employee ID" does not
   * apply to someone who is not yet an employee. Outside this block those same
   * labels mean other things, so the rules that answer them are gated on this
   * pattern rather than on the label alone.
   */
  const SELF_ID_RE =
    /(voluntary\s+self[-\s]?identification|self[-\s]?identification\s+of\s+disability|form\s*cc-?305|cc-?305|section\s*503|omb\s*control\s*number\s*1250|voluntary\s+disclosure)/i;

  const RULES = [
    /* ---------------- Voluntary self-identification (CC-305) ----------------
     *
     * These three sit above every generic rule because the block they belong to
     * is the one place on an application where "Name", "Date" and "Employee ID"
     * are unambiguous — and the one place a wrong answer is a false statement on
     * a federal form.
     *
     * All three were previously unmatched, which handed them to the AI pass:
     * it answered "Name" with "Yes" (it had read the disability question sitting
     * directly above) and answered "Employee ID" with the applicant's name.
     */
    {
      key: "selfIdName",
      // Above fullName (6) and signature (8) so the section-aware rule wins.
      weight: 19,
      require: SELF_ID_RE,
      match: [/^name$/i, /\byour\s*name\b/i, /\b(full|legal)\s*name\b/i, /\bname\b/i],
      deny: [
        THIRD_PARTY,
        /\bemployee\s*(id|number|#)/i,
        /first|last|middle|preferred|company|school|university|employer|file|user|login/i,
      ],
      identity: true,
      type: ["text"],
      value: (p) => E(p).disabilitySignatureName || fullName(p),
    },
    {
      /**
       * The date beside a self-identification signature is today's date, every
       * time, on every application. The generic `todayDate` rule deliberately
       * refuses a bare "Date" because elsewhere on a form it is just as likely
       * to be a graduation or employment date — but inside this block there is
       * nothing else it can mean, so it is answered here instead.
       */
      key: "selfIdDate",
      weight: 19,
      require: SELF_ID_RE,
      match: [/^date$/i, /\bdate\b/i],
      deny: [
        THIRD_PARTY,
        /\b(start|end|from|to|birth|dob|graduation|grad|hire|termination|expiry|expiration|issued|available|availability|joining|last\s*working)\b/i,
      ],
      identity: true,
      type: ["text", "date"],
      value: (p, el) => todayFor(el),
    },
    {
      /**
       * "Employee ID (if applicable)" is not applicable to an applicant. It has
       * no profile value and must not acquire one: left to the generic passes it
       * collected the applicant's name from the AI, and once that was captured
       * it came back on every later application from Saved Answers.
       *
       * `blank` tells the planner to leave the field alone entirely rather than
       * fall through to saved answers or the model.
       */
      key: "employeeId",
      weight: 19,
      match: [
        /\bemployee\s*(id|no\.?|number|#)\b/i,
        /\bassociate\s*(id|number)\b/i,
        /\bpersonnel\s*(id|number)\b/i,
        /\bworker\s*id\b/i,
      ],
      deny: [/\bapplicant\b|\bcandidate\b|\brequisition\b/i],
      identity: true,
      blank: true,
      type: ["text", "number"],
      value: () => null,
    },

    /* ---------------- Name ---------------- */
    {
      key: "firstName",
      identity: true,
      weight: 10,
      match: [/\b(first|given|fore)\s*name\b/i, /^fname$/i, /\bfirst_?name\b/i],
      deny: [THIRD_PARTY, /reference|emergency|supervisor|manager|contact\s*person|spouse|parent/i],
      type: ["text"],
      value: (p) => P(p).firstName,
    },
    {
      key: "lastName",
      identity: true,
      weight: 10,
      match: [/\b(last|family|sur)\s*name\b/i, /^lname$/i, /\blast_?name\b/i],
      deny: [THIRD_PARTY, /reference|emergency|supervisor|manager|contact\s*person|spouse|parent/i],
      type: ["text"],
      value: (p) => P(p).lastName,
    },
    {
      key: "middleName",
      identity: true,
      weight: 10,
      match: [/\bmiddle\s*(name|initial)\b/i],
      deny: [THIRD_PARTY],
      type: ["text"],
      value: (p) => P(p).middleName,
    },
    {
      key: "preferredName",
      identity: true,
      weight: 9,
      match: [/\b(preferred|nick)\s*name\b/i, /\bwhat.*(call|go by)\b/i],
      deny: [THIRD_PARTY],
      type: ["text"],
      value: (p) => P(p).preferredName || P(p).firstName,
    },
    {
      key: "fullName",
      identity: true,
      weight: 6,
      match: [/\b(full|legal|your)\s*name\b/i, /^name$/i, /\bcandidate\s*name\b/i, /\bapplicant\s*name\b/i],
      deny: [THIRD_PARTY, /first|last|middle|company|school|university|employer|reference|file|user/i],
      type: ["text"],
      value: fullName,
    },
    {
      key: "signature",
      identity: true,
      weight: 8,
      match: [/\b(e-?)?signature\b/i, /\btype\s*your\s*(full\s*)?name\b/i, /\bsign\s*(here|below)\b/i],
      // "Signature Date" is a date, not a place to type a name.
      deny: [THIRD_PARTY, /\bdate\b/i],
      type: ["text"],
      value: (p) => E(p).disabilitySignatureName || fullName(p),
    },
    {
      key: "pronouns",
      weight: 9,
      match: [/\bpronouns?\b/i],
      type: ["text", "select", "radio"],
      value: (p) => P(p).pronouns,
    },
    {
      key: "dateOfBirth",
      identity: true,
      weight: 11,
      match: [/\b(date\s*of\s*birth|birth\s*date|dob)\b/i],
      deny: [THIRD_PARTY, /graduat|start|end|employment/i],
      type: ["text", "date", "month"],
      value: (p, el) => dateForField(P(p).dateOfBirth, el),
    },
    {
      key: "nationality",
      identity: true,
      weight: 10,
      match: [/\b(nationality|citizenship|citizen(ship)?\s*status)\b/i],
      deny: [THIRD_PARTY, /work\s*authorization|sponsor|visa/i],
      type: ["text", "select"],
      value: (p) => P(p).nationality || P(p).citizenship,
    },

    /* ---------------- Contact ---------------- */
    {
      key: "email",
      identity: true,
      weight: 10,
      match: [/\be-?mail\b/i],
      deny: [THIRD_PARTY, /confirm|verify|re-?enter|alternate|reference|emergency/i,
             /\bextension\b|\bext\.?\s*$|area\s*code|country\s*code/i],
      type: ["text", "email"],
      value: (p) => P(p).email,
    },
    {
      key: "emailConfirm",
      identity: true,
      weight: 11,
      match: [/(confirm|verify|re-?enter|repeat).*e-?mail/i, /e-?mail.*(confirm|again)/i],
      deny: [THIRD_PARTY],
      type: ["text", "email"],
      value: (p) => P(p).email,
    },
    {
      key: "phoneCountryCode",
      weight: 11,
      match: [/\b(country|dial|area)\s*code\b/i, /\bphone.*code\b/i],
      deny: [THIRD_PARTY],
      type: ["text", "select", "tel"],
      value: (p) => P(p).phoneCountryCode,
    },
    {
      key: "phone",
      weight: 9,
      match: [/\b(phone|mobile|cell|telephone|contact\s*number)\b/i],
      deny: [THIRD_PARTY, /country|area\s*code|extension|emergency|reference|type/i],
      type: ["text", "tel"],
      value: (p) => P(p).phone,
    },
    {
      // Claims the field so nothing else can. "Phone Extension" matched no rule
      // before, which left it open to whatever came next — a saved answer or a
      // drafted one — and it was being filled with the email address. It is
      // answered from the profile when there is an extension to give, and left
      // alone otherwise.
      key: "phoneExtension",
      weight: 12,
      match: [/\b(phone|telephone|mobile)?\s*extension\b/i, /\bext\.?\s*(number|no)?\s*$/i],
      deny: [THIRD_PARTY],
      type: ["text", "tel", "number"],
      value: (p) => P(p).phoneExtension || P(p).phoneExt || null,
    },
    {
      key: "phoneType",
      weight: 10,
      match: [/\bphone\s*(type|device)\b/i],
      deny: [THIRD_PARTY],
      type: ["select", "radio", "text"],
      value: (p) => P(p).phoneType || "Mobile",
      options: ["mobile", "cell", "home", "personal"],
    },

    /* ---------------- Address ---------------- */
    {
      key: "addressLine2",
      weight: 11,
      match: [/\b(address\s*(line\s*)?2|apt|apartment|suite|unit)\b/i],
      deny: [THIRD_PARTY],
      type: ["text"],
      // Résumé parsing sometimes copies the street into both lines. Repeating
      // it is never what the applicant meant, so line 2 gives way when it only
      // echoes line 1.
      value: (p) => {
        const line2 = P(p).addressLine2;
        if (!line2) return null;
        const norm = (x) => String(x ?? "").trim().toLowerCase().replace(/[.,]/g, "");
        return norm(line2) === norm(P(p).address) ? null : line2;
      },
    },
    {
      key: "address",
      weight: 8,
      match: [/\b(street|address\s*(line\s*)?1?|mailing\s*address|home\s*address)\b/i],
      deny: [THIRD_PARTY, /e-?mail|city|state|zip|postal|country|line\s*2|apt|suite/i],
      type: ["text"],
      // Only the street when the form has its own City/State/Zip boxes, which
      // is nearly always; a single free-text address box still gets the lot.
      value: (p, el) => {
        const form = el?.closest?.("form") || document;
        // Attributes first — but a portal that ids its inputs with GUIDs has
        // none of these, and its Postal Code box was therefore invisible here.
        // The whole flattened address then went into Address Line 1, on exactly
        // the forms that already had a box for each part.
        let hasParts = Boolean(
          form.querySelector?.('[name*="zip" i], [name*="postal" i], [id*="zip" i], [id*="postal" i], [aria-label*="zip" i], [aria-label*="postal" i], [data-automation-id*="postal" i], [data-automation-id*="zip" i], [placeholder*="zip" i], [placeholder*="postal" i]')
        );
        if (!hasParts) {
          // Then what the applicant can actually read on the page.
          try {
            hasParts = Array.from(form.querySelectorAll("label, legend") || [])
              .some((node) => /\b(zip|postal|post\s*code|postcode)\b/i.test(node.textContent || ""));
          } catch {}
        }
        return hasParts ? streetOnly(p) : fullAddress(p);
      },
    },
    {
      key: "city",
      weight: 10,
      match: [/\bcity\b/i, /\btown\b/i, /\blocality\b/i],
      deny: [THIRD_PARTY, /school|university|employer|company|birth/i],
      type: ["text", "select"],
      value: (p) => P(p).city,
    },
    {
      key: "state",
      weight: 10,
      match: [/\b(state|province|region|county)\b/i],
      deny: [THIRD_PARTY, /united\s*states\b.*country|veteran|marital|employment\s*status/i],
      type: ["text", "select"],
      value: (p) => P(p).state,
    },
    {
      key: "zip",
      weight: 10,
      match: [/\b(zip|postal)\s*code\b/i, /^zip$/i, /\bpostcode\b/i],
      deny: [THIRD_PARTY],
      type: ["text"],
      value: (p) => P(p).zip,
    },
    {
      key: "country",
      weight: 9,
      match: [/\bcountry\b/i],
      deny: [THIRD_PARTY, /code|citizenship|origin/i],
      type: ["text", "select"],
      value: (p) => P(p).country,
    },
    {
      key: "location",
      weight: 6,
      match: [/\b(location|where are you (based|located))\b/i, /\bcurrent\s*location\b/i],
      deny: [THIRD_PARTY, /job|role|position|office|preferred\s*work/i],
      type: ["text"],
      value: (p) => [P(p).city, P(p).state, P(p).country].filter(Boolean).join(", ") || null,
    },

    /* ---------------- Links ---------------- */
    {
      key: "linkedin",
      weight: 11,
      match: [/\blinked-?in\b/i],
      type: ["text", "url"],
      value: (p) => site(p, "linkedin"),
    },
    {
      key: "github",
      weight: 11,
      match: [/\bgit-?hub\b/i],
      type: ["text", "url"],
      value: (p) => site(p, "github"),
    },
    {
      key: "portfolio",
      weight: 9,
      match: [/\b(portfolio|personal\s*(web)?site|website|your\s*url)\b/i],
      deny: [/company|employer|linkedin|github/i],
      type: ["text", "url"],
      value: (p) => site(p, "portfolio", "personal", "website") || site(p, "github"),
    },
    {
      key: "twitter",
      weight: 11,
      match: [/\b(twitter|x\.com)\b/i],
      type: ["text", "url"],
      value: (p) => site(p, "twitter", "x"),
    },

    /* ---------------- Work history ---------------- */
    {
      key: "currentCompany",
      weight: 14,
      match: [
        /\b(work\s*experience|employment|work\s*history|job\s*history|professional\s*experience)\b.*\b(company|employer|organization)\b/i,
        /\b(current|present|most recent|latest)\s*(employer|company|organization)\b/i,
        /^company$/i,
        /\bemployer\b/i,
      ],
      deny: [/previous|former|why|reason|reference/i],
      type: ["text"],
      value: (p, _el, _label, index) => latestJob(p, index).company,
    },
    {
      key: "currentTitle",
      weight: 14,
      match: [
        /\b(work\s*experience|employment|work\s*history|job\s*history|professional\s*experience)\b.*\b(job\s*)?title\b/i,
        // The same pairing in the other order: iCIMS labels the box "Title" and
        // puts "Professional Experience (1)" in the section heading, so the
        // section word lands *after* the field word in the derived label.
        /\b(job\s*)?title\b.*\b(work\s*experience|employment|work\s*history|job\s*history|professional\s*experience)\b/i,
        /\b(current|present|most recent|latest)\s*(job\s*)?title\b/i,
        /\byour\s*(job\s*)?title\b/i,
        /^job\s*title$/i,
        /\bposition\s*title\b/i,
        /\bjob\s*title\b/i,
      ],
      deny: [/desired|applying|role you|reference|degree|education|school|university/i],
      type: ["text"],
      value: (p, _el, _label, index) => latestJob(p, index).title,
    },
    {
      key: "employmentType",
      weight: 12,
      match: [/\bemployment\s*(type|status)\b/i, /\bjob\s*(type|status)\b/i, /\bwork\s*(type|status)\b/i],
      deny: [/current|previous|eligibility|authorized/i],
      type: ["text", "select", "radio"],
      value: (p, _el, _label, index) => latestJob(p, index).employmentType,
    },
    {
      key: "experienceLocation",
      weight: 12,
      match: [
        /\b(experience|employment|work\s*history|job\s*history)\b.*\blocation\b/i,
        /\blocation\b.*\b(experience|employment|work\s*history|job\s*history)\b/i,
      ],
      type: ["text", "select"],
      value: (p, _el, _label, index) => latestJob(p, index).location,
    },
    {
      key: "experienceLocationType",
      weight: 12,
      match: [
        /\b(work|job|employment|experience)\b.*\b(location|workplace)\s*(type|mode|arrangement)\b/i,
        /\b(remote|hybrid|on[- ]site)\b.*\b(work|employment|location)\b/i,
      ],
      type: ["text", "select", "radio"],
      value: (p, _el, _label, index) => latestJob(p, index).locationType,
      options: {
        "On-site": ["on-site", "onsite", "office"],
        Remote: ["remote", "work from home", "wfh"],
        Hybrid: ["hybrid"],
      },
    },
    {
      key: "responsibilities",
      weight: 9,
      match: [
        /\b(responsibilit(?:y|ies)|what\s+you\s+did|duties|job\s+duties|accomplishments)\b/i,
        // A "Description" box inside a work-experience block is the role
        // summary. Anchored to the section so it can never swallow the job
        // posting's own description field.
        /\b(description|summary\s*of\s*(work|duties))\b.*\b(work\s*experience|employment|work\s*history|job\s*history|professional\s*experience|employer)\b/i,
        /\b(work\s*experience|employment|work\s*history|job\s*history|professional\s*experience)\b.*\b(description|summary\s*of\s*(work|duties))\b/i,
      ],
      deny: [/reference|emergency|job\s*post|posting\s*description|cover\s*letter/i],
      type: ["text", "textarea"],
      value: (p, _el, _label, index) => latestJob(p, index).description,
    },
    {
      key: "experienceStartDate",
      weight: 12,
      match: [
        /\b(experience|employment|work\s*history|job\s*history)\b.*\bstart\b/i,
        /\bstart\b.*\b(experience|employment|work\s*history|job\s*history)\b/i,
      ],
      type: ["text", "date", "month"],
      value: (p, el, _label, index) => dateForField(latestJob(p, index).startDate, el),
    },
    {
      key: "experienceEndDate",
      weight: 12,
      match: [
        /\b(experience|employment|work\s*history|job\s*history)\b.*\bend\b/i,
        /\bend\b.*\b(experience|employment|work\s*history|job\s*history)\b/i,
      ],
      type: ["text", "date", "month"],
      value: (p, el, _label, index) => dateForField(latestJob(p, index).endDate, el),
    },
    /* Split Month / Day / Year controls inside a work-experience block.
       Highest weight in the family so a bare "Year" box can never fall through
       to the whole-date rule and receive "2025-04". */
    {
      key: "experienceDatePart",
      weight: 16,
      match: [
        /\b(month|year|day|mm|dd|yy(?:yy)?)\b.*\b(work\s*experience|employment|work\s*history|job\s*history|professional\s*experience|employer)\b/i,
        /\b(work\s*experience|employment|work\s*history|job\s*history|professional\s*experience|employer)\b.*\b(month|year|day|mm|dd|yy(?:yy)?)\b/i,
      ],
      deny: [/education|school|college|university|degree|graduat|birth|dob|gpa/i],
      type: ["select", "text", "number", "month", "date"],
      value: (p, el, label, index) => {
        const job = jobAt(p, index);
        if (!job) return null;
        const { part, which } = dateSlot(label, el);
        const raw = which === "end" ? job.endDate : job.startDate;
        if (which === "end" && (job.current || !job.endDate)) return null;   // still employed
        if (!raw) return null;
        if (!part) return dateForField(raw, el);
        return valueForSlot(raw, part, el);
      },
      options: MONTH_SYNONYMS,
    },
    {
      key: "experienceStartMonth",
      weight: 13,
      match: [/\bstart\s*date\s*month\b/i, /\bstart\s*month\b/i],
      deny: [/education|school|college|university/i],
      type: ["select", "text"],
      value: (p, _el, _label, index) => dateMonth(latestJob(p, index).startDate),
      options: MONTH_SYNONYMS,
    },
    {
      key: "experienceStartYear",
      weight: 13,
      match: [/\bstart\s*date\s*year\b/i, /\bstart\s*year\b/i],
      deny: [/education|school|college|university/i],
      type: ["select", "text"],
      value: (p, _el, _label, index) => dateYear(latestJob(p, index).startDate),
    },
    {
      key: "experienceEndMonth",
      weight: 13,
      match: [/\bend\s*date\s*month\b/i, /\bend\s*month\b/i],
      deny: [/education|school|college|university/i],
      type: ["select", "text"],
      value: (p, _el, _label, index) => dateMonth(latestJob(p, index).endDate),
      options: MONTH_SYNONYMS,
    },
    {
      key: "experienceEndYear",
      weight: 13,
      match: [/\bend\s*date\s*year\b/i, /\bend\s*year\b/i],
      deny: [/education|school|college|university/i],
      type: ["select", "text"],
      value: (p, _el, _label, index) => dateYear(latestJob(p, index).endDate),
    },
    {
      key: "currentJob",
      weight: 12,
      match: [/\bcurrently\s*(work|employed)\b/i, /\bcurrent\s*(job|role|position)\b/i, /\bthis\s*is\s*my\s*current\s*(job|role)\b/i],
      type: ["checkbox", "radio", "select"],
      value: (p, _el, _label, index) => latestJob(p, index).current ? "Yes" : "No",
      options: { Yes: ["yes", "currently", "current", "true"], No: ["no", "not current", "false"] },
    },
    {
      key: "yearsExperience",
      weight: 9,
      match: [/\byears?\s*(of\s*)?(relevant\s*|professional\s*|work\s*)?experience\b/i, /\bhow many years\b/i, /\bexperience\s*\(years\)/i],
      type: ["text", "number", "select", "radio"],
      value: yearsExperience,
    },

    /* ---------------- Education ---------------- */
    {
      key: "school",
      weight: 10,
      match: [/\b(school|university|college|institution)\b/i],
      deny: [/high\s*school\s*only|graduated\b.*\?/i],
      type: ["text", "select"],
      value: (p, _el, _label, index) => latestSchool(p, index).school,
    },
    {
      key: "degree",
      weight: 10,
      match: [/\bdegree\b/i, /\beducation\s*level\b/i, /\bhighest\s*(level\s*of\s*)?education\b/i],
      deny: [/field|major|subject|date/i],
      type: ["text", "select", "radio"],
      value: (p, _el, _label, index) => latestSchool(p, index).degree,
    },
    {
      key: "fieldOfStudy",
      weight: 11,
      match: [/\b(field\s*of\s*study|major|discipline|concentration|area\s*of\s*study)\b/i],
      type: ["text", "select"],
      value: (p, _el, _label, index) => latestSchool(p, index).fieldOfStudy,
    },
    {
      key: "educationLocation",
      weight: 8,
      match: [/\b(school|college|university|education)\b.*\blocation\b/i, /\blocation\b.*\b(school|college|university)\b/i],
      type: ["text", "select"],
      value: (p, _el, _label, index) => latestSchool(p, index).location,
    },
    {
      key: "gpa",
      weight: 11,
      match: [/\bgpa\b/i, /\bgrade\s*point\b/i],
      type: ["text", "number"],
      value: (p, _el, _label, index) => latestSchool(p, index).gpa,
    },
    {
      key: "graduationDate",
      weight: 9,
      match: [/\b(graduation|grad)\s*(date|year|month)\b/i, /\b(expected|anticipated)\s*graduation\b/i],
      type: ["text", "date", "month", "select"],
      value: (p, el, _label, index) => dateForField(latestSchool(p, index).endDate, el),
    },
    /* Split Month / Day / Year controls inside an education block. */
    {
      key: "educationDatePart",
      weight: 16,
      match: [
        /\b(month|year|day|mm|dd|yy(?:yy)?)\b.*\b(education|school|college|university|degree|academic)\b/i,
        /\b(education|school|college|university|degree|academic)\b.*\b(month|year|day|mm|dd|yy(?:yy)?)\b/i,
      ],
      deny: [/work\s*experience|employment|work\s*history|job\s*history|professional\s*experience|birth|dob/i],
      type: ["select", "text", "number", "month", "date"],
      value: (p, el, label, index) => {
        const school = schoolAt(p, index);
        if (!school) return null;
        const { part, which } = dateSlot(label, el);
        const raw = which === "start" ? school.startDate : school.endDate;
        if (!raw) return null;
        if (!part) return dateForField(raw, el);
        return valueForSlot(raw, part, el);
      },
      options: MONTH_SYNONYMS,
    },
    {
      key: "educationStartMonth",
      weight: 13,
      match: [
        /\b(education|school|college|university)\b.*\b(start|begin)\w*\s*date\s*month\b/i,
        /\b(start|begin)\w*\s*date\s*month\b.*\b(education|school|college|university)\b/i,
      ],
      type: ["select", "text"],
      value: (p, _el, _label, index) => dateMonth(latestSchool(p, index).startDate),
      options: MONTH_SYNONYMS,
    },
    {
      key: "educationStartYear",
      weight: 13,
      match: [
        /\b(education|school|college|university)\b.*\b(start|begin)\w*\s*date\s*year\b/i,
        /\b(start|begin)\w*\s*date\s*year\b.*\b(education|school|college|university)\b/i,
      ],
      type: ["select", "text"],
      value: (p, _el, _label, index) => dateYear(latestSchool(p, index).startDate),
    },
    {
      key: "educationEndMonth",
      weight: 13,
      match: [
        /\b(education|school|college|university)\b.*\bend\s*date\s*month\b/i,
        /\bend\s*date\s*month\b.*\b(education|school|college|university)\b/i,
        /\bend\s*\(?(or\s+expected)?\)?\s*date\s*month\b.*\b(education|school|college|university)\b/i,
      ],
      type: ["select", "text"],
      value: (p, _el, _label, index) => dateMonth(latestSchool(p, index).endDate),
      options: MONTH_SYNONYMS,
    },
    {
      key: "educationEndYear",
      weight: 13,
      match: [
        /\b(education|school|college|university)\b.*\bend\s*date\s*year\b/i,
        /\bend\s*date\s*year\b.*\b(education|school|college|university)\b/i,
        /\bend\s*\(?(or\s+expected)?\)?\s*date\s*year\b.*\b(education|school|college|university)\b/i,
      ],
      type: ["select", "text"],
      value: (p, _el, _label, index) => dateYear(latestSchool(p, index).endDate),
    },

    /* ---------------- Work eligibility ---------------- */
    {
      /**
       * Answered only from the profile.
       *
       * These used to fall back to "Yes" — authorised to work, over 18, willing
       * to relocate, willing to take a drug test and a background check — and
       * "No" for prior employment. An application is a document the applicant
       * signs, and those are claims about their legal status and their consent.
       * Filling them from nothing puts words in their mouth on a form an
       * employer will hold them to, so a profile that has not answered leaves
       * the field blank and visibly needing them.
       */
      key: "authorizedToWork",
      weight: 12,
      match: [
        /\b(legally\s*)?(authoriz|eligib)\w*\s*to\s*work\b/i,
        /\bwork\s*authoriz\w*\b/i,
        /\blegally\s*(entitled|permitted)\s*to\s*work\b/i,
        /\bright\s*to\s*work\b/i,
      ],
      deny: [/sponsor/i],
      type: ["select", "radio", "text"],
      value: (p) => W(p).authorizedToWork || null,   // never assumed: a claim about legal status
      options: { Yes: ["yes", "i am", "authorized", "true"], No: ["no", "not authorized", "false"] },
    },
    {
      key: "requireSponsorship",
      weight: 13,
      match: [
        /\b(require|need|seek)\w*\s*(visa\s*)?sponsor/i,
        /\bsponsorship\b.*\b(now|future|require|need)\b/i,
        /\bwill\s*you\s*.*sponsorship\b/i,
        /\bimmigration\s*sponsorship\b/i,
      ],
      type: ["select", "radio", "text"],
      /**
       * Half of these questions are asked the other way round.
       *
       * "Will you require sponsorship?" and "Are you able to work without
       * sponsorship?" want opposite answers from the same fact, and the stored
       * value was written straight into both — so an applicant who needs no
       * sponsorship was telling employers, on the second phrasing, that they
       * could not work without it. That is a disqualifying answer, and the
       * wrong one.
       */
      value: (p, el, label) => {
        const stored = W(p).requireSponsorship;
        if (!stored) return null;   // unknown: leave it for the applicant
        const text = String(label ?? "");
        if (!SPONSORSHIP_INVERTED.test(text)) return stored;

        const requiresSponsorship = /^y/i.test(stored);
        if (requiresSponsorship) return "No";

        // Some of these ask about authorisation in the same breath — "legally
        // authorized to work without sponsorship" — and needing no sponsorship
        // only answers half of that.
        const authorized = W(p).authorizedToWork;
        if (/\bauthoriz|\beligible|\blegally\b/i.test(text) && authorized && !/^y/i.test(authorized)) return "No";
        return "Yes";
      },
      options: { Yes: ["yes", "i will", "true"], No: ["no", "i do not", "i don't", "false"] },
    },
    {
      key: "visaStatus",
      weight: 10,
      match: [/\bvisa\s*(status|type)\b/i, /\bimmigration\s*status\b/i, /\bwork\s*permit\s*type\b/i],
      type: ["select", "text"],
      value: (p) => W(p).workAuthType || W(p).visaStatus,
    },
    {
      key: "willingToRelocate",
      weight: 11,
      match: [/\bwilling\s*to\s*relocat/i, /\bopen\s*to\s*relocat/i, /\brelocation\b/i],
      type: ["select", "radio", "text"],
      value: (p) => W(p).willingToRelocate || null,  // never assumed: a commitment to move
      options: { Yes: ["yes", "willing", "true"], No: ["no", "not willing", "false"] },
    },
    {
      key: "remotePreference",
      weight: 10,
      match: [/\b(remote|work\s*(location\s*)?preference|hybrid|on-?site)\s*(preference)?\b/i],
      type: ["select", "radio"],
      value: (p) => W(p).remotePreference,
    },
    {
      key: "startDate",
      weight: 10,
      match: [/\b(available|earliest|possible|potential)\s*(to\s*)?start\s*(date)?\b/i, /\bwhen\s*can\s*you\s*start\b/i, /\bstart\s*date\b/i, /\bavailability\s*date\b/i],
      deny: [/employment\s*start|previous|current\s*job|experience|employment|work\s*history|education|school|college|university/i],
      type: ["text", "date", "month"],
      value: (p, el) => dateForField(W(p).availableStartDate, el),
    },
    {
      key: "noticePeriod",
      weight: 11,
      match: [/\bnotice\s*period\b/i, /\bhow\s*much\s*notice\b/i],
      type: ["text", "select"],
      value: (p) => W(p).noticePeriod,
    },
    {
      key: "over18",
      weight: 12,
      match: [/\b(are\s*you\s*)?(at\s*least\s*)?(18|eighteen)\s*(years)?\s*(of\s*age|or\s*older|\+)?\b/i, /\blegal\s*working\s*age\b/i],
      type: ["select", "radio"],
      value: (p) => W(p).over18 || null,             // never assumed: a claim about age
      options: { Yes: ["yes", "true"], No: ["no", "false"] },
    },
    {
      key: "previouslyEmployed",
      weight: 12,
      match: [/\b(previously|ever)\s*(been\s*)?(employed|worked)\b/i, /\bformer\s*employee\b/i, /\bworked\s*(here|for\s*(us|this))\b/i],
      type: ["select", "radio"],
      value: (p) => W(p).previouslyEmployedHere || null,  // never assumed: a fact about their history
      options: { Yes: ["yes", "true"], No: ["no", "false"] },
    },
    {
      key: "referredBy",
      weight: 11,
      match: [/\breferr?ed\s*by\b/i, /\breferral\s*(name|source)\b/i, /\bwho\s*referred\b/i],
      type: ["text"],
      value: (p) => W(p).referredBy,
    },
    {
      /**
       * "Today's Date", "Date Signed", and the bare "Date" beside a signature.
       *
       * These are the one date on an application that isn't in the profile —
       * it's whatever day the form is being filled in — so they were left blank
       * on every form. Written as MM/DD/YYYY for a text box and as YYYY-MM-DD
       * for a native date input, which is the only format those accept.
       *
       * The denials matter more than the patterns: a bare "Date" also appears on
       * employment and education rows, and on availability questions, and none
       * of those mean today.
       */
      key: "todayDate",
      identity: true,
      // Above the date-part rules (16). "Today's Date" is an explicit phrase,
      // while those match a loose month/year hint near an education or
      // employment word — which a placeholder of "MM/DD/YYYY" beside an
      // Education heading is enough to satisfy.
      weight: 18,
      match: [
        /\btoday'?s?\s*date\b/i,
        /\bcurrent\s*date\b/i,
        /\bdate\s*(of\s*)?(signature|signed|signing)\b/i,
        /\bsignature\s*date\b/i,
        /\bdate\s*of\s*application\b/i,
        /\bapplication\s*date\b/i,
      ],
      // A bare "Date" is deliberately not matched. It is just as likely to be an
      // employment row's start date or a graduation date, and writing today into
      // one of those is worse than leaving it for the applicant.
      deny: [
        THIRD_PARTY,
        /\b(start|end|from|to|birth|dob|graduation|grad|hire|termination|expiry|expiration|issued|available|availability|joining|last\s*working)\b/i,
      ],
      type: ["text", "date"],
      value: (p, el) => todayFor(el),
    },
    {
      key: "howDidYouHear",
      weight: 11,
      match: [/\bhow\s*did\s*you\s*(hear|find|learn)\b/i, /\bsource\s*of\s*(referral|application)\b/i, /\bwhere\s*did\s*you\s*(hear|find)\b/i],
      type: ["select", "text", "radio"],
      value: () => "LinkedIn",   // Always use LinkedIn as the canonical source answer.
      // The matcher resolves that canonical answer against native selects,
      // radio groups, Workday custom dropdowns and segmented controls.
      // Many portals ask this in two steps: a category here ("Job Board") and
      // the actual source in a "Please specify" box that appears afterwards.
      // A stored answer of "LinkedIn" has to resolve to whichever category
      // this particular list uses, or the question cannot be answered at all.
      options: {
        // Ordered most specific first. "Job board" used to outrank "social
        // media" and "professional network", so a list offering LinkedIn only
        // under one of those was answered with the wrong category.
        LinkedIn: ["linkedin", "linked in", "professional network", "professional networking",
                   "social media", "social network", "job board", "job boards", "job site",
                   "online", "internet", "website"],
        Indeed: ["indeed", "job board", "job boards", "online", "internet", "job site"],
        Glassdoor: ["glassdoor", "job board", "job boards", "online"],
        Monster: ["monster", "job board", "job boards", "online"],
        Dice: ["dice", "job board", "job boards", "online"],
        ZipRecruiter: ["ziprecruiter", "job board", "job boards", "online"],
        Naukri: ["naukri", "job board", "job boards", "online"],
        "Company Website": ["company website", "our web site", "our website", "career site", "careers page", "website", "online"],
        Referral: ["referral", "employee referral", "word of mouth", "friend", "personal"],
        "Employee Referral": ["employee referral", "referral", "word of mouth"],
        Recruiter: ["recruiter", "agency", "staffing", "search firm", "head hunter", "direct sourcing"],
        "Job Fair": ["job fair", "career fair", "event", "campus", "university"],
        "Career Fair": ["career fair", "job fair", "event", "campus", "university"],
        Twitter: ["twitter", "x", "social media", "online"],
        Facebook: ["facebook", "social media", "online"],
        Instagram: ["instagram", "social media", "online"],
        Google: ["google", "search engine", "online", "internet"],
        Other: ["other"],
      },
    },
    {
      key: "securityClearance",
      weight: 11,
      match: [/\bsecurity\s*clearance\b/i, /\bclearance\s*level\b/i],
      type: ["select", "radio", "text"],
      value: (p) => W(p).securityClearance,
    },
    {
      key: "driversLicense",
      weight: 11,
      match: [/\bdriver'?s?\s*licen[cs]e\b/i],
      type: ["select", "radio", "text"],
      value: (p) => W(p).driversLicense,
    },
    {
      key: "willingToDrugTest",
      weight: 11,
      match: [/\b(willing|agree|consent).*\bdrug\s*test\b/i, /\bdrug\s*test\b/i],
      type: ["select", "radio"],
      value: (p) => W(p).willingToDrugTest || null,  // never assumed: this is consent
      options: { Yes: ["yes", "agree", "consent", "true"], No: ["no", "do not", "decline", "false"] },
    },
    {
      key: "willingToBackgroundCheck",
      weight: 11,
      match: [/\b(willing|agree|consent).*\bbackground\s*(check|screening)\b/i, /\bbackground\s*(check|screening)\b/i],
      type: ["select", "radio"],
      value: (p) => W(p).willingToBackgroundCheck || null,  // never assumed: this is consent
      options: { Yes: ["yes", "agree", "consent", "true"], No: ["no", "do not", "decline", "false"] },
    },

    /* ---------------- Compensation ---------------- */
    {
      key: "desiredSalary",
      weight: 11,
      match: [
        /\b(desired|expected|requested|target)\s*(salary|compensation|pay|rate)\b/i,
        /\bsalary\s*(expectation|requirement)/i,
        /\bcompensation\s*expectation/i,
        /\bwhat.*salary.*(looking|expect)/i,
      ],
      type: ["text", "number"],
      value: (p) => C(p).desiredSalary,
    },
    {
      key: "currentSalary",
      weight: 12,
      match: [/\b(current|present)\s*(salary|compensation|pay)\b/i],
      type: ["text", "number"],
      value: (p) => C(p).currentSalary,
    },

    /* ---------------- EEO ---------------- */
    {
      key: "gender",
      identity: true,
      weight: 10,
      match: [/\bgender\b/i, /\bsex\b/i],
      deny: [/identity\s*expression|transgender/i],
      type: ["select", "radio"],
      eeo: true,
      decline: "Decline to self-identify",
      value: (p) => (E(p).declineToSelfIdentify ? "Decline to self-identify" : E(p).gender),
      options: {
        Male: ["male", "man", "i identify as male"],
        Female: ["female", "woman", "i identify as female"],
        "Non-binary": ["non-binary", "nonbinary", "non binary", "genderqueer", "another gender identity"],
        "Decline to self-identify": [
          "decline to self-identify", "decline to self identify", "prefer not to say",
          "i don't wish to answer", "do not wish to disclose", "not declared",
          "choose not to disclose", "i don't want to answer", "prefer not to disclose",
        ],
        "Prefer not to say": [
          "prefer not to say", "decline to self-identify", "decline to self identify",
          "not declared", "do not wish to disclose", "i don't wish to answer",
        ],
      },
    },
    {
      key: "hispanicLatino",
      identity: true,
      weight: 12,
      match: [/\bhispanic\s*(or|\/)?\s*latino\b/i],
      type: ["select", "radio"],
      eeo: true,
      decline: "Decline to self-identify",
      value: (p) => (E(p).declineToSelfIdentify ? "Decline to self-identify" : E(p).hispanicLatino),
      options: {
        Yes: ["yes", "yes, hispanic or latino", "hispanic or latino"],
        No: ["no", "not hispanic or latino"],
        "Decline to self-identify": [
          "decline to self-identify", "decline to self identify", "prefer not to say",
          "i don't wish to answer", "do not wish to disclose", "not declared",
        ],
      },
    },
    {
      key: "race",
      identity: true,
      weight: 10,
      match: [/\b(race|ethnicity|ethnic\s*(group|background))\b/i],
      deny: [/hispanic\s*(or|\/)?\s*latino/i],
      type: ["select", "radio", "checkbox"],
      eeo: true,
      decline: "Decline to self-identify",
      value: (p) => (E(p).declineToSelfIdentify ? "Decline to self-identify" : E(p).race),
      options: {
        Asian: ["asian", "asian (not hispanic or latino)", "asian (united states of america)"],
        White: ["white", "white (not hispanic or latino)", "caucasian"],
        "Black or African American": ["black or african american", "black", "african american"],
        "Hispanic or Latino": ["hispanic or latino", "hispanic", "latino", "latinx"],
        "Native Hawaiian or Other Pacific Islander": ["native hawaiian or other pacific islander", "pacific islander", "native hawaiian"],
        "American Indian or Alaska Native": ["american indian or alaska native", "american indian", "alaska native", "native american"],
        "Two or More Races": ["two or more races", "two or more", "multiracial", "multi-racial"],
        "Decline to self-identify": [
          "decline to self-identify", "decline to self identify", "prefer not to say",
          "i don't wish to answer", "do not wish to disclose", "not declared",
          "choose not to disclose", "i do not wish to self-identify",
        ],
      },
    },
    /* Voluntary self-identification.
     *
     * `eeo: true` tells the engine these are disclosure questions: if the
     * profile has no stored answer and no saved answer exists, it may fall back
     * to `decline`, which is always a permitted and truthful choice. It never
     * invents a factual answer such as "I am not a protected veteran". */
    {
      key: "veteranStatus",
      identity: true,
      weight: 11,
      match: [/\bveteran\b/i, /\bmilitary\s*(service|status)\b/i, /\bprotected\s*veteran\b/i],
      deny: [/spouse|accommodation/i],
      type: ["select", "radio", "checkbox"],
      eeo: true,
      decline: "I don't wish to answer",
      value: (p) => E(p).veteranStatus || (E(p).declineToSelfIdentify ? "I don't wish to answer" : null),
      options: {
        "I am not a protected veteran": [
          "i am not a protected veteran", "not a protected veteran", "i am not a veteran",
          "no, i am not a protected veteran", "non-veteran", "not a veteran", "no",
        ],
        "I identify as one or more of the classifications of a protected veteran": [
          "i identify as one or more of the classifications of a protected veteran",
          "i identify as one or more of the classifications of protected veteran",
          "one or more of the classifications", "i am a protected veteran",
          "yes, i am a protected veteran", "yes",
        ],
        "I don't wish to answer": [
          "i don't wish to answer", "i dont wish to answer", "decline to self-identify",
          "decline to self identify", "i prefer not to answer", "prefer not to say",
          "i don't want to answer", "choose not to disclose", "do not wish to disclose",
        ],
      },
    },
    {
      key: "disabilityStatus",
      identity: true,
      weight: 11,
      match: [/\bdisabilit(y|ies)\b/i, /\bsection\s*503\b/i, /\bform\s*cc-?257\b/i],
      deny: [/accommodation/i],
      type: ["select", "radio", "checkbox"],
      eeo: true,
      decline: "I don't wish to answer",
      value: (p) => (E(p).declineToSelfIdentify ? "I don't wish to answer" : E(p).disabilityStatus),
      options: {
        "Yes": [
          "yes, i have a disability", "yes i have a disability",
          "yes, i have a disability, or have had one in the past",
          "i have a disability", "or have had one in the past", "yes",
        ],
        "No": [
          "no, i do not have a disability", "no i don't have a disability",
          "no, i do not have a disability and have not had one in the past",
          "i do not have a disability", "no",
        ],
        "I don't wish to answer": [
          "i don't wish to answer", "i do not want to answer", "i don't want to answer",
          "decline to self-identify", "decline to self identify", "prefer not to say",
          "i do not wish to answer", "choose not to disclose",
        ],
      },
    },

    /* ---------------- Misc ---------------- */
    {
      key: "resume",
      weight: 12,
      match: [/\bresume\b/i, /\bcv\b/i, /\bupload\s*(your\s*)?(resume|cv)\b/i],
      deny: [/cover\s*letter|transcript|portfolio\s*file/i],
      type: ["file"],
      value: () => "__RESUME__",
    },
    {
      key: "coverLetter",
      weight: 12,
      match: [/\bcover\s*letter\b/i, /\bmotivation\s*letter\b/i],
      type: ["file", "textarea"],
      value: () => "__COVER_LETTER__",
    },
    {
      key: "certifications",
      weight: 8,
      match: [/\b(certification|certifications|professional\s*license|licen[cs]e)\b/i],
      deny: [/driver'?s?/i],
      type: ["text", "textarea"],
      value: (p) => (p?.certifications ?? []).join(", "),
    },
    {
      key: "languages",
      weight: 8,
      match: [/\b(language|languages|spoken\s*languages|language\s*proficiency)\b/i],
      type: ["text", "textarea"],
      value: (p) => (P(p).languages ?? []).join(", "),
    },
    {
      key: "summary",
      weight: 6,
      match: [/\b(about\s*(you|yourself)|summary|bio|profile\s*summary|tell\s*us\s*about\s*you)\b/i],
      type: ["textarea"],
      value: (p) => p?.summary,
    },
  ];

  global.ZAPPLY_FIELD_MAP = RULES;
})(typeof window !== "undefined" ? window : globalThis);
