import type { ReactNode } from "react";

export type FitCardStatus = "ready" | "attention" | "empty";

export interface FitCard {
  /** Stable identity within a step — used as the React key. */
  key: string;
  icon?: ReactNode;
  /** Component TYPE — "Model card", "Environment", … never an instance name. */
  title: string;
  /** Real instance names shown as badges (capped at 3 + "+N"). */
  badges?: string[];
  /** Static explainer shown *instead of* badges — for pieces you don't
   *  create-and-name (a Session, the Sandbox), or the click-to-describe
   *  body text on the static/demo surface. */
  description?: string;
  /** Short one-line note under the title — lighter-weight than `description`. */
  note?: string;
  /** Drives the status dot color. Omit for a demo card with no live state. */
  status?: FitCardStatus;
  /** CTA text shown when `status === "empty"` and no badges are set. */
  emptyCta?: string;
  /** Dashed border + reduced opacity — the "not set up yet" / example look,
   *  independent of `status` (used by the static demo surface). */
  dashed?: boolean;
  /** The hero card — brand-accented and a size up. */
  hero?: boolean;
  /** Provider ids rendered as an overlapping avatar-group of ProviderMarks. */
  providerMarks?: string[];
  /** Card click handler — console navigates, the landing page opens a dialog. */
  onActivate?: () => void;
}

/** A step's contents, top to bottom. A nested array is one ROW — cards that
 *  sit side by side because they're peers of each other. */
export type FitRow = FitCard | FitCard[];

export interface FitStep {
  number: string;
  name: string;
  optional?: boolean;
  done?: boolean;
  cards: FitRow[];
  /** Vertically centre the cards. */
  center?: boolean;
  /** Chain the cards with ↓ pointers instead of plain gaps. */
  chain?: boolean;
  /** Labels for the chain's ↓ pointers (index i annotates the arrow before
   *  row i+1). */
  chainLabels?: string[];
  /** Extra width share on wide layouts. */
  wide?: boolean;
}

export interface FitFormulaRow {
  lhs: string;
  parts: string[];
}
