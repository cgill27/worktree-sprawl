// What the mod needs from the machine before it can scan. Pure: no Herdr imports.

export const MIN_GIT = [2, 31]; // `git rev-parse --path-format=absolute`

/** Why the mod can't run on this platform, or null. */
export function platformProblem(platform) {
  if (platform !== "windows") return null;
  return "Worktree Sprawl runs on Linux and macOS only. It needs find, du and sh, which Windows doesn't have.";
}

/**
 * Why this git can't be used, or null. `result` is what `git --version` gave:
 * { code, stdout, stderr }. A version that can't be read is not treated as a problem.
 */
export function gitProblem(result) {
  const need = MIN_GIT.join(".");
  if (!result || result.code !== 0) {
    const why = String(result?.stderr ?? "").trim().split("\n")[0];
    return `git could not be run${why ? ` (${why})` : ""}. Worktree Sprawl needs git ${need} or newer on your PATH.`;
  }
  const m = /(\d+)\.(\d+)/.exec(String(result.stdout ?? ""));
  if (!m) return null;
  const major = Number(m[1]), minor = Number(m[2]);
  if (major > MIN_GIT[0] || (major === MIN_GIT[0] && minor >= MIN_GIT[1])) return null;
  return `git ${major}.${minor} is too old: Worktree Sprawl needs git ${need} or newer. Update git, then press Refresh.`;
}
