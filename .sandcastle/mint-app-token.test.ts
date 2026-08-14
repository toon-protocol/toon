import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mintAppToken } from "./mint-app-token.ts";

// A real (throwaway) RSA key pair so `createSign(...).sign(pem, ...)` succeeds.
// Nothing here ever verifies the signature — `fetch` is mocked below — so the
// key's provenance doesn't matter, only that it's a valid PEM.
const { privateKey: testPrivateKeyPem } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "pkcs1", format: "pem" },
});

// `vi.stubEnv(name, undefined)` does NOT delete the var on this vitest version
// — it stubs the literal string `"undefined"`, which is truthy. Deleting for
// real (and restoring afterward) is the only reliable way to test the "unset"
// branches.
const ENV_KEYS = ["APP_ID", "APP_PRIVATE_KEY", "GH_TOKEN", "GITHUB_REPOSITORY"] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

function unsetEnv(name: (typeof ENV_KEYS)[number]): void {
  delete process.env[name];
}

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("mintAppToken — ambient fallback", () => {
  it("falls back to the ambient GH_TOKEN when APP_ID/APP_PRIVATE_KEY are unset", async () => {
    unsetEnv("APP_ID");
    unsetEnv("APP_PRIVATE_KEY");
    vi.stubEnv("GH_TOKEN", "ghs_ambientTokenValue");

    const result = await mintAppToken();

    expect(result).toEqual({ token: "ghs_ambientTokenValue", source: "ambient" });
  });

  it("falls back to the ambient GH_TOKEN when only APP_ID is set", async () => {
    vi.stubEnv("APP_ID", "12345");
    unsetEnv("APP_PRIVATE_KEY");
    vi.stubEnv("GH_TOKEN", "ghs_ambientTokenValue");

    const result = await mintAppToken();

    expect(result).toEqual({ token: "ghs_ambientTokenValue", source: "ambient" });
  });

  it("throws when neither the App credentials nor GH_TOKEN are available", async () => {
    unsetEnv("APP_ID");
    unsetEnv("APP_PRIVATE_KEY");
    unsetEnv("GH_TOKEN");

    await expect(mintAppToken()).rejects.toThrow(
      /Cannot obtain a GitHub credential/,
    );
  });
});

describe("mintAppToken — App JWT mint path", () => {
  it("mints a fresh installation token via the App JWT flow", async () => {
    vi.stubEnv("APP_ID", "12345");
    vi.stubEnv("APP_PRIVATE_KEY", testPrivateKeyPem);
    vi.stubEnv("GITHUB_REPOSITORY", "toon-protocol/toon");
    vi.stubEnv("GH_TOKEN", "ghs_shouldNotBeUsed");

    const calls: Array<{ url: string; method: string | undefined }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method });
      if (url.endsWith("/repos/toon-protocol/toon/installation")) {
        return new Response(JSON.stringify({ id: 999 }), { status: 200 });
      }
      if (url.endsWith("/app/installations/999/access_tokens")) {
        return new Response(JSON.stringify({ token: "ghs_freshlyMinted" }), {
          status: 201,
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await mintAppToken();

    expect(result).toEqual({ token: "ghs_freshlyMinted", source: "app" });
    expect(calls).toEqual([
      { url: "https://api.github.com/repos/toon-protocol/toon/installation", method: "GET" },
      {
        url: "https://api.github.com/app/installations/999/access_tokens",
        method: "POST",
      },
    ]);
  });

  it("accepts a PEM with literal \\n sequences (round-tripped through a shell)", async () => {
    vi.stubEnv("APP_ID", "12345");
    vi.stubEnv("APP_PRIVATE_KEY", testPrivateKeyPem.replace(/\n/g, "\\n"));
    vi.stubEnv("GITHUB_REPOSITORY", "toon-protocol/toon");

    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/installation")) {
        return new Response(JSON.stringify({ id: 1 }), { status: 200 });
      }
      return new Response(JSON.stringify({ token: "ghs_freshlyMinted" }), { status: 201 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await mintAppToken();

    expect(result).toEqual({ token: "ghs_freshlyMinted", source: "app" });
  });

  it("throws when the installation lookup returns no id", async () => {
    vi.stubEnv("APP_ID", "12345");
    vi.stubEnv("APP_PRIVATE_KEY", testPrivateKeyPem);
    vi.stubEnv("GITHUB_REPOSITORY", "toon-protocol/toon");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })),
    );

    await expect(mintAppToken()).rejects.toThrow(/no installation id/);
  });

  it("throws when the access-token response has no token field", async () => {
    vi.stubEnv("APP_ID", "12345");
    vi.stubEnv("APP_PRIVATE_KEY", testPrivateKeyPem);
    vi.stubEnv("GITHUB_REPOSITORY", "toon-protocol/toon");

    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/installation")) {
        return new Response(JSON.stringify({ id: 1 }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 201 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(mintAppToken()).rejects.toThrow(/no `token` field/);
  });

  it("surfaces the GitHub API error body when a request fails", async () => {
    vi.stubEnv("APP_ID", "12345");
    vi.stubEnv("APP_PRIVATE_KEY", testPrivateKeyPem);
    vi.stubEnv("GITHUB_REPOSITORY", "toon-protocol/toon");

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("not found", {
            status: 404,
            statusText: "Not Found",
          }),
      ),
    );

    await expect(mintAppToken()).rejects.toThrow(/404 Not Found/);
  });
});
