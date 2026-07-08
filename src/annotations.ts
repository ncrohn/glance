export type AnchorKind = "exact" | "quote-only" | "drifted" | "orphaned";
export type AnnotationStatus = "open" | "resolved" | "orphaned";

export interface LineHint {
  start: number;
  end: number;
}

export interface Annotation {
  id: string;
  quote: string;
  prefix: string;
  suffix: string;
  lineHint: LineHint;
  note: string;
  status: AnnotationStatus;
  author: "user" | "claude";
  createdAt: string;
}

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
