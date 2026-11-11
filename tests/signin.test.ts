import { beforeEach, describe, expect, it } from "vitest";
import { codeChallenge, finishSignIn, signInUrl } from "../src/signin";

describe("sign in with OpenRouter (OAuth PKCE)", () => {
  beforeEach(() => sessionStorage.clear());

  it("computes the S256 challenge as in RFC 7636", async () => {
    // the RFC's own test vector (appendix B)
    expect(await codeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("sends the visitor to openrouter.ai with a challenge, state and our callback", async () => {
    const u = new URL(await signInUrl("https://primbs.ca/tankbrain/"));
    expect(u.origin + u.pathname).toBe("https://openrouter.ai/auth");
    expect(u.searchParams.get("callback_url")).toBe("https://primbs.ca/tankbrain/");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    const pending = JSON.parse(sessionStorage.getItem("tankbrain.signin")!);
    expect(u.searchParams.get("code_challenge")).toBe(await codeChallenge(pending.verifier));
    expect(u.searchParams.get("state")).toBe(pending.state);
  });

  it("exchanges the code for a key, with the verifier", async () => {
    const u = new URL(await signInUrl("https://primbs.ca/tankbrain/"));
    const { verifier, state } = JSON.parse(sessionStorage.getItem("tankbrain.signin")!);
    let sent: any = null;
    const fakeFetch = (async (url: string, init: any) => {
      sent = { url, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ key: "sk-or-v1-test" }), { status: 200 });
    }) as typeof fetch;
    const back = new URL(`https://primbs.ca/tankbrain/?code=abc&state=${state}`);
    expect(await finishSignIn(back, fakeFetch)).toEqual({ key: "sk-or-v1-test" });
    expect(sent.url).toBe("https://openrouter.ai/api/v1/auth/keys");
    expect(sent.body).toEqual({ code: "abc", code_verifier: verifier, code_challenge_method: "S256" });
    expect(sessionStorage.getItem("tankbrain.signin")).toBeNull(); // single use
    expect(u).toBeTruthy();
  });

  it("ignores a ?code it didn't ask for, and refuses a wrong state", async () => {
    const never = (async () => { throw new Error("must not be called"); }) as typeof fetch;
    expect(await finishSignIn(new URL("https://primbs.ca/tankbrain/?code=abc"), never)).toBeNull();
    await signInUrl("https://primbs.ca/tankbrain/");
    const r = await finishSignIn(new URL("https://primbs.ca/tankbrain/?code=abc&state=forged"), never);
    expect(r).toHaveProperty("error");
  });

  it("explains a rejected code", async () => {
    await signInUrl("https://primbs.ca/tankbrain/");
    const { state } = JSON.parse(sessionStorage.getItem("tankbrain.signin")!);
    const denied = (async () => new Response("{}", { status: 403 })) as typeof fetch;
    const r = await finishSignIn(new URL(`https://primbs.ca/tankbrain/?code=abc&state=${state}`), denied);
    expect(r).toEqual({ error: expect.stringMatching(/invalid or expired/) });
  });
});
