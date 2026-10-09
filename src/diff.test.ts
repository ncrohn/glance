import { describe, it, expect } from "vitest";
import { diffLines, diffLinesDetailed } from "./diff";

const set = (...n: number[]) => new Set(n);

describe("diffLines", () => {
  it("returns empty when texts are identical", () => {
    expect(diffLines("a\nb\nc", "a\nb\nc")).toEqual(set());
  });

  it("ignores a differing trailing newline", () => {
    expect(diffLines("a\nb", "a\nb\n")).toEqual(set());
    expect(diffLines("a\nb\n", "a\nb")).toEqual(set());
  });

  it("marks an appended line", () => {
    expect(diffLines("a\nb", "a\nb\nc")).toEqual(set(3));
  });

  it("marks a modified middle line", () => {
    expect(diffLines("a\nb\nc", "a\nB\nc")).toEqual(set(2));
  });

  it("marks a modified leading line", () => {
    expect(diffLines("a\nb\nc", "A\nb\nc")).toEqual(set(1));
  });

  it("does not mark an adjacent surviving line for a deletion", () => {
    expect(diffLines("a\nb\nc", "a\nc")).toEqual(set());
  });

  it("marks everything when growing from empty", () => {
    expect(diffLines("", "a\nb")).toEqual(set(1, 2));
  });

  it("returns empty when shrinking to empty", () => {
    // nothing left in new text to highlight
    expect(diffLines("a\nb", "")).toEqual(set());
  });
});

describe("diffLinesDetailed", () => {
  it("places a middle deletion before the next surviving line", () => {
    expect(diffLinesDetailed("a\nb\nc", "a\nc")).toEqual({
      changed: set(),
      deletedBefore: set(2),
    });
  });

  it("places a trailing deletion after the last surviving line", () => {
    expect(diffLinesDetailed("a\nb\nc", "a\nb")).toEqual({
      changed: set(),
      deletedBefore: set(3),
    });
  });

  it("separates an adjacent edit from a deletion", () => {
    expect(diffLinesDetailed("a\nb\nc\nd", "a\nB\nd")).toEqual({
      changed: set(2),
      deletedBefore: set(3),
    });
  });
});

// The quadratic LCS the diff used to run, kept as a reference for the count of
// changed lines (|new| - LCS), which any optimal diff must agree on.
function lcsLength(a: string[], b: string[]): number {
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return dp[0][0];
}

describe("diff algorithm", () => {
  it("marks the minimum number of changed lines on random edits", () => {
    let seed = 7;
    const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    for (let round = 0; round < 300; round++) {
      const a = Array.from({ length: 1 + rand(30) }, () => "abcde"[rand(5)]);
      const b = a.slice();
      for (let e = rand(8); e > 0; e--) {
        const at = rand(b.length + 1);
        if (rand(2)) b.splice(at, 1);
        else b.splice(at, 0, "abcdef"[rand(6)]);
      }
      if (b.length === 0) continue;
      const changed = diffLines(a.join("\n"), b.join("\n"));
      expect(changed.size).toBe(b.length - lcsLength(a, b));
      for (const line of changed) expect(line >= 1 && line <= b.length).toBe(true);
    }
  });

  it("treats CRLF and LF as the same line ending", () => {
    expect(diffLinesDetailed("l1\r\nl2\r\nl3\r\n", "Xl1\nl2\nl3\n")).toEqual({ changed: set(1), deletedBefore: set() });
  });

  it("hands out sets the caller can change without affecting later calls", () => {
    const first = diffLines("a\nb", "a\nB");
    first.add(99);
    expect(diffLines("a\nb", "a\nB")).toEqual(set(2));
  });

  it("stays fast on large documents", () => {
    const lines = Array.from({ length: 20000 }, (_, i) => `line ${i} lorem ipsum`);
    const text = lines.join("\n") + "\n";
    const edited = lines.slice();
    edited[100] = "edited";
    edited.splice(15000, 3);
    edited.splice(5000, 0, "inserted");
    const rewrite = lines.map((l) => l + " rewritten").join("\n");
    const t = performance.now();
    expect(diffLines(text, text.slice())).toEqual(set());
    expect(diffLinesDetailed(text, edited.join("\n"))).toEqual({ changed: set(101, 5001), deletedBefore: set(15002) });
    expect(diffLines(text, rewrite).size).toBe(20000);
    expect(performance.now() - t).toBeLessThan(1000);
  });
});
