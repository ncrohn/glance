// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("./ipc", () => ({ openExternal: async () => {} }));
vi.mock("./assets/app-icon.png", () => ({ default: "icon.png" }));

const titles = () => Array.from(document.querySelectorAll("#modal-root .modal-title")).map((t) => t.textContent);
const press = (label: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>("#modal-root button")).find((b) => b.textContent === label)!.click();

let modal: typeof import("./modal");

beforeEach(async () => {
  vi.resetModules();
  document.body.innerHTML = `<div id="modal-root"></div>`;
  modal = await import("./modal");
});

describe("modal queue", () => {
  it("a prompt waiting on a decision is never replaced; later modals queue behind it", async () => {
    const first = modal.confirmReload("a.md");
    const second = modal.confirmReload("b.md");
    modal.showNotice("saved elsewhere", false);
    expect(titles()).toEqual(["File changed on disk"]);
    expect(document.getElementById("modal-root")!.textContent).toContain("a.md");

    press("Load disk");
    await expect(first).resolves.toBe("disk");
    expect(document.getElementById("modal-root")!.textContent).toContain("b.md");

    press("Keep mine");
    await expect(second).resolves.toBe("mine");
    expect(titles()).toEqual(["Something went wrong"]);
    press("OK");
    expect(titles()).toEqual([]);
  });

  it("a dismissable modal is replaced by the next one, settling its own promise", async () => {
    const answer = modal.promptText("Name");
    modal.showNotice("hello");
    await expect(answer).resolves.toBeNull();
    expect(titles()).toEqual(["Done"]);
  });

  it("a queued modal focuses its primary button once shown", () => {
    void modal.confirmReload("a.md");
    modal.showNotice("next");
    press("Keep mine");
    expect(document.activeElement?.textContent).toBe("OK");
  });
});
