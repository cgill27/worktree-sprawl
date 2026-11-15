// Unit tests for mods/worktree-sprawl/checks.js. Run from the package root: node tests/checks.test.mjs
// (Loads the module from source as a data: URL, so it works without a package.json "type": "module".)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const src = readFileSync(new URL("../mods/worktree-sprawl/checks.js", import.meta.url), "utf8");
const { platformProblem, gitProblem } = await import(`data:text/javascript,${encodeURIComponent(src)}`);

const ok = (stdout) => ({ code: 0, stdout, stderr: "" });

// Platform: only Windows is refused; an unknown platform is let through.
assert.equal(platformProblem("linux"), null);
assert.equal(platformProblem("macos"), null);
assert.equal(platformProblem(undefined), null);
assert.match(platformProblem("windows"), /Linux and macOS only/);

// git: 2.31 is the first version that works; each platform's version string is read.
assert.equal(gitProblem(ok("git version 2.56.1\n")), null);
assert.equal(gitProblem(ok("git version 2.31.0")), null);
assert.equal(gitProblem(ok("git version 2.39.5 (Apple Git-154)")), null);
assert.equal(gitProblem(ok("git version 2.45.1.windows.1")), null);
assert.equal(gitProblem(ok("git version 3.0.0")), null);
assert.match(gitProblem(ok("git version 2.30.2")), /git 2\.30 is too old.*2\.31 or newer/);
assert.match(gitProblem(ok("git version 2.25.1")), /git 2\.25 is too old/);
assert.match(gitProblem(ok("git version 1.9.5")), /git 1\.9 is too old/);
// A version that can't be read doesn't block the scan.
assert.equal(gitProblem(ok("something else")), null);
// git missing or failing to start.
assert.match(gitProblem({ code: -1, stdout: "", stderr: "No such file or directory\nmore" }), /could not be run \(No such file or directory\)\..*2\.31/);
assert.match(gitProblem({ code: 127, stdout: "", stderr: "" }), /^git could not be run\. /);
assert.match(gitProblem(null), /could not be run/);

console.log("all checks tests passed");
