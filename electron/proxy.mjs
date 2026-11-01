/**
 * pi reads its proxy from the environment, and an app started from the desktop has
 * none there. This turns the proxy the system would use into those variables. Local
 * model servers stay outside it.
 */
export function proxyEnv(env, resolved) {
  if (env.HTTPS_PROXY || env.https_proxy) return {}; // the person's own setting wins
  const found = /^(PROXY|HTTPS) ([^;\s]+)/.exec(resolved);
  if (!found) return {}; // DIRECT, or a SOCKS proxy that pi cannot use
  const url = `${found[1] === "HTTPS" ? "https" : "http"}://${found[2]}`;
  return { HTTPS_PROXY: url, HTTP_PROXY: url, NO_PROXY: env.NO_PROXY || env.no_proxy || "localhost,127.0.0.1,::1" };
}
