import assert from "node:assert/strict"
import { createVerify, generateKeyPairSync } from "node:crypto"
import { test } from "node:test"
import { AppTokenProvider, appJwt, envTokenProvider } from "../../src/github/app-auth.ts"

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
const pem = privateKey.export({ type: "pkcs1", format: "pem" }) as string

function b64url(s: string): string {
  return Buffer.from(s, "base64url").toString("utf8")
}

test("the App JWT is RS256, issued by the App id, valid for under ten minutes", () => {
  const now = 1_800_000_000_000
  const jwt = appJwt("12345", pem, now)
  const [h, p, sig] = jwt.split(".")
  assert.deepEqual(JSON.parse(b64url(h as string)), { alg: "RS256", typ: "JWT" })
  const claims = JSON.parse(b64url(p as string))
  assert.equal(claims.iss, "12345")
  assert.equal(claims.iat, Math.floor(now / 1000) - 60)
  assert.ok(claims.exp - claims.iat <= 600)
  const verifier = createVerify("RSA-SHA256")
  verifier.update(`${h}.${p}`)
  assert.ok(verifier.verify(publicKey, Buffer.from(sig as string, "base64url")))
})

test("the installation token is fetched with the JWT and cached until shortly before expiry", async () => {
  const calls: { url: string; auth: string | null }[] = []
  let clock = 1_800_000_000_000
  let expiresAt = new Date(clock + 3600_000).toISOString()
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") })
    return new Response(JSON.stringify({ token: `ghs_${calls.length}`, expires_at: expiresAt }), {
      status: 201,
      headers: { "content-type": "application/json" },
    })
  }
  const provider = new AppTokenProvider({
    appId: "12345",
    privateKey: pem,
    installationId: "777",
    fetch: fetchImpl,
    now: () => clock,
  })
  assert.equal(await provider.token(), "ghs_1")
  assert.equal(await provider.token(), "ghs_1", "cached")
  assert.equal(calls.length, 1)
  assert.match(calls[0]?.url ?? "", /\/app\/installations\/777\/access_tokens$/)
  assert.match(calls[0]?.auth ?? "", /^Bearer eyJ/)

  clock += 3600_000 - 4 * 60_000 // four minutes before expiry: refresh
  expiresAt = new Date(clock + 3600_000).toISOString()
  assert.equal(await provider.token(), "ghs_2")
  assert.equal(calls.length, 2)
})

test("the env token provider reads the named variable at the moment it is asked", async () => {
  const name = "TRAIN_TEST_TOKEN_SET"
  const provider = envTokenProvider(name)
  process.env[name] = "  ghs_from_env\n"
  try {
    assert.equal(await provider.token(), "ghs_from_env")
  } finally {
    delete process.env[name]
  }
})

test("an unset or empty variable is an error that names the variable, never an empty token", async () => {
  const name = "TRAIN_TEST_TOKEN_UNSET"
  delete process.env[name]
  await assert.rejects(() => envTokenProvider(name).token(), /TRAIN_TEST_TOKEN_UNSET is not set/)
  process.env[name] = "   "
  try {
    await assert.rejects(() => envTokenProvider(name).token(), /TRAIN_TEST_TOKEN_UNSET is not set/)
  } finally {
    delete process.env[name]
  }
})
