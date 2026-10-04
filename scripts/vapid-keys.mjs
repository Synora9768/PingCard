#!/usr/bin/env node
/**
 * Generate (or re-derive) the VAPID key pair used for Web Push.
 *
 *   npm run vapid:keys
 *   npm run vapid:keys -- --from-private <VAPID_PRIVATE_KEY>
 *   npm run vapid:keys -- --json
 *
 * Output format (same as the `web-push` CLI, so it also works with other tools):
 *   VAPID_PUBLIC_KEY  = base64url of the 65-byte uncompressed P-256 point
 *   VAPID_PRIVATE_KEY = base64url of the 32-byte P-256 private scalar
 *
 * The public key is what the browser receives via
 * `pushManager.subscribe({ applicationServerKey })`.
 */
import { createECDH, generateKeyPairSync } from 'node:crypto';

const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const A = P - 3n;
const B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;
const GX = 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n;
const GY = 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n;

const toBase64Url = (buffer) => Buffer.from(buffer).toString('base64url');
const fromBase64Url = (value) => Buffer.from(String(value).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function mod(value, m = P) {
  const out = value % m;
  return out < 0n ? out + m : out;
}

function modPow(base, exponent, m = P) {
  let result = 1n;
  let b = mod(base, m);
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return result;
}

function modInverse(value, m = P) {
  return modPow(value, m - 2n, m);
}

/** Point doubling/addition on P-256 (affine, BigInt). */
function addPoints(p1, p2) {
  if (!p1) return p2;
  if (!p2) return p1;
  const [x1, y1] = p1;
  const [x2, y2] = p2;
  if (x1 === x2 && mod(y1 + y2) === 0n) return null;
  const lambda =
    x1 === x2 && y1 === y2
      ? mod((3n * x1 * x1 + A) * modInverse(2n * y1))
      : mod((y2 - y1) * modInverse(mod(x2 - x1)));
  const x3 = mod(lambda * lambda - x1 - x2);
  const y3 = mod(lambda * (x1 - x3) - y1);
  return [x3, y3];
}

function multiply(point, scalar) {
  let result = null;
  let addend = point;
  let k = scalar;
  while (k > 0n) {
    if (k & 1n) result = addPoints(result, addend);
    addend = addPoints(addend, addend);
    k >>= 1n;
  }
  return result;
}

function bigIntToBytes(value, length = 32) {
  const hex = value.toString(16).padStart(length * 2, '0');
  return Buffer.from(hex, 'hex');
}

/** Derive the uncompressed public point from a 32-byte private scalar. */
function publicFromPrivate(privateBytes) {
  const d = BigInt(`0x${Buffer.from(privateBytes).toString('hex')}`);
  if (d <= 0n || d >= P) throw new Error('private key scalar is out of range');
  const point = multiply([GX, GY], d);
  if (!point) throw new Error('failed to derive the public key');
  return Buffer.concat([Buffer.from([4]), bigIntToBytes(point[0]), bigIntToBytes(point[1])]);
}

/** Decompress a 33-byte SEC1 compressed point. */
function decompressPoint(bytes) {
  const prefix = bytes[0];
  const x = BigInt(`0x${bytes.subarray(1, 33).toString('hex')}`);
  const alpha = mod(x * x * x + A * x + B);
  const beta = modPow(alpha, (P + 1n) / 4n);
  if (mod(beta * beta) !== alpha) throw new Error('point is not on the curve');
  const y = beta % 2n === BigInt(prefix - 2) ? beta : P - beta;
  return Buffer.concat([Buffer.from([4]), bigIntToBytes(x), bigIntToBytes(y)]);
}

function normalisePrivateKey(input) {
  const value = String(input).trim();
  if (value.startsWith('-----BEGIN')) {
    const der = Buffer.from(value.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
    return der.subarray(der.length - 32);
  }
  if (value.startsWith('{')) {
    const jwk = JSON.parse(value);
    if (!jwk.d) throw new Error('JWK has no "d" member');
    return fromBase64Url(jwk.d);
  }
  const bytes = fromBase64Url(value);
  if (bytes.length !== 32) throw new Error(`expected a 32-byte scalar, got ${bytes.length} bytes`);
  return bytes;
}

function describe(publicKeyBytes) {
  const point = publicKeyBytes[0] === 4 ? publicKeyBytes : decompressPoint(publicKeyBytes);
  return {
    publicKey: toBase64Url(point),
    uncompressedHex: point.toString('hex'),
    x: toBase64Url(point.subarray(1, 33)),
    y: toBase64Url(point.subarray(33, 65)),
  };
}

function printUsage() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  const scalar = fromBase64Url(jwk.d);
  const publicBytes = publicFromPrivate(scalar);
  const { publicKey, uncompressedHex } = describe(publicBytes);

  console.log('');
  console.log('VAPID_PUBLIC_KEY=' + publicKey);
  console.log('VAPID_PRIVATE_KEY=' + toBase64Url(scalar));
  console.log('');
  console.log('生成的密钥对（请妥善保存 VAPID_PRIVATE_KEY，切勿提交到仓库）：');
  console.log('  applicationServerKey (hex, 供前端调试参考):', uncompressedHex);
  console.log('');
  console.log('下一步：');
  console.log('  wrangler pages secret put VAPID_PUBLIC_KEY  --project-name pingcard');
  console.log('  wrangler pages secret put VAPID_PRIVATE_KEY --project-name pingcard');
  console.log('  wrangler pages secret put VAPID_SUBJECT     --project-name pingcard   # mailto:you@example.com');
  console.log('');
}

const args = process.argv.slice(2);
const fromPrivateIndex = args.indexOf('--from-private');

if (args.includes('--help') || args.includes('-h')) {
  console.log(`用法：
  npm run vapid:keys                        # 生成新的 VAPID 密钥对
  npm run vapid:keys -- --from-private KEY  # 由私钥反推公钥（KEY 支持 base64url / PEM / JWK）
  npm run vapid:keys -- --json              # 以 JSON 输出`);
  process.exit(0);
}

if (fromPrivateIndex !== -1) {
  const raw = args[fromPrivateIndex + 1];
  if (!raw) {
    console.error('错误：--from-private 需要一个密钥参数');
    process.exit(1);
  }
  const scalar = normalisePrivateKey(raw);
  const info = describe(publicFromPrivate(scalar));
  if (args.includes('--json')) {
    console.log(JSON.stringify({ VAPID_PUBLIC_KEY: info.publicKey, VAPID_PRIVATE_KEY: toBase64Url(scalar) }, null, 2));
  } else {
    console.log('VAPID_PUBLIC_KEY=' + info.publicKey);
    console.log('VAPID_PRIVATE_KEY=' + toBase64Url(scalar));
  }
  process.exit(0);
}

if (args.includes('--json')) {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const publicKey = ecdh.getPublicKey(); // uncompressed point
  const privateKey = ecdh.getPrivateKey();
  console.log(
    JSON.stringify(
      { VAPID_PUBLIC_KEY: toBase64Url(publicKey), VAPID_PRIVATE_KEY: toBase64Url(privateKey) },
      null,
      2,
    ),
  );
} else {
  printUsage();
}
