import { describe, it, expect } from "vitest";
import * as github from "../src/auth/github";
import { buildAuthorizeUrl } from "../src/auth/github";

describe("buildAuthorizeUrl", () => {
  it("targets GitHub authorize with client_id, redirect_uri, scope, state, and S256 challenge", () => {
    const url = new URL(
      buildAuthorizeUrl({ clientId: "cid", redirectUri: "https://x/auth/callback", state: "st", challenge: "ch" })
    );
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("redirect_uri")).toBe("https://x/auth/callback");
    expect(url.searchParams.get("scope")).toBe("read:user user:email"); // no read:org — sign-in checks no GitHub org (§5.1)
    expect(url.searchParams.get("state")).toBe("st");
    expect(url.searchParams.get("code_challenge")).toBe("ch");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("no longer knows any GitHub org: the org gate and its constant are gone (§5.1)", () => {
    expect(Object.keys(github)).not.toEqual(expect.arrayContaining(["SAPLING_ORG", "isActiveOrgMember"]));
    expect(Object.keys(github).sort()).toEqual(["buildAuthorizeUrl", "exchangeCode", "getPrimaryEmail", "getUser"]);
  });
});
