// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { showToast } from "./toast";

describe("showToast onExpire", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ""; });

  it("fires when the toast times out", () => {
    const onExpire = vi.fn();
    showToast("a", { onExpire, ms: 1000 });
    vi.advanceTimersByTime(1000);
    expect(onExpire).toHaveBeenCalledOnce();
    expect(document.querySelector(".toast")).toBeNull();
  });

  it("does not fire when another toast replaces it", () => {
    const onExpire = vi.fn();
    showToast("a", { onExpire, ms: 1000 });
    showToast("b", { ms: 5000 });
    vi.advanceTimersByTime(5000);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it("does not fire when the action is clicked", () => {
    const onExpire = vi.fn();
    const onAction = vi.fn();
    showToast("a", { actionLabel: "Go", onAction, onExpire, ms: 1000 });
    document.querySelector<HTMLButtonElement>(".toast-action")!.click();
    vi.advanceTimersByTime(1000);
    expect(onAction).toHaveBeenCalledOnce();
    expect(onExpire).not.toHaveBeenCalled();
  });
});
