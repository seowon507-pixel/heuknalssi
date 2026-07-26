// Web Push 발신자 신원(VAPID) 키 한 쌍을 만든다.
// 공개키는 브라우저에 그대로 내려가고, 개인키는 서버 환경변수로만 둔다.
// 키를 바꾸면 기존 구독이 전부 무효가 되므로 한 번만 만들어 쓴다.
import { createECDH } from "node:crypto";

const encode = (buffer) =>
  Buffer.from(buffer).toString("base64")
    .replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");

const ecdh = createECDH("prime256v1");
ecdh.generateKeys();

console.log(`VAPID_PUBLIC_KEY=${encode(ecdh.getPublicKey())}`);
console.log(`VAPID_PRIVATE_KEY=${encode(ecdh.getPrivateKey())}`);
