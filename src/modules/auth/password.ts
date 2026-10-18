import { hash, verify } from "@node-rs/argon2";

/**
 * Passwords are hashed with argon2id: deliberately slow and memory-hungry, so a stolen
 * hash is expensive to brute-force. The hash string stores its own salt and parameters.
 */
export function hashPassword(password: string): Promise<string> {
  return hash(password);
}

export function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  return verify(passwordHash, password);
}

let dummyHash: Promise<string> | undefined;

/**
 * Used when a login email doesn't exist: we still run a real verification so the response
 * takes as long as for an existing user. Otherwise response time reveals which emails exist.
 */
export async function verifyAgainstDummy(password: string): Promise<false> {
  dummyHash ??= hash("verity-dummy-password-for-timing");
  await verify(await dummyHash, password);
  return false;
}
