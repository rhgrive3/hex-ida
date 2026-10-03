# V3 game-member holdout — independent layout/source authority and rationale

Created: 2026-10-01T02:42:25Z (UTC)
Author: Freebuff V3 independent query/oracle author, model DeepSeek V4.1 Flash high; blind to Jev outcomes, the v3 development implementation/policy, stability-design-v2.md, and all candidate/ranking/result data.

This file is oracle-side evidence for the V3 prospective holdout. It records, per
case, the exact-build DWARF ancestry that grounds the answer. It must NOT be copied
into production candidate descriptions or into the retrieval product.

## Exact builds and authority provenance

- `openttd` — package `openttd-dbgsym (Ubuntu noble ddebs, 13.4-1build3 arm64)`
  - binary SHA256 `8f1686353f2b1325a1bcf78a9db0d4be3a1fcce3151cf242a87ce3e063fa9bd5`
  - GNU build-ID `d878fe2573ea43be2209d5ea5afef0b476f39d70`
  - debug file `/mnt/workspace/.dev-state/agent-work/checkpoints/jev-realgame-final/openttd-dbgsym/usr/lib/debug/.build-id/d8/78fe2573ea43be2209d5ea5afef0b476f39d70.debug`
  - debug file SHA256 `9f7cbd3075c4ad5c388a11ff8ba17a2c661195e06f7297616f8c0fe0312db5be`
- `openmw` — package `openmw-dbgsym (Ubuntu noble multiverse, 0.48.0-1ubuntu5 arm64)`
  - binary SHA256 `a2dcff8a8851e28b3477bc0c5a1317f40e914ae42796255d1283bcce99ccb8db`
  - GNU build-ID `eef0625b6b9af7971e72c4fc8260258b50dcae43`
  - debug file `/mnt/workspace/.dev-state/agent-work/checkpoints/jev-realgame-final/openmw-dbgsym/usr/lib/debug/.build-id/ee/f0625b6b9af7971e72c4fc8260258b50dcae43.debug`
  - debug file SHA256 `deed9ba59bad9cf0e3ba4446e9f77ece20887929ffd06be0410f4cae76b74b41`

Both ARM64 release/build identities above are the same audited release identity used by
the original70 and prior fresh50 packages; `layout-*` and `fresh-layout-*` agree on the
binary SHA256 and GNU build-ID per game, so a single physical layout is used throughout.
Extraction: Exact-build DWARF via retained scripts/jev-realgame-gdb-layout.py + gdb 12.1 (GNU gdb 12.1 (Ubuntu 12.1-0ubuntu1~22.04.2)).

Authority files hashed into `freeze.json`:
- `fresh-layout-openmw.json` `51d19c47bf4165df9182e2f7c234ca3df6689c82be7a417765562fbde1f5a181`
- `fresh-layout-openttd.json` `325f53923ffee0800d9974f7d84fd895ce11f0f9bd3f0ffc977b8d27c11f8e4e`
- `layout-openmw.json` `2d07d1240d93bcbaf5f278cb5c15b03d16d7e0e4593731bc1fbe86797ea64cb3`
- `layout-openttd.json` `3b85b9add5a47858d35959d582c49f6ce1b49707011f905f86abafd4227ba5a2`
- `oracle-authority.json` `38665f5657573bf281e71b4a2b7f50805862eca19448c86f1ff904e549833844`

## Integrity correction / parent exposure audit

The parent accidentally ran a filename-scoped `rg` over the in-progress draft
`authority.md` and saw exactly two report labels:
- `Company identity colour stored on the company property block`
- `ClientNetworkGameSocketHandler::sock offset 40 size 4`

Exposed draft case ids: SV3-OP-01, SV3-OP-13. 
Query text exposed: False. Other case labels exposed: 
False. Outcome/candidate data exposed: False.
Tuned using the exposure: False.

Remediation: Both exposed physical fields were dropped and replaced by independently selected never-used verified identities (Group.vehicle_type for SV3-OP-01; ClientNetworkGameSocketHandler.info for SV3-OP-13). No exposed identity is present in the final holdout.

The original draft is preserved byte-identical as `holdout.draft-v1.json`,
`freeze.draft-v1.json` and `authority.draft-v1.md`. Zero parent exposure to the
draft is **not** claimed.

## Case construction and exclusion rule

Each verified case is a single distinct scalar or pointer member, read directly from the
exact-build layout authority (`offset`, `size`, `type`, `owningClassName`, and the
recursive inheritance list down to the declaring base). A case is rejected unless its
primary `(className, offset)` and every true base/derived alias of the same physical
field are disjoint from:

- the original frozen70 (`holdout-cases.json` + `structural-gold.json`),
- the prior fresh50 (`fresh-holdout.json` + `fresh-structural-cases.json`),
- V2 (`stability-v2/holdout.json` + `stability-v2/structural-cases.json`).

vptrs, bitfields, arrays, embedded aggregates, references and nested-aggregate guesses
are excluded. Controls carry no identity and have a written absence rationale.

## Verified cases (report-only semantic labels)

### SV3-OP-01 · openttd

- Subject: Vehicle type a group is restricted to; replacement selected independently after the draft company-colour identity was exposed. The exposed field is not used.
- Physical identity: `Group::vehicle_type` @ offset 41, size 1, type `VehicleType`
- Owning/declaring class: `Group` (declaring offset 41)
- Inheritance to owning base: none (member declared directly on the selected class)
- Layout source used: `fresh-layout-openttd.json` (report-only semantic label `Group.vehicle_type`)
- Alias identities emitted (same physical field): 1
- REPLACEMENT CASE: replaces exposed draft identity CompanyProperties.colour / offset 112 (exposed in draft authority.md)

### SV3-OP-02 · openttd

- Subject: Flag recording whether the company slot is occupied by an AI.
- Physical identity: `CompanyProperties::is_ai` @ offset 168, size 1, type `bool`
- Owning/declaring class: `CompanyProperties` (declaring offset 168)
- Inheritance to owning base: none (member declared directly on the selected class)
- Layout source used: `fresh-layout-openttd.json` (report-only semantic label `CompanyProperties.is_ai`)
- Alias identities emitted (same physical field): 2

### SV3-OP-03 · openttd

- Subject: Count of populated entries in the company's economy statistics history.
- Physical identity: `CompanyProperties::num_valid_stat_ent` @ offset 7688, size 1, type `unsigned char`
- Owning/declaring class: `CompanyProperties` (declaring offset 7688)
- Inheritance to owning base: none (member declared directly on the selected class)
- Layout source used: `fresh-layout-openttd.json` (report-only semantic label `CompanyProperties.num_valid_stat_ent`)
- Alias identities emitted (same physical field): 2

### SV3-OP-04 · openttd

- Subject: Pointer to the head of the company's automatic engine-replacement list.
- Physical identity: `CompanyProperties::engine_renew_list` @ offset 7760, size 8, type `EngineRenew *`
- Owning/declaring class: `CompanyProperties` (declaring offset 7760)
- Inheritance to owning base: none (member declared directly on the selected class)
- Layout source used: `fresh-layout-openttd.json` (report-only semantic label `CompanyProperties.engine_renew_list`)
- Alias identities emitted (same physical field): 2

### SV3-OP-05 · openttd

- Subject: Town subsidy participation marker.
- Physical identity: `TownCache::part_of_subsidy` @ offset 24, size 1, type `PartOfSubsidy`
- Owning/declaring class: `TownCache` (declaring offset 24)
- Inheritance to owning base: none (member declared directly on the selected class)
- Layout source used: `layout-openttd.json` (report-only semantic label `TownCache.part_of_subsidy`)
- Alias identities emitted (same physical field): 1

### SV3-OP-06 · openttd

- Subject: Head pointer of the station's linked list of road vehicle bus stops.
- Physical identity: `Station::bus_stops` @ offset 192, size 8, type `RoadStop *`
- Owning/declaring class: `Station` (declaring offset 192)
- Inheritance to owning base: none (member declared directly on the selected class)
- Layout source used: `fresh-layout-openttd.json` (report-only semantic label `Station.bus_stops`)
- Alias identities emitted (same physical field): 1

### SV3-OP-07 · openttd

- Subject: Industry type associated with an industry-serving station.
- Physical identity: `Station::indtype` @ offset 272, size 1, type `unsigned char`
- Owning/declaring class: `Station` (declaring offset 272)
- Inheritance to owning base: none (member declared directly on the selected class)
- Layout source used: `fresh-layout-openttd.json` (report-only semantic label `Station.indtype`)
- Alias identities emitted (same physical field): 1

### SV3-OP-08 · openttd

- Subject: Owner recorded when an exclusive supply arrangement is active for the industry.
- Physical identity: `Industry::exclusive_supplier` @ offset 461, size 1, type `Owner`
- Owning/declaring class: `Industry` (declaring offset 461)
- Inheritance to owning base: none (member declared directly on the selected class)
- Layout source used: `fresh-layout-openttd.json` (report-only semantic label `Industry.exclusive_supplier`)
- Alias identities emitted (same physical field): 1

### SV3-OP-09 · openttd

- Subject: Industry construction/tile-layout style marker.
- Physical identity: `Industry::construction_type` @ offset 392, size 1, type `unsigned char`
- Owning/declaring class: `Industry` (declaring offset 392)
- Inheritance to owning base: none (member declared directly on the selected class)
- Layout source used: `fresh-layout-openttd.json` (report-only semantic label `Industry.construction_type`)
- Alias identities emitted (same physical field): 1

### SV3-OP-10 · openttd

- Subject: Flag marking that default parameter values were recorded for the NewGRF.
- Physical identity: `GRFConfig::has_param_defaults` @ offset 672, size 1, type `bool`
- Owning/declaring class: `GRFConfig` (declaring offset 672)
- Inheritance to owning base: none (member declared directly on the selected class)
- Layout source used: `layout-openttd.json` (report-only semantic label `GRFConfig.has_param_defaults`)
- Alias identities emitted (same physical field): 1

### SV3-OP-11 · openttd

- Subject: Number of valid parameter slots of the NewGRF configuration.
- Physical identity: `GRFConfig::num_valid_params` @ offset 645, size 1, type `unsigned char`
- Owning/declaring class: `GRFConfig` (declaring offset 645)
- Inheritance to owning base: none (member declared directly on the selected class)
- Layout source used: `layout-openttd.json` (report-only semantic label `GRFConfig.num_valid_params`)
- Alias identities emitted (same physical field): 1

### SV3-OP-12 · openttd

- Subject: Network connection's assigned client id (declared on the base network game socket handler).
- Physical identity: `ClientNetworkGameSocketHandler::client_id` @ offset 60, size 4, type `ClientID`
- Owning/declaring class: `NetworkGameSocketHandler` (declaring offset 52)
- Inheritance to owning base: `NetworkGameSocketHandler`@8(+96)
- Layout source used: `layout-openttd.json` (report-only semantic label `NetworkGameSocketHandler.client_id`)
- Alias identities emitted (same physical field): 1

### SV3-OP-13 · openttd

- Subject: Pointer to the client's server-side info record; replacement selected independently after the draft socket-descriptor identity was exposed. The exposed field is not used.
- Physical identity: `ClientNetworkGameSocketHandler::info` @ offset 48, size 8, type `NetworkClientInfo *`
- Owning/declaring class: `NetworkGameSocketHandler` (declaring offset 40)
- Inheritance to owning base: `NetworkGameSocketHandler`@8(+96)
- Layout source used: `layout-openttd.json` (report-only semantic label `NetworkGameSocketHandler.info`)
- Alias identities emitted (same physical field): 1
- REPLACEMENT CASE: replaces exposed draft identity ClientNetworkGameSocketHandler.sock / offset 40 size 4 (exposed in draft authority.md)

### SV3-OP-14 · openttd

- Subject: Current a-coordinate of the diagonal tile iterator.
- Physical identity: `DiagonalTileIterator::a_cur` @ offset 20, size 4, type `int`
- Owning/declaring class: `DiagonalTileIterator` (declaring offset 20)
- Inheritance to owning base: none (member declared directly on the selected class)
- Layout source used: `layout-openttd.json` (report-only semantic label `DiagonalTileIterator.a_cur`)
- Alias identities emitted (same physical field): 1

### SV3-OP-15 · openttd

- Subject: Active callback id of the station resolver object.
- Physical identity: `StationResolverObject::callback` @ offset 24, size 4, type `CallbackID`
- Owning/declaring class: `ResolverObject` (declaring offset 24)
- Inheritance to owning base: `ResolverObject`@0(+80)
- Layout source used: `layout-openttd.json` (report-only semantic label `ResolverObject.callback`)
- Alias identities emitted (same physical field): 1

### SV3-OP-16 · openttd

- Subject: Reference count of the script engine ref-counted object.
- Physical identity: `SQRefCounted::_uiRef` @ offset 8, size 8, type `unsigned long long`
- Owning/declaring class: `SQRefCounted` (declaring offset 8)
- Inheritance to owning base: none (member declared directly on the selected class)
- Layout source used: `layout-openttd.json` (report-only semantic label `SQRefCounted._uiRef`)
- Alias identities emitted (same physical field): 1

### SV3-OP-17 · openttd

- Subject: Container version of the sprite loader's grf file.
- Physical identity: `SpriteLoaderGrf::container_ver` @ offset 8, size 1, type `unsigned char`
- Owning/declaring class: `SpriteLoaderGrf` (declaring offset 8)
- Inheritance to owning base: none (member declared directly on the selected class)
- Layout source used: `layout-openttd.json` (report-only semantic label `SpriteLoaderGrf.container_ver`)
- Alias identities emitted (same physical field): 1

### SV3-OP-18 · openttd

- Subject: Base file scanner subdirectory the tar scanner assigns discovered entries to.
- Physical identity: `TarScanner::subdir` @ offset 8, size 4, type `Subdirectory`
- Owning/declaring class: `FileScanner` (declaring offset 8)
- Inheritance to owning base: `FileScanner`@0(+16)
- Layout source used: `layout-openttd.json` (report-only semantic label `FileScanner.subdir`)
- Alias identities emitted (same physical field): 1

### SV3-OP-19 · openttd

- Subject: Address family of the connecter's resolved target.
- Physical identity: `TCPConnecter::family` @ offset 352, size 4, type `int`
- Owning/declaring class: `TCPConnecter` (declaring offset 352)
- Inheritance to owning base: none (member declared directly on the selected class)
- Layout source used: `layout-openttd.json` (report-only semantic label `TCPConnecter.family`)
- Alias identities emitted (same physical field): 1

### SV3-OP-20 · openttd

- Subject: Cached axle resistance term of the ground vehicle physics cache.
- Physical identity: `GroundVehicleCache::cached_axle_resistance` @ offset 12, size 2, type `unsigned short`
- Owning/declaring class: `GroundVehicleCache` (declaring offset 12)
- Inheritance to owning base: none (member declared directly on the selected class)
- Layout source used: `layout-openttd.json` (report-only semantic label `GroundVehicleCache.cached_axle_resistance`)
- Alias identities emitted (same physical field): 1

### SV3-MW-01 · openmw

- Subject: Water level stored on the cell record.
- Physical identity: `ESM::Cell::mWater` @ offset 172, size 4, type `float`
- Owning/declaring class: `ESM::Cell` (declaring offset 172)
- Inheritance to owning base: none (member declared directly on the selected class)
- Layout source used: `fresh-layout-openmw.json` (report-only semantic label `ESM::Cell.mWater`)
- Alias identities emitted (same physical field): 1

### SV3-MW-02 · openmw

- Subject: Flag that disables player movement input.
- Physical identity: `ESM::ControlsState::mControlsDisabled` @ offset 1, size 1, type `bool`
- Owning/declaring class: `ESM::ControlsState` (declaring offset 1)
- Inheritance to owning base: none (member declared directly on the selected class)
- Layout source used: `fresh-layout-openmw.json` (report-only semantic label `ESM::ControlsState.mControlsDisabled`)
- Alias identities emitted (same physical field): 1

### SV3-MW-03 · openmw

- Subject: Month component of a journal entry's recorded date.
- Physical identity: `ESM::JournalEntry::mMonth` @ offset 140, size 4, type `int`
- Owning/declaring class: `ESM::JournalEntry` (declaring offset 140)
- Inheritance to owning base: none (member declared directly on the selected class)
- Layout source used: `fresh-layout-openmw.json` (report-only semantic label `ESM::JournalEntry.mMonth`)
- Alias identities emitted (same physical field): 1

### SV3-MW-04 · openmw

- Subject: Pointer to the active interactive message box managed by the GUI.
- Physical identity: `MWGui::MessageBoxManager::mInterMessageBoxe` @ offset 48, size 8, type `MWGui::InteractiveMessageBox *`
- Owning/declaring class: `MWGui::MessageBoxManager` (declaring offset 48)
- Inheritance to owning base: none (member declared directly on the selected class)
- Layout source used: `fresh-layout-openmw.json` (report-only semantic label `MWGui::MessageBoxManager.mInterMessageBoxe`)
- Alias identities emitted (same physical field): 1

### SV3-MW-05 · openmw

- Subject: Game hour at which an in-progress wait is scheduled to stop.
- Physical identity: `MWGui::WaitDialog::mInterruptAt` @ offset 272, size 4, type `int`
- Owning/declaring class: `MWGui::WaitDialog` (declaring offset 272)
- Inheritance to owning base: none (member declared directly on the selected class)
- Layout source used: `fresh-layout-openmw.json` (report-only semantic label `MWGui::WaitDialog.mInterruptAt`)
- Alias identities emitted (same physical field): 1

### SV3-MW-06 · openmw

- Subject: Configured cursor speed used for gamepad-driven GUI navigation.
- Physical identity: `MWInput::ControllerManager::mGamepadCursorSpeed` @ offset 36, size 4, type `float`
- Owning/declaring class: `MWInput::ControllerManager` (declaring offset 36)
- Inheritance to owning base: none (member declared directly on the selected class)
- Layout source used: `fresh-layout-openmw.json` (report-only semantic label `MWInput::ControllerManager.mGamepadCursorSpeed`)
- Alias identities emitted (same physical field): 1

### SV3-MW-07 · openmw

- Subject: Pointer to the bindings manager owned by the controller input handler.
- Physical identity: `MWInput::ControllerManager::mBindingsManager` @ offset 8, size 8, type `MWInput::BindingsManager *`
- Owning/declaring class: `MWInput::ControllerManager` (declaring offset 8)
- Inheritance to owning base: none (member declared directly on the selected class)
- Layout source used: `fresh-layout-openmw.json` (report-only semantic label `MWInput::ControllerManager.mBindingsManager`)
- Alias identities emitted (same physical field): 1

### SV3-MW-08 · openmw

- Subject: Count of queued pursuit AI packages in the actor's AI sequence.
- Physical identity: `MWMechanics::AiSequence::mNumPursuitPackages` @ offset 40, size 4, type `int`
- Owning/declaring class: `MWMechanics::AiSequence` (declaring offset 40)
- Inheritance to owning base: none (member declared directly on the selected class)
- Layout source used: `fresh-layout-openmw.json` (report-only semantic label `MWMechanics::AiSequence.mNumPursuitPackages`)
- Alias identities emitted (same physical field): 1

### SV3-MW-09 · openmw

- Subject: Movement capability flags of the creature statistics.
- Physical identity: `MWMechanics::CreatureStats::mMovementFlags` @ offset 520, size 4, type `unsigned int`
- Owning/declaring class: `MWMechanics::CreatureStats` (declaring offset 520)
- Inheritance to owning base: none (member declared directly on the selected class)
- Layout source used: `fresh-layout-openmw.json` (report-only semantic label `MWMechanics::CreatureStats.mMovementFlags`)
- Alias identities emitted (same physical field): 2

### SV3-MW-10 · openmw

- Subject: Owning actor id recorded on the creature statistics.
- Physical identity: `MWMechanics::CreatureStats::mActorId` @ offset 604, size 4, type `int`
- Owning/declaring class: `MWMechanics::CreatureStats` (declaring offset 604)
- Inheritance to owning base: none (member declared directly on the selected class)
- Layout source used: `fresh-layout-openmw.json` (report-only semantic label `MWMechanics::CreatureStats.mActorId`)
- Alias identities emitted (same physical field): 2

### SV3-MW-11 · openmw

- Subject: Crime id attributed to the NPC.
- Physical identity: `MWMechanics::NpcStats::mCrimeId` @ offset 1152, size 4, type `int`
- Owning/declaring class: `MWMechanics::NpcStats` (declaring offset 1152)
- Inheritance to owning base: none (member declared directly on the selected class)
- Layout source used: `fresh-layout-openmw.json` (report-only semantic label `MWMechanics::NpcStats.mCrimeId`)
- Alias identities emitted (same physical field): 1

### SV3-MW-12 · openmw

- Subject: Werewolf-form kill counter of the NPC statistics.
- Physical identity: `MWMechanics::NpcStats::mWerewolfKills` @ offset 1160, size 4, type `int`
- Owning/declaring class: `MWMechanics::NpcStats` (declaring offset 1160)
- Inheritance to owning base: none (member declared directly on the selected class)
- Layout source used: `fresh-layout-openmw.json` (report-only semantic label `MWMechanics::NpcStats.mWerewolfKills`)
- Alias identities emitted (same physical field): 1

### SV3-MW-13 · openmw

- Subject: Flag marking that the pathgrid graph's adjacency structure is constructed.
- Physical identity: `MWMechanics::PathgridGraph::mIsGraphConstructed` @ offset 40, size 1, type `bool`
- Owning/declaring class: `MWMechanics::PathgridGraph` (declaring offset 40)
- Inheritance to owning base: none (member declared directly on the selected class)
- Layout source used: `layout-openmw.json` (report-only semantic label `MWMechanics::PathgridGraph.mIsGraphConstructed`)
- Alias identities emitted (same physical field): 1

### SV3-MW-14 · openmw

- Subject: Index into the strongly connected component table of the pathgrid graph.
- Physical identity: `MWMechanics::PathgridGraph::mSCCIndex` @ offset 48, size 4, type `int`
- Owning/declaring class: `MWMechanics::PathgridGraph` (declaring offset 48)
- Inheritance to owning base: none (member declared directly on the selected class)
- Layout source used: `layout-openmw.json` (report-only semantic label `MWMechanics::PathgridGraph.mSCCIndex`)
- Alias identities emitted (same physical field): 1

### SV3-MW-15 · openmw

- Subject: Collision object the actor's feet rest on this frame.
- Physical identity: `MWPhysics::ActorFrameData::mStandingOn` @ offset 24, size 8, type `const btCollisionObject *`
- Owning/declaring class: `MWPhysics::ActorFrameData` (declaring offset 24)
- Inheritance to owning base: none (member declared directly on the selected class)
- Layout source used: `layout-openmw.json` (report-only semantic label `MWPhysics::ActorFrameData.mStandingOn`)
- Alias identities emitted (same physical field): 1

### SV3-MW-16 · openmw

- Subject: Pointer to the ESM cell record owned by the cell store.
- Physical identity: `MWWorld::CellStore::mCell` @ offset 24, size 8, type `const ESM::Cell *`
- Owning/declaring class: `MWWorld::CellStore` (declaring offset 24)
- Inheritance to owning base: none (member declared directly on the selected class)
- Layout source used: `fresh-layout-openmw.json` (report-only semantic label `MWWorld::CellStore.mCell`)
- Alias identities emitted (same physical field): 1

### SV3-MW-17 · openmw

- Subject: Stop time of the NIF blend controller.
- Physical identity: `Nif::bhkBlendController::timeStop` @ offset 80, size 4, type `float`
- Owning/declaring class: `Nif::Controller` (declaring offset 80)
- Inheritance to owning base: `Nif::Controller`@0(+96)
- Layout source used: `layout-openmw.json` (report-only semantic label `Nif::Controller.timeStop`)
- Alias identities emitted (same physical field): 1

### SV3-MW-18 · openmw

- Subject: Pointer to the matrix transform restoring the rig geometry to its origin.
- Physical identity: `SceneUtil::RigGeometryHolder::mBackToOrigin` @ offset 368, size 8, type `osg::MatrixTransform *`
- Owning/declaring class: `SceneUtil::RigGeometryHolder` (declaring offset 368)
- Inheritance to owning base: none (member declared directly on the selected class)
- Layout source used: `layout-openmw.json` (report-only semantic label `SceneUtil::RigGeometryHolder.mBackToOrigin`)
- Alias identities emitted (same physical field): 1

### SV3-MW-19 · openmw

- Subject: Flag recording whether the SDL cursor manager has drawn its custom cursor.
- Physical identity: `SDLUtil::SDLCursorManager::mEnabled` @ offset 88, size 1, type `bool`
- Owning/declaring class: `SDLUtil::SDLCursorManager` (declaring offset 88)
- Inheritance to owning base: none (member declared directly on the selected class)
- Layout source used: `layout-openmw.json` (report-only semantic label `SDLUtil::SDLCursorManager.mEnabled`)
- Alias identities emitted (same physical field): 1

### SV3-MW-20 · openmw

- Subject: Pointer to the compass image widget owned by the local map base.
- Physical identity: `MWGui::HUD::mCompass` @ offset 160, size 8, type `MyGUI::ImageBox *`
- Owning/declaring class: `MWGui::LocalMapBase` (declaring offset 56)
- Inheritance to owning base: `MWGui::LocalMapBase`@104(+328)
- Layout source used: `fresh-layout-openmw.json` (report-only semantic label `MWGui::LocalMapBase.mCompass`)
- Alias identities emitted (same physical field): 1

## Controls (abstain)

- **SV3-CTL-01** (openttd): What is the average passenger satisfaction rating of this bus route?
- **SV3-CTL-02** (openttd): How many litres of paint were used to respray this train?
- **SV3-CTL-03** (openttd): What is the surname of the station master at this station?
- **SV3-CTL-04** (openttd): How many cups of coffee does this company's president drink each day?
- **SV3-CTL-05** (openttd): What is the octane rating of the diesel burned by this road vehicle?
- **SV3-CTL-06** (openmw): How much does the sword this character is carrying weigh in grams?
- **SV3-CTL-07** (openmw): What is this character's shoe size?
- **SV3-CTL-08** (openmw): How many teeth does this creature have?
- **SV3-CTL-09** (openmw): What is the title of the background song currently playing?
- **SV3-CTL-10** (openmw): How many stars are visible above this cell's night sky?

Each control asks for a datum that no member of the available exact-build layout
authority — and no game-state field these binaries track — can supply. The correct
behaviour is abstention; a confident field must not be invented for them.

## Verification performed (independent of the parent)

- All 40 verified identities were re-derived from the raw authority files and matched
  on `offset`/`size`/`type`/`owningClassName`; 40/40 matched with zero mismatch.
- Every alias class at the same physical `(offset,size,type)` was re-checked against the
  original70/fresh50/V2 identity sets; zero alias overlap.
- All 50 query strings were compared, normalised, against every original70/fresh50/V2
  query string; zero duplicate text.
- Distribution validated: 20 verified OpenTTD + 20 verified OpenMW + 5 control OpenTTD
  + 5 control OpenMW = 50.
- `holdout.json` SHA256 is bound into `freeze.json`.

## Limitations

- Questions are written from the member's documented role and the owning class's
  subsystem; they avoid quoting identifiers, offsets, or `Class.field` syntax, so a
  retriever must resolve them semantically rather than by string matching.
- Only classes present in the five authorised layout files were usable. Where a chosen
  member is declared on a base class, the declaring class and inherited base offset are
  recorded explicitly so the oracle is not silently attributed to the derived class.
- Controls are intentionally outside the games' tracked state; they are not a claim that
  the products contain such data.
- No result, snapshot, policy, v3-development receipt, or production source was read
  while authoring this holdout.
