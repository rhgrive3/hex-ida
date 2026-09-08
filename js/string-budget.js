export const STRING_SCAN_BUDGET = Object.freeze({
  inputBytes: 64 * 1024 * 1024,
  resultLimit: 60_000,
  estimatedHeapBytes: 32 * 1024 * 1024,
});

/*
 * findStrings() walks the collected string index under an independent work
 * budget. Signal-aware scans yield in chunks so cancellation can be delivered;
 * the item/text budgets remain hard bounds independent of the result limit
 * (#5900).
 */
export const FIND_STRINGS_SCAN_BUDGET = Object.freeze({
  items: 1_000_000,
  textBytes: 64 * 1024 * 1024,
});

export class StringCollectionBudget {
  constructor(config = STRING_SCAN_BUDGET) {
    const inputBytes = typeof config.inputBytes === 'number' ? config.inputBytes : NaN;
    const resultLimit = typeof config.resultLimit === 'number' ? config.resultLimit : NaN;
    const estimatedHeapBytes = typeof config.estimatedHeapBytes === 'number' ? config.estimatedHeapBytes : NaN;
    this.inputRemaining = Number.isFinite(inputBytes) ? Math.max(0, inputBytes) : 0;
    this.resultLimit = Number.isFinite(resultLimit) ? Math.max(0, Math.floor(resultLimit)) : 1;
    this.heapLimit = Number.isFinite(estimatedHeapBytes) ? Math.max(1, estimatedHeapBytes) : 1;
    this.results = 0;
    this.estimatedHeap = 0;
    this.truncationReason = null;
  }

  requestBytes(size) {
    if (this.inputRemaining <= 0) return 0;
    const requested = typeof size === 'number' ? size : NaN;
    const n = Number.isFinite(requested)
      ? Math.min(this.inputRemaining, Math.max(0, requested))
      : 0;
    this.inputRemaining -= n;
    return n;
  }

  requestLimit() {
    return Math.max(0, this.resultLimit - this.results);
  }

  accept(text) {
    if (this.results >= this.resultLimit) {
      this.truncationReason ||= 'result-budget';
      return false;
    }
    const bytes = 96 + String(text || '').length * 2;
    if (this.estimatedHeap + bytes > this.heapLimit) {
      this.truncationReason ||= 'heap-budget';
      return false;
    }
    this.results++;
    this.estimatedHeap += bytes;
    return true;
  }

  get exhausted() {
    return this.requestLimit() <= 0 || this.estimatedHeap >= this.heapLimit;
  }
}

export class SearchScanBudget {
  constructor(config = FIND_STRINGS_SCAN_BUDGET) {
    const items = typeof config.items === 'number' && Number.isFinite(config.items) ? config.items : NaN;
    const textBytes = typeof config.textBytes === 'number' && Number.isFinite(config.textBytes) ? config.textBytes : NaN;
    this.itemsRemaining = Number.isFinite(items) ? Math.max(0, Math.floor(items)) : 0;
    this.textBytesRemaining = Number.isFinite(textBytes) ? Math.max(0, textBytes) : 0;
    this.scannedItems = 0;
    this.scannedTextBytes = 0;
  }

  get exhausted() {
    return this.itemsRemaining <= 0 || this.textBytesRemaining <= 0;
  }

  /* Charge the candidate before callers read candidate.text. */
  consumeItem() {
    if (this.itemsRemaining <= 0) return false;
    this.itemsRemaining -= 1;
    this.scannedItems += 1;
    return true;
  }

  /* Text-byte work is charged only for string-valued text. */
  consumeText(text) {
    if (typeof text !== 'string') return;
    const bytes = text.length * 2;
    this.textBytesRemaining -= bytes;
    this.scannedTextBytes += bytes;
  }

  /* Backward-compatible combined charge for existing direct callers. */
  consume(text) {
    if (!this.consumeItem()) return false;
    this.consumeText(text);
    return true;
  }
}
