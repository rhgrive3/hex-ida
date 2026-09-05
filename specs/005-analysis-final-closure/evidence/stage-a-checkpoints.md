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
    },
    {
      "sequence": 3,
      "acceptedTaskId": "T052",
      "integrationParentSha": "eb3f37b0cadaec5724688d109f336d29f6a06889",
      "mainReconciliation": {
        "schemaVersion": "hex-final-closure-main-reconciliation/v1",
        "mode": "NOOP",
        "previousEvidenceSha": "eb3f37b0cadaec5724688d109f336d29f6a06889",
        "currentMainSha": "eef6223fc08d90ef3e86b5eb8e4a56c06f04af84",
        "integrationHeadSha": "eb3f37b0cadaec5724688d109f336d29f6a06889",
        "integrationHeadTreeSha": "b154700ce0f355b6d54767f1119495e6b96a92e6",
        "autoMergeTreeSha": null,
        "adjustmentPaths": [],
        "adjustmentStableDigest": "09612b07b5ecb5a5359f19cb0456e970"
      },
      "componentHeadSha": "0a521b282c6aa93afc94e0dfbfe701e705ccdf2a",
      "candidateMergeTreeSha": "deea1e4be6a26f69b669e9c15b6d15d49ad8586b",
      "acceptedMerge": {
        "commitSha": "6ee082bff33f162ea512267561c230a402e3382e",
        "treeSha": "deea1e4be6a26f69b669e9c15b6d15d49ad8586b"
      },
      "checkpointProduct": {
        "commitSha": "7d0b5c739cfc9d28443edd1af11105563e5b5ff6",
        "treeSha": "deea1e4be6a26f69b669e9c15b6d15d49ad8586b"
      },
      "integrationReconciliation": {
        "schemaVersion": "hex-final-closure-product-reconciliation/v1",
        "ownerTaskId": "T049",
        "mergeCommitSha": "6ee082bff33f162ea512267561c230a402e3382e",
        "productCommitSha": "7d0b5c739cfc9d28443edd1af11105563e5b5ff6",
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
          "headSha": "7d0b5c739cfc9d28443edd1af11105563e5b5ff6",
          "treeSha": "deea1e4be6a26f69b669e9c15b6d15d49ad8586b"
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
            "gitBlobSha1": "2b79a3f1722f6c3f2ebce0b7115dbf7833b5073c",
            "sha256": "2dba3ecbec974eada7b08a4c0f090b2da2a6112384d1f7c70396899ea0051783"
          },
          {
            "path": "userscript/release-version.json",
            "gitBlobSha1": "fa7099b7676a992855a74721daefc54042cc4750",
            "sha256": "0b6155df2874c93a28fbfa836a46c9797384dde2d6a85560f4e6b53aaf8e01ed"
          }
        ],
        "sourceIdentity": "917cf1a9c083139d07c54f8727a25bff8e95e0360855be34ca0057c2c557cb25",
        "buildIdentity": "0b332a2b0822f723303a9c38df2155bdb4ce980d8db3c7d427fdf988c90528d0",
        "artifactIdentity": "1eb910f2363784ad4633c4c1bc1a17aeaf43b895a03798d67b1a3f69cb925555",
        "releaseIdentity": "041b7008efd4ef074f868c87f448aff1894d4f5a4db7394aaa46752d4124737a",
        "buildId": "c66c0b76c27366ce34c113f9",
        "releaseSerial": 2322242133
      },
      "rollingProductGates": {
        "schemaVersion": "hex-final-closure-checkpoint-rolling-evidence/v2",
        "taskIds": [
          "T051",
          "T059",
          "T052"
        ],
        "status": "PASS",
        "candidateIdentity": {
          "headSha": "7d0b5c739cfc9d28443edd1af11105563e5b5ff6",
          "treeSha": "deea1e4be6a26f69b669e9c15b6d15d49ad8586b"
        },
        "registry": {
          "path": "specs/005-analysis-final-closure/contracts/task-ownership.json",
          "sourceCommitSha": "7d0b5c739cfc9d28443edd1af11105563e5b5ff6",
          "sourceTreeSha": "deea1e4be6a26f69b669e9c15b6d15d49ad8586b",
          "gitBlobSha1": "599f4f441b23e521183f41c0860f3f2b8560b652",
          "sha256": "ad3f075f12f54ae9babde16bc5a02a3ad86f16e9578bcab8ef84e96d05f0d80f",
          "initialCandidateGateDigest": "63fb512b688c281f862740411f20df72",
          "rollingSetDigest": "822d6d2dabb465505d67b8356e3cf975"
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
              "headSha": "7d0b5c739cfc9d28443edd1af11105563e5b5ff6",
              "treeSha": "deea1e4be6a26f69b669e9c15b6d15d49ad8586b"
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
            "identity": "e844d86a072b5ddf7b4b264c9fe5b26ea716d64fa74bfd7895af659789588352"
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
              "headSha": "7d0b5c739cfc9d28443edd1af11105563e5b5ff6",
              "treeSha": "deea1e4be6a26f69b669e9c15b6d15d49ad8586b"
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
            "identity": "7b6d96cac230f1334bd0880cd22738a39f29625e2003a734a8de82c4ab13fb65"
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
              "headSha": "7d0b5c739cfc9d28443edd1af11105563e5b5ff6",
              "treeSha": "deea1e4be6a26f69b669e9c15b6d15d49ad8586b"
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
            "identity": "fd50b6c486d5c9b8ddd79e8cfdb2717bc56574d9941fd8073669495e41b4f7f3"
          },
          {
            "taskId": "T052",
            "gateId": "t052-remote-authority",
            "registeredArgv": [
              "node",
              "tests/phase12/collaboration/remote-authority-identity-3619.test.mjs"
            ],
            "registeredArgvDigest": "c2df6272b3793eb58623de807bb0c9f8",
            "executedArgv": [
              "node",
              "tests/phase12/collaboration/remote-authority-identity-3619.test.mjs"
            ],
            "executedArgvDigest": "c2df6272b3793eb58623de807bb0c9f8",
            "candidateIdentity": {
              "headSha": "7d0b5c739cfc9d28443edd1af11105563e5b5ff6",
              "treeSha": "deea1e4be6a26f69b669e9c15b6d15d49ad8586b"
            },
            "process": {
              "exitCode": 0,
              "signal": null,
              "spawnErrorCode": null,
              "outputLimitExceeded": false
            },
            "stdout": {
              "byteLength": 69,
              "sha256": "3887e3b173004cc7d01fa931a8ebe69f24848b070cc1ecceef889224ae6f5d93"
            },
            "stderr": {
              "byteLength": 0,
              "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
            },
            "status": "PASS",
            "identity": "427777441a19bdf67d9a2af966bb6d4f74d38e9456bf514690d48cca796d2aea"
          },
          {
            "taskId": "T052",
            "gateId": "t052-remote-integrity",
            "registeredArgv": [
              "node",
              "tests/phase12/collaboration/remote-integrity.test.mjs"
            ],
            "registeredArgvDigest": "3e6ffa211964817256b6a78f98bf81e7",
            "executedArgv": [
              "node",
              "tests/phase12/collaboration/remote-integrity.test.mjs"
            ],
            "executedArgvDigest": "3e6ffa211964817256b6a78f98bf81e7",
            "candidateIdentity": {
              "headSha": "7d0b5c739cfc9d28443edd1af11105563e5b5ff6",
              "treeSha": "deea1e4be6a26f69b669e9c15b6d15d49ad8586b"
            },
            "process": {
              "exitCode": 0,
              "signal": null,
              "spawnErrorCode": null,
              "outputLimitExceeded": false
            },
            "stdout": {
              "byteLength": 58,
              "sha256": "4a295d8789cd9ab854bb191ccdb2bcbf19276e1f1a2769c8b29a525fb2036165"
            },
            "stderr": {
              "byteLength": 0,
              "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
            },
            "status": "PASS",
            "identity": "5f6600c7c32aeded876c22979031809def3c629b0b9c03d782f2b6e6defbdf1f"
          },
          {
            "taskId": "T052",
            "gateId": "t052-action-canonical",
            "registeredArgv": [
              "node",
              "tests/phase12/collaboration/action-canonical-3546.test.mjs"
            ],
            "registeredArgvDigest": "f7aa1b0896aab33af5fd5072e093acb5",
            "executedArgv": [
              "node",
              "tests/phase12/collaboration/action-canonical-3546.test.mjs"
            ],
            "executedArgvDigest": "f7aa1b0896aab33af5fd5072e093acb5",
            "candidateIdentity": {
              "headSha": "7d0b5c739cfc9d28443edd1af11105563e5b5ff6",
              "treeSha": "deea1e4be6a26f69b669e9c15b6d15d49ad8586b"
            },
            "process": {
              "exitCode": 0,
              "signal": null,
              "spawnErrorCode": null,
              "outputLimitExceeded": false
            },
            "stdout": {
              "byteLength": 52,
              "sha256": "41763e7a9d10003b5eaa82c55ab24e721efdfd9d94a337d0969ce089c6a55bc0"
            },
            "stderr": {
              "byteLength": 0,
              "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
            },
            "status": "PASS",
            "identity": "6f6cb8299038fd3685ff98ccedd58f5cf2e800903fec75a89ce7694f7197e2c0"
          },
          {
            "taskId": "T052",
            "gateId": "t052-pending-drain",
            "registeredArgv": [
              "node",
              "tests/phase12/collaboration/issues-5397-5399-5467-5497.test.mjs"
            ],
            "registeredArgvDigest": "08a9dc17c58b27bd1cfdb3b9c5813830",
            "executedArgv": [
              "node",
              "tests/phase12/collaboration/issues-5397-5399-5467-5497.test.mjs"
            ],
            "executedArgvDigest": "08a9dc17c58b27bd1cfdb3b9c5813830",
            "candidateIdentity": {
              "headSha": "7d0b5c739cfc9d28443edd1af11105563e5b5ff6",
              "treeSha": "deea1e4be6a26f69b669e9c15b6d15d49ad8586b"
            },
            "process": {
              "exitCode": 0,
              "signal": null,
              "spawnErrorCode": null,
              "outputLimitExceeded": false
            },
            "stdout": {
              "byteLength": 1513,
              "sha256": "910a302ed27ff47f1c1ff01a9f293a2571b62609953c96761d0d8d8eeef9e45f"
            },
            "stderr": {
              "byteLength": 0,
              "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
            },
            "status": "PASS",
            "identity": "61f674bbb34e94c9c4e0b41626469e12a6b66ce352937fdd025879555e2fcbaa"
          },
          {
            "taskId": "T052",
            "gateId": "t052-trust-boundary",
            "registeredArgv": [
              "node",
              "tests/phase12/adversarial/trust-boundaries.test.mjs"
            ],
            "registeredArgvDigest": "b81b3098444b1e00516b15b1a158059d",
            "executedArgv": [
              "node",
              "tests/phase12/adversarial/trust-boundaries.test.mjs"
            ],
            "executedArgvDigest": "b81b3098444b1e00516b15b1a158059d",
            "candidateIdentity": {
              "headSha": "7d0b5c739cfc9d28443edd1af11105563e5b5ff6",
              "treeSha": "deea1e4be6a26f69b669e9c15b6d15d49ad8586b"
            },
            "process": {
              "exitCode": 0,
              "signal": null,
              "spawnErrorCode": null,
              "outputLimitExceeded": false
            },
            "stdout": {
              "byteLength": 60,
              "sha256": "597f6729a054df1813e18ad41cca8202c826cb548d61ba8886f3a9f39e7b266b"
            },
            "stderr": {
              "byteLength": 0,
              "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
            },
            "status": "PASS",
            "identity": "9f631a2e8736f68347ba0b661b2ff6341e5fef2fcbfae97236a4316c8bc7568b"
          },
          {
            "taskId": "T052",
            "gateId": "t052-facade",
            "registeredArgv": [
              "node",
              "tests/phase12/integration/facade.test.mjs"
            ],
            "registeredArgvDigest": "de6e7413b5112a7f0d6b1d00166c103e",
            "executedArgv": [
              "node",
              "tests/phase12/integration/facade.test.mjs"
            ],
            "executedArgvDigest": "de6e7413b5112a7f0d6b1d00166c103e",
            "candidateIdentity": {
              "headSha": "7d0b5c739cfc9d28443edd1af11105563e5b5ff6",
              "treeSha": "deea1e4be6a26f69b669e9c15b6d15d49ad8586b"
            },
            "process": {
              "exitCode": 0,
              "signal": null,
              "spawnErrorCode": null,
              "outputLimitExceeded": false
            },
            "stdout": {
              "byteLength": 60,
              "sha256": "c91c651e0512b51ac3c571b705a9958ed7b14abf0df021858d83259b9f6cf158"
            },
            "stderr": {
              "byteLength": 0,
              "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
            },
            "status": "PASS",
            "identity": "259965803805a8814d8f8f4a786ded79c0dada9720659dae148aa7fb6c9d886c"
          }
        ],
        "identity": "cee38f00ba330b79ea0d12c70862d9a40e63d7e86e937f010e955d1a49bfd116"
      },
      "independentShadowVerifier": {
        "schemaVersion": "hex-final-closure-checkpoint-shadow-evidence/v2",
        "status": "PASS",
        "candidateIdentity": {
          "headSha": "7d0b5c739cfc9d28443edd1af11105563e5b5ff6",
          "treeSha": "deea1e4be6a26f69b669e9c15b6d15d49ad8586b"
        },
        "reports": [
          {
            "schemaVersion": "hex-final-closure-shadow-gate-evidence/v1",
            "status": "PASS",
            "taskId": "T051",
            "gateId": "t051-independent-verifier",
            "candidateIdentity": {
              "headSha": "7d0b5c739cfc9d28443edd1af11105563e5b5ff6",
              "treeSha": "deea1e4be6a26f69b669e9c15b6d15d49ad8586b"
            },
            "authorityCommitSha": "6ee082bff33f162ea512267561c230a402e3382e",
            "authorityOwnershipArtifact": {
              "path": "specs/005-analysis-final-closure/contracts/task-ownership.json",
              "gitBlobSha1": "599f4f441b23e521183f41c0860f3f2b8560b652",
              "sha256": "ad3f075f12f54ae9babde16bc5a02a3ad86f16e9578bcab8ef84e96d05f0d80f"
            },
            "registryEntryDigest": "f120c169be6ae3d781e7a2c0c33b3d28",
            "verifierArtifact": {
              "path": "tools/validation/final-closure/preflight.mjs",
              "gitBlobSha1": "54737922f0298fae20188ee5715a76492f2123f9",
              "sha256": "8cc6828d48f3650caf504eba44a1c47b697c17487b605da136cfa7347aa1c851"
            },
            "verifierIdentity": "8cc6828d48f3650caf504eba44a1c47b697c17487b605da136cfa7347aa1c851",
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
            "evidenceIdentity": "6509bf4ca1f005d8022e7efab5e1527d216570cd47b6c189061fdc923313e34c"
          },
          {
            "schemaVersion": "hex-final-closure-shadow-gate-evidence/v1",
            "status": "PASS",
            "taskId": "T059",
            "gateId": "t059-independent-verifier",
            "candidateIdentity": {
              "headSha": "7d0b5c739cfc9d28443edd1af11105563e5b5ff6",
              "treeSha": "deea1e4be6a26f69b669e9c15b6d15d49ad8586b"
            },
            "authorityCommitSha": "6ee082bff33f162ea512267561c230a402e3382e",
            "authorityOwnershipArtifact": {
              "path": "specs/005-analysis-final-closure/contracts/task-ownership.json",
              "gitBlobSha1": "599f4f441b23e521183f41c0860f3f2b8560b652",
              "sha256": "ad3f075f12f54ae9babde16bc5a02a3ad86f16e9578bcab8ef84e96d05f0d80f"
            },
            "registryEntryDigest": "c809c95cf5c0dc4f1d2aa4d4340b4830",
            "verifierArtifact": {
              "path": "tools/validation/final-closure/preflight.mjs",
              "gitBlobSha1": "54737922f0298fae20188ee5715a76492f2123f9",
              "sha256": "8cc6828d48f3650caf504eba44a1c47b697c17487b605da136cfa7347aa1c851"
            },
            "verifierIdentity": "8cc6828d48f3650caf504eba44a1c47b697c17487b605da136cfa7347aa1c851",
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
            "evidenceIdentity": "adbb807c80aedc408ac8c7c4f2efaf1821914217543aed19f81d7b9500e73b9c"
          },
          {
            "schemaVersion": "hex-final-closure-shadow-gate-evidence/v1",
            "status": "PASS",
            "taskId": "T052",
            "gateId": "t052-independent-verifier",
            "candidateIdentity": {
              "headSha": "7d0b5c739cfc9d28443edd1af11105563e5b5ff6",
              "treeSha": "deea1e4be6a26f69b669e9c15b6d15d49ad8586b"
            },
            "authorityCommitSha": "6ee082bff33f162ea512267561c230a402e3382e",
            "authorityOwnershipArtifact": {
              "path": "specs/005-analysis-final-closure/contracts/task-ownership.json",
              "gitBlobSha1": "599f4f441b23e521183f41c0860f3f2b8560b652",
              "sha256": "ad3f075f12f54ae9babde16bc5a02a3ad86f16e9578bcab8ef84e96d05f0d80f"
            },
            "registryEntryDigest": "870aa3ec026061dcc12c1ce2f5e041bb",
            "verifierArtifact": {
              "path": "tools/validation/final-closure/preflight.mjs",
              "gitBlobSha1": "54737922f0298fae20188ee5715a76492f2123f9",
              "sha256": "8cc6828d48f3650caf504eba44a1c47b697c17487b605da136cfa7347aa1c851"
            },
            "verifierIdentity": "8cc6828d48f3650caf504eba44a1c47b697c17487b605da136cfa7347aa1c851",
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
                "caseId": "collaboration-remote-authority-identity",
                "path": "tests/phase12/collaboration/issues-5397-5399-5467-5497.test.mjs",
                "gitBlobSha1": "55112274bf27b93e376390258e0b4bf934fb6db2",
                "sha256": "3258d724db529650fa1b31b0e765353e39485a48ce8ba64cf2b32c90b8a93ac6"
              }
            ],
            "judgeIdentity": "175a307b54cb82d037cd8ed40838f8ba6ac185812597797fbbbad763c59befa2",
            "observations": {
              "oracle": {
                "schemaVersion": "hex-final-closure-shadow-raw-observation/v1",
                "taskId": "T052",
                "gateId": "t052-independent-verifier",
                "observations": [
                  {
                    "caseId": "collaboration-remote-authority-identity",
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
                "taskId": "T052",
                "gateId": "t052-independent-verifier",
                "observations": [
                  {
                    "caseId": "collaboration-remote-authority-identity",
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
              "contractIdentity": "085f65f4ee1c493efb736ec8680fef8b8cb3b80dfc1a34d37eacf97828d14c76",
              "caseCount": 1,
              "results": [
                {
                  "caseId": "collaboration-remote-authority-identity",
                  "disposition": "MATCH",
                  "oracleObservationSha256": "10c9b3a5de90d5cf7d01b78c5a627375cbdbce6dacfbc76cddc48e8c26c187b6",
                  "productObservationSha256": "10c9b3a5de90d5cf7d01b78c5a627375cbdbce6dacfbc76cddc48e8c26c187b6"
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
            "evidenceIdentity": "7f1e621d88ddc5ce769102d142f99fa90e0c04d09ecac867e1bc33800f5317ee"
          }
        ],
        "aggregate": {
          "schemaVersion": "hex-final-closure-checkpoint-shadow-aggregate/v1",
          "status": "PARTIAL_ZERO",
          "candidateIdentity": {
            "headSha": "7d0b5c739cfc9d28443edd1af11105563e5b5ff6",
            "treeSha": "deea1e4be6a26f69b669e9c15b6d15d49ad8586b"
          },
          "reportEvidenceIdentities": [
            {
              "taskId": "T051",
              "gateId": "t051-independent-verifier",
              "evidenceIdentity": "6509bf4ca1f005d8022e7efab5e1527d216570cd47b6c189061fdc923313e34c",
              "proofIdentity": "978a37ce9e7d6ea98d09248c8212b2d4f1b590b69e0ad8085d6936e06a762b7a"
            },
            {
              "taskId": "T052",
              "gateId": "t052-independent-verifier",
              "evidenceIdentity": "7f1e621d88ddc5ce769102d142f99fa90e0c04d09ecac867e1bc33800f5317ee",
              "proofIdentity": "49e9099d3a1ee867b6da983b77352450ecbea67155a40f855b3fda530e6ddd02"
            },
            {
              "taskId": "T059",
              "gateId": "t059-independent-verifier",
              "evidenceIdentity": "adbb807c80aedc408ac8c7c4f2efaf1821914217543aed19f81d7b9500e73b9c",
              "proofIdentity": "67bf8115ada1c236bb74c458e25ffd387cd240ab98c85fa954567d9c30269da4"
            }
          ],
          "reportSetIdentity": "b615316e7a3a9f1da38a3414a4714e73a7bed377cc3d76b758568818dcdece3c",
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
              "denominator": 3
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
          "identity": "598d7e8adcf041ebc4caf966398eab7a953a3096daf17679e725b0d7852f4733"
        },
        "identity": "ac942185fcc4ca45d44a5dcbcbfcbeef99bc30bf9c07dde2faa9e7c192eee63c"
      },
      "initialCandidateGateDigest": "63fb512b688c281f862740411f20df72",
      "cumulativeInventory": {
        "baseSha": "eef6223fc08d90ef3e86b5eb8e4a56c06f04af84",
        "stableDigest": "ca0daf90dfde5d165352eeabe890dd23",
        "pathCount": 53
      }
    },
    {
      "sequence": 4,
      "acceptedTaskId": "T057",
      "integrationParentSha": "bfc363047c1f0099499f2b4d72cc9a871e3600e9",
      "mainReconciliation": {
        "schemaVersion": "hex-final-closure-main-reconciliation/v1",
        "mode": "NOOP",
        "previousEvidenceSha": "bfc363047c1f0099499f2b4d72cc9a871e3600e9",
        "currentMainSha": "eef6223fc08d90ef3e86b5eb8e4a56c06f04af84",
        "integrationHeadSha": "bfc363047c1f0099499f2b4d72cc9a871e3600e9",
        "integrationHeadTreeSha": "a1df3e517154b5b3b3cb53acf54eded3f37efef0",
        "autoMergeTreeSha": null,
        "adjustmentPaths": [],
        "adjustmentStableDigest": "09612b07b5ecb5a5359f19cb0456e970"
      },
      "componentHeadSha": "8cca5b359a434fa11d18c60684fb4906288c2a15",
      "candidateMergeTreeSha": "d7c473e0740c6b273d211e338819d2c709e31194",
      "acceptedMerge": {
        "commitSha": "40421f4ce99e804b5638e1c473b6e8e758796add",
        "treeSha": "d7c473e0740c6b273d211e338819d2c709e31194"
      },
      "checkpointProduct": {
        "commitSha": "f19bb7b03c3c9f0581f3a536588e50c6851a5775",
        "treeSha": "d7c473e0740c6b273d211e338819d2c709e31194"
      },
      "integrationReconciliation": {
        "schemaVersion": "hex-final-closure-product-reconciliation/v1",
        "ownerTaskId": "T049",
        "mergeCommitSha": "40421f4ce99e804b5638e1c473b6e8e758796add",
        "productCommitSha": "f19bb7b03c3c9f0581f3a536588e50c6851a5775",
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
          "headSha": "f19bb7b03c3c9f0581f3a536588e50c6851a5775",
          "treeSha": "d7c473e0740c6b273d211e338819d2c709e31194"
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
            "gitBlobSha1": "2b79a3f1722f6c3f2ebce0b7115dbf7833b5073c",
            "sha256": "2dba3ecbec974eada7b08a4c0f090b2da2a6112384d1f7c70396899ea0051783"
          },
          {
            "path": "userscript/release-version.json",
            "gitBlobSha1": "fa7099b7676a992855a74721daefc54042cc4750",
            "sha256": "0b6155df2874c93a28fbfa836a46c9797384dde2d6a85560f4e6b53aaf8e01ed"
          }
        ],
        "sourceIdentity": "c71c1d6afff0cb397e7deb6483ab75e4d8bc7366bab04ff46db8b12c96692e83",
        "buildIdentity": "0b332a2b0822f723303a9c38df2155bdb4ce980d8db3c7d427fdf988c90528d0",
        "artifactIdentity": "1eb910f2363784ad4633c4c1bc1a17aeaf43b895a03798d67b1a3f69cb925555",
        "releaseIdentity": "041b7008efd4ef074f868c87f448aff1894d4f5a4db7394aaa46752d4124737a",
        "buildId": "c66c0b76c27366ce34c113f9",
        "releaseSerial": 2322242133
      },
      "rollingProductGates": {
        "schemaVersion": "hex-final-closure-checkpoint-rolling-evidence/v2",
        "taskIds": [
          "T051",
          "T059",
          "T052",
          "T057"
        ],
        "status": "PASS",
        "candidateIdentity": {
          "headSha": "f19bb7b03c3c9f0581f3a536588e50c6851a5775",
          "treeSha": "d7c473e0740c6b273d211e338819d2c709e31194"
        },
        "registry": {
          "path": "specs/005-analysis-final-closure/contracts/task-ownership.json",
          "sourceCommitSha": "f19bb7b03c3c9f0581f3a536588e50c6851a5775",
          "sourceTreeSha": "d7c473e0740c6b273d211e338819d2c709e31194",
          "gitBlobSha1": "599f4f441b23e521183f41c0860f3f2b8560b652",
          "sha256": "ad3f075f12f54ae9babde16bc5a02a3ad86f16e9578bcab8ef84e96d05f0d80f",
          "initialCandidateGateDigest": "63fb512b688c281f862740411f20df72",
          "rollingSetDigest": "7ec895078a1698449f7529c4b0bf8ca5"
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
              "headSha": "f19bb7b03c3c9f0581f3a536588e50c6851a5775",
              "treeSha": "d7c473e0740c6b273d211e338819d2c709e31194"
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
            "identity": "adcc02e7aed234533b5974b110e60919313134319c1d7b3f7eb0eb18d193affd"
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
              "headSha": "f19bb7b03c3c9f0581f3a536588e50c6851a5775",
              "treeSha": "d7c473e0740c6b273d211e338819d2c709e31194"
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
            "identity": "0bf1fedaf8b246bdc04b1ec3c6822e46afc42cb689d52dbb0e569fa423ef2418"
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
              "headSha": "f19bb7b03c3c9f0581f3a536588e50c6851a5775",
              "treeSha": "d7c473e0740c6b273d211e338819d2c709e31194"
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
            "identity": "af9a663597b5902b916ecb41aa35ff90a7b23ee805d755576d7cf76d182af3cc"
          },
          {
            "taskId": "T052",
            "gateId": "t052-remote-authority",
            "registeredArgv": [
              "node",
              "tests/phase12/collaboration/remote-authority-identity-3619.test.mjs"
            ],
            "registeredArgvDigest": "c2df6272b3793eb58623de807bb0c9f8",
            "executedArgv": [
              "node",
              "tests/phase12/collaboration/remote-authority-identity-3619.test.mjs"
            ],
            "executedArgvDigest": "c2df6272b3793eb58623de807bb0c9f8",
            "candidateIdentity": {
              "headSha": "f19bb7b03c3c9f0581f3a536588e50c6851a5775",
              "treeSha": "d7c473e0740c6b273d211e338819d2c709e31194"
            },
            "process": {
              "exitCode": 0,
              "signal": null,
              "spawnErrorCode": null,
              "outputLimitExceeded": false
            },
            "stdout": {
              "byteLength": 69,
              "sha256": "3887e3b173004cc7d01fa931a8ebe69f24848b070cc1ecceef889224ae6f5d93"
            },
            "stderr": {
              "byteLength": 0,
              "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
            },
            "status": "PASS",
            "identity": "e2323161fdf016e8bdda6ab8c66e6003aa746581c62824012322111c863e0d54"
          },
          {
            "taskId": "T052",
            "gateId": "t052-remote-integrity",
            "registeredArgv": [
              "node",
              "tests/phase12/collaboration/remote-integrity.test.mjs"
            ],
            "registeredArgvDigest": "3e6ffa211964817256b6a78f98bf81e7",
            "executedArgv": [
              "node",
              "tests/phase12/collaboration/remote-integrity.test.mjs"
            ],
            "executedArgvDigest": "3e6ffa211964817256b6a78f98bf81e7",
            "candidateIdentity": {
              "headSha": "f19bb7b03c3c9f0581f3a536588e50c6851a5775",
              "treeSha": "d7c473e0740c6b273d211e338819d2c709e31194"
            },
            "process": {
              "exitCode": 0,
              "signal": null,
              "spawnErrorCode": null,
              "outputLimitExceeded": false
            },
            "stdout": {
              "byteLength": 58,
              "sha256": "4a295d8789cd9ab854bb191ccdb2bcbf19276e1f1a2769c8b29a525fb2036165"
            },
            "stderr": {
              "byteLength": 0,
              "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
            },
            "status": "PASS",
            "identity": "d28202aa7e978290c6128715c024d3384e937b9b2f1c9752e0636b26f7aaa037"
          },
          {
            "taskId": "T052",
            "gateId": "t052-action-canonical",
            "registeredArgv": [
              "node",
              "tests/phase12/collaboration/action-canonical-3546.test.mjs"
            ],
            "registeredArgvDigest": "f7aa1b0896aab33af5fd5072e093acb5",
            "executedArgv": [
              "node",
              "tests/phase12/collaboration/action-canonical-3546.test.mjs"
            ],
            "executedArgvDigest": "f7aa1b0896aab33af5fd5072e093acb5",
            "candidateIdentity": {
              "headSha": "f19bb7b03c3c9f0581f3a536588e50c6851a5775",
              "treeSha": "d7c473e0740c6b273d211e338819d2c709e31194"
            },
            "process": {
              "exitCode": 0,
              "signal": null,
              "spawnErrorCode": null,
              "outputLimitExceeded": false
            },
            "stdout": {
              "byteLength": 52,
              "sha256": "41763e7a9d10003b5eaa82c55ab24e721efdfd9d94a337d0969ce089c6a55bc0"
            },
            "stderr": {
              "byteLength": 0,
              "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
            },
            "status": "PASS",
            "identity": "8b465ff4342f521411f976dd49d9ca2edff5bb27143ef9ce7a42286049a41c19"
          },
          {
            "taskId": "T052",
            "gateId": "t052-pending-drain",
            "registeredArgv": [
              "node",
              "tests/phase12/collaboration/issues-5397-5399-5467-5497.test.mjs"
            ],
            "registeredArgvDigest": "08a9dc17c58b27bd1cfdb3b9c5813830",
            "executedArgv": [
              "node",
              "tests/phase12/collaboration/issues-5397-5399-5467-5497.test.mjs"
            ],
            "executedArgvDigest": "08a9dc17c58b27bd1cfdb3b9c5813830",
            "candidateIdentity": {
              "headSha": "f19bb7b03c3c9f0581f3a536588e50c6851a5775",
              "treeSha": "d7c473e0740c6b273d211e338819d2c709e31194"
            },
            "process": {
              "exitCode": 0,
              "signal": null,
              "spawnErrorCode": null,
              "outputLimitExceeded": false
            },
            "stdout": {
              "byteLength": 1512,
              "sha256": "4187ce9a1dfd4b2f6aaa52f12dffe3c7a1cf21fbe887cb9c79429ae79c9b2be9"
            },
            "stderr": {
              "byteLength": 0,
              "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
            },
            "status": "PASS",
            "identity": "d91917be96e085c3e7f874a997d9bf29c292ed5b2e29915cec114fa9c13f8ff5"
          },
          {
            "taskId": "T052",
            "gateId": "t052-trust-boundary",
            "registeredArgv": [
              "node",
              "tests/phase12/adversarial/trust-boundaries.test.mjs"
            ],
            "registeredArgvDigest": "b81b3098444b1e00516b15b1a158059d",
            "executedArgv": [
              "node",
              "tests/phase12/adversarial/trust-boundaries.test.mjs"
            ],
            "executedArgvDigest": "b81b3098444b1e00516b15b1a158059d",
            "candidateIdentity": {
              "headSha": "f19bb7b03c3c9f0581f3a536588e50c6851a5775",
              "treeSha": "d7c473e0740c6b273d211e338819d2c709e31194"
            },
            "process": {
              "exitCode": 0,
              "signal": null,
              "spawnErrorCode": null,
              "outputLimitExceeded": false
            },
            "stdout": {
              "byteLength": 60,
              "sha256": "597f6729a054df1813e18ad41cca8202c826cb548d61ba8886f3a9f39e7b266b"
            },
            "stderr": {
              "byteLength": 0,
              "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
            },
            "status": "PASS",
            "identity": "20b1cd16c57842b99cfa579ed1a725d41a6d16a68175fb0dcd4d766b5caeaa37"
          },
          {
            "taskId": "T052",
            "gateId": "t052-facade",
            "registeredArgv": [
              "node",
              "tests/phase12/integration/facade.test.mjs"
            ],
            "registeredArgvDigest": "de6e7413b5112a7f0d6b1d00166c103e",
            "executedArgv": [
              "node",
              "tests/phase12/integration/facade.test.mjs"
            ],
            "executedArgvDigest": "de6e7413b5112a7f0d6b1d00166c103e",
            "candidateIdentity": {
              "headSha": "f19bb7b03c3c9f0581f3a536588e50c6851a5775",
              "treeSha": "d7c473e0740c6b273d211e338819d2c709e31194"
            },
            "process": {
              "exitCode": 0,
              "signal": null,
              "spawnErrorCode": null,
              "outputLimitExceeded": false
            },
            "stdout": {
              "byteLength": 60,
              "sha256": "c91c651e0512b51ac3c571b705a9958ed7b14abf0df021858d83259b9f6cf158"
            },
            "stderr": {
              "byteLength": 0,
              "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
            },
            "status": "PASS",
            "identity": "c7481ad5913f5bcf6bb9b0c6d9d9fcb1ecdeab723234fddb76bc5f7f73551105"
          },
          {
            "taskId": "T057",
            "gateId": "t057-phase11-suite",
            "registeredArgv": [
              "npm",
              "run",
              "phase11:test"
            ],
            "registeredArgvDigest": "281f8a0c682a81f8f0451fe7ae5230c1",
            "executedArgv": [
              "npm",
              "run",
              "phase11:test"
            ],
            "executedArgvDigest": "281f8a0c682a81f8f0451fe7ae5230c1",
            "candidateIdentity": {
              "headSha": "f19bb7b03c3c9f0581f3a536588e50c6851a5775",
              "treeSha": "d7c473e0740c6b273d211e338819d2c709e31194"
            },
            "process": {
              "exitCode": 0,
              "signal": null,
              "spawnErrorCode": null,
              "outputLimitExceeded": false
            },
            "stdout": {
              "byteLength": 6336,
              "sha256": "8da0e718c48bb456c07a4f1ff7a6c56ec759a2456e23ecb0126a2c7ccf27a72a"
            },
            "stderr": {
              "byteLength": 0,
              "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
            },
            "status": "PASS",
            "identity": "d60748f8983ab0c9a353a72fa88ed79df6a1df7b1fe35eaba2a2922953f4ecde"
          }
        ],
        "identity": "7cad4d41757715f3197eb4e2a9d786f096aba70e92246187a6444917cfffcc7b"
      },
      "independentShadowVerifier": {
        "schemaVersion": "hex-final-closure-checkpoint-shadow-evidence/v2",
        "status": "PASS",
        "candidateIdentity": {
          "headSha": "f19bb7b03c3c9f0581f3a536588e50c6851a5775",
          "treeSha": "d7c473e0740c6b273d211e338819d2c709e31194"
        },
        "reports": [
          {
            "schemaVersion": "hex-final-closure-shadow-gate-evidence/v1",
            "status": "PASS",
            "taskId": "T051",
            "gateId": "t051-independent-verifier",
            "candidateIdentity": {
              "headSha": "f19bb7b03c3c9f0581f3a536588e50c6851a5775",
              "treeSha": "d7c473e0740c6b273d211e338819d2c709e31194"
            },
            "authorityCommitSha": "40421f4ce99e804b5638e1c473b6e8e758796add",
            "authorityOwnershipArtifact": {
              "path": "specs/005-analysis-final-closure/contracts/task-ownership.json",
              "gitBlobSha1": "599f4f441b23e521183f41c0860f3f2b8560b652",
              "sha256": "ad3f075f12f54ae9babde16bc5a02a3ad86f16e9578bcab8ef84e96d05f0d80f"
            },
            "registryEntryDigest": "f120c169be6ae3d781e7a2c0c33b3d28",
            "verifierArtifact": {
              "path": "tools/validation/final-closure/preflight.mjs",
              "gitBlobSha1": "54737922f0298fae20188ee5715a76492f2123f9",
              "sha256": "8cc6828d48f3650caf504eba44a1c47b697c17487b605da136cfa7347aa1c851"
            },
            "verifierIdentity": "8cc6828d48f3650caf504eba44a1c47b697c17487b605da136cfa7347aa1c851",
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
            "evidenceIdentity": "b50e8aa06805b19f2ed72b0a313aaa5bdd9175ee22a069ec3961dcb68cb5b871"
          },
          {
            "schemaVersion": "hex-final-closure-shadow-gate-evidence/v1",
            "status": "PASS",
            "taskId": "T059",
            "gateId": "t059-independent-verifier",
            "candidateIdentity": {
              "headSha": "f19bb7b03c3c9f0581f3a536588e50c6851a5775",
              "treeSha": "d7c473e0740c6b273d211e338819d2c709e31194"
            },
            "authorityCommitSha": "40421f4ce99e804b5638e1c473b6e8e758796add",
            "authorityOwnershipArtifact": {
              "path": "specs/005-analysis-final-closure/contracts/task-ownership.json",
              "gitBlobSha1": "599f4f441b23e521183f41c0860f3f2b8560b652",
              "sha256": "ad3f075f12f54ae9babde16bc5a02a3ad86f16e9578bcab8ef84e96d05f0d80f"
            },
            "registryEntryDigest": "c809c95cf5c0dc4f1d2aa4d4340b4830",
            "verifierArtifact": {
              "path": "tools/validation/final-closure/preflight.mjs",
              "gitBlobSha1": "54737922f0298fae20188ee5715a76492f2123f9",
              "sha256": "8cc6828d48f3650caf504eba44a1c47b697c17487b605da136cfa7347aa1c851"
            },
            "verifierIdentity": "8cc6828d48f3650caf504eba44a1c47b697c17487b605da136cfa7347aa1c851",
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
            "evidenceIdentity": "48ad9af3ec1416b98ccfb14ad488448ad57f5a139a6fdf1dd735ed46a2025df3"
          },
          {
            "schemaVersion": "hex-final-closure-shadow-gate-evidence/v1",
            "status": "PASS",
            "taskId": "T052",
            "gateId": "t052-independent-verifier",
            "candidateIdentity": {
              "headSha": "f19bb7b03c3c9f0581f3a536588e50c6851a5775",
              "treeSha": "d7c473e0740c6b273d211e338819d2c709e31194"
            },
            "authorityCommitSha": "40421f4ce99e804b5638e1c473b6e8e758796add",
            "authorityOwnershipArtifact": {
              "path": "specs/005-analysis-final-closure/contracts/task-ownership.json",
              "gitBlobSha1": "599f4f441b23e521183f41c0860f3f2b8560b652",
              "sha256": "ad3f075f12f54ae9babde16bc5a02a3ad86f16e9578bcab8ef84e96d05f0d80f"
            },
            "registryEntryDigest": "870aa3ec026061dcc12c1ce2f5e041bb",
            "verifierArtifact": {
              "path": "tools/validation/final-closure/preflight.mjs",
              "gitBlobSha1": "54737922f0298fae20188ee5715a76492f2123f9",
              "sha256": "8cc6828d48f3650caf504eba44a1c47b697c17487b605da136cfa7347aa1c851"
            },
            "verifierIdentity": "8cc6828d48f3650caf504eba44a1c47b697c17487b605da136cfa7347aa1c851",
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
                "caseId": "collaboration-remote-authority-identity",
                "path": "tests/phase12/collaboration/issues-5397-5399-5467-5497.test.mjs",
                "gitBlobSha1": "55112274bf27b93e376390258e0b4bf934fb6db2",
                "sha256": "3258d724db529650fa1b31b0e765353e39485a48ce8ba64cf2b32c90b8a93ac6"
              }
            ],
            "judgeIdentity": "175a307b54cb82d037cd8ed40838f8ba6ac185812597797fbbbad763c59befa2",
            "observations": {
              "oracle": {
                "schemaVersion": "hex-final-closure-shadow-raw-observation/v1",
                "taskId": "T052",
                "gateId": "t052-independent-verifier",
                "observations": [
                  {
                    "caseId": "collaboration-remote-authority-identity",
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
                "taskId": "T052",
                "gateId": "t052-independent-verifier",
                "observations": [
                  {
                    "caseId": "collaboration-remote-authority-identity",
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
              "contractIdentity": "085f65f4ee1c493efb736ec8680fef8b8cb3b80dfc1a34d37eacf97828d14c76",
              "caseCount": 1,
              "results": [
                {
                  "caseId": "collaboration-remote-authority-identity",
                  "disposition": "MATCH",
                  "oracleObservationSha256": "10c9b3a5de90d5cf7d01b78c5a627375cbdbce6dacfbc76cddc48e8c26c187b6",
                  "productObservationSha256": "10c9b3a5de90d5cf7d01b78c5a627375cbdbce6dacfbc76cddc48e8c26c187b6"
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
            "evidenceIdentity": "7946d26d0fd7d5ba1fbe264c24a7124d2238ba0791744158d2bc81df6ca70003"
          },
          {
            "schemaVersion": "hex-final-closure-shadow-gate-evidence/v1",
            "status": "PASS",
            "taskId": "T057",
            "gateId": "t057-independent-verifier",
            "candidateIdentity": {
              "headSha": "f19bb7b03c3c9f0581f3a536588e50c6851a5775",
              "treeSha": "d7c473e0740c6b273d211e338819d2c709e31194"
            },
            "authorityCommitSha": "40421f4ce99e804b5638e1c473b6e8e758796add",
            "authorityOwnershipArtifact": {
              "path": "specs/005-analysis-final-closure/contracts/task-ownership.json",
              "gitBlobSha1": "599f4f441b23e521183f41c0860f3f2b8560b652",
              "sha256": "ad3f075f12f54ae9babde16bc5a02a3ad86f16e9578bcab8ef84e96d05f0d80f"
            },
            "registryEntryDigest": "9e9d49a52dba579d0205c4644d5f1ad2",
            "verifierArtifact": {
              "path": "tools/validation/final-closure/preflight.mjs",
              "gitBlobSha1": "54737922f0298fae20188ee5715a76492f2123f9",
              "sha256": "8cc6828d48f3650caf504eba44a1c47b697c17487b605da136cfa7347aa1c851"
            },
            "verifierIdentity": "8cc6828d48f3650caf504eba44a1c47b697c17487b605da136cfa7347aa1c851",
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
                "caseId": "cil-return-shape-authority",
                "path": "tests/issue-1142-cil-stack-validation.mjs",
                "gitBlobSha1": "7d0310e0643a42c9c83ce375cd7bdbddd9ec6b62",
                "sha256": "b0ca9229506db235f7c4f7bb3ecba8d264c4659da2a01dee90d079d40862b0ca"
              }
            ],
            "judgeIdentity": "98cebb9468e2391cc5aac1b9d124e4f7f48c5b131c04d64a85a1a107cb6ab9b5",
            "observations": {
              "oracle": {
                "schemaVersion": "hex-final-closure-shadow-raw-observation/v1",
                "taskId": "T057",
                "gateId": "t057-independent-verifier",
                "observations": [
                  {
                    "caseId": "cil-return-shape-authority",
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
                "taskId": "T057",
                "gateId": "t057-independent-verifier",
                "observations": [
                  {
                    "caseId": "cil-return-shape-authority",
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
              "contractIdentity": "493d7220d371610b1a60b384c153e281fe46959497e77232706a1e7444f34a7b",
              "caseCount": 1,
              "results": [
                {
                  "caseId": "cil-return-shape-authority",
                  "disposition": "MATCH",
                  "oracleObservationSha256": "f8aa561ec158c25ececcb652c4b5dac9ee06ac95766bb49894a0eff822fd1a95",
                  "productObservationSha256": "f8aa561ec158c25ececcb652c4b5dac9ee06ac95766bb49894a0eff822fd1a95"
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
            "evidenceIdentity": "5c61c1c8f18e31b69c6ff1896b190628adeb008256a782485f13e28cd621d015"
          }
        ],
        "aggregate": {
          "schemaVersion": "hex-final-closure-checkpoint-shadow-aggregate/v1",
          "status": "PARTIAL_ZERO",
          "candidateIdentity": {
            "headSha": "f19bb7b03c3c9f0581f3a536588e50c6851a5775",
            "treeSha": "d7c473e0740c6b273d211e338819d2c709e31194"
          },
          "reportEvidenceIdentities": [
            {
              "taskId": "T051",
              "gateId": "t051-independent-verifier",
              "evidenceIdentity": "b50e8aa06805b19f2ed72b0a313aaa5bdd9175ee22a069ec3961dcb68cb5b871",
              "proofIdentity": "978a37ce9e7d6ea98d09248c8212b2d4f1b590b69e0ad8085d6936e06a762b7a"
            },
            {
              "taskId": "T052",
              "gateId": "t052-independent-verifier",
              "evidenceIdentity": "7946d26d0fd7d5ba1fbe264c24a7124d2238ba0791744158d2bc81df6ca70003",
              "proofIdentity": "49e9099d3a1ee867b6da983b77352450ecbea67155a40f855b3fda530e6ddd02"
            },
            {
              "taskId": "T057",
              "gateId": "t057-independent-verifier",
              "evidenceIdentity": "5c61c1c8f18e31b69c6ff1896b190628adeb008256a782485f13e28cd621d015",
              "proofIdentity": "fed5274e7d6f3003ce64d7bc33200f859090c6de1f049cbe637bf376e2258f4c"
            },
            {
              "taskId": "T059",
              "gateId": "t059-independent-verifier",
              "evidenceIdentity": "48ad9af3ec1416b98ccfb14ad488448ad57f5a139a6fdf1dd735ed46a2025df3",
              "proofIdentity": "67bf8115ada1c236bb74c458e25ffd387cd240ab98c85fa954567d9c30269da4"
            }
          ],
          "reportSetIdentity": "056aa4b328f1af98ae14e443b4dfe22c90fff092c07bad744f9ef09dcc49503c",
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
              "denominator": 4
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
          "identity": "aa4ebddd166ddd7f7a54d165ffc5f61f84b097e089014c472ddb0122eab8f9cc"
        },
        "identity": "54a51c59a8c316164ac07c9457f28f08f10dade89bbfd2d96eae1d6f9e74b228"
      },
      "initialCandidateGateDigest": "63fb512b688c281f862740411f20df72",
      "cumulativeInventory": {
        "baseSha": "eef6223fc08d90ef3e86b5eb8e4a56c06f04af84",
        "stableDigest": "ff8cd08db360875b893697dec9bed0b4",
        "pathCount": 55
      }
    }
  ]
}
```

## Checkpoint 3 — T052, 2026-09-05

PR #6669 merged into the living Recovery branch as
`6ee082bff33f162ea512267561c230a402e3382e`, with ordered parents P2
`eb3f37b0cadaec5724688d109f336d29f6a06889` and reviewed component
`0a521b282c6aa93afc94e0dfbfe701e705ccdf2a`. Its actual tree is
`deea1e4be6a26f69b669e9c15b6d15d49ad8586b`; only the four T052-owned
source/test paths were added relative to P2. Original handoffs and both
T060 receipts remain unchanged.

- Exact P2 hosted preflight/runtime run `33961730358`: PASS.
- Exact event-authorized T052 candidate run `33961805786`: PASS, including
  canonical final-closure regressions, walking skeleton, owned/rolling/shadow
  gates and inherited current-product runtime reproduction.
- Exact G `7d0b5c739cfc9d28443edd1af11105563e5b5ff6`: canonical generation
  repeated twice with zero diff; nine cumulative rolling gates and three
  pinned independent shadow reports PASS. The T052 owned group also PASS.
- Root inspected production/hydration/fixture diffs and candidate identity.
  CodeRabbit had no review threads on PR #6669 at acceptance. Historical
  review or this component checkpoint does not certify final Recovery CI.

Recovery release-level failures remain assigned to their unfinished owners;
full Phase 12, Stage 2, semantic corpus and final exact-head CI are not claimed
green here. This checkpoint accepts the T052 boundary only. The new integration
evidence HEAD still requires hosted verification. Physical device remains
`SKIPPED_USER_WAIVER`. Stage B has not started.

## Checkpoint 4 — T057, 2026-09-05

PR #6724 merged as `40421f4ce99e804b5638e1c473b6e8e758796add`, ordered
parents prior E `bfc363047c1f0099499f2b4d72cc9a871e3600e9` and component
`8cca5b359a434fa11d18c60684fb4906288c2a15`. Actual candidate tree:
`d7c473e0740c6b273d211e338819d2c709e31194`. Both changed paths are tests;
no CIL production semantics or PR #6700 frontend inference were adopted.
The positive case requires explicit return-shape authority, while missing,
coercive and contradictory authority retain partial/invalid outcomes.

Exact prior E hosted run `33964875774` and exact T057 candidate run
`33965028613` PASS, including their required current-product reproduction.
The candidate owned group and full Phase 11 runner PASS locally. Root reviewed
the two-path diff; PR #6724 had no CodeRabbit threads at acceptance.
Exact G `f19bb7b03c3c9f0581f3a536588e50c6851a5775` was rebuilt twice with
zero diff; ten cumulative rolling gates and four pinned independent shadow
reports PASS. Release/build identities remain unchanged. The new evidence
HEAD requires its own hosted verification; this is not final Recovery or main
acceptance, and all remaining release gates remain required.
