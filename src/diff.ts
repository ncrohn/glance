// Split into lines, treating a single trailing newline as insignificant so
// "a\nb\n" and "a\nb" compare equal. An empty string yields no lines.
function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  return text.replace(/\n$/, "").split("\n");
}

/**
 * Line-based LCS diff. Returns the 1-indexed line numbers in `newText` that
 * are added or modified relative to `oldText`. Deletions are attributed to the
 * adjacent surviving line in `newText` so a removed block stays discoverable.
 */
export function diffLines(oldText: string, newText: string): Set<number> {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const m = a.length;
  const n = b.length;
  const changed = new Set<number>();

  // dp[i][j] = length of LCS of a[i..] and b[j..]
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  );
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      // a[i] deleted — attribute to the surviving new line at position j
      changed.add(j + 1);
      i++;
    } else {
      // b[j] added
      changed.add(j + 1);
      j++;
    }
  }
  // trailing additions in new text
  while (j < n) {
    changed.add(j + 1);
    j++;
  }
  // trailing deletions: attribute to the last surviving new line, if any
  if (i < m && n > 0) changed.add(n);

  return changed;
}
