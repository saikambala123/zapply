import mongoose, { Schema, model, models } from "mongoose";

/**
 * What happened to one field on one fill.
 *
 * This is the feedback loop the product was missing. Fill accuracy is the whole
 * value of the extension, and until now nothing measured it: every accuracy bug
 * — a veteran declaration answered with the wrong option, an email address in a
 * phone box, a date that arrived as "MM/2022" — reached the applicant before it
 * reached anyone who could fix it, and was reported by hand from a screenshot.
 *
 * One row per distinct question, per ATS, per user, aggregated over time rather
 * than appended per fill. `corrections` is the number that matters: a field the
 * applicant retypes after we fill it is a field we got wrong, and it is the
 * highest-signal event in the system.
 *
 * WHAT IS DELIBERATELY NOT STORED
 *
 * The value. Not what we filled, not what the applicant changed it to. A
 * corrections table that recorded values would become a copy of every
 * applicant's name, address, salary expectation and disability status, sitting
 * in a collection built for analytics rather than for holding sensitive data.
 * The label, the rule and the outcome are enough to find the bug; the value only
 * adds risk. `sample` keeps a short excerpt of the *question* text — never the
 * answer — because a rule key alone is hard to act on.
 */
const FieldOutcomeSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },

    /** Normalised question text, used as the identity of the field. */
    key: { type: String, required: true },
    /** Readable excerpt of the label, for the dashboard. Never an answer. */
    sample: { type: String, default: "" },

    ats: { type: String, default: "unknown" },
    /** The rule that answered it, or null when nothing matched. */
    ruleKey: { type: String, default: null },
    /** profile | saved | ai | blank | unmatched */
    source: { type: String, default: "unmatched" },
    /** text | textarea | select | radio | checkbox | date | file */
    inputType: { type: String, default: "text" },

    fills: { type: Number, default: 0 },
    /** Filled by us and then retyped by the applicant: we got it wrong. */
    corrections: { type: Number, default: 0 },
    /** Left for the applicant because nothing could answer it. */
    blanks: { type: Number, default: 0 },
    /** The page rejected our value — required-but-empty, invalid, too long. */
    rejections: { type: Number, default: 0 },

    lastSeenAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

/** One row per question per ATS per user; upserts aggregate into it. */
FieldOutcomeSchema.index({ userId: 1, ats: 1, key: 1 }, { unique: true });
/** Drives the dashboard's "worst first" ordering without a scan. */
FieldOutcomeSchema.index({ userId: 1, corrections: -1 });

export type FieldOutcomeDoc = mongoose.InferSchemaType<typeof FieldOutcomeSchema>;

export default models.FieldOutcome || model("FieldOutcome", FieldOutcomeSchema);
