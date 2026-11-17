/** Expands %VAR% references (case-insensitive), e.g. %LOCALAPPDATA%\Programs\x.exe. Unknown variables are left as-is. */
export function expandEnv(text: string, env: NodeJS.ProcessEnv): string {
  const lower = new Map(Object.entries(env).map(([k, v]) => [k.toLowerCase(), v ?? ""]));
  return text.replace(/%([^%\/:*?"<>|]+)%/g, (whole, name: string) => lower.get(name.toLowerCase()) ?? whole);
}
