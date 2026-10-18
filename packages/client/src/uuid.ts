/**
 * A random UUID (version 4) in the canonical lowercase form ComfyUI requires of a prompt id.
 * Built from `crypto.getRandomValues`, which, unlike `crypto.randomUUID`, browsers also offer on
 * pages that aren't a secure context (`http://192.168.…`).
 */
export function randomUuid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
