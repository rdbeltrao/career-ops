import assert from "node:assert/strict";
import { test } from "node:test";
import "../helpers/web-ts-alias-loader.mjs";
const { GET } = await import("../../src/app/api/ai-models/route.ts");

test("model catalog API validates tool and provider before invoking a CLI", async () => {
  for (const query of ["cliId=unknown", "cliId=claude", "cliId=codex&provider=--help", "cliId=codex&provider=a%0Ab"]) {
    const response = await GET(new Request(`http://localhost:3000/api/ai-models?${query}`));
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(typeof (await response.json()).error, "string");
  }
});

test("local and custom providers never receive OpenAI model suggestions", async () => {
  for (const provider of ["ollama", "lmstudio", "company-gateway"]) {
    const response = await GET(new Request(`http://localhost:3000/api/ai-models?cliId=codex&provider=${provider}`));
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(result.models, []);
    assert.match(result.warning, /custom model/i);
  }
});
