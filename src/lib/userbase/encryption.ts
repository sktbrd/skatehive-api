import crypto from "crypto";

// Ported verbatim from the skatehive3.0 web app (lib/userbase/encryption.ts) so
// this service can decrypt posting keys the web app encrypted, and vice versa.
// REQUIRES the SAME USERBASE_KEY_ENCRYPTION_SECRET value as the web deployment.

const SECRET_ENV = "USERBASE_KEY_ENCRYPTION_SECRET";

function getKey() {
  const secret = process.env[SECRET_ENV];
  if (!secret) throw new Error(`${SECRET_ENV} is not set`);
  return crypto.scryptSync(secret, "skatehive-userbase", 32);
}

function deriveHiveKeyEncryptionKey(userId: string): Buffer {
  const secret = process.env[SECRET_ENV];
  if (!secret) throw new Error(`${SECRET_ENV} is not set`);
  const salt = `skatehive-hive-key-${userId}`;
  return crypto.scryptSync(secret, salt, 32);
}

export function encryptSecret(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    v: 1,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: encrypted.toString("base64"),
  });
}

export function decryptSecret(payload: string) {
  let parsed: { iv: string; tag: string; data: string };
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error("Invalid encrypted payload");
  }
  if (!parsed?.iv || !parsed?.tag || !parsed?.data) {
    throw new Error("Invalid encrypted payload");
  }
  const key = getKey();
  const iv = Buffer.from(parsed.iv, "base64");
  const tag = Buffer.from(parsed.tag, "base64");
  const data = Buffer.from(parsed.data, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

export function decryptHivePostingKey(
  encryptedData: { encryptedKey: string; iv: string; authTag: string },
  userId: string
): string {
  if (!encryptedData || typeof encryptedData !== "object") {
    throw new Error("Invalid encrypted data");
  }
  const { encryptedKey, iv: ivStr, authTag: authTagStr } = encryptedData;
  if (!encryptedKey || !ivStr || !authTagStr) {
    throw new Error("Invalid encrypted data");
  }
  const key = deriveHiveKeyEncryptionKey(userId);
  const iv = Buffer.from(ivStr, "base64");
  const authTag = Buffer.from(authTagStr, "base64");
  const encrypted = Buffer.from(encryptedKey, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}
