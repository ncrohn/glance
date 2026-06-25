import { Doc, isDirty } from "./document";

export type ReloadAction = "auto-reload" | "prompt";

export function decideReload(doc: Doc): ReloadAction {
  return isDirty(doc) ? "prompt" : "auto-reload";
}
