import { argon2, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const argon2Async = promisify(argon2);

/** OWASP's recommended Argon2id baseline: 19 MiB, 2 passes, 1 lane (~20 ms here). */
const PARAMS = { memory: 19_456, passes: 2, parallelism: 1, tagLength: 32 } as const;

const b64 = (b: Buffer) => b.toString("base64").replace(/=+$/, "");

/** Hashes a password into a self-describing PHC string (`$argon2id$v=19$m=…,t=…,p=…$salt$hash`). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await argon2Async("argon2id", { message: password, nonce: salt, ...PARAMS });
  return `$argon2id$v=19$m=${PARAMS.memory},t=${PARAMS.passes},p=${PARAMS.parallelism}$${b64(salt)}$${b64(hash)}`;
}

/** Verifies against a PHC string, honouring the parameters it was created with. */
export async function verifyPassword(password: string, phc: string): Promise<boolean> {
  const m = phc.match(/^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/);
  if (!m) return false;
  const expected = Buffer.from(m[5]!, "base64");
  const actual = await argon2Async("argon2id", {
    message: password,
    nonce: Buffer.from(m[4]!, "base64"),
    memory: Number(m[1]),
    passes: Number(m[2]),
    parallelism: Number(m[3]),
    tagLength: expected.length,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** A hash to verify against when the user doesn't exist, so timing doesn't reveal valid usernames. */
export const DUMMY_HASH = await hashPassword(randomBytes(16).toString("hex"));
