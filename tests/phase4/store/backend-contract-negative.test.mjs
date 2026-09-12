import assert from "node:assert/strict";
import { MemoryArtifactBackend } from "../../../js/core/artifacts/backends.js";
import { runArtifactBackendContract } from "./backend-contract.js";

async function assertContractRejects(name, createBackend, operator) {
  await assert.rejects(
    () => runArtifactBackendContract({ name, createBackend }),
    (error) => error?.name === "AssertionError"
      && error.code === "ERR_ASSERTION"
      && error.operator === operator,
  );
}

class ChangingCapabilitiesBackend extends MemoryArtifactBackend {
  #revision = 0;

  capabilities() {
    return Object.freeze({ ...super.capabilities(), revision: ++this.#revision });
  }
}

class MapCapabilitiesBackend extends MemoryArtifactBackend {
  #revision = 0;

  capabilities() {
    const capabilities = new Map([["revision", ++this.#revision]]);
    capabilities.backend = "memory";
    capabilities.persistent = false;
    return Object.freeze(capabilities);
  }
}

class SetCapabilitiesBackend extends MemoryArtifactBackend {
  #revision = 0;

  capabilities() {
    const capabilities = new Set([++this.#revision]);
    capabilities.backend = "memory";
    capabilities.persistent = false;
    return Object.freeze(capabilities);
  }
}

class ByteMismatchBackend extends MemoryArtifactBackend {
  async getRaw(artifactId) {
    const raw = await super.getRaw(artifactId);
    if (raw?.payload?.byteLength) raw.payload[0] ^= 0xff;
    return raw;
  }
}

class ResolvingAbortBackend extends MemoryArtifactBackend {
  async putAtomic(record, payload) {
    return super.putAtomic(record, payload);
  }
}

await assertContractRejects(
  "changing capability record",
  async () => new ChangingCapabilitiesBackend(),
  "deepStrictEqual",
);

await assertContractRejects(
  "Map capability object",
  async () => new MapCapabilitiesBackend(),
  "deepStrictEqual",
);

await assertContractRejects(
  "Set capability object",
  async () => new SetCapabilitiesBackend(),
  "deepStrictEqual",
);

await assertContractRejects(
  "byte-mismatching backend",
  async () => new ByteMismatchBackend(),
  "bytesEqual",
);

await assertContractRejects(
  "resolving pre-aborted publication",
  async () => new ResolvingAbortBackend(),
  "rejects",
);

console.log("phase4 backend contract negative assertions: PASS");
