# T039 final safety evidence

- Recorded: 2026-09-08
- Owner lane: Luna Max (evidence only)
- Evidence disposition: COMPLETE_ZERO
- Scope: T039's seven hard-zero semantic and safety counters on the exact source identity below.

This file records the exact-source T045 shadow receipt that supplies the locked T039 denominator packet. It does not promote T040/T041/T042, establish a hosted deployment, or provide physical-device evidence. Those remain separate release gates.

## Contract and acceptance rule

T039 is the task ledger entry in specs/005-analysis-final-closure/tasks.md. Its completion evidence requires every one of the seven counters to be exactly zero, with a non-zero denominator. The canonical counter IDs are defined by tools/validation/final-closure/preflight.mjs; terminal acceptance is enforced by assertTerminalShadowCounterEvidence and rejects missing, zero-denominator, or non-zero rows. T039 owns this evidence path only; implementation defects return to their canonical owners.

The T045 registry binding is t045-final-platform-verifier -> t045-browser-platform-regression-v1 in tools/validation/final-closure/shadow/foundation/registry.json and contracts.json. The locked contract has six projection cases. Their failure-counter mapping gives a real denominator for every required row:

| T039 counter | Locked projection case | Denominator | Observed |
| --- | --- | ---: | ---: |
| falseExactNoAlias | alias-soundness -> tests/phase7/negative/alias-soundness.test.mjs | 1 | 0 |
| falseExactMustAlias | alias-soundness -> tests/phase7/negative/alias-soundness.test.mjs | 1 | 0 |
| falseExactIndirectTarget | indirect-control-soundness -> tests/semantic-v2/issue-949-indirect-control.test.mjs | 1 | 0 |
| falseExactType | type-soundness-counterexamples -> tests/phase7/types/c3-01-counterexamples.test.mjs | 1 | 0 |
| semanticMismatch | all six locked projection cases below | 6 | 0 |
| stalePublicationAfterCancel | cancellation-publication -> tests/phase4/bytesource/cached-cancellation-lifecycle.test.mjs | 1 | 0 |
| invalidWriterOutputAccepted | rebuild-invalid-output-rejection -> tests/stage2/rebuild-transaction.test.mjs | 1 | 0 |

The six cases are browser-platform, alias-soundness, indirect-control-soundness, type-soundness-counterexamples, cancellation-publication, and rebuild-invalid-output-rejection. Each oracle/product observation exited with code 0 and each pair was a canonical MATCH; the receipt's proof has caseCount: 6 and verdict: PASS.

## Exact source and authority identities

The collector ran from a clean detached worktree at the exact candidate source, with the pinned Node runtime:

```text
PATH=/root/.nvm/versions/node/v22.22.1/bin:$PATH /root/.nvm/versions/node/v22.22.1/bin/node tools/validation/final-closure/preflight.mjs --emit-shadow-evidence --task T045 --expect-sha 8e045342db6bd9596056942d49b994aad55b895e --expect-tree df2fb9e524d960977d78b17d7667d792ca478f17 --authority-sha a5209e5bd5580ad6bd95c82f496f854b2374183c
```

| Identity | Value |
| --- | --- |
| Candidate head | 8e045342db6bd9596056942d49b994aad55b895e |
| Candidate tree | df2fb9e524d960977d78b17d7667d792ca478f17 |
| Direct authority parent | a5209e5bd5580ad6bd95c82f496f854b2374183c |
| T045 registry entry digest | eb169e1d78a03fbccb752e6caf998bf1 |
| Verifier identity | 4e36669c2238a6607db0cf2b60501fab3bd141a7d7a556bdaf28b216e06f9597 |
| Shadow contract identity | 58963cc16934a9498e8e36a308b7d8d35c031b377f7cbd798e382eecd2ad681a |
| Authority artifact identity | 11bfa71b9343ba71b4fc4b9121a4207339c593fcc1045701c407ef73330b3ef0 |
| Judge artifact identity | 780b1c76b20f8cb03b73c848c25157d25ab0043e5e3c172785b35c4f2a307987 |
| T045 receipt identity | 211cbe3b5c7553894847e9e62af71b180cf97674f5fecd99f7c7066887397dc4 |

The authority artifacts are the frozen registry, contract, oracle provider, and product provider blobs recorded in the receipt. The six judge artifact paths and content hashes are also recorded there, so the denominators cannot be replaced by generic positive integers.

## Terminal seven-zero packet

The central verifier rederived the receipt proof from the candidate ownership artifact and the frozen registry/contracts, then accepted the aggregate below. This is the packet for the T039 checkbox decision.

```json
{
  "schemaVersion": "hex-final-closure-checkpoint-shadow-aggregate/v1",
  "status": "COMPLETE_ZERO",
  "candidateIdentity": {
    "headSha": "8e045342db6bd9596056942d49b994aad55b895e",
    "treeSha": "df2fb9e524d960977d78b17d7667d792ca478f17"
  },
  "reportEvidenceIdentities": [
    {
      "taskId": "T045",
      "gateId": "t045-final-platform-verifier",
      "evidenceIdentity": "211cbe3b5c7553894847e9e62af71b180cf97674f5fecd99f7c7066887397dc4",
      "proofIdentity": "5cddd42fa96b5d44a9092bdab318f6227e00dc627735a9588b302e96bb33dcf3"
    }
  ],
  "reportSetIdentity": "0354a2266b8fde6c20fdf702ea2e54298448170f8bb346f9d556ea6cb63f411c",
  "counters": [
    {
      "id": "falseExactNoAlias",
      "observed": 0,
      "denominator": 1
    },
    {
      "id": "falseExactMustAlias",
      "observed": 0,
      "denominator": 1
    },
    {
      "id": "falseExactIndirectTarget",
      "observed": 0,
      "denominator": 1
    },
    {
      "id": "falseExactType",
      "observed": 0,
      "denominator": 1
    },
    {
      "id": "semanticMismatch",
      "observed": 0,
      "denominator": 6
    },
    {
      "id": "stalePublicationAfterCancel",
      "observed": 0,
      "denominator": 1
    },
    {
      "id": "invalidWriterOutputAccepted",
      "observed": 0,
      "denominator": 1
    }
  ],
  "aggregateIdentity": "c1d7630a22b8e75ecffe9e70c74984241b06e6653b37c305359dd53acbb5bb48",
  "envelopeIdentity": "af17d52bf458d8bc2ea8dc21b135d4e05a018b6e508e7818a4d632c48de3bdbf"
}
```

## Verbatim T045 receipt

```json
{
  "schemaVersion": "hex-final-closure-shadow-gate-evidence/v1",
  "status": "PASS",
  "taskId": "T045",
  "gateId": "t045-final-platform-verifier",
  "candidateIdentity": {
    "headSha": "8e045342db6bd9596056942d49b994aad55b895e",
    "treeSha": "df2fb9e524d960977d78b17d7667d792ca478f17"
  },
  "authorityCommitSha": "a5209e5bd5580ad6bd95c82f496f854b2374183c",
  "authorityOwnershipArtifact": {
    "path": "specs/005-analysis-final-closure/contracts/task-ownership.json",
    "gitBlobSha1": "e801e55c017ec275f3de65397a3a915e908d98b2",
    "sha256": "6015c8d43d5b34bc0facac437a787cd63c68cc3e0c7b3795cf52c19052ec87aa"
  },
  "registryEntryDigest": "eb169e1d78a03fbccb752e6caf998bf1",
  "verifierArtifact": {
    "path": "tools/validation/final-closure/preflight.mjs",
    "gitBlobSha1": "c121db65b8f0eaab5858d65d2329a9a7b62b2544",
    "sha256": "4e36669c2238a6607db0cf2b60501fab3bd141a7d7a556bdaf28b216e06f9597"
  },
  "verifierIdentity": "4e36669c2238a6607db0cf2b60501fab3bd141a7d7a556bdaf28b216e06f9597",
  "authorityArtifacts": [
    {
      "role": "registry",
      "path": "tools/validation/final-closure/shadow/foundation/registry.json",
      "gitBlobSha1": "495099bd5db7a977abcf91fac0f045db419f09e1",
      "sha256": "5ef70a1159d7fe8e0768cb3cd16958c8d96238c89ee9f0463d78e1555ef21b0e"
    },
    {
      "role": "contracts",
      "path": "tools/validation/final-closure/shadow/foundation/contracts.json",
      "gitBlobSha1": "50e9f04bfd9af11d8288e5d8e0d8e61e346652a3",
      "sha256": "ddff1dda2831e24aba7706699af20463752eafc0318378fdb1776e55a0bc451b"
    },
    {
      "role": "oracleProvider",
      "path": "tools/validation/final-closure/shadow/foundation/oracle-observer.mjs",
      "gitBlobSha1": "9136f0a32790f1679e1ef9e5e5f972a5393c4d74",
      "sha256": "2ea797c3947459e21466827239034d53ce25620c5d70f4609e188e5db083991a"
    },
    {
      "role": "productProvider",
      "path": "tools/validation/final-closure/shadow/foundation/product-observer.mjs",
      "gitBlobSha1": "bd688116273a9235d7f63e49a8ff4ee6e7964392",
      "sha256": "04d70f70b3db14d1eda1ba469429af35befd674fcd0a2255112f69931c8d48e2"
    }
  ],
  "authorityIdentity": "11bfa71b9343ba71b4fc4b9121a4207339c593fcc1045701c407ef73330b3ef0",
  "judgeArtifacts": [
    {
      "caseId": "browser-platform",
      "path": "tests/browser.mjs",
      "gitBlobSha1": "5cb3378af31ae75e6dc3468fbcb0d4b5149badea",
      "sha256": "7d2e552a58d76aad97ccf3194ff1f25022a77a945f7e815b7b57c69e548ae688"
    },
    {
      "caseId": "alias-soundness",
      "path": "tests/phase7/negative/alias-soundness.test.mjs",
      "gitBlobSha1": "a7d1a3b35e32c051fb66e896eca8046c88bc6370",
      "sha256": "0e932c1fcd5d9d334669ed29a2c3cc5104cd916a79255d203b2c95653f148909"
    },
    {
      "caseId": "indirect-control-soundness",
      "path": "tests/semantic-v2/issue-949-indirect-control.test.mjs",
      "gitBlobSha1": "11164fd89f13dbf5da31a13dedb3626dcfea8a52",
      "sha256": "0f931a1a227db73de96f7fb07d1cd3900cb70579229b7a4763d4189d05f481f8"
    },
    {
      "caseId": "type-soundness-counterexamples",
      "path": "tests/phase7/types/c3-01-counterexamples.test.mjs",
      "gitBlobSha1": "104e31813d653962f531b7ab60efea029193a378",
      "sha256": "f91e487f63d56f92f4f3f3cf4af0c348e1a72464c8f8fd0c8634ce6937c3a0a5"
    },
    {
      "caseId": "cancellation-publication",
      "path": "tests/phase4/bytesource/cached-cancellation-lifecycle.test.mjs",
      "gitBlobSha1": "4ab954db4e2e2c2545772957a53a0d66b63c76ea",
      "sha256": "59aab3912c5ac36d014078e3e545579f67b61fe1b907440799a9f7758a52af6a"
    },
    {
      "caseId": "rebuild-invalid-output-rejection",
      "path": "tests/stage2/rebuild-transaction.test.mjs",
      "gitBlobSha1": "e1d94aa0b263dd040e4de3fe250fc27f7a44373f",
      "sha256": "9feff361078e8fc0c31ff502cb2b1035108757b5246b957acf57b9c87661edbf"
    }
  ],
  "judgeIdentity": "780b1c76b20f8cb03b73c848c25157d25ab0043e5e3c172785b35c4f2a307987",
  "observations": {
    "oracle": {
      "schemaVersion": "hex-final-closure-shadow-raw-observation/v1",
      "taskId": "T045",
      "gateId": "t045-final-platform-verifier",
      "observations": [
        {
          "caseId": "browser-platform",
          "state": "OBSERVED",
          "value": {
            "errorCode": null,
            "exitCode": 0,
            "signal": null
          }
        },
        {
          "caseId": "alias-soundness",
          "state": "OBSERVED",
          "value": {
            "errorCode": null,
            "exitCode": 0,
            "signal": null
          }
        },
        {
          "caseId": "indirect-control-soundness",
          "state": "OBSERVED",
          "value": {
            "errorCode": null,
            "exitCode": 0,
            "signal": null
          }
        },
        {
          "caseId": "type-soundness-counterexamples",
          "state": "OBSERVED",
          "value": {
            "errorCode": null,
            "exitCode": 0,
            "signal": null
          }
        },
        {
          "caseId": "cancellation-publication",
          "state": "OBSERVED",
          "value": {
            "errorCode": null,
            "exitCode": 0,
            "signal": null
          }
        },
        {
          "caseId": "rebuild-invalid-output-rejection",
          "state": "OBSERVED",
          "value": {
            "errorCode": null,
            "exitCode": 0,
            "signal": null
          }
        }
      ]
    },
    "product": {
      "schemaVersion": "hex-final-closure-shadow-raw-observation/v1",
      "taskId": "T045",
      "gateId": "t045-final-platform-verifier",
      "observations": [
        {
          "caseId": "browser-platform",
          "state": "OBSERVED",
          "value": {
            "exitCode": 0,
            "signal": null,
            "errorCode": null
          }
        },
        {
          "caseId": "alias-soundness",
          "state": "OBSERVED",
          "value": {
            "exitCode": 0,
            "signal": null,
            "errorCode": null
          }
        },
        {
          "caseId": "indirect-control-soundness",
          "state": "OBSERVED",
          "value": {
            "exitCode": 0,
            "signal": null,
            "errorCode": null
          }
        },
        {
          "caseId": "type-soundness-counterexamples",
          "state": "OBSERVED",
          "value": {
            "exitCode": 0,
            "signal": null,
            "errorCode": null
          }
        },
        {
          "caseId": "cancellation-publication",
          "state": "OBSERVED",
          "value": {
            "exitCode": 0,
            "signal": null,
            "errorCode": null
          }
        },
        {
          "caseId": "rebuild-invalid-output-rejection",
          "state": "OBSERVED",
          "value": {
            "exitCode": 0,
            "signal": null,
            "errorCode": null
          }
        }
      ]
    }
  },
  "proof": {
    "schemaVersion": "hex-final-closure-shadow-proof/v2",
    "verdict": "PASS",
    "comparisonAlgorithm": "canonical-observation-equality-safe-unknown/v1",
    "contractIdentity": "58963cc16934a9498e8e36a308b7d8d35c031b377f7cbd798e382eecd2ad681a",
    "caseCount": 6,
    "results": [
      {
        "caseId": "browser-platform",
        "disposition": "MATCH",
        "oracleObservationSha256": "4e7bf554259a47662c19f25fa4162cfa42a4accf8f5c81e9755f66ccfd189710",
        "productObservationSha256": "4e7bf554259a47662c19f25fa4162cfa42a4accf8f5c81e9755f66ccfd189710"
      },
      {
        "caseId": "alias-soundness",
        "disposition": "MATCH",
        "oracleObservationSha256": "743704ef334e63ecc9815890d8467557a63bb8860acad7ccd4bcfbedbd3ff5df",
        "productObservationSha256": "743704ef334e63ecc9815890d8467557a63bb8860acad7ccd4bcfbedbd3ff5df"
      },
      {
        "caseId": "indirect-control-soundness",
        "disposition": "MATCH",
        "oracleObservationSha256": "5a3c72303ad59794747f2a6880144e9b2b2517e0951f659a446f536d466df620",
        "productObservationSha256": "5a3c72303ad59794747f2a6880144e9b2b2517e0951f659a446f536d466df620"
      },
      {
        "caseId": "type-soundness-counterexamples",
        "disposition": "MATCH",
        "oracleObservationSha256": "b74bd14d38dd11fcedca96fa6f4e622f49f8f7d06f6b1129774ac521fd19432a",
        "productObservationSha256": "b74bd14d38dd11fcedca96fa6f4e622f49f8f7d06f6b1129774ac521fd19432a"
      },
      {
        "caseId": "cancellation-publication",
        "disposition": "MATCH",
        "oracleObservationSha256": "a912b5c71a753fdd40f275c67cd03ad8158a7d18c322b84315c1e2bdd9ecf4a9",
        "productObservationSha256": "a912b5c71a753fdd40f275c67cd03ad8158a7d18c322b84315c1e2bdd9ecf4a9"
      },
      {
        "caseId": "rebuild-invalid-output-rejection",
        "disposition": "MATCH",
        "oracleObservationSha256": "f2d19b89ecc829bbfe180f05a7ed6a015a48efd76e1e15b17dbd14821540205d",
        "productObservationSha256": "f2d19b89ecc829bbfe180f05a7ed6a015a48efd76e1e15b17dbd14821540205d"
      }
    ],
    "counters": [
      {
        "id": "falseExactNoAlias",
        "observed": 0,
        "denominator": 1
      },
      {
        "id": "falseExactMustAlias",
        "observed": 0,
        "denominator": 1
      },
      {
        "id": "falseExactIndirectTarget",
        "observed": 0,
        "denominator": 1
      },
      {
        "id": "falseExactType",
        "observed": 0,
        "denominator": 1
      },
      {
        "id": "semanticMismatch",
        "observed": 0,
        "denominator": 6
      },
      {
        "id": "stalePublicationAfterCancel",
        "observed": 0,
        "denominator": 1
      },
      {
        "id": "invalidWriterOutputAccepted",
        "observed": 0,
        "denominator": 1
      }
    ]
  },
  "evidenceIdentity": "211cbe3b5c7553894847e9e62af71b180cf97674f5fecd99f7c7066887397dc4"
}
```

## Decision

The exact-source T045 receipt proves all seven T039 counters at zero with the locked six-case denominator mapping. T039's evidence condition is therefore satisfied as COMPLETE_ZERO; the task-ledger checkbox can be closed by the canonical integration owner when this evidence-only file is integrated.
