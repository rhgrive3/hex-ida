# V4 game-member holdout — independent layout/source authority and rationale

Created: 2026-10-01T05:29:06Z (UTC)
Author: Freebuff V4 independent query/oracle author, model DeepSeek V4.1 Flash high; blind to Jev outcomes, the v3/v4 development implementations and policy, stability-design-v2.md, and all candidate/ranking/result data.

This file is oracle-side evidence for the V4 prospective holdout. It records, per case,
the exact-build DWARF ancestry that grounds the answer. It must NOT be copied into
production candidate descriptions or into the retrieval product.

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

Both ARM64 release/build identities above are the same audited release identity used by the
original70, prior fresh50, stability V2 and default V3 packages; `layout-*` and
`fresh-layout-*` agree on the binary SHA256 and GNU build-ID per game, so a single physical
layout is used throughout.
Extraction: Exact-build DWARF via retained scripts/jev-realgame-gdb-layout.py + gdb 12.1 (GNU gdb 12.1 (Ubuntu 12.1-0ubuntu1~22.04.2)).

Authority files hashed into `freeze.json`:
- `fresh-layout-openmw.json` `51d19c47bf4165df9182e2f7c234ca3df6689c82be7a417765562fbde1f5a181`
- `fresh-layout-openttd.json` `325f53923ffee0800d9974f7d84fd895ce11f0f9bd3f0ffc977b8d27c11f8e4e`
- `layout-openmw.json` `2d07d1240d93bcbaf5f278cb5c15b03d16d7e0e4593731bc1fbe86797ea64cb3`
- `layout-openttd.json` `3b85b9add5a47858d35959d582c49f6ce1b49707011f905f86abafd4227ba5a2`
- `oracle-authority.json` `38665f5657573bf281e71b4a2b7f50805862eca19448c86f1ff904e549833844`

## Case construction and exclusion rule

Each verified case is a single distinct scalar or pointer member, read directly from the
exact-build layout authority (`offset`, `size`, `type`, `owningClassName`, and the recursive
inheritance list down to the declaring base). A case is rejected unless its primary
`(className, offset)` and every true base/derived alias of the same physical field are
disjoint from:

- the original frozen70 (`holdout-cases.json` + `structural-gold.json`),
- the prior fresh50 (`fresh-holdout.json` + `fresh-structural-cases.json`),
- stability V2 (`stability-v2/holdout.json` + `stability-v2/structural-cases.json`),
- default V3 (`default-v3/holdout.json` + `default-v3/structural-cases.json`).

vptrs, bitfields, arrays, embedded aggregates, references, function pointers and
nested-aggregate guesses are excluded. Controls carry no identity and have a written absence
rationale.

## Verified cases (report-only semantic labels)

### SV4-OP-01 · openttd

- Subject: Elapsed time since the consist's current order began; scalar on the shared consist base.
- Physical identity: `BaseConsist::current_order_time` @ offset 40, size 4, type `unsigned int`
- Owning/declaring class: `BaseConsist` (declaring offset 40)
- Inheritance to owning base: none (member declared directly on the selected class)
- Layout source used: `layout-openttd.json` (report-only semantic label `BaseConsist.current_order_time`)
- Alias identities emitted (same physical field): 6

### SV4-OP-02 · openttd

- Subject: Bit-flag set describing the vehicle's current handling and status state.
- Physical identity: `BaseConsist::vehicle_flags` @ offset 56, size 2, type `unsigned short`
- Owning/declaring class: `BaseConsist` (declaring offset 56)
- Inheritance to owning base: none (member declared directly on the selected class)
- Layout source used: `layout-openttd.json` (report-only semantic label `BaseConsist.vehicle_flags`)
- Alias identities emitted (same physical field): 6

### SV4-OP-03 · openttd

- Subject: Owner field of the group, identifying the company that owns it.
- Physical identity: `Group::owner` @ offset 40, size 1, type `Owner`
- Owning/declaring class: `Group` (declaring offset 40)
- Inheritance to owning base: none (member declared directly on the selected class)
- Layout source used: `fresh-layout-openttd.json` (report-only semantic label `Group.owner`)
- Alias identities emitted (same physical field): 1

### SV4-OP-04 · openttd

- Subject: Company tree-planting allowance recorded on the company property block.
- Physical identity: `Company::tree_limit` @ offset 160, size 4, type `unsigned int`
- Owning/declaring class: `CompanyProperties` (declaring offset 160)
- Inheritance to owning base: `CompanyProperties`@0(+7792)
- Layout source used: `layout-openttd.json` (report-only semantic label `CompanyProperties.tree_limit`)
- Alias identities emitted (same physical field): 3

### SV4-OP-05 · openttd

- Subject: Pointer to the AI info of a company that is computer-controlled.
- Physical identity: `Company::ai_info` @ offset 7816, size 8, type `AIInfo *`
- Owning/declaring class: `Company` (declaring offset 7816)
- Inheritance to owning base: none (member declared directly on the selected class)
- Layout source used: `layout-openttd.json` (report-only semantic label `Company.ai_info`)
- Alias identities emitted (same physical field): 1

### SV4-OP-06 · openttd

- Subject: Version number recorded in the NewGRF configuration.
- Physical identity: `GRFConfig::version` @ offset 112, size 4, type `unsigned int`
- Owning/declaring class: `GRFConfig` (declaring offset 112)
- Inheritance to owning base: none (member declared directly on the selected class)
- Layout source used: `layout-openttd.json` (report-only semantic label `GRFConfig.version`)
- Alias identities emitted (same physical field): 1

### SV4-OP-07 · openttd

- Subject: Number of parameter slots available in the NewGRF configuration.
- Physical identity: `GRFConfig::num_params` @ offset 644, size 1, type `unsigned char`
- Owning/declaring class: `GRFConfig` (declaring offset 644)
- Inheritance to owning base: none (member declared directly on the selected class)
- Layout source used: `layout-openttd.json` (report-only semantic label `GRFConfig.num_params`)
- Alias identities emitted (same physical field): 1

### SV4-OP-08 · openttd

- Subject: Four-character NewGRF identifier of the loaded file.
- Physical identity: `GRFFile::grfid` @ offset 16, size 4, type `unsigned int`
- Owning/declaring class: `GRFFile` (declaring offset 16)
- Inheritance to owning base: none (member declared directly on the selected class)
- Layout source used: `layout-openttd.json` (report-only semantic label `GRFFile.grfid`)
- Alias identities emitted (same physical field): 1

### SV4-OP-09 · openttd

- Subject: Count of sounds supplied by the loaded NewGRF.
- Physical identity: `GRFFile::num_sounds` @ offset 28, size 2, type `unsigned short`
- Owning/declaring class: `GRFFile` (declaring offset 28)
- Inheritance to owning base: none (member declared directly on the selected class)
- Layout source used: `layout-openttd.json` (report-only semantic label `GRFFile.num_sounds`)
- Alias identities emitted (same physical field): 1

### SV4-OP-10 · openttd

- Subject: Pointer from the industry to the town it is associated with.
- Physical identity: `Industry::town` @ offset 16, size 8, type `Town *`
- Owning/declaring class: `Industry` (declaring offset 16)
- Inheritance to owning base: none (member declared directly on the selected class)
- Layout source used: `fresh-layout-openttd.json` (report-only semantic label `Industry.town`)
- Alias identities emitted (same physical field): 1

### SV4-OP-11 · openttd

- Subject: Subsidy participation marker recorded on the industry.
- Physical identity: `Industry::part_of_subsidy` @ offset 302, size 1, type `PartOfSubsidy`
- Owning/declaring class: `Industry` (declaring offset 302)
- Inheritance to owning base: none (member declared directly on the selected class)
- Layout source used: `fresh-layout-openttd.json` (report-only semantic label `Industry.part_of_subsidy`)
- Alias identities emitted (same physical field): 1

### SV4-OP-12 · openttd

- Subject: Company granted an exclusive consumer arrangement for the industry.
- Physical identity: `Industry::exclusive_consumer` @ offset 462, size 1, type `Owner`
- Owning/declaring class: `Industry` (declaring offset 462)
- Inheritance to owning base: none (member declared directly on the selected class)
- Layout source used: `fresh-layout-openttd.json` (report-only semantic label `Industry.exclusive_consumer`)
- Alias identities emitted (same physical field): 1

### SV4-OP-13 · openttd

- Subject: Head pointer of the station's linked list of road truck stops.
- Physical identity: `Station::truck_stops` @ offset 208, size 8, type `RoadStop *`
- Owning/declaring class: `Station` (declaring offset 208)
- Inheritance to owning base: none (member declared directly on the selected class)
- Layout source used: `fresh-layout-openttd.json` (report-only semantic label `Station.truck_stops`)
- Alias identities emitted (same physical field): 1

### SV4-OP-14 · openttd

- Subject: Record of the vehicle types that have served the station.
- Physical identity: `Station::had_vehicle_of_type` @ offset 328, size 1, type `StationHadVehicleOfType`
- Owning/declaring class: `Station` (declaring offset 328)
- Inheritance to owning base: none (member declared directly on the selected class)
- Layout source used: `fresh-layout-openttd.json` (report-only semantic label `Station.had_vehicle_of_type`)
- Alias identities emitted (same physical field): 1

### SV4-OP-15 · openttd

- Subject: Facility flags of the station, e.g. which transport types it handles.
- Physical identity: `BaseStation::facilities` @ offset 121, size 1, type `StationFacility`
- Owning/declaring class: `BaseStation` (declaring offset 121)
- Inheritance to owning base: none (member declared directly on the selected class)
- Layout source used: `fresh-layout-openttd.json` (report-only semantic label `BaseStation.facilities`)
- Alias identities emitted (same physical field): 3

### SV4-OP-16 · openttd

- Subject: Base row coordinate of the diagonal tile iterator.
- Physical identity: `DiagonalTileIterator::base_y` @ offset 16, size 4, type `unsigned int`
- Owning/declaring class: `DiagonalTileIterator` (declaring offset 16)
- Inheritance to owning base: none (member declared directly on the selected class)
- Layout source used: `layout-openttd.json` (report-only semantic label `DiagonalTileIterator.base_y`)
- Alias identities emitted (same physical field): 1

### SV4-OP-17 · openttd

- Subject: Flag marking that the client connection has quit.
- Physical identity: `ClientNetworkGameSocketHandler::has_quit` @ offset 16, size 1, type `bool`
- Owning/declaring class: `NetworkSocketHandler` (declaring offset 8)
- Inheritance to owning base: `NetworkGameSocketHandler`@8(+96) <- `NetworkTCPSocketHandler`@8(+40) <- `NetworkSocketHandler`@8(+16)
- Layout source used: `layout-openttd.json` (report-only semantic label `NetworkSocketHandler.has_quit`)
- Alias identities emitted (same physical field): 1

### SV4-OP-18 · openttd

- Subject: Pointer to the resolved address list of the connector.
- Physical identity: `TCPConnecter::ai` @ offset 24, size 8, type `addrinfo *`
- Owning/declaring class: `TCPConnecter` (declaring offset 24)
- Inheritance to owning base: none (member declared directly on the selected class)
- Layout source used: `layout-openttd.json` (report-only semantic label `TCPConnecter.ai`)
- Alias identities emitted (same physical field): 1

### SV4-OP-19 · openttd

- Subject: Pointer to the weak-reference record of the reference-counted script object.
- Physical identity: `SQRefCounted::_weakref` @ offset 16, size 8, type `SQWeakRef *`
- Owning/declaring class: `SQRefCounted` (declaring offset 16)
- Inheritance to owning base: none (member declared directly on the selected class)
- Layout source used: `layout-openttd.json` (report-only semantic label `SQRefCounted._weakref`)
- Alias identities emitted (same physical field): 1

### SV4-OP-20 · openttd

- Subject: Target tile index used by the big UFO destroyer disaster vehicle.
- Physical identity: `DisasterVehicle::big_ufo_destroyer_target` @ offset 544, size 4, type `unsigned int`
- Owning/declaring class: `DisasterVehicle` (declaring offset 544)
- Inheritance to owning base: none (member declared directly on the selected class)
- Layout source used: `layout-openttd.json` (report-only semantic label `DisasterVehicle.big_ufo_destroyer_target`)
- Alias identities emitted (same physical field): 1

### SV4-MW-01 · openmw

- Subject: Flag marking whether the cell's recorded water level is interior-style.
- Physical identity: `ESM::Cell::mWaterInt` @ offset 176, size 1, type `bool`
- Owning/declaring class: `ESM::Cell` (declaring offset 176)
- Inheritance to owning base: none (member declared directly on the selected class)
- Layout source used: `fresh-layout-openmw.json` (report-only semantic label `ESM::Cell.mWaterInt`)
- Alias identities emitted (same physical field): 1

### SV4-MW-02 · openmw

- Subject: Flag that disables view switching in the player controls state.
- Physical identity: `ESM::ControlsState::mViewSwitchDisabled` @ offset 0, size 1, type `bool`
- Owning/declaring class: `ESM::ControlsState` (declaring offset 0)
- Inheritance to owning base: none (member declared directly on the selected class)
- Layout source used: `fresh-layout-openmw.json` (report-only semantic label `ESM::ControlsState.mViewSwitchDisabled`)
- Alias identities emitted (same physical field): 1

### SV4-MW-03 · openmw

- Subject: Day component of the journal entry's recorded date.
- Physical identity: `ESM::JournalEntry::mDay` @ offset 136, size 4, type `int`
- Owning/declaring class: `ESM::JournalEntry` (declaring offset 136)
- Inheritance to owning base: none (member declared directly on the selected class)
- Layout source used: `fresh-layout-openmw.json` (report-only semantic label `ESM::JournalEntry.mDay`)
- Alias identities emitted (same physical field): 1

### SV4-MW-04 · openmw

- Subject: Zoom level applied to the local map panel of the interface.
- Physical identity: `MWGui::HUD::mLocalMapZoom` @ offset 112, size 4, type `float`
- Owning/declaring class: `MWGui::LocalMapBase` (declaring offset 8)
- Inheritance to owning base: `MWGui::LocalMapBase`@104(+328)
- Layout source used: `fresh-layout-openmw.json` (report-only semantic label `MWGui::LocalMapBase.mLocalMapZoom`)
- Alias identities emitted (same physical field): 1

### SV4-MW-05 · openmw

- Subject: Pointer to the local map renderer owned by the local map base.
- Physical identity: `MWGui::HUD::mLocalMapRender` @ offset 120, size 8, type `MWRender::LocalMap *`
- Owning/declaring class: `MWGui::LocalMapBase` (declaring offset 16)
- Inheritance to owning base: `MWGui::LocalMapBase`@104(+328)
- Layout source used: `fresh-layout-openmw.json` (report-only semantic label `MWGui::LocalMapBase.mLocalMapRender`)
- Alias identities emitted (same physical field): 1

### SV4-MW-06 · openmw

- Subject: Number of cells represented by the local map.
- Physical identity: `MWGui::HUD::mNumCells` @ offset 208, size 4, type `int`
- Owning/declaring class: `MWGui::LocalMapBase` (declaring offset 104)
- Inheritance to owning base: `MWGui::LocalMapBase`@104(+328)
- Layout source used: `fresh-layout-openmw.json` (report-only semantic label `MWGui::LocalMapBase.mNumCells`)
- Alias identities emitted (same physical field): 1

### SV4-MW-07 · openmw

- Subject: Pointer to the interface's drag-and-drop helper object.
- Physical identity: `MWGui::HUD::mDragAndDrop` @ offset 648, size 8, type `MWGui::DragAndDrop *`
- Owning/declaring class: `MWGui::HUD` (declaring offset 648)
- Inheritance to owning base: none (member declared directly on the selected class)
- Layout source used: `fresh-layout-openmw.json` (report-only semantic label `MWGui::HUD.mDragAndDrop`)
- Alias identities emitted (same physical field): 1

### SV4-MW-08 · openmw

- Subject: Actor id of the enemy currently shown by the HUD.
- Physical identity: `MWGui::HUD::mEnemyActorId` @ offset 776, size 4, type `int`
- Owning/declaring class: `MWGui::HUD` (declaring offset 776)
- Inheritance to owning base: none (member declared directly on the selected class)
- Layout source used: `fresh-layout-openmw.json` (report-only semantic label `MWGui::HUD.mEnemyActorId`)
- Alias identities emitted (same physical field): 1

### SV4-MW-09 · openmw

- Subject: Pointer to the static message box owned by the manager.
- Physical identity: `MWGui::MessageBoxManager::mStaticMessageBox` @ offset 56, size 8, type `MWGui::MessageBox *`
- Owning/declaring class: `MWGui::MessageBoxManager` (declaring offset 56)
- Inheritance to owning base: none (member declared directly on the selected class)
- Layout source used: `fresh-layout-openmw.json` (report-only semantic label `MWGui::MessageBoxManager.mStaticMessageBox`)
- Alias identities emitted (same physical field): 1

### SV4-MW-10 · openmw

- Subject: Number of hours selected manually in the wait dialog.
- Physical identity: `MWGui::WaitDialog::mManualHours` @ offset 264, size 4, type `int`
- Owning/declaring class: `MWGui::WaitDialog` (declaring offset 264)
- Inheritance to owning base: none (member declared directly on the selected class)
- Layout source used: `fresh-layout-openmw.json` (report-only semantic label `MWGui::WaitDialog.mManualHours`)
- Alias identities emitted (same physical field): 1

### SV4-MW-11 · openmw

- Subject: Remaining fade time of the wait dialog.
- Physical identity: `MWGui::WaitDialog::mFadeTimeRemaining` @ offset 268, size 4, type `float`
- Owning/declaring class: `MWGui::WaitDialog` (declaring offset 268)
- Inheritance to owning base: none (member declared directly on the selected class)
- Layout source used: `fresh-layout-openmw.json` (report-only semantic label `MWGui::WaitDialog.mFadeTimeRemaining`)
- Alias identities emitted (same physical field): 1

### SV4-MW-12 · openmw

- Subject: Pointer to the action manager owned by the controller manager.
- Physical identity: `MWInput::ControllerManager::mActionManager` @ offset 16, size 8, type `MWInput::ActionManager *`
- Owning/declaring class: `MWInput::ControllerManager` (declaring offset 16)
- Inheritance to owning base: none (member declared directly on the selected class)
- Layout source used: `fresh-layout-openmw.json` (report-only semantic label `MWInput::ControllerManager.mActionManager`)
- Alias identities emitted (same physical field): 1

### SV4-MW-13 · openmw

- Subject: Flag marking that joystick input was most recently used.
- Physical identity: `MWInput::ControllerManager::mJoystickLastUsed` @ offset 46, size 1, type `bool`
- Owning/declaring class: `MWInput::ControllerManager` (declaring offset 46)
- Inheritance to owning base: none (member declared directly on the selected class)
- Layout source used: `fresh-layout-openmw.json` (report-only semantic label `MWInput::ControllerManager.mJoystickLastUsed`)
- Alias identities emitted (same physical field): 1

### SV4-MW-14 · openmw

- Subject: Flag marking the actor's AI sequence as completed.
- Physical identity: `MWMechanics::AiSequence::mDone` @ offset 32, size 1, type `bool`
- Owning/declaring class: `MWMechanics::AiSequence` (declaring offset 32)
- Inheritance to owning base: none (member declared directly on the selected class)
- Layout source used: `fresh-layout-openmw.json` (report-only semantic label `MWMechanics::AiSequence.mDone`)
- Alias identities emitted (same physical field): 1

### SV4-MW-15 · openmw

- Subject: Gold pool recorded in the creature's statistics.
- Physical identity: `MWMechanics::CreatureStats::mGoldPool` @ offset 600, size 4, type `int`
- Owning/declaring class: `MWMechanics::CreatureStats` (declaring offset 600)
- Inheritance to owning base: none (member declared directly on the selected class)
- Layout source used: `fresh-layout-openmw.json` (report-only semantic label `MWMechanics::CreatureStats.mGoldPool`)
- Alias identities emitted (same physical field): 2

### SV4-MW-16 · openmw

- Subject: Counter of hits the creature has taken from friendly sources.
- Physical identity: `MWMechanics::CreatureStats::mFriendlyHits` @ offset 508, size 4, type `int`
- Owning/declaring class: `MWMechanics::CreatureStats` (declaring offset 508)
- Inheritance to owning base: none (member declared directly on the selected class)
- Layout source used: `fresh-layout-openmw.json` (report-only semantic label `MWMechanics::CreatureStats.mFriendlyHits`)
- Alias identities emitted (same physical field): 2

### SV4-MW-17 · openmw

- Subject: Pointer to the ESM pathgrid record the graph wraps.
- Physical identity: `MWMechanics::PathgridGraph::mPathgrid` @ offset 8, size 8, type `const ESM::Pathgrid *`
- Owning/declaring class: `MWMechanics::PathgridGraph` (declaring offset 8)
- Inheritance to owning base: none (member declared directly on the selected class)
- Layout source used: `layout-openmw.json` (report-only semantic label `MWMechanics::PathgridGraph.mPathgrid`)
- Alias identities emitted (same physical field): 1

### SV4-MW-18 · openmw

- Subject: Flag marking that the actor walks on water this frame.
- Physical identity: `MWPhysics::ActorFrameData::mWalkingOnWater` @ offset 34, size 1, type `bool`
- Owning/declaring class: `MWPhysics::ActorFrameData` (declaring offset 34)
- Inheritance to owning base: none (member declared directly on the selected class)
- Layout source used: `layout-openmw.json` (report-only semantic label `MWPhysics::ActorFrameData.mWalkingOnWater`)
- Alias identities emitted (same physical field): 1

### SV4-MW-19 · openmw

- Subject: Flag marking that the cell store holds modifications.
- Physical identity: `MWWorld::CellStore::mHasState` @ offset 36, size 1, type `bool`
- Owning/declaring class: `MWWorld::CellStore` (declaring offset 36)
- Inheritance to owning base: none (member declared directly on the selected class)
- Layout source used: `fresh-layout-openmw.json` (report-only semantic label `MWWorld::CellStore.mHasState`)
- Alias identities emitted (same physical field): 1

### SV4-MW-20 · openmw

- Subject: Phase value of the NIF blend controller.
- Physical identity: `Nif::bhkBlendController::phase` @ offset 72, size 4, type `float`
- Owning/declaring class: `Nif::Controller` (declaring offset 72)
- Inheritance to owning base: `Nif::Controller`@0(+96)
- Layout source used: `layout-openmw.json` (report-only semantic label `Nif::Controller.phase`)
- Alias identities emitted (same physical field): 1

## Controls (abstain)

- **SV4-CTL-01** (openttd): What is the name of the pilot flying this aircraft?
- **SV4-CTL-02** (openttd): How many passengers on this bus are currently asleep?
- **SV4-CTL-03** (openttd): What is the average humidity inside this station's waiting room?
- **SV4-CTL-04** (openttd): Which flavour of ice cream does this town's mayor prefer?
- **SV4-CTL-05** (openttd): How much does the clock on this station platform weigh?
- **SV4-CTL-06** (openmw): What is the name of this shopkeeper's pet cat?
- **SV4-CTL-07** (openmw): What is the temperature of the water in this cell?
- **SV4-CTL-08** (openmw): Which song is the bard in this tavern currently composing?
- **SV4-CTL-09** (openmw): How many keys are on this guard's keyring?
- **SV4-CTL-10** (openmw): What is the serial number stamped on this iron dagger?

Each control asks for a datum that no member of the available exact-build layout authority —
and no game-state field these binaries track — can supply. The correct behaviour is
abstention. Controls are intentionally outside the games' tracked state; they are not a claim
that the products contain such data.

## Verification performed (independent of the parent)

- All 40 verified identities were re-derived from the raw authority files and matched on
  `offset`/`size`/`type`/`owningClassName`; 40/40 matched with zero mismatch.
- Every alias class at the same physical `(offset,size,type)` was re-checked against the
  original70/fresh50/V2/V3 identity sets; zero alias overlap.
- All 50 query strings were compared, normalised, against every prior query string; zero
  duplicate text.
- Distribution validated: 20 verified OpenTTD + 20 verified OpenMW + 5 control OpenTTD
  + 5 control OpenMW = 50.
- `holdout.json` SHA256 is bound into `freeze.json`.

## Limitations

- Questions are written from the member's documented role and the owning class's subsystem;
  they avoid quoting identifiers, offsets, or `Class.field` syntax, so a retriever must
  resolve them semantically rather than by string matching.
- Only classes present in the five authorised layout files were usable. Where a chosen member
  is declared on a base class, the declaring class and inherited base offset are recorded
  explicitly so the oracle is not silently attributed to the derived class.
- No result, snapshot, report README, policy, development receipt, or production source was
  read while authoring this holdout.

