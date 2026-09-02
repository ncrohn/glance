export type AnchorKind = "exact" | "quote-only" | "drifted" | "orphaned";
export type AnnotationStatus = "open" | "resolved" | "orphaned";

export interface LineHint {
  start: number;
  end: number;
}

export interface Annotation {
  id: string;
  // Stable per-document number assigned by the store on add; 0 while the
  // server add is still in flight.
  number: number;
  quote: string;
  prefix: string;
  suffix: string;
  lineHint: LineHint;
  note: string;
  status: AnnotationStatus;
  author: "user" | "claude";
  createdAt: string;
  // Who resolved it and when; both absent while open.
  resolvedBy?: "user" | "claude";
  resolvedAt?: string;
  // Thread under the note: Claude's resolution notes and questions, the
  // user's answers. Stores written before replies existed omit the key.
  replies?: Reply[];
}

export interface Reply {
  author: "user" | "claude";
  text: string;
  createdAt: string;
}

export type AnnotationPatch = Partial<Pick<Annotation, "note" | "status" | "resolvedBy" | "resolvedAt">>;

export interface AnnotationStore {
  docPath: string;
  annotations: Annotation[];
}

export interface Resolution {
  id: string;
  startLine: number | null;
  endLine: number | null;
  anchor: AnchorKind;
}

export function genId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function addAnnotation(list: Annotation[], a: Annotation): Annotation[] {
  return [...list, a];
}

export function resolveAnnotation(list: Annotation[], id: string): Annotation[] {
  return list.map((a) => (a.id === id ? { ...a, status: "resolved" } : a));
}

export function removeAnnotation(list: Annotation[], id: string): Annotation[] {
  return list.filter((a) => a.id !== id);
}

/** Merge `patch` into the annotation with `id`. A key set to `undefined`
 *  clears that field (how a reopen drops resolvedBy/resolvedAt). */
export function patchAnnotation(list: Annotation[], id: string, patch: AnnotationPatch): Annotation[] {
  return list.map((a) => (a.id === id ? { ...a, ...patch } : a));
}

/** Append `reply` to the thread of the annotation with `id`. */
export function appendReply(list: Annotation[], id: string, reply: Reply): Annotation[] {
  return list.map((a) => (a.id === id ? { ...a, replies: [...(a.replies ?? []), reply] } : a));
}
