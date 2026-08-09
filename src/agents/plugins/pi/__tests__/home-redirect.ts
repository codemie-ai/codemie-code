/**
 * Point `os.homedir()` at a fixture directory for the duration of a test.
 *
 * `homedir()` reads `$HOME` on POSIX but `%USERPROFILE%` on Windows, so setting only one of
 * them leaves the other platform resolving `~/.pi/agent` against the real user profile. The
 * user-scope fixtures are then invisible and every count comes back zero — indistinguishable
 * from the broken mapping these suites exist to catch.
 *
 * @returns a function that restores both variables to their previous state.
 */
export function redirectHomeDir(dir: string): () => void {
  const saved: Record<string, string | undefined> = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
  };
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;

  return () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}
