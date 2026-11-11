// "Sign in with OpenRouter": OpenRouter's OAuth flow with PKCE. The visitor
// signs in on openrouter.ai and approves a key for this app; OpenRouter sends
// them back here with a one-time code, which this page exchanges for the key.
// No client secret and no server: the PKCE verifier proves the code is ours.
// https://openrouter.ai/docs/guides/overview/auth/oauth

const AUTH_URL = "https://openrouter.ai/auth";
const EXCHANGE_URL = "https://openrouter.ai/api/v1/auth/keys";
const PENDING = "tankbrain.signin"; // sessionStorage: { verifier, state } while the visitor is away

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const randomString = (n = 32) => base64url(crypto.getRandomValues(new Uint8Array(n)));

export async function codeChallenge(verifier: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(hash));
}

/** This page without query or hash: where OpenRouter sends the visitor back. */
export const callbackUrl = (loc: Location = location) => loc.origin + loc.pathname;

/** The openrouter.ai sign-in address; remembers what's needed to finish. */
export async function signInUrl(callback = callbackUrl()): Promise<string> {
  const verifier = randomString();
  const state = randomString(16);
  sessionStorage.setItem(PENDING, JSON.stringify({ verifier, state }));
  const q = new URLSearchParams({
    callback_url: callback,
    code_challenge: await codeChallenge(verifier),
    code_challenge_method: "S256",
    state,
    key_label: "Norbert, the brain",
  });
  return `${AUTH_URL}?${q}`;
}

/** Leave for openrouter.ai to sign in. */
export async function startSignIn(): Promise<void> {
  location.assign(await signInUrl());
}

/** Back from openrouter.ai? Then exchange the code for a key and tidy the
 * address bar. Returns null when this page load isn't a sign-in return. */
export async function finishSignIn(url = new URL(location.href),
                                   fetchFn: typeof fetch = fetch): Promise<{ key: string } | { error: string } | null> {
  const code = url.searchParams.get("code");
  const raw = sessionStorage.getItem(PENDING);
  // a ?code= without a sign-in of ours in progress isn't for us
  if (!code || !raw) return null;
  const returnedState = url.searchParams.get("state");
  sessionStorage.removeItem(PENDING);
  url.searchParams.delete("code");
  url.searchParams.delete("state");
  globalThis.history?.replaceState(null, "", url.pathname + url.search + url.hash); // the code is single-use: keep it out of bookmarks
  const { verifier, state } = JSON.parse(raw);
  // OpenRouter returns state unchanged; a mismatch means the code isn't from our request
  if (returnedState !== state) return { error: "the sign-in didn't come back from the request this page made; please try again" };
  return exchange(code, verifier, fetchFn);
}

async function exchange(code: string, verifier: string, fetchFn: typeof fetch): Promise<{ key: string } | { error: string }> {
  try {
    const r = await fetchFn(EXCHANGE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }),
    });
    if (!r.ok) {
      const why = r.status === 403 ? "the sign-in code was invalid or expired; please try again" : `OpenRouter answered ${r.status}`;
      return { error: why };
    }
    const data = await r.json();
    return typeof data?.key === "string" && data.key ? { key: data.key } : { error: "OpenRouter sent no key" };
  } catch (e) {
    return { error: `couldn't reach OpenRouter: ${(e as Error).message ?? e}` };
  }
}
