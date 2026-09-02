import type { Annotation } from "./annotations";

/** What Claude did to a document's comments between two store reads. */
export interface Activity {
  resolved: string[];
  replied: string[];
}

function byNumber(list: Annotation[]): Annotation[] {
  return [...list].sort((a, b) => a.number - b.number);
}

/** Ids Claude resolved or replied to in `next` that it had not in `prev`.
 *  Pass `prev === next` on first load so nothing is reported. */
export function diffActivity(prev: Annotation[], next: Annotation[]): Activity {
  const before = new Map(prev.map((a) => [a.id, a]));
  const resolved: string[] = [];
  const replied: string[] = [];
  for (const a of byNumber(next)) {
    const old = before.get(a.id);
    if (a.status === "resolved" && a.resolvedBy === "claude" && old?.status !== "resolved") {
      resolved.push(a.id);
    }
    const replies = a.replies ?? [];
    const last = replies[replies.length - 1];
    if (replies.length > (old?.replies?.length ?? 0) && last?.author === "claude") {
      replied.push(a.id);
    }
  }
  return { resolved, replied };
}

/** "Claude resolved 2, replied to 1" — only the non-zero parts. */
export function activityMessage(act: Activity): string {
  const parts: string[] = [];
  if (act.resolved.length) parts.push(`resolved ${act.resolved.length}`);
  if (act.replied.length) parts.push(`replied to ${act.replied.length}`);
  return `Claude ${parts.join(", ")}`;
}
