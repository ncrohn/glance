// Split into lines, treating a single trailing newline as insignificant so
// "a\nb\n" and "a\nb" compare equal. An empty string yields no lines.
function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  return text.replace(/\n$/, "").split("\n");
}

export interface DetailedLineDiff {
  changed: Set<number>;
  deletedBefore: Set<number>;
}

export function diffLinesDetailed(
  oldText: string,
  newText: string,
): DetailedLineDiff {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const m = a.length;
  const n = b.length;
  const changed = new Set<number>();
  const deletedBefore = new Set<number>();

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
  while (i < m || j < n) {
    if (i < m && j < n && a[i] === b[j]) {
      i++;
      j++;
      continue;
    }

    const newStart = j;
    let oldCount = 0;
    let newCount = 0;
    while (
      (i < m || j < n) &&
      !(i < m && j < n && a[i] === b[j])
    ) {
      if (j >= n || (i < m && dp[i + 1][j] >= dp[i][j + 1])) {
        i++;
        oldCount++;
      } else {
        j++;
        newCount++;
      }
    }

    for (let line = newStart + 1; line <= newStart + newCount; line++) {
      changed.add(line);
    }
    if (oldCount > newCount) {
      deletedBefore.add(newStart + newCount + 1);
    }
  }

  return { changed, deletedBefore };
}

/** Returns 1-indexed added or modified line numbers in `newText`. */
export function diffLines(oldText: string, newText: string): Set<number> {
  return diffLinesDetailed(oldText, newText).changed;
}
