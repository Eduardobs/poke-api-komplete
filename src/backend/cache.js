// Bounded per-process caches: anonymous, read-only requests only.
export class LruCache {
  constructor({ maxBytes, maxEntries = 256, ttlMs = Infinity }) { Object.assign(this, { maxBytes, maxEntries, ttlMs }); this.bytes = 0; this.items = new Map(); }
  get(key) {
    const item = this.items.get(key);
    if (!item) return;
    if (item.expires <= Date.now()) { this.delete(key); return; }
    this.items.delete(key); this.items.set(key, item);
    return item.value;
  }
  delete(key) { const old = this.items.get(key); if (old) { this.bytes -= old.bytes; this.items.delete(key); } }
  set(key, value, bytes) {
    this.delete(key);
    if (bytes > this.maxBytes || this.ttlMs <= 0) return;
    while (this.items.size && (this.bytes + bytes > this.maxBytes || this.items.size >= this.maxEntries)) this.delete(this.items.keys().next().value);
    this.items.set(key, { value, bytes, expires: Date.now() + this.ttlMs }); this.bytes += bytes;
  }
}
