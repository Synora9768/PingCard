/**
 * Unit tests for the pure logic (no Worker runtime needed):
 *   node --test test/unit.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  escapeHtml,
  extractPlaceholders,
  lintTemplate,
  renderTemplate,
  resolveVariables,
  substituteVariables,
} from '../functions/_lib/templateEngine.js';
import { html as parseHtml } from 'satori-html';
import * as engine from '../functions/_lib/templateEngine.js';
import { canonicalCardRequest, cardCacheKey, signCardRequest, verifyCardSignature } from '../functions/_lib/sign.js';
import { assertSafeHttpUrl, isBlockedHost } from '../functions/_lib/urls.js';
import {
  parseVapidKeys,
  encryptPayload,
  encryptRecord,
  interpretPushResponse,
  vapidAuthorizationHeader,
  MAX_PAYLOAD_BYTES,
} from '../functions/_lib/webpush.js';
import { toBase64Url, fromBase64Url, timingSafeEqual } from '../functions/_lib/bytes.js';

/* ------------------------------------------------------------- placeholders */

test('renderTemplate substitutes values and inline defaults', () => {
  const html = '<div>{{title}} / {{footer|默认页脚}} / {{missing}}</div>';
  assert.equal(renderTemplate(html, { title: '标题' }), '<div>标题 / 默认页脚 / </div>');
});

/** Deepest-first search over a satori-html tree (satori-html adds a wrapper root). */
function findNode(node, type) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const entry of node) {
      const found = findNode(entry, type);
      if (found) return found;
    }
    return null;
  }
  const nested = findNode(node.props?.children, type);
  if (nested) return nested;
  return node.type === type ? node : null;
}

const utf8 = (value) => new TextEncoder().encode(value);

test('substituteVariables renders arbitrary text literally (no markup injection)', () => {
  const tree = substituteVariables(
    parseHtml('<div style="display:flex;color:red"><span>{{title}}</span></div>'),
    { title: '"</span><script>alert(1)</script><span>" {{title}} & \'' },
  );

  const span = findNode(tree, 'span');
  const text = span.props.children;
  assert.equal(typeof text, 'string');
  assert.ok(text.includes('<script>'), 'the value is kept verbatim as *text*');
  assert.ok(text.includes('{{title}}'), 'values are never re-parsed as placeholders');
  assert.equal(findNode(tree, 'script'), null, 'no script element may be created');
  assert.equal(findNode(tree, 'div').props.style.color, 'red', 'template css is untouched');
});

test('CSS placeholders survive style parsing (image URLs, colors, widths)', () => {
  const template =
    `<div style="display:flex;background-image:url('{{bg}}');color:{{color}};width:{{percent}}%">x</div>`;
  const variables = { bg: 'https://cdn.example.com/a.jpg?w=1024&h=512&fit=cover', color: '#fff', percent: '42' };

  // `renderCard` uses this two-step pipeline: attribute pre-pass, then tree walk.
  const { substituteInAttributes } = engine;
  const tree = substituteVariables(parseHtml(substituteInAttributes(template, variables)), variables);
  const div = findNode(tree, 'div');
  assert.equal(div.props.style.backgroundImage, "url('https://cdn.example.com/a.jpg?w=1024&h=512&fit=cover')");
  assert.equal(div.props.style.color, '#fff');
  assert.equal(div.props.style.width, '42%');
});

test('attribute substitution keeps values inside the attribute', () => {
  const { substituteInAttributes } = engine;
  const template = `<div style="display:flex" title="{{t}}">x</div>`;
  const rendered = substituteInAttributes(template, { t: 'evil" onmouseover="alert(1)' });
  assert.equal(rendered, '<div style="display:flex" title="evil onmouseover=alert(1)">x</div>');

  // Structurally: the injected text stays inside `title`, no extra attributes.
  const div = findNode(parseHtml(rendered), 'div');
  assert.deepEqual(Object.keys(div.props).sort(), ['children', 'style', 'title']);
  assert.equal(div.props.title, 'evil onmouseover=alert(1)');
});

test('substituteVariables applies inline defaults and drops unknown placeholders', () => {
  const tree = substituteVariables(parseHtml('<div style="display:flex">{{a|兜底}}|{{missing}}</div>'), {});
  assert.equal(findNode(tree, 'div').props.children, '兜底|');
});

test('renderTemplate substitutes into a plain text/CSS string', () => {
  assert.equal(renderTemplate('{{a}} / {{b|默认}} / {{c}}', { a: '1' }), '1 / 默认 / ');
  assert.equal(renderTemplate('url("{{u}}")', { u: 'https://x/y.png?a=1&b=2' }), 'url("https://x/y.png?a=1&b=2")');
});

test('extractPlaceholders reports names, defaults and duplicates once', () => {
  const found = extractPlaceholders('{{a}} {{b|x}} {{a}}');
  assert.deepEqual(
    found.map((p) => p.name),
    ['a', 'b'],
  );
  assert.equal(found[1].defaultValue, 'x');
  assert.equal(found[0].count, 2);
});

test('resolveVariables merges schema defaults, validates required and image urls', () => {
  const schema = {
    title: { type: 'string', required: true, label: '标题' },
    footer: { type: 'string', required: false, default: '来自系统通知' },
    bgImage: { type: 'image_url', required: false },
  };
  const resolved = resolveVariables({ title: '你好' }, schema);
  assert.equal(resolved.footer, '来自系统通知');
  assert.equal(resolved.title, '你好');

  assert.throws(() => resolveVariables({}, schema), /Missing required variable "title"/);
  assert.throws(() => resolveVariables({ title: 'x', bgImage: 'ftp://evil' }, schema), /must use http/);
  assert.throws(
    () => resolveVariables({ title: 'x', bgImage: 'http://169.254.169.254/latest/meta-data' }, schema),
    /private or reserved host/,
  );
});

test('lintTemplate blocks unsupported tags and empty templates', () => {
  assert.ok(lintTemplate('<table><tr><td>x</td></tr></table>').errors.some((e) => e.includes('table')));
  assert.ok(lintTemplate('<div onclick="x()">{{a}}</div>').errors.some((e) => e.includes('onclick')));
  assert.ok(lintTemplate('<div style="display:flex">无变量</div>').errors.some((e) => e.includes('占位符')));
  assert.ok(lintTemplate('<div style="position:fixed">{{a}}</div>').errors.some((e) => e.includes('fixed')));
  const okTemplate = lintTemplate('<div style="display:flex">{{a}}</div>');
  assert.deepEqual(okTemplate.errors, []);
});

/* ------------------------------------------------------------------ signing */

const SECRET = 'test-secret-0123456789';

test('sign + verify round trip, tampering and expiry', async () => {
  const payload = { templateId: 't_demo', variables: { title: '你好', n: '1' }, width: 1024, height: 512 };
  const ts = Math.floor(Date.now() / 1000);
  const sig = await signCardRequest(SECRET, { ...payload, ts });

  assert.equal((await verifyCardSignature(SECRET, { ...payload, ts, sig })).valid, true);
  assert.equal(
    (await verifyCardSignature(SECRET, { ...payload, variables: { title: '篡改' }, ts, sig })).reason,
    'bad_signature',
  );
  assert.equal((await verifyCardSignature(SECRET, { ...payload, ts, sig: 'AAAA' })).valid, false);
  assert.equal(
    (await verifyCardSignature(SECRET, { ...payload, ts: ts - 3600, sig }, { ttlSeconds: 300 })).reason,
    'expired',
  );
  assert.equal((await verifyCardSignature(SECRET, { ...payload, ts, sig: 'x' }, { ttlSeconds: 300 })).valid, false);
});

test('canonical form is key-order independent and cache key is collision-safe', async () => {
  const a = canonicalCardRequest({ templateId: 't', variables: { b: '2', a: '1' }, width: 1, height: 2 });
  const b = canonicalCardRequest({ templateId: 't', variables: { a: '1', b: '2' }, width: 1, height: 2 });
  assert.equal(a, b);

  const k1 = await cardCacheKey({ templateId: 't', variables: { a: 'b' }, width: 10, height: 10, revision: 'r1' });
  const k2 = await cardCacheKey({ templateId: 't', variables: { a: 'bc' }, width: 10, height: 10, revision: 'r1' });
  const k3 = await cardCacheKey({ templateId: 't', variables: { a: 'b' }, width: 10, height: 10, revision: 'r2' });
  assert.notEqual(k1, k2, 'different variables must produce different keys');
  assert.notEqual(k1, k3, 'a template revision bump must invalidate the cache');
});

/* -------------------------------------------------------------------- bytes */

test('base64url helpers round trip and comparison is length-safe', () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 251, 255]);
  assert.deepEqual([...fromBase64Url(toBase64Url(bytes))], [...bytes]);
  assert.equal(timingSafeEqual('abc', 'abc'), true);
  assert.equal(timingSafeEqual('abc', 'abd'), false);
  assert.equal(timingSafeEqual('abc', 'abcd'), false);
  assert.equal(timingSafeEqual('', ''), true);
});

/* --------------------------------------------------------------------- urls */

test('ssrf guard blocks private ranges and allows public hosts', () => {
  for (const host of ['localhost', '127.0.0.1', '10.1.2.3', '192.168.0.1', '172.16.5.5', '169.254.169.254', '::1']) {
    assert.equal(isBlockedHost(host), true, `${host} should be blocked`);
  }
  assert.equal(isBlockedHost('example.com'), false);
  assert.equal(assertSafeHttpUrl('https://cdn.example.com/a.png'), 'https://cdn.example.com/a.png');
  assert.throws(() => assertSafeHttpUrl('javascript:alert(1)'), /http or https/);
});

/* ------------------------------------------------------------------ webpush */

test('parseVapidKeys accepts the web-push style base64url pair', () => {
  const { privateKey } = globalThis.crypto.subtle
    ? { privateKey: null }
    : { privateKey: null };
  // Generate a throwaway P-256 pair through Web Crypto for the test.
  return (async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
    const keys = parseVapidKeys({
      publicKey: toBase64Url(raw),
      privateKey: toBase64Url(fromBase64Url(jwk.d)),
      subject: 'mailto:test@example.com',
    });
    assert.equal(keys.publicKeyBytes.length, 65);
    assert.equal(keys.publicKeyBase64Url, toBase64Url(raw));
  })();
});

test('encryptPayload produces an RFC 8188 aes128gcm record', async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const subscription = {
    endpoint: 'https://push.example.com/x',
    keys: { p256dh: toBase64Url(raw), auth: toBase64Url(auth) },
  };

  const body = await encryptPayload(JSON.stringify({ title: '你好', body: '测试' }), subscription);
  // salt(16) + rs(4) + idlen(1) + keyid(65) + ciphertext(plaintext + 0x02 delimiter + 16 byte tag)
  const plaintextLength = new TextEncoder().encode(JSON.stringify({ title: '你好', body: '测试' })).length;
  assert.equal(body[16 + 4], 65, 'key id length byte must be 65');
  assert.equal(body[16 + 4 + 1], 4, 'key id must start with the uncompressed point marker');
  assert.equal(body.length, 16 + 4 + 1 + 65 + plaintextLength + 1 + 16);

  const rs = new DataView(body.buffer, 16, 4).getUint32(0, false);
  assert.equal(rs, MAX_PAYLOAD_BYTES);

  await assert.rejects(() => encryptPayload('x'.repeat(MAX_PAYLOAD_BYTES + 1), subscription), /limit/);
  await assert.rejects(
    () => encryptPayload('hi', { endpoint: 'https://x/y', keys: { p256dh: 'zzz', auth: toBase64Url(auth) } }),
    /uncompressed P-256/,
  );
});

test('push responses are classified (sent / expired / retryable)', async () => {
  assert.deepEqual((await interpretPushResponse(new Response('', { status: 201 }))).expired, false);
  assert.equal((await interpretPushResponse(new Response('', { status: 201 }))).ok, true);
  assert.equal((await interpretPushResponse(new Response('gone', { status: 410 }))).expired, true);
  assert.equal((await interpretPushResponse(new Response('nope', { status: 404 }))).expired, true);
  assert.equal((await interpretPushResponse(new Response('slow down', { status: 429 }))).retryable, true);
  assert.equal((await interpretPushResponse(new Response('boom', { status: 500 }))).ok, false);
});

test('escapeHtml covers the attribute-breaking characters', () => {
  assert.equal(escapeHtml('<a href="x" onclick=\'y\'>&'), '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;');
});

/* -------------------------------------------------- reference interop (RFC 8291)
 * `http_ece` is the reference implementation of RFC 8188/8291 written by the
 * author of those RFCs. The tests below check our Worker-side encryption against
 * it byte-for-byte with fixed key material, and decrypt each other's output, so
 * a wrong info string, record layout or nonce would be caught immediately.
 * -------------------------------------------------------------------------- */

const FIXED = {
  // fixed, throwaway P-256 key pairs (generated for these tests only)
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
};

async function loadReferenceEce() {
  try {
    const module = await import('http_ece');
    return module.default || module;
  } catch {
    return null;
  }
}

function ecdhFromPrivate(base64urlPrivate, base64urlPublic) {
  // Node's createECDH is only used inside the tests (Node runtime).
  return import('node:crypto').then(({ createECDH }) => {
    const curve = createECDH('prime256v1');
    curve.setPrivateKey(fromBase64Url(base64urlPrivate));
    return curve;
  });
}

async function importEcdhPrivate(rawBase64url, publicBase64url) {
  const publicBytes = fromBase64Url(publicBase64url);
  return crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      d: rawBase64url,
      x: toBase64Url(publicBytes.subarray(1, 33)),
      y: toBase64Url(publicBytes.subarray(33, 65)),
    },
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits'],
  );
}

test('our aes128gcm record is byte-identical to the reference implementation', async (t) => {
  const ece = await loadReferenceEce();
  if (!ece) return t.skip('http_ece is not installed (npm install)');

  const payload = 'When I grow up, I want to be a watermelon';
  const ourRecord = await encryptRecord({
    body: new TextEncoder().encode(payload),
    uaPublicBytes: fromBase64Url(FIXED.uaPublic),
    authSecret: fromBase64Url(FIXED.authSecret),
    asPrivateKey: await importEcdhPrivate(FIXED.asPrivate, FIXED.asPublic),
    asPublicBytes: fromBase64Url(FIXED.asPublic),
    salt: fromBase64Url(FIXED.salt),
  });

  const asCurve = await ecdhFromPrivate(FIXED.asPrivate, FIXED.asPublic);
  const referenceRecord = Buffer.from(
    ece.encrypt(Buffer.from(payload), {
      version: 'aes128gcm',
      privateKey: asCurve,
      dh: FIXED.uaPublic, // the receiver's public key
      keyid: Buffer.from(fromBase64Url(FIXED.asPublic)), // raw bytes, not the base64 text
      salt: FIXED.salt,
      authSecret: FIXED.authSecret,
    }),
  );

  assert.equal(toBase64Url(ourRecord), referenceRecord.toString('base64url'));
});

test('the reference implementation decrypts what we encrypt (interop)', async (t) => {
  const ece = await loadReferenceEce();
  if (!ece) return t.skip('http_ece is not installed (npm install)');

  const payload = JSON.stringify({ title: '中文标题', body: 'with "quotes" & <tags>', emoji: '🎉' });
  const record = await encryptPayload(payload, {
    endpoint: 'https://push.example.com/interop',
    keys: { p256dh: FIXED.uaPublic, auth: FIXED.authSecret },
  });

  const uaCurve = await ecdhFromPrivate(FIXED.uaPrivate, FIXED.uaPublic);
  const decrypted = Buffer.from(
    ece.decrypt(Buffer.from(record), {
      version: 'aes128gcm',
      privateKey: uaCurve,
      authSecret: FIXED.authSecret,
    }),
  ).toString();

  assert.equal(decrypted, payload);
});

test('a subscriber can decrypt what we send (full round trip)', async () => {
  // Simulate the user agent: generate a subscription, decrypt the record with
  // the mirrored derivation, and check the plaintext + padding framing.
  const uaKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const uaPublicBytes = new Uint8Array(await crypto.subtle.exportKey('raw', uaKeys.publicKey));
  const authSecret = crypto.getRandomValues(new Uint8Array(16));
  const subscription = {
    endpoint: 'https://push.example.com/roundtrip',
    keys: { p256dh: toBase64Url(uaPublicBytes), auth: toBase64Url(authSecret) },
  };

  const payload = JSON.stringify({ title: '中文标题', body: 'with "quotes" & <tags>', emoji: '🎉' });
  const body = await encryptPayload(payload, subscription);

  // ---- parse the aes128gcm header
  const salt = body.subarray(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0, false);
  const idlen = body[20];
  const asPublicBytes = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);
  assert.equal(rs, 4096);
  assert.equal(idlen, 65);
  assert.equal(asPublicBytes[0], 4);

  // ---- mirrored key derivation
  const asPublicKey = await crypto.subtle.importKey('raw', asPublicBytes, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: asPublicKey }, uaKeys.privateKey, 256),
  );
  const hkdf = async (saltBytes, keyMaterial, info, length) => {
    const key = await crypto.subtle.importKey('raw', keyMaterial, 'HKDF', false, ['deriveBits']);
    return new Uint8Array(
      await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: saltBytes, info }, key, length * 8),
    );
  };
  const concat = (...parts) => {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  };
  // IKM is extracted with the auth secret; CEK/nonce expand with the record salt.
  const ikm = await hkdf(
    authSecret,
    sharedSecret,
    concat(utf8('WebPush: info\0'), uaPublicBytes, asPublicBytes),
    32,
  );
  const cekBytes = await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12);

  const cek = await crypto.subtle.importKey('raw', cekBytes, 'AES-GCM', false, ['decrypt']);
  const record = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, cek, ciphertext),
  );

  assert.equal(record[record.length - 1], 2, 'last-record delimiter must be 0x02');
  assert.equal(new TextDecoder().decode(record.subarray(0, record.length - 1)), payload);
});

test('VAPID authorization header carries a verifiable ES256 JWT', async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const keys = parseVapidKeys({
    publicKey: toBase64Url(raw),
    privateKey: toBase64Url(fromBase64Url(jwk.d)),
    subject: 'mailto:test@example.com',
  });

  const header = await vapidAuthorizationHeader(keys, 'https://fcm.googleapis.com/fcm/send/abc');
  const match = header.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.ok(match, `unexpected header: ${header}`);
  assert.equal(match[2], keys.publicKeyBase64Url);

  const [jwtHeader, claims, signature] = match[1].split('.');
  assert.deepEqual(JSON.parse(atob(jwtHeader.replace(/-/g, '+').replace(/_/g, '/'))), { typ: 'JWT', alg: 'ES256' });
  const parsedClaims = JSON.parse(Buffer.from(claims.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
  assert.equal(parsedClaims.aud, 'https://fcm.googleapis.com');
  assert.equal(parsedClaims.sub, 'mailto:test@example.com');
  assert.ok(parsedClaims.exp > Math.floor(Date.now() / 1000) + 3600);

  // The signature must verify with the *public* key the browser subscribed with.
  const verifyKey = await crypto.subtle.importKey('raw', raw, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const valid = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    verifyKey,
    fromBase64Url(signature),
    new TextEncoder().encode(`${jwtHeader}.${claims}`),
  );
  assert.equal(valid, true, 'VAPID JWT signature must verify against VAPID_PUBLIC_KEY');
  assert.equal(fromBase64Url(signature).length, 64, 'JWS ES256 signature must be r||s (64 bytes)');
});
