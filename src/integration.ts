// Pure helpers for the AI-integration picker + result grouping. Kept out of
// modal.ts (which is DOM glue) so they can be unit-tested in isolation.

import type { ClientInfo, SetupStep, IntegrationAction } from "./ipc";

export interface StepGroup {
  name: string;
  steps: SetupStep[];
}

/** Partition result steps into ordered sections by `group`, preserving
 *  first-seen order (the backend emits the shared mdview step first). */
export function groupSteps(steps: SetupStep[]): StepGroup[] {
  const order: string[] = [];
  const byName = new Map<string, SetupStep[]>();
  for (const s of steps) {
    let bucket = byName.get(s.group);
    if (!bucket) {
      bucket = [];
      byName.set(s.group, bucket);
      order.push(s.group);
    }
    bucket.push(s);
  }
  return order.map((name) => ({ name, steps: byName.get(name)! }));
}

/** Supported vs unsupported capability labels for a client, for the picker
 *  sub-line. Supported drives what gets installed; unsupported is shown muted
 *  (setup only) so the user sees why a client does less. */
export function capabilitySummary(client: ClientInfo): { supported: string[]; unsupported: string[] } {
  return {
    supported: client.capabilities.filter((c) => c.supported).map((c) => c.label),
    unsupported: client.capabilities.filter((c) => !c.supported).map((c) => c.label),
  };
}

/** Whether a client row is selectable for the given action. Setup: any detected
 *  client. Remove: only detected clients (nothing to remove otherwise). Both
 *  gate on `present`, but keep the action explicit for future divergence. */
export function isSelectable(client: ClientInfo, _action: IntegrationAction): boolean {
  return client.present;
}

/** Whether to show the empty-state "set up AI integration" prompt: the user has
 *  a detected client but hasn't wired Glance into any of them yet. Once any
 *  detected client is configured, the prompt goes away. */
export function needsSetup(clients: ClientInfo[]): boolean {
  const present = clients.filter((c) => c.present);
  return present.length > 0 && present.every((c) => !c.configured);
}
