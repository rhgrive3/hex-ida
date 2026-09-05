# Stage A checkpoint evidence

This isolated T051 proposal is not accepted until exact runtime replay and
candidate CI succeed. Recorded gate results below were executed on exact G.
Physical-device tests are SKIPPED_USER_WAIVER, never PASS; Stage B is unstarted.

```json final-closure-stage-a-checkpoints
{
  "schemaVersion": "hex-final-closure-integration-checkpoint-ledger/v1",
  "campaignStage": "STAGE_A",
  "checkpoints": [
    {
      "sequence": 1,
      "acceptedTaskId": "T051",
      "integrationParentSha": "d7fbe59871f4a29913f313d33afe0c525de9329a",
      "mainReconciliation": {
        "schemaVersion": "hex-final-closure-main-reconciliation/v1",
        "mode": "NOOP",
        "previousEvidenceSha": "d7fbe59871f4a29913f313d33afe0c525de9329a",
        "currentMainSha": "7012c4cc4f0d5c0d8a7ca44c6c5c1edcb080aba1",
        "integrationHeadSha": "d7fbe59871f4a29913f313d33afe0c525de9329a",
        "integrationHeadTreeSha": "774281e3c37514ff472ebb5f7b3d2ca8950b5d09",
        "autoMergeTreeSha": null,
        "adjustmentPaths": [],
        "adjustmentStableDigest": "09612b07b5ecb5a5359f19cb0456e970"
      },
      "componentHeadSha": "3f0b6a31d54360d05e8560e50d6efc5a912fc29b",
      "candidateMergeTreeSha": "17591181aab07357291a8fbbb651f8c1e91b83e2",
      "acceptedMerge": {
        "commitSha": "7d4bb334f4c18e48e35240638c84bad55b7c1feb",
        "treeSha": "17591181aab07357291a8fbbb651f8c1e91b83e2"
      },
      "checkpointProduct": {
        "commitSha": "b83226bbbb2065e9d541c0bd6a5c5540839570cc",
        "treeSha": "9215a2778fe0174635b95555b421ead229be55c5"
      },
      "integrationReconciliation": {
        "schemaVersion": "hex-final-closure-product-reconciliation/v1",
        "ownerTaskId": "T049",
        "mergeCommitSha": "7d4bb334f4c18e48e35240638c84bad55b7c1feb",
        "productCommitSha": "b83226bbbb2065e9d541c0bd6a5c5540839570cc",
        "paths": [],
        "pathCount": 0,
        "stableDigest": "09612b07b5ecb5a5359f19cb0456e970"
      },
      "generation": {
        "schemaVersion": "hex-final-closure-checkpoint-generation-evidence/v1",
        "command": "node scripts/build-userscript.mjs",
        "firstRunDiffEmpty": true,
        "secondRunDiffEmpty": true,
        "candidateIdentity": {
          "headSha": "b83226bbbb2065e9d541c0bd6a5c5540839570cc",
          "treeSha": "9215a2778fe0174635b95555b421ead229be55c5"
        },
        "generator": {
          "path": "scripts/build-userscript.mjs",
          "gitBlobSha1": "4a0babc9a05b68259ac1796b12e4e255e297bf0f",
          "sha256": "710c1d19d1c6fe5c0e10fabdfb5439d1e3ec5d6236c424bac2609ebd5256b663"
        },
        "generatedBlobs": [
          {
            "path": "js/userscript/deployment-identity.generated.js",
            "gitBlobSha1": "a9f51f223052c0ae67b174d52344afa773666a0a",
            "sha256": "3887de01f4ab6c25d10339b6111a9c4d1b9b7be75f6b01fce5bdbed080d63252"
          },
          {
            "path": "userscript/hex.user.template.js",
            "gitBlobSha1": "9527368db2da1115c6c215ef7ef3c658660398c3",
            "sha256": "7726e03556763539dd71eadba29445cb5b4ed517d0a10ca8f06613fee1afde89"
          },
          {
            "path": "userscript/release-version.json",
            "gitBlobSha1": "18f97c4b8eccb64b799a9de0647114c508374088",
            "sha256": "efb92a534277bb932fa9ce9a32bd1fe835c1ff4c088a842b1bff6a52c6e24606"
          }
        ],
        "sourceIdentity": "fbdb07dca8c051a8eed8e438834978e8f9a9d81ef4fb9bc987471024fb1c0d54",
        "buildIdentity": "ff1b41f831edffced86b14179e89f28031dc61f97ad70d2a13b9245b52dec8a2",
        "artifactIdentity": "6fe10ffb2b3275041af6e44cbd9b7b54506bc307cc5fe8d52de3a707275a7307",
        "releaseIdentity": "8bb3838fb499b6e276f06da899f67faf4c924a21bc566ff45f665daaea8ddee9",
        "buildId": "dbcba7da5f2bb0098ba548b4",
        "releaseSerial": 2322242131
      },
      "rollingProductGates": {
        "schemaVersion": "hex-final-closure-checkpoint-rolling-evidence/v2",
        "taskIds": [
          "T051"
        ],
        "status": "PASS",
        "candidateIdentity": {
          "headSha": "b83226bbbb2065e9d541c0bd6a5c5540839570cc",
          "treeSha": "9215a2778fe0174635b95555b421ead229be55c5"
        },
        "registry": {
          "path": "specs/005-analysis-final-closure/contracts/task-ownership.json",
          "sourceCommitSha": "b83226bbbb2065e9d541c0bd6a5c5540839570cc",
          "sourceTreeSha": "9215a2778fe0174635b95555b421ead229be55c5",
          "gitBlobSha1": "07217ca3cb49bf6444e93f5021d2539b64f252f2",
          "sha256": "74b9c0f479ab8d420aa39b9fd6cb4cb75b60972849d8d4d4e097f882dacfefc6",
          "initialCandidateGateDigest": "63fb512b688c281f862740411f20df72",
          "rollingSetDigest": "af876d48d0b09d421d8c749ee64cc74b"
        },
        "results": [
          {
            "taskId": "T051",
            "gateId": "t051-ai-release-session",
            "registeredArgv": [
              "node",
              "tests/phase12/adversarial/issue-3664-ai-runtime-release-session.test.mjs"
            ],
            "registeredArgvDigest": "8a1737fec2e21babad13e736f8e1faa4",
            "executedArgv": [
              "node",
              "tests/phase12/adversarial/issue-3664-ai-runtime-release-session.test.mjs"
            ],
            "executedArgvDigest": "8a1737fec2e21babad13e736f8e1faa4",
            "candidateIdentity": {
              "headSha": "b83226bbbb2065e9d541c0bd6a5c5540839570cc",
              "treeSha": "9215a2778fe0174635b95555b421ead229be55c5"
            },
            "process": {
              "exitCode": 0,
              "signal": null,
              "spawnErrorCode": null,
              "outputLimitExceeded": false
            },
            "stdout": {
              "byteLength": 72,
              "sha256": "06700e4d61092e39c75ed601ef3210358c3b6a97a26ed5da3ebe1543785b1a98"
            },
            "stderr": {
              "byteLength": 0,
              "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
            },
            "status": "PASS",
            "identity": "b358976e7a81d9f9fe91713e8275f1c5d89fa259bed68f4f3bde0683419e0f1a"
          },
          {
            "taskId": "T051",
            "gateId": "t051-ai-binary-identity",
            "registeredArgv": [
              "node",
              "tests/phase12/adversarial/issue-6241-ai-snapshot-binary-identity.test.mjs"
            ],
            "registeredArgvDigest": "00f934e13d986dbb5aa0e7f4f52858d2",
            "executedArgv": [
              "node",
              "tests/phase12/adversarial/issue-6241-ai-snapshot-binary-identity.test.mjs"
            ],
            "executedArgvDigest": "00f934e13d986dbb5aa0e7f4f52858d2",
            "candidateIdentity": {
              "headSha": "b83226bbbb2065e9d541c0bd6a5c5540839570cc",
              "treeSha": "9215a2778fe0174635b95555b421ead229be55c5"
            },
            "process": {
              "exitCode": 0,
              "signal": null,
              "spawnErrorCode": null,
              "outputLimitExceeded": false
            },
            "stdout": {
              "byteLength": 43,
              "sha256": "21405ece7b7ae267b0e6bd85c395a3b016eb30dd6c3feca7355c0f02b94f3c6d"
            },
            "stderr": {
              "byteLength": 0,
              "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
            },
            "status": "PASS",
            "identity": "93a140ea3631baa7b0005976fab9c913e06e54266794463d17cc3c9aff891cc1"
          }
        ],
        "identity": "51fba482e882feb8a0172e23c9bce9019ff7e8aa0941427cab0ebfece9751fc5"
      },
      "independentShadowVerifier": {
        "schemaVersion": "hex-final-closure-checkpoint-shadow-evidence/v2",
        "status": "PASS",
        "candidateIdentity": {
          "headSha": "b83226bbbb2065e9d541c0bd6a5c5540839570cc",
          "treeSha": "9215a2778fe0174635b95555b421ead229be55c5"
        },
        "reports": [
          {
            "schemaVersion": "hex-final-closure-shadow-gate-evidence/v1",
            "status": "PASS",
            "taskId": "T051",
            "gateId": "t051-independent-verifier",
            "candidateIdentity": {
              "headSha": "b83226bbbb2065e9d541c0bd6a5c5540839570cc",
              "treeSha": "9215a2778fe0174635b95555b421ead229be55c5"
            },
            "authorityCommitSha": "7d4bb334f4c18e48e35240638c84bad55b7c1feb",
            "authorityOwnershipArtifact": {
              "path": "specs/005-analysis-final-closure/contracts/task-ownership.json",
              "gitBlobSha1": "07217ca3cb49bf6444e93f5021d2539b64f252f2",
              "sha256": "74b9c0f479ab8d420aa39b9fd6cb4cb75b60972849d8d4d4e097f882dacfefc6"
            },
            "registryEntryDigest": "f120c169be6ae3d781e7a2c0c33b3d28",
            "verifierArtifact": {
              "path": "tools/validation/final-closure/preflight.mjs",
              "gitBlobSha1": "244b7ac8c7a2d0480917491137d3db73378ece16",
              "sha256": "7cda1f185627d88efb85f7500da22d8220a5c120e282e6ab5a05257dbb82703a"
            },
            "verifierIdentity": "7cda1f185627d88efb85f7500da22d8220a5c120e282e6ab5a05257dbb82703a",
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
                "caseId": "ai-snapshot-binary-identity",
                "path": "tests/ai-scope-hardening.mjs",
                "gitBlobSha1": "4e6912d4e94b259f01b3367c7df8d359e2c08724",
                "sha256": "1ec4b027893b217058eda1505183e9d70e58035a32050643a1fcd6aaae10c49f"
              }
            ],
            "judgeIdentity": "5ef6c46abb516de3d8df77b5f1c020082b0091ecfee72f482fe7f885c0465cff",
            "observations": {
              "oracle": {
                "schemaVersion": "hex-final-closure-shadow-raw-observation/v1",
                "taskId": "T051",
                "gateId": "t051-independent-verifier",
                "observations": [
                  {
                    "caseId": "ai-snapshot-binary-identity",
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
                "taskId": "T051",
                "gateId": "t051-independent-verifier",
                "observations": [
                  {
                    "caseId": "ai-snapshot-binary-identity",
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
              "contractIdentity": "8ed019f13666f1913ae77d906a840016b38d50afe5ee9a301eb4355dfbe573f1",
              "caseCount": 1,
              "results": [
                {
                  "caseId": "ai-snapshot-binary-identity",
                  "disposition": "MATCH",
                  "oracleObservationSha256": "d6afc80f95c68f389ce9a6dbcf5379503c547c299008dd093b767fb33cf628b2",
                  "productObservationSha256": "d6afc80f95c68f389ce9a6dbcf5379503c547c299008dd093b767fb33cf628b2"
                }
              ],
              "counters": [
                {
                  "id": "falseExactNoAlias",
                  "observed": 0,
                  "denominator": 0
                },
                {
                  "id": "falseExactMustAlias",
                  "observed": 0,
                  "denominator": 0
                },
                {
                  "id": "falseExactIndirectTarget",
                  "observed": 0,
                  "denominator": 0
                },
                {
                  "id": "falseExactType",
                  "observed": 0,
                  "denominator": 0
                },
                {
                  "id": "semanticMismatch",
                  "observed": 0,
                  "denominator": 1
                },
                {
                  "id": "stalePublicationAfterCancel",
                  "observed": 0,
                  "denominator": 0
                },
                {
                  "id": "invalidWriterOutputAccepted",
                  "observed": 0,
                  "denominator": 0
                }
              ]
            },
            "evidenceIdentity": "8515692b983a1948a1bfaec0c70f55230ae5afc422dfd950bb6df8279d99cf62"
          }
        ],
        "aggregate": {
          "schemaVersion": "hex-final-closure-checkpoint-shadow-aggregate/v1",
          "status": "PARTIAL_ZERO",
          "candidateIdentity": {
            "headSha": "b83226bbbb2065e9d541c0bd6a5c5540839570cc",
            "treeSha": "9215a2778fe0174635b95555b421ead229be55c5"
          },
          "reportEvidenceIdentities": [
            {
              "taskId": "T051",
              "gateId": "t051-independent-verifier",
              "evidenceIdentity": "8515692b983a1948a1bfaec0c70f55230ae5afc422dfd950bb6df8279d99cf62",
              "proofIdentity": "978a37ce9e7d6ea98d09248c8212b2d4f1b590b69e0ad8085d6936e06a762b7a"
            }
          ],
          "reportSetIdentity": "a7fd7bbae923321d21692c075beb0be1684727479e6ada2916dab8e526998637",
          "counters": [
            {
              "id": "falseExactNoAlias",
              "observed": 0,
              "denominator": 0
            },
            {
              "id": "falseExactMustAlias",
              "observed": 0,
              "denominator": 0
            },
            {
              "id": "falseExactIndirectTarget",
              "observed": 0,
              "denominator": 0
            },
            {
              "id": "falseExactType",
              "observed": 0,
              "denominator": 0
            },
            {
              "id": "semanticMismatch",
              "observed": 0,
              "denominator": 1
            },
            {
              "id": "stalePublicationAfterCancel",
              "observed": 0,
              "denominator": 0
            },
            {
              "id": "invalidWriterOutputAccepted",
              "observed": 0,
              "denominator": 0
            }
          ],
          "identity": "a803241e5df0bbad52fb4f78c3b0cf5f9f328e918cb9f9e9530d52985a045f77"
        },
        "identity": "af29510610f5af9b10cce4f540ecbbf24e6d2a6f0ae3d6ceb20b178074019d6a"
      },
      "initialCandidateGateDigest": "63fb512b688c281f862740411f20df72",
      "cumulativeInventory": {
        "baseSha": "7012c4cc4f0d5c0d8a7ca44c6c5c1edcb080aba1",
        "stableDigest": "d6811d4d91a49c65b5ddc428b213c4c4",
        "pathCount": 45
      }
    },
    {
      "sequence": 2,
      "acceptedTaskId": "T059",
      "integrationParentSha": "dc07d77cb3c36cd9ecde14e5cc608c479fece5cb",
      "mainReconciliation": {
        "schemaVersion": "hex-final-closure-main-reconciliation/v1",
        "mode": "NOOP",
        "previousEvidenceSha": "dc07d77cb3c36cd9ecde14e5cc608c479fece5cb",
        "currentMainSha": "7012c4cc4f0d5c0d8a7ca44c6c5c1edcb080aba1",
        "integrationHeadSha": "dc07d77cb3c36cd9ecde14e5cc608c479fece5cb",
        "integrationHeadTreeSha": "abdf3a5ec73669d2e98ea1a1cd7b09c8f0a7ed1c",
        "autoMergeTreeSha": null,
        "adjustmentPaths": [],
        "adjustmentStableDigest": "09612b07b5ecb5a5359f19cb0456e970"
      },
      "componentHeadSha": "c965cf30ef6426d2178759494006ba9f2864ed45",
      "candidateMergeTreeSha": "24f67206ef0bfedae63f1bd8196902613c3e7dd6",
      "acceptedMerge": {
        "commitSha": "9bce4fc12327c9a20368eb24021fc0ed525e2db0",
        "treeSha": "24f67206ef0bfedae63f1bd8196902613c3e7dd6"
      },
      "checkpointProduct": {
        "commitSha": "8d7c945c9254b4223e088ad87cc98259d09648e5",
        "treeSha": "093cf7ef96a2ced37d26b2a325bb66ac46ecd282"
      },
      "integrationReconciliation": {
        "schemaVersion": "hex-final-closure-product-reconciliation/v1",
        "ownerTaskId": "T049",
        "mergeCommitSha": "9bce4fc12327c9a20368eb24021fc0ed525e2db0",
        "productCommitSha": "8d7c945c9254b4223e088ad87cc98259d09648e5",
        "paths": [],
        "pathCount": 0,
        "stableDigest": "09612b07b5ecb5a5359f19cb0456e970"
      },
      "generation": {
        "schemaVersion": "hex-final-closure-checkpoint-generation-evidence/v1",
        "command": "node scripts/build-userscript.mjs",
        "firstRunDiffEmpty": true,
        "secondRunDiffEmpty": true,
        "candidateIdentity": {
          "headSha": "8d7c945c9254b4223e088ad87cc98259d09648e5",
          "treeSha": "093cf7ef96a2ced37d26b2a325bb66ac46ecd282"
        },
        "generator": {
          "path": "scripts/build-userscript.mjs",
          "gitBlobSha1": "4a0babc9a05b68259ac1796b12e4e255e297bf0f",
          "sha256": "710c1d19d1c6fe5c0e10fabdfb5439d1e3ec5d6236c424bac2609ebd5256b663"
        },
        "generatedBlobs": [
          {
            "path": "js/userscript/deployment-identity.generated.js",
            "gitBlobSha1": "a9f51f223052c0ae67b174d52344afa773666a0a",
            "sha256": "3887de01f4ab6c25d10339b6111a9c4d1b9b7be75f6b01fce5bdbed080d63252"
          },
          {
            "path": "userscript/hex.user.template.js",
            "gitBlobSha1": "2794f352f9a3555d2424930f89c880d1c22254ee",
            "sha256": "14366642f5dd669dbf97ca706b40c7982f2edd820abd1dd07eb05fbba11f533d"
          },
          {
            "path": "userscript/release-version.json",
            "gitBlobSha1": "0e4d73b24da51df91e7deac6e77d9636aac0d0e3",
            "sha256": "a67d5659466775edae5ba18b12770289d63d18880dd08b89c1dd69624bf3ca40"
          }
        ],
        "sourceIdentity": "134bdc5b650c73f51ac57d0abbd69c30d2834873c08ad7096a289bc114c5c2e9",
        "buildIdentity": "f630d348b91bfcfdeda9e401845cc8e90ac6cbd48bb7ac28596d71e68dda94ff",
        "artifactIdentity": "e8c018de097f13a7295825b81d6113f389df0f179053bdc8e1e7ff18c35f54b3",
        "releaseIdentity": "9e501b6e69e1ef93950a94a558742357da4c4c443a255275d7da1836f1e3a9f8",
        "buildId": "ebf2decf66736c0b087ec491",
        "releaseSerial": 2322242132
      },
      "rollingProductGates": {
        "schemaVersion": "hex-final-closure-checkpoint-rolling-evidence/v2",
        "taskIds": [
          "T051",
          "T059"
        ],
        "status": "PASS",
        "candidateIdentity": {
          "headSha": "8d7c945c9254b4223e088ad87cc98259d09648e5",
          "treeSha": "093cf7ef96a2ced37d26b2a325bb66ac46ecd282"
        },
        "registry": {
          "path": "specs/005-analysis-final-closure/contracts/task-ownership.json",
          "sourceCommitSha": "8d7c945c9254b4223e088ad87cc98259d09648e5",
          "sourceTreeSha": "093cf7ef96a2ced37d26b2a325bb66ac46ecd282",
          "gitBlobSha1": "07217ca3cb49bf6444e93f5021d2539b64f252f2",
          "sha256": "74b9c0f479ab8d420aa39b9fd6cb4cb75b60972849d8d4d4e097f882dacfefc6",
          "initialCandidateGateDigest": "63fb512b688c281f862740411f20df72",
          "rollingSetDigest": "cccf5d0d22e8ecb933714e9464a178dc"
        },
        "results": [
          {
            "taskId": "T051",
            "gateId": "t051-ai-release-session",
            "registeredArgv": [
              "node",
              "tests/phase12/adversarial/issue-3664-ai-runtime-release-session.test.mjs"
            ],
            "registeredArgvDigest": "8a1737fec2e21babad13e736f8e1faa4",
            "executedArgv": [
              "node",
              "tests/phase12/adversarial/issue-3664-ai-runtime-release-session.test.mjs"
            ],
            "executedArgvDigest": "8a1737fec2e21babad13e736f8e1faa4",
            "candidateIdentity": {
              "headSha": "8d7c945c9254b4223e088ad87cc98259d09648e5",
              "treeSha": "093cf7ef96a2ced37d26b2a325bb66ac46ecd282"
            },
            "process": {
              "exitCode": 0,
              "signal": null,
              "spawnErrorCode": null,
              "outputLimitExceeded": false
            },
            "stdout": {
              "byteLength": 72,
              "sha256": "06700e4d61092e39c75ed601ef3210358c3b6a97a26ed5da3ebe1543785b1a98"
            },
            "stderr": {
              "byteLength": 0,
              "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
            },
            "status": "PASS",
            "identity": "c61a4a42c2987a8ca435fa893f87e5cd4f426c9b750eb6ce6bdab04c62217a50"
          },
          {
            "taskId": "T051",
            "gateId": "t051-ai-binary-identity",
            "registeredArgv": [
              "node",
              "tests/phase12/adversarial/issue-6241-ai-snapshot-binary-identity.test.mjs"
            ],
            "registeredArgvDigest": "00f934e13d986dbb5aa0e7f4f52858d2",
            "executedArgv": [
              "node",
              "tests/phase12/adversarial/issue-6241-ai-snapshot-binary-identity.test.mjs"
            ],
            "executedArgvDigest": "00f934e13d986dbb5aa0e7f4f52858d2",
            "candidateIdentity": {
              "headSha": "8d7c945c9254b4223e088ad87cc98259d09648e5",
              "treeSha": "093cf7ef96a2ced37d26b2a325bb66ac46ecd282"
            },
            "process": {
              "exitCode": 0,
              "signal": null,
              "spawnErrorCode": null,
              "outputLimitExceeded": false
            },
            "stdout": {
              "byteLength": 43,
              "sha256": "21405ece7b7ae267b0e6bd85c395a3b016eb30dd6c3feca7355c0f02b94f3c6d"
            },
            "stderr": {
              "byteLength": 0,
              "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
            },
            "status": "PASS",
            "identity": "1def7acd0a73e0e76e34376d55716922741cc30b0d625b640e17e204ad29e66b"
          },
          {
            "taskId": "T059",
            "gateId": "t059-scheduler-dag",
            "registeredArgv": [
              "node",
              "tests/phase4/scheduler/dag.test.mjs"
            ],
            "registeredArgvDigest": "0c5163143f7dc9c77fdd9ffbe8fd0766",
            "executedArgv": [
              "node",
              "tests/phase4/scheduler/dag.test.mjs"
            ],
            "executedArgvDigest": "0c5163143f7dc9c77fdd9ffbe8fd0766",
            "candidateIdentity": {
              "headSha": "8d7c945c9254b4223e088ad87cc98259d09648e5",
              "treeSha": "093cf7ef96a2ced37d26b2a325bb66ac46ecd282"
            },
            "process": {
              "exitCode": 0,
              "signal": null,
              "spawnErrorCode": null,
              "outputLimitExceeded": false
            },
            "stdout": {
              "byteLength": 27,
              "sha256": "9444c500097baa475306ac92b07ae25a13397157307fcd30a6f29cdf766873c7"
            },
            "stderr": {
              "byteLength": 0,
              "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
            },
            "status": "PASS",
            "identity": "8a7594c9d46d84883379b222be0d0c94793bf044c658d90084d4c566893d2da9"
          }
        ],
        "identity": "26690411677d7a47b3e3b8bbac61c541528a54ae48e79a45c5d065229c6ce606"
      },
      "independentShadowVerifier": {
        "schemaVersion": "hex-final-closure-checkpoint-shadow-evidence/v2",
        "status": "PASS",
        "candidateIdentity": {
          "headSha": "8d7c945c9254b4223e088ad87cc98259d09648e5",
          "treeSha": "093cf7ef96a2ced37d26b2a325bb66ac46ecd282"
        },
        "reports": [
          {
            "schemaVersion": "hex-final-closure-shadow-gate-evidence/v1",
            "status": "PASS",
            "taskId": "T051",
            "gateId": "t051-independent-verifier",
            "candidateIdentity": {
              "headSha": "8d7c945c9254b4223e088ad87cc98259d09648e5",
              "treeSha": "093cf7ef96a2ced37d26b2a325bb66ac46ecd282"
            },
            "authorityCommitSha": "9bce4fc12327c9a20368eb24021fc0ed525e2db0",
            "authorityOwnershipArtifact": {
              "path": "specs/005-analysis-final-closure/contracts/task-ownership.json",
              "gitBlobSha1": "07217ca3cb49bf6444e93f5021d2539b64f252f2",
              "sha256": "74b9c0f479ab8d420aa39b9fd6cb4cb75b60972849d8d4d4e097f882dacfefc6"
            },
            "registryEntryDigest": "f120c169be6ae3d781e7a2c0c33b3d28",
            "verifierArtifact": {
              "path": "tools/validation/final-closure/preflight.mjs",
              "gitBlobSha1": "244b7ac8c7a2d0480917491137d3db73378ece16",
              "sha256": "7cda1f185627d88efb85f7500da22d8220a5c120e282e6ab5a05257dbb82703a"
            },
            "verifierIdentity": "7cda1f185627d88efb85f7500da22d8220a5c120e282e6ab5a05257dbb82703a",
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
                "caseId": "ai-snapshot-binary-identity",
                "path": "tests/ai-scope-hardening.mjs",
                "gitBlobSha1": "4e6912d4e94b259f01b3367c7df8d359e2c08724",
                "sha256": "1ec4b027893b217058eda1505183e9d70e58035a32050643a1fcd6aaae10c49f"
              }
            ],
            "judgeIdentity": "5ef6c46abb516de3d8df77b5f1c020082b0091ecfee72f482fe7f885c0465cff",
            "observations": {
              "oracle": {
                "schemaVersion": "hex-final-closure-shadow-raw-observation/v1",
                "taskId": "T051",
                "gateId": "t051-independent-verifier",
                "observations": [
                  {
                    "caseId": "ai-snapshot-binary-identity",
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
                "taskId": "T051",
                "gateId": "t051-independent-verifier",
                "observations": [
                  {
                    "caseId": "ai-snapshot-binary-identity",
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
              "contractIdentity": "8ed019f13666f1913ae77d906a840016b38d50afe5ee9a301eb4355dfbe573f1",
              "caseCount": 1,
              "results": [
                {
                  "caseId": "ai-snapshot-binary-identity",
                  "disposition": "MATCH",
                  "oracleObservationSha256": "d6afc80f95c68f389ce9a6dbcf5379503c547c299008dd093b767fb33cf628b2",
                  "productObservationSha256": "d6afc80f95c68f389ce9a6dbcf5379503c547c299008dd093b767fb33cf628b2"
                }
              ],
              "counters": [
                {
                  "id": "falseExactNoAlias",
                  "observed": 0,
                  "denominator": 0
                },
                {
                  "id": "falseExactMustAlias",
                  "observed": 0,
                  "denominator": 0
                },
                {
                  "id": "falseExactIndirectTarget",
                  "observed": 0,
                  "denominator": 0
                },
                {
                  "id": "falseExactType",
                  "observed": 0,
                  "denominator": 0
                },
                {
                  "id": "semanticMismatch",
                  "observed": 0,
                  "denominator": 1
                },
                {
                  "id": "stalePublicationAfterCancel",
                  "observed": 0,
                  "denominator": 0
                },
                {
                  "id": "invalidWriterOutputAccepted",
                  "observed": 0,
                  "denominator": 0
                }
              ]
            },
            "evidenceIdentity": "7ff41c2ca53c33cb4a26787cde202e828574d3b95272bec732806af0084bb067"
          },
          {
            "schemaVersion": "hex-final-closure-shadow-gate-evidence/v1",
            "status": "PASS",
            "taskId": "T059",
            "gateId": "t059-independent-verifier",
            "candidateIdentity": {
              "headSha": "8d7c945c9254b4223e088ad87cc98259d09648e5",
              "treeSha": "093cf7ef96a2ced37d26b2a325bb66ac46ecd282"
            },
            "authorityCommitSha": "9bce4fc12327c9a20368eb24021fc0ed525e2db0",
            "authorityOwnershipArtifact": {
              "path": "specs/005-analysis-final-closure/contracts/task-ownership.json",
              "gitBlobSha1": "07217ca3cb49bf6444e93f5021d2539b64f252f2",
              "sha256": "74b9c0f479ab8d420aa39b9fd6cb4cb75b60972849d8d4d4e097f882dacfefc6"
            },
            "registryEntryDigest": "c809c95cf5c0dc4f1d2aa4d4340b4830",
            "verifierArtifact": {
              "path": "tools/validation/final-closure/preflight.mjs",
              "gitBlobSha1": "244b7ac8c7a2d0480917491137d3db73378ece16",
              "sha256": "7cda1f185627d88efb85f7500da22d8220a5c120e282e6ab5a05257dbb82703a"
            },
            "verifierIdentity": "7cda1f185627d88efb85f7500da22d8220a5c120e282e6ab5a05257dbb82703a",
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
                "caseId": "scheduler-id-authority",
                "path": "tests/phase4/scheduler/strict-authority-boundaries.test.mjs",
                "gitBlobSha1": "9247ac1793db1888f39f7a4a643623bb61e962d1",
                "sha256": "a21eadd97295b3822adb9fd259b962caed25d2b3a50aa6b88363ab990a7bc2e6"
              }
            ],
            "judgeIdentity": "a1e49d0ae7e8095e44178bb846ff2a071d74e134bdb412626996b9cd5ece7766",
            "observations": {
              "oracle": {
                "schemaVersion": "hex-final-closure-shadow-raw-observation/v1",
                "taskId": "T059",
                "gateId": "t059-independent-verifier",
                "observations": [
                  {
                    "caseId": "scheduler-id-authority",
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
                "taskId": "T059",
                "gateId": "t059-independent-verifier",
                "observations": [
                  {
                    "caseId": "scheduler-id-authority",
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
              "contractIdentity": "ed970160e0a0e32a1efa4cc0eec22392b2fdda86693e142327bb0fdafd601a26",
              "caseCount": 1,
              "results": [
                {
                  "caseId": "scheduler-id-authority",
                  "disposition": "MATCH",
                  "oracleObservationSha256": "544b6f8c3645429cd9f23c0c6660d6f516bd16db21f1f4f0f4ee45d2a981a5e6",
                  "productObservationSha256": "544b6f8c3645429cd9f23c0c6660d6f516bd16db21f1f4f0f4ee45d2a981a5e6"
                }
              ],
              "counters": [
                {
                  "id": "falseExactNoAlias",
                  "observed": 0,
                  "denominator": 0
                },
                {
                  "id": "falseExactMustAlias",
                  "observed": 0,
                  "denominator": 0
                },
                {
                  "id": "falseExactIndirectTarget",
                  "observed": 0,
                  "denominator": 0
                },
                {
                  "id": "falseExactType",
                  "observed": 0,
                  "denominator": 0
                },
                {
                  "id": "semanticMismatch",
                  "observed": 0,
                  "denominator": 1
                },
                {
                  "id": "stalePublicationAfterCancel",
                  "observed": 0,
                  "denominator": 1
                },
                {
                  "id": "invalidWriterOutputAccepted",
                  "observed": 0,
                  "denominator": 0
                }
              ]
            },
            "evidenceIdentity": "bff4570c731f26ebfba17e311e22ac4aefd75a3d4ff4353e83d246153baff67b"
          }
        ],
        "aggregate": {
          "schemaVersion": "hex-final-closure-checkpoint-shadow-aggregate/v1",
          "status": "PARTIAL_ZERO",
          "candidateIdentity": {
            "headSha": "8d7c945c9254b4223e088ad87cc98259d09648e5",
            "treeSha": "093cf7ef96a2ced37d26b2a325bb66ac46ecd282"
          },
          "reportEvidenceIdentities": [
            {
              "taskId": "T051",
              "gateId": "t051-independent-verifier",
              "evidenceIdentity": "7ff41c2ca53c33cb4a26787cde202e828574d3b95272bec732806af0084bb067",
              "proofIdentity": "978a37ce9e7d6ea98d09248c8212b2d4f1b590b69e0ad8085d6936e06a762b7a"
            },
            {
              "taskId": "T059",
              "gateId": "t059-independent-verifier",
              "evidenceIdentity": "bff4570c731f26ebfba17e311e22ac4aefd75a3d4ff4353e83d246153baff67b",
              "proofIdentity": "67bf8115ada1c236bb74c458e25ffd387cd240ab98c85fa954567d9c30269da4"
            }
          ],
          "reportSetIdentity": "482f832451d67c6539cad64e71a04562abc54f6a1ff9573b670c1e8468ee9c79",
          "counters": [
            {
              "id": "falseExactNoAlias",
              "observed": 0,
              "denominator": 0
            },
            {
              "id": "falseExactMustAlias",
              "observed": 0,
              "denominator": 0
            },
            {
              "id": "falseExactIndirectTarget",
              "observed": 0,
              "denominator": 0
            },
            {
              "id": "falseExactType",
              "observed": 0,
              "denominator": 0
            },
            {
              "id": "semanticMismatch",
              "observed": 0,
              "denominator": 2
            },
            {
              "id": "stalePublicationAfterCancel",
              "observed": 0,
              "denominator": 1
            },
            {
              "id": "invalidWriterOutputAccepted",
              "observed": 0,
              "denominator": 0
            }
          ],
          "identity": "066cb06da58bf005b12342415edcd7ba5db203ff1577ce5ef076bdb06fdf96dd"
        },
        "identity": "69d4e68de68da9e5036e795160ae3c4b9365e5c9b61a6e3b0bb2a91766b9c213"
      },
      "initialCandidateGateDigest": "63fb512b688c281f862740411f20df72",
      "cumulativeInventory": {
        "baseSha": "7012c4cc4f0d5c0d8a7ca44c6c5c1edcb080aba1",
        "stableDigest": "551499d607903c0215fd1fbaba5beb19",
        "pathCount": 47
      }
    }
  ]
}
```
