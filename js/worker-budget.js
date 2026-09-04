/* Shared hard limits for the classic analysis worker. */
(function installHexWorkerBudget(root) {
  const MiB = 1024 * 1024;
  root.HexWorkerBudget = Object.freeze({
    PROGRAM_INDEX_BYTES: 96 * MiB,
    /*
     * Function discovery already had a 400k output/data-candidate ceiling.
     * #555 added a shared cap for the previously-unbounded post-terminal and
     * branch-evidence collections. Give those two independently useful,
     * bounded cohorts one aggregate 800k pool instead of letting the existing
     * metadata candidates consume the entire new budget before code scanning.
     */
    FUNCTION_AUX_SLOTS: 800_000,
    SUPPLEMENTAL_READ_BYTES: 32 * MiB,
    SUPPLEMENTAL_RESIDENT_BYTES: 8 * MiB,
    SUPPLEMENTAL_REGIONS: 128,
    SUPPLEMENTAL_NAMES: 80_000,
    SUPPLEMENTAL_STRING_BYTES: 8 * MiB,
    SUPPLEMENTAL_OPERATIONS: 2_000_000,
    SUPPLEMENTAL_WALL_MS: 3000,
    createSupplementalBudget() {
      const start = Date.now();
      const used = { read:0, resident:0, regions:0, names:0, strings:0, operations:0 };
      const take = (key, amount, limit) => {
        if (typeof amount !== 'number') return false;
        const n = amount;
        if (!Number.isFinite(n) || n < 0 || Date.now() - start > 3000 || used[key] + n > limit) return false;
        used[key] += n; return true;
      };
      return {
        takeRead:(n)=>take('read',n,32*MiB), takeResident:(n)=>take('resident',n,8*MiB),
        /*
         * Release must be as strict as take. Only a finite positive primitive
         * number may be returned to resident accounting (#1337, #3291).
         */
        releaseResident(n){ if(typeof n!=='number'||!Number.isFinite(n)||n<=0) return; used.resident=Math.max(0,used.resident-n); },
        takeRegion:(n=1)=>take('regions',n,128), takeName:(n=1)=>take('names',n,80_000),
        takeString:(n)=>take('strings',n,8*MiB), takeOperation:(n=1)=>take('operations',n,2_000_000),
        expired:()=>Date.now()-start>3000, snapshot:()=>({...used,elapsedMs:Date.now()-start}),
      };
    },
    functionAuxLimit(requested) {
      const n = typeof requested === 'number' && Number.isFinite(requested) ? Math.max(0, Math.floor(requested)) : 0;
      return Math.min(800_000, Math.max(32_768, n * 2));
    },
    withinProgramBudget(currentBytes, temporaryBytes) {
      return typeof currentBytes === 'number' && Number.isFinite(currentBytes)
        && typeof temporaryBytes === 'number' && Number.isFinite(temporaryBytes)
        && currentBytes >= 0 && temporaryBytes >= 0
        && currentBytes + temporaryBytes <= 96 * MiB;
    },
  });
})(globalThis);
