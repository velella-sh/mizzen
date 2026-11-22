import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { hashOf } from "../outputs/build-hash.ts";

export type Signing =
  | { readonly algorithm: "none" }
  | { readonly algorithm: "ed25519"; readonly keyId: string };

export interface SigningAdapter {
  readonly identity: Extract<Signing, { algorithm: "ed25519" }>;
  sign(bytes: Uint8Array): Uint8Array;
}

function keyId(publicKey: KeyObject): string {
  return hashOf(publicKey.export({ type: "spki", format: "der" }));
}

export function ed25519Signer(pem: string): SigningAdapter {
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(pem);
  } catch {
    throw new Error("the signing key must be a readable, unencrypted Ed25519 private PEM key");
  }
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("the signing key must use Ed25519");
  return {
    identity: { algorithm: "ed25519", keyId: keyId(createPublicKey(privateKey)) },
    sign: (bytes) => sign(null, bytes, privateKey),
  };
}

export function trustedKeys(values: readonly string[]): ReadonlyMap<string, KeyObject> {
  const keys = new Map<string, KeyObject>();
  for (const pem of values) {
    let key: KeyObject;
    try {
      if (!/^-----BEGIN PUBLIC KEY-----\r?\n[\w+/=\r\n]+-----END PUBLIC KEY-----\s*$/.test(pem)) throw new Error();
      key = createPublicKey(pem);
    } catch {
      throw new Error("trustedKeys must contain Ed25519 public PEM keys");
    }
    if (key.asymmetricKeyType !== "ed25519") throw new Error("trustedKeys must use Ed25519");
    keys.set(keyId(key), key);
  }
  return keys;
}

export function verifiesSignature(key: KeyObject, bytes: Uint8Array, signature: string): boolean {
  const raw = Buffer.from(signature, "base64");
  return raw.length === 64 && raw.toString("base64") === signature && verify(null, bytes, key, raw);
}
