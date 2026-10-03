# stability-holdout-v2 — independent layout/source authority

Schema: `hex-jev-stability-holdout-v2/v1`  
Created (UTC): 2026-09-30T16:58:00.571Z  
Author: independent query/oracle author (evidence-only writes). This document is the per-case evidence file for `holdout.json`.

## Scope and independence

- Sources used: only the authoritative layout/oracle metadata and the original/prior **case** files listed below. Jev results, result snapshots, README metric tables, `stability-design-v2.md`, the v2 implementation, and all candidate/ranking outputs were **not** opened while authoring these cases.
- Original/prior case files were read **only** to avoid duplicate query text and duplicate physical gold identities.
- Every verified member exists in the exact-build DWARF layout authority with a proven namespace (class + owning class + owning offset) and, where inherited, an explicit base offset. RTTI alone was never used.
- Excluded by construction: vptrs, bitfields, array/nested-aggregate guesses, members only present in a different build layout, health/fatigue/magicka concepts, and the oracle-rejected `CreatureStats.mSpells` alternative.

## Build and layout authority

| binary | binary sha256 | build-id | debug sha256 | package |
|---|---|---|---|---|
| openttd | `8f1686353f2b1325a1bcf78a9db0d4be3a1fcce3151cf242a87ce3e063fa9bd5` | `d878fe2573ea43be2209d5ea5afef0b476f39d70` | `9f7cbd3075c4ad5c388a11ff8ba17a2c661195e06f7297616f8c0fe0312db5be` | 13.4-1build3 (dbgsym sha256 `09930c29507c3d5e02b8c1aa5c25dd9f44ad3f8975b00ce0b37adabce91d3b40`) |
| openmw | `a2dcff8a8851e28b3477bc0c5a1317f40e914ae42796255d1283bcce99ccb8db` | `eef0625b6b9af7971e72c4fc8260258b50dcae43` | `deed9ba59bad9cf0e3ba4446e9f77ece20887929ffd06be0410f4cae76b74b41` | 0.48.0-1ubuntu5 (dbgsym sha256 `77272a82a9311d0a41d403a55c6ead13e7ae7f40455559c1005557047dbe41ef`) |

Parent and fresh extracts were checked to carry byte-identical release/build identities:

- openttd: `layout-openttd.json` vs `fresh-layout-openttd.json` — same binary sha256: true, same build-id: true, same debug sha256: true
- openmw: `layout-openmw.json` vs `fresh-layout-openmw.json` — same binary sha256: true, same build-id: true, same debug sha256: true

## Authority files (sha256 at freeze time)

- reports/investigations/jev-realgame-final/oracle-authority.json — sha256 `38665f5657573bf281e71b4a2b7f50805862eca19448c86f1ff904e549833844` (1098 bytes) — independent oracle authority
- reports/investigations/jev-realgame-final/layout-openttd.json — sha256 `3b85b9add5a47858d35959d582c49f6ce1b49707011f905f86abafd4227ba5a2` (356640 bytes) — exact parent layout extract (openttd)
- reports/investigations/jev-realgame-final/layout-openmw.json — sha256 `2d07d1240d93bcbaf5f278cb5c15b03d16d7e0e4593731bc1fbe86797ea64cb3` (42212 bytes) — exact parent layout extract (openmw)
- reports/investigations/jev-realgame-final/fresh-layout-openttd.json — sha256 `325f53923ffee0800d9974f7d84fd895ce11f0f9bd3f0ffc977b8d27c11f8e4e` (88578 bytes) — independent fresh layout extract (openttd)
- reports/investigations/jev-realgame-final/fresh-layout-openmw.json — sha256 `51d19c47bf4165df9182e2f7c234ca3df6689c82be7a417765562fbde1f5a181` (108387 bytes) — independent fresh layout extract (openmw)

## Verified cases (40)

### SV2-OP-01 — BaseConsist.timetable_start (openttd)

- **Query:** Which game tick was recorded as the moment this vehicle's timetable began?
- **Member:** class `BaseConsist` (DWARF declaration: `class BaseConsist`, class size 64), field `timetable_start`, **offset 48**, **size 4**, type `int`
- **Owning class of the member:** `BaseConsist` at owning offset 48 (declared directly in this class)
- **Binary identity:** sha256 `8f1686353f2b1325a1bcf78a9db0d4be3a1fcce3151cf242a87ce3e063fa9bd5`, build-id `d878fe2573ea43be2209d5ea5afef0b476f39d70`, debug file sha256 `9f7cbd3075c4ad5c388a11ff8ba17a2c661195e06f7297616f8c0fe0312db5be`
- **Layout authority:** `reports/investigations/jev-realgame-final/layout-openttd.json` (sha256 `3b85b9add5a47858d35959d582c49f6ce1b49707011f905f86abafd4227ba5a2`), schema `hex-jev-realgame-struct-layout/v1`, extracted 2026-09-30T08:28:43.078Z, method `GDB Python compiler/DWARF Type.fields, byte offsets, actual sizeof, declared owner, and recursive base adjustments`, extractor sha256 `c554bd4412c4fdd8697ad9f5b151d80e82f0ad920f6a67648810b7b611170177`
- **Independent cross-check:** class present only in the primary extract; identity is bound through the shared binary sha256/build-id/debug sha256 pair verified identical across parent and fresh extracts.
- **Identities (including inherited aliases):** BaseConsist@48+4, DisasterVehicle@48+4, RoadVehicle@48+4, Ship@48+4, Vehicle@48+4
- **Neighbouring fields considered and rejected:** `lateness_counter`@44+4 (already original/prior gold); `service_interval`@52+2 (already original/prior gold)
- **Rationale:** Timetable start point on the shared consist base. Independent of the original lateness and service-interval gold (different member, different meaning) and absent from prior fresh identities.
- **Independence:** physical identity absent from original70 structural gold and prior fresh50 structural identities (mechanically checked); semantic label not present in any prior gold; query text not a duplicate or paraphrase-match of any prior query.

### SV2-OP-02 — Vehicle.vehstatus (openttd)

- **Query:** Which status flags is this vehicle carrying right now, such as stopped, loading, or waiting at a waypoint?
- **Member:** class `Vehicle` (DWARF declaration: `class Vehicle`, class size 544), field `vehstatus`, **offset 374**, **size 1**, type `unsigned char`
- **Owning class of the member:** `Vehicle` at owning offset 374 (declared directly in this class)
- **Binary identity:** sha256 `8f1686353f2b1325a1bcf78a9db0d4be3a1fcce3151cf242a87ce3e063fa9bd5`, build-id `d878fe2573ea43be2209d5ea5afef0b476f39d70`, debug file sha256 `9f7cbd3075c4ad5c388a11ff8ba17a2c661195e06f7297616f8c0fe0312db5be`
- **Layout authority:** `reports/investigations/jev-realgame-final/layout-openttd.json` (sha256 `3b85b9add5a47858d35959d582c49f6ce1b49707011f905f86abafd4227ba5a2`), schema `hex-jev-realgame-struct-layout/v1`, extracted 2026-09-30T08:28:43.078Z, method `GDB Python compiler/DWARF Type.fields, byte offsets, actual sizeof, declared owner, and recursive base adjustments`, extractor sha256 `c554bd4412c4fdd8697ad9f5b151d80e82f0ad920f6a67648810b7b611170177`
- **Independent cross-check:** identical member (offset/size/type/owner) in `reports/investigations/jev-realgame-final/fresh-layout-openttd.json` (sha256 `325f53923ffee0800d9974f7d84fd895ce11f0f9bd3f0ffc977b8d27c11f8e4e`); same binary sha256: true, same build-id: true, same debug sha256: true
- **Identities (including inherited aliases):** Vehicle@374+1, DisasterVehicle@374+1, RoadVehicle@374+1, Ship@374+1
- **Neighbouring fields considered and rejected:** `running_ticks`@373+1; `current_order`@376+24 (already original/prior gold) (aggregate/array)
- **Rationale:** Vehicle status byte owned directly by Vehicle; width-1 flag coverage in the core vehicle class. No prior case targets any status member.
- **Independence:** physical identity absent from original70 structural gold and prior fresh50 structural identities (mechanically checked); semantic label not present in any prior gold; query text not a duplicate or paraphrase-match of any prior query.

### SV2-OP-03 — Vehicle.z_pos (openttd)

- **Query:** How high above the map is this vehicle drawn at the moment?
- **Member:** class `Vehicle` (DWARF declaration: `class Vehicle`, class size 544), field `z_pos`, **offset 244**, **size 4**, type `int`
- **Owning class of the member:** `Vehicle` at owning offset 244 (declared directly in this class)
- **Binary identity:** sha256 `8f1686353f2b1325a1bcf78a9db0d4be3a1fcce3151cf242a87ce3e063fa9bd5`, build-id `d878fe2573ea43be2209d5ea5afef0b476f39d70`, debug file sha256 `9f7cbd3075c4ad5c388a11ff8ba17a2c661195e06f7297616f8c0fe0312db5be`
- **Layout authority:** `reports/investigations/jev-realgame-final/layout-openttd.json` (sha256 `3b85b9add5a47858d35959d582c49f6ce1b49707011f905f86abafd4227ba5a2`), schema `hex-jev-realgame-struct-layout/v1`, extracted 2026-09-30T08:28:43.078Z, method `GDB Python compiler/DWARF Type.fields, byte offsets, actual sizeof, declared owner, and recursive base adjustments`, extractor sha256 `c554bd4412c4fdd8697ad9f5b151d80e82f0ad920f6a67648810b7b611170177`
- **Independent cross-check:** identical member (offset/size/type/owner) in `reports/investigations/jev-realgame-final/fresh-layout-openttd.json` (sha256 `325f53923ffee0800d9974f7d84fd895ce11f0f9bd3f0ffc977b8d27c11f8e4e`); same binary sha256: true, same build-id: true, same debug sha256: true
- **Identities (including inherited aliases):** Vehicle@244+4, DisasterVehicle@244+4, RoadVehicle@244+4, Ship@244+4
- **Neighbouring fields considered and rejected:** `y_pos`@240+4; `direction`@248+1 (already original/prior gold)
- **Rationale:** Vertical draw position. Distinct physical member from the original tile/destination tile gold, covering the height axis rather than map-tile identity.
- **Independence:** physical identity absent from original70 structural gold and prior fresh50 structural identities (mechanically checked); semantic label not present in any prior gold; query text not a duplicate or paraphrase-match of any prior query.

### SV2-OP-04 — Vehicle.refit_cap (openttd)

- **Query:** What cargo capacity will this vehicle have once its ordered refit is applied?
- **Member:** class `Vehicle` (DWARF declaration: `class Vehicle`, class size 544), field `refit_cap`, **offset 308**, **size 2**, type `unsigned short`
- **Owning class of the member:** `Vehicle` at owning offset 308 (declared directly in this class)
- **Binary identity:** sha256 `8f1686353f2b1325a1bcf78a9db0d4be3a1fcce3151cf242a87ce3e063fa9bd5`, build-id `d878fe2573ea43be2209d5ea5afef0b476f39d70`, debug file sha256 `9f7cbd3075c4ad5c388a11ff8ba17a2c661195e06f7297616f8c0fe0312db5be`
- **Layout authority:** `reports/investigations/jev-realgame-final/layout-openttd.json` (sha256 `3b85b9add5a47858d35959d582c49f6ce1b49707011f905f86abafd4227ba5a2`), schema `hex-jev-realgame-struct-layout/v1`, extracted 2026-09-30T08:28:43.078Z, method `GDB Python compiler/DWARF Type.fields, byte offsets, actual sizeof, declared owner, and recursive base adjustments`, extractor sha256 `c554bd4412c4fdd8697ad9f5b151d80e82f0ad920f6a67648810b7b611170177`
- **Independent cross-check:** identical member (offset/size/type/owner) in `reports/investigations/jev-realgame-final/fresh-layout-openttd.json` (sha256 `325f53923ffee0800d9974f7d84fd895ce11f0f9bd3f0ffc977b8d27c11f8e4e`); same binary sha256: true, same build-id: true, same debug sha256: true
- **Identities (including inherited aliases):** Vehicle@308+2, DisasterVehicle@308+2, RoadVehicle@308+2, Ship@308+2
- **Neighbouring fields considered and rejected:** `cargo_cap`@306+2 (already original/prior gold); `cargo`@312+56 (already original/prior gold) (aggregate/array)
- **Rationale:** Post-refit capacity, a different member from the original current-capacity gold; the question targets pending refit semantics, not maximum capacity.
- **Independence:** physical identity absent from original70 structural gold and prior fresh50 structural identities (mechanically checked); semantic label not present in any prior gold; query text not a duplicate or paraphrase-match of any prior query.

### SV2-OP-05 — Ship.rotation (openttd)

- **Query:** Which facing rotation is this ship currently turned to?
- **Member:** class `Ship` (DWARF declaration: `class Ship`, class size 632), field `rotation`, **offset 624**, **size 1**, type `Direction`
- **Owning class of the member:** `Ship` at owning offset 624 (declared directly in this class)
- **Binary identity:** sha256 `8f1686353f2b1325a1bcf78a9db0d4be3a1fcce3151cf242a87ce3e063fa9bd5`, build-id `d878fe2573ea43be2209d5ea5afef0b476f39d70`, debug file sha256 `9f7cbd3075c4ad5c388a11ff8ba17a2c661195e06f7297616f8c0fe0312db5be`
- **Layout authority:** `reports/investigations/jev-realgame-final/layout-openttd.json` (sha256 `3b85b9add5a47858d35959d582c49f6ce1b49707011f905f86abafd4227ba5a2`), schema `hex-jev-realgame-struct-layout/v1`, extracted 2026-09-30T08:28:43.078Z, method `GDB Python compiler/DWARF Type.fields, byte offsets, actual sizeof, declared owner, and recursive base adjustments`, extractor sha256 `c554bd4412c4fdd8697ad9f5b151d80e82f0ad920f6a67648810b7b611170177`
- **Independent cross-check:** class present only in the primary extract; identity is bound through the shared binary sha256/build-id/debug sha256 pair verified identical across parent and fresh extracts.
- **Identities (including inherited aliases):** Ship@624+1
- **Neighbouring fields considered and rejected:** `path`@544+80 (aggregate/array); `rotation_x_pos`@626+2
- **Rationale:** Ship-specific member beyond the shared vehicle base, giving subtype coverage with a 1-byte enumeration.
- **Independence:** physical identity absent from original70 structural gold and prior fresh50 structural identities (mechanically checked); semantic label not present in any prior gold; query text not a duplicate or paraphrase-match of any prior query.

### SV2-OP-06 — RoadVehicle.roadtype (openttd)

- **Query:** What kind of road surface is this road vehicle running on at the moment?
- **Member:** class `RoadVehicle` (DWARF declaration: `class RoadVehicle`, class size 760), field `roadtype`, **offset 745**, **size 1**, type `RoadType`
- **Owning class of the member:** `RoadVehicle` at owning offset 745 (declared directly in this class)
- **Binary identity:** sha256 `8f1686353f2b1325a1bcf78a9db0d4be3a1fcce3151cf242a87ce3e063fa9bd5`, build-id `d878fe2573ea43be2209d5ea5afef0b476f39d70`, debug file sha256 `9f7cbd3075c4ad5c388a11ff8ba17a2c661195e06f7297616f8c0fe0312db5be`
- **Layout authority:** `reports/investigations/jev-realgame-final/layout-openttd.json` (sha256 `3b85b9add5a47858d35959d582c49f6ce1b49707011f905f86abafd4227ba5a2`), schema `hex-jev-realgame-struct-layout/v1`, extracted 2026-09-30T08:28:43.078Z, method `GDB Python compiler/DWARF Type.fields, byte offsets, actual sizeof, declared owner, and recursive base adjustments`, extractor sha256 `c554bd4412c4fdd8697ad9f5b151d80e82f0ad920f6a67648810b7b611170177`
- **Independent cross-check:** class present only in the primary extract; identity is bound through the shared binary sha256/build-id/debug sha256 pair verified identical across parent and fresh extracts.
- **Identities (including inherited aliases):** RoadVehicle@745+1
- **Neighbouring fields considered and rejected:** `reverse_ctr`@744+1; `compatible_roadtypes`@752+8
- **Rationale:** Road-vehicle-specific road surface kind; distinct owner and subsystem from all train/vehicle-cache gold.
- **Independence:** physical identity absent from original70 structural gold and prior fresh50 structural identities (mechanically checked); semantic label not present in any prior gold; query text not a duplicate or paraphrase-match of any prior query.

### SV2-OP-07 — GroundVehicleCache.cached_total_length (openttd)

- **Query:** What is the precomputed overall length of this train's entire consist?
- **Member:** class `GroundVehicleCache` (DWARF declaration: `class GroundVehicleCache`, class size 32), field `cached_total_length`, **offset 24**, **size 2**, type `unsigned short`
- **Owning class of the member:** `GroundVehicleCache` at owning offset 24 (declared directly in this class)
- **Binary identity:** sha256 `8f1686353f2b1325a1bcf78a9db0d4be3a1fcce3151cf242a87ce3e063fa9bd5`, build-id `d878fe2573ea43be2209d5ea5afef0b476f39d70`, debug file sha256 `9f7cbd3075c4ad5c388a11ff8ba17a2c661195e06f7297616f8c0fe0312db5be`
- **Layout authority:** `reports/investigations/jev-realgame-final/layout-openttd.json` (sha256 `3b85b9add5a47858d35959d582c49f6ce1b49707011f905f86abafd4227ba5a2`), schema `hex-jev-realgame-struct-layout/v1`, extracted 2026-09-30T08:28:43.078Z, method `GDB Python compiler/DWARF Type.fields, byte offsets, actual sizeof, declared owner, and recursive base adjustments`, extractor sha256 `c554bd4412c4fdd8697ad9f5b151d80e82f0ad920f6a67648810b7b611170177`
- **Independent cross-check:** class present only in the primary extract; identity is bound through the shared binary sha256/build-id/debug sha256 pair verified identical across parent and fresh extracts.
- **Identities (including inherited aliases):** GroundVehicleCache@24+2
- **Neighbouring fields considered and rejected:** `cached_air_drag`@20+4 (already original/prior gold); `first_engine`@26+2
- **Rationale:** Length quantity from the ground-vehicle physics cache; original gold in this class covered weight, power, tractive effort, drag and top speed only, never length.
- **Independence:** physical identity absent from original70 structural gold and prior fresh50 structural identities (mechanically checked); semantic label not present in any prior gold; query text not a duplicate or paraphrase-match of any prior query.

### SV2-OP-08 — Order.dest (openttd)

- **Query:** Which station or stop is this schedule instruction pointed at?
- **Member:** class `Order` (DWARF declaration: `class Order`, class size 24), field `dest`, **offset 6**, **size 2**, type `unsigned short`
- **Owning class of the member:** `Order` at owning offset 6 (declared directly in this class)
- **Binary identity:** sha256 `8f1686353f2b1325a1bcf78a9db0d4be3a1fcce3151cf242a87ce3e063fa9bd5`, build-id `d878fe2573ea43be2209d5ea5afef0b476f39d70`, debug file sha256 `9f7cbd3075c4ad5c388a11ff8ba17a2c661195e06f7297616f8c0fe0312db5be`
- **Layout authority:** `reports/investigations/jev-realgame-final/layout-openttd.json` (sha256 `3b85b9add5a47858d35959d582c49f6ce1b49707011f905f86abafd4227ba5a2`), schema `hex-jev-realgame-struct-layout/v1`, extracted 2026-09-30T08:28:43.078Z, method `GDB Python compiler/DWARF Type.fields, byte offsets, actual sizeof, declared owner, and recursive base adjustments`, extractor sha256 `c554bd4412c4fdd8697ad9f5b151d80e82f0ad920f6a67648810b7b611170177`
- **Independent cross-check:** identical member (offset/size/type/owner) in `reports/investigations/jev-realgame-final/fresh-layout-openttd.json` (sha256 `325f53923ffee0800d9974f7d84fd895ce11f0f9bd3f0ffc977b8d27c11f8e4e`); same binary sha256: true, same build-id: true, same debug sha256: true
- **Identities (including inherited aliases):** Order@6+2
- **Neighbouring fields considered and rejected:** `flags`@5+1; `refit_cargo`@8+1 (already original/prior gold)
- **Rationale:** Order destination member; prior order gold covered wait/travel time, refit cargo and instruction kind, never the destination.
- **Independence:** physical identity absent from original70 structural gold and prior fresh50 structural identities (mechanically checked); semantic label not present in any prior gold; query text not a duplicate or paraphrase-match of any prior query.

### SV2-OP-09 — Order.next (openttd)

- **Query:** Which instruction follows this one in the schedule list?
- **Member:** class `Order` (DWARF declaration: `class Order`, class size 24), field `next`, **offset 16**, **size 8**, type `Order *`
- **Owning class of the member:** `Order` at owning offset 16 (declared directly in this class)
- **Binary identity:** sha256 `8f1686353f2b1325a1bcf78a9db0d4be3a1fcce3151cf242a87ce3e063fa9bd5`, build-id `d878fe2573ea43be2209d5ea5afef0b476f39d70`, debug file sha256 `9f7cbd3075c4ad5c388a11ff8ba17a2c661195e06f7297616f8c0fe0312db5be`
- **Layout authority:** `reports/investigations/jev-realgame-final/layout-openttd.json` (sha256 `3b85b9add5a47858d35959d582c49f6ce1b49707011f905f86abafd4227ba5a2`), schema `hex-jev-realgame-struct-layout/v1`, extracted 2026-09-30T08:28:43.078Z, method `GDB Python compiler/DWARF Type.fields, byte offsets, actual sizeof, declared owner, and recursive base adjustments`, extractor sha256 `c554bd4412c4fdd8697ad9f5b151d80e82f0ad920f6a67648810b7b611170177`
- **Independent cross-check:** identical member (offset/size/type/owner) in `reports/investigations/jev-realgame-final/fresh-layout-openttd.json` (sha256 `325f53923ffee0800d9974f7d84fd895ce11f0f9bd3f0ffc977b8d27c11f8e4e`); same binary sha256: true, same build-id: true, same debug sha256: true
- **Identities (including inherited aliases):** Order@16+8
- **Neighbouring fields considered and rejected:** `max_speed`@14+2 (already original/prior gold)
- **Rationale:** Pointer-width link member giving linked-structure coverage in the schedule subsystem; no prior pointer gold in Order.
- **Independence:** physical identity absent from original70 structural gold and prior fresh50 structural identities (mechanically checked); semantic label not present in any prior gold; query text not a duplicate or paraphrase-match of any prior query.

### SV2-OP-10 — BaseStation.town (openttd)

- **Query:** Which town is this station part of?
- **Member:** class `BaseStation` (DWARF declaration: `class BaseStation`, class size 192), field `town`, **offset 112**, **size 8**, type `Town *`
- **Owning class of the member:** `BaseStation` at owning offset 112 (declared directly in this class)
- **Binary identity:** sha256 `8f1686353f2b1325a1bcf78a9db0d4be3a1fcce3151cf242a87ce3e063fa9bd5`, build-id `d878fe2573ea43be2209d5ea5afef0b476f39d70`, debug file sha256 `9f7cbd3075c4ad5c388a11ff8ba17a2c661195e06f7297616f8c0fe0312db5be`
- **Layout authority:** `reports/investigations/jev-realgame-final/fresh-layout-openttd.json` (sha256 `325f53923ffee0800d9974f7d84fd895ce11f0f9bd3f0ffc977b8d27c11f8e4e`), schema not embedded in this extract; paired extract schema `hex-jev-realgame-struct-layout/v1`, extract time recorded on the paired extract 2026-09-30T08:28:43.078Z, method `Independent parent rerun of exact-build GDB Type.fields; same audited release/debug build-ID`, parentLayoutSha256 `aca006cbf153cf221767f322af177195c6835f75a5d5cf077ee54dba6e4af9f2`
- **Independent cross-check:** class present only in the primary extract; identity is bound through the shared binary sha256/build-id/debug sha256 pair verified identical across parent and fresh extracts.
- **Identities (including inherited aliases):** BaseStation@112+8, Station@112+8
- **Neighbouring fields considered and rejected:** `cached_name`@80+32 (aggregate/array); `owner`@120+1
- **Rationale:** Pointer member declared on the station base class; prior station gold covered build date and last vehicle type only.
- **Independence:** physical identity absent from original70 structural gold and prior fresh50 structural identities (mechanically checked); semantic label not present in any prior gold; query text not a duplicate or paraphrase-match of any prior query.

### SV2-OP-11 — Station.always_accepted (openttd)

- **Query:** Which cargo types does this station accept no matter what its industries currently need?
- **Member:** class `Station` (DWARF declaration: `class Station`, class size 9128), field `always_accepted`, **offset 9064**, **size 8**, type `unsigned long long`
- **Owning class of the member:** `Station` at owning offset 9064 (declared directly in this class)
- **Binary identity:** sha256 `8f1686353f2b1325a1bcf78a9db0d4be3a1fcce3151cf242a87ce3e063fa9bd5`, build-id `d878fe2573ea43be2209d5ea5afef0b476f39d70`, debug file sha256 `9f7cbd3075c4ad5c388a11ff8ba17a2c661195e06f7297616f8c0fe0312db5be`
- **Layout authority:** `reports/investigations/jev-realgame-final/layout-openttd.json` (sha256 `3b85b9add5a47858d35959d582c49f6ce1b49707011f905f86abafd4227ba5a2`), schema `hex-jev-realgame-struct-layout/v1`, extracted 2026-09-30T08:28:43.078Z, method `GDB Python compiler/DWARF Type.fields, byte offsets, actual sizeof, declared owner, and recursive base adjustments`, extractor sha256 `c554bd4412c4fdd8697ad9f5b151d80e82f0ad920f6a67648810b7b611170177`
- **Independent cross-check:** identical member (offset/size/type/owner) in `reports/investigations/jev-realgame-final/fresh-layout-openttd.json` (sha256 `325f53923ffee0800d9974f7d84fd895ce11f0f9bd3f0ffc977b8d27c11f8e4e`); same binary sha256: true, same build-id: true, same debug sha256: true
- **Identities (including inherited aliases):** Station@9064+8
- **Neighbouring fields considered and rejected:** `goods`@360+8704 (aggregate/array); `industries_near`@9072+48 (aggregate/array)
- **Rationale:** 64-bit cargo acceptance bitset at the tail of the station class; distinct owner and width from all prior station gold.
- **Independence:** physical identity absent from original70 structural gold and prior fresh50 structural identities (mechanically checked); semantic label not present in any prior gold; query text not a duplicate or paraphrase-match of any prior query.

### SV2-OP-12 — Industry.counter (openttd)

- **Query:** What countdown drives this industry's next production update?
- **Member:** class `Industry` (DWARF declaration: `class Industry`, class size 512), field `counter`, **offset 290**, **size 2**, type `unsigned short`
- **Owning class of the member:** `Industry` at owning offset 290 (declared directly in this class)
- **Binary identity:** sha256 `8f1686353f2b1325a1bcf78a9db0d4be3a1fcce3151cf242a87ce3e063fa9bd5`, build-id `d878fe2573ea43be2209d5ea5afef0b476f39d70`, debug file sha256 `9f7cbd3075c4ad5c388a11ff8ba17a2c661195e06f7297616f8c0fe0312db5be`
- **Layout authority:** `reports/investigations/jev-realgame-final/layout-openttd.json` (sha256 `3b85b9add5a47858d35959d582c49f6ce1b49707011f905f86abafd4227ba5a2`), schema `hex-jev-realgame-struct-layout/v1`, extracted 2026-09-30T08:28:43.078Z, method `GDB Python compiler/DWARF Type.fields, byte offsets, actual sizeof, declared owner, and recursive base adjustments`, extractor sha256 `c554bd4412c4fdd8697ad9f5b151d80e82f0ad920f6a67648810b7b611170177`
- **Independent cross-check:** identical member (offset/size/type/owner) in `reports/investigations/jev-realgame-final/fresh-layout-openttd.json` (sha256 `325f53923ffee0800d9974f7d84fd895ce11f0f9bd3f0ffc977b8d27c11f8e4e`); same binary sha256: true, same build-id: true, same debug sha256: true
- **Identities (including inherited aliases):** Industry@290+2
- **Neighbouring fields considered and rejected:** `last_month_transported`@258+32 (aggregate/array); `type`@292+1 (already original/prior gold)
- **Rationale:** Production scheduling countdown; prior industry gold covered construction date, output year, industry kind and founder.
- **Independence:** physical identity absent from original70 structural gold and prior fresh50 structural identities (mechanically checked); semantic label not present in any prior gold; query text not a duplicate or paraphrase-match of any prior query.

### SV2-OP-13 — Industry.selected_layout (openttd)

- **Query:** Which of this industry type's possible map layouts is this particular site using?
- **Member:** class `Industry` (DWARF declaration: `class Industry`, class size 512), field `selected_layout`, **offset 460**, **size 1**, type `unsigned char`
- **Owning class of the member:** `Industry` at owning offset 460 (declared directly in this class)
- **Binary identity:** sha256 `8f1686353f2b1325a1bcf78a9db0d4be3a1fcce3151cf242a87ce3e063fa9bd5`, build-id `d878fe2573ea43be2209d5ea5afef0b476f39d70`, debug file sha256 `9f7cbd3075c4ad5c388a11ff8ba17a2c661195e06f7297616f8c0fe0312db5be`
- **Layout authority:** `reports/investigations/jev-realgame-final/layout-openttd.json` (sha256 `3b85b9add5a47858d35959d582c49f6ce1b49707011f905f86abafd4227ba5a2`), schema `hex-jev-realgame-struct-layout/v1`, extracted 2026-09-30T08:28:43.078Z, method `GDB Python compiler/DWARF Type.fields, byte offsets, actual sizeof, declared owner, and recursive base adjustments`, extractor sha256 `c554bd4412c4fdd8697ad9f5b151d80e82f0ad920f6a67648810b7b611170177`
- **Independent cross-check:** identical member (offset/size/type/owner) in `reports/investigations/jev-realgame-final/fresh-layout-openttd.json` (sha256 `325f53923ffee0800d9974f7d84fd895ce11f0f9bd3f0ffc977b8d27c11f8e4e`); same binary sha256: true, same build-id: true, same debug sha256: true
- **Identities (including inherited aliases):** Industry@460+1
- **Neighbouring fields considered and rejected:** `last_cargo_accepted_at`@396+64 (aggregate/array); `exclusive_supplier`@461+1
- **Rationale:** Layout variant byte for the placed industry; a different subsystem (map presentation) from prior industry gold.
- **Independence:** physical identity absent from original70 structural gold and prior fresh50 structural identities (mechanically checked); semantic label not present in any prior gold; query text not a duplicate or paraphrase-match of any prior query.

### SV2-OP-14 — Group.parent (openttd)

- **Query:** Which group does this group sit underneath in the group hierarchy?
- **Member:** class `Group` (DWARF declaration: `class Group`, class size 88), field `parent`, **offset 82**, **size 2**, type `unsigned short`
- **Owning class of the member:** `Group` at owning offset 82 (declared directly in this class)
- **Binary identity:** sha256 `8f1686353f2b1325a1bcf78a9db0d4be3a1fcce3151cf242a87ce3e063fa9bd5`, build-id `d878fe2573ea43be2209d5ea5afef0b476f39d70`, debug file sha256 `9f7cbd3075c4ad5c388a11ff8ba17a2c661195e06f7297616f8c0fe0312db5be`
- **Layout authority:** `reports/investigations/jev-realgame-final/layout-openttd.json` (sha256 `3b85b9add5a47858d35959d582c49f6ce1b49707011f905f86abafd4227ba5a2`), schema `hex-jev-realgame-struct-layout/v1`, extracted 2026-09-30T08:28:43.078Z, method `GDB Python compiler/DWARF Type.fields, byte offsets, actual sizeof, declared owner, and recursive base adjustments`, extractor sha256 `c554bd4412c4fdd8697ad9f5b151d80e82f0ad920f6a67648810b7b611170177`
- **Independent cross-check:** identical member (offset/size/type/owner) in `reports/investigations/jev-realgame-final/fresh-layout-openttd.json` (sha256 `325f53923ffee0800d9974f7d84fd895ce11f0f9bd3f0ffc977b8d27c11f8e4e`); same binary sha256: true, same build-id: true, same debug sha256: true
- **Identities (including inherited aliases):** Group@82+2
- **Neighbouring fields considered and rejected:** `folded`@80+1 (already original/prior gold)
- **Rationale:** Hierarchy link of the vehicle group tree; prior group gold only covered the collapsed-in-list GUI flag.
- **Independence:** physical identity absent from original70 structural gold and prior fresh50 structural identities (mechanically checked); semantic label not present in any prior gold; query text not a duplicate or paraphrase-match of any prior query.

### SV2-OP-15 — Window.parent (openttd)

- **Query:** Which window opened this one?
- **Member:** class `Window` (DWARF declaration: `class Window`, class size 192), field `parent`, **offset 176**, **size 8**, type `Window *`
- **Owning class of the member:** `Window` at owning offset 176 (declared directly in this class)
- **Binary identity:** sha256 `8f1686353f2b1325a1bcf78a9db0d4be3a1fcce3151cf242a87ce3e063fa9bd5`, build-id `d878fe2573ea43be2209d5ea5afef0b476f39d70`, debug file sha256 `9f7cbd3075c4ad5c388a11ff8ba17a2c661195e06f7297616f8c0fe0312db5be`
- **Layout authority:** `reports/investigations/jev-realgame-final/layout-openttd.json` (sha256 `3b85b9add5a47858d35959d582c49f6ce1b49707011f905f86abafd4227ba5a2`), schema `hex-jev-realgame-struct-layout/v1`, extracted 2026-09-30T08:28:43.078Z, method `GDB Python compiler/DWARF Type.fields, byte offsets, actual sizeof, declared owner, and recursive base adjustments`, extractor sha256 `c554bd4412c4fdd8697ad9f5b151d80e82f0ad920f6a67648810b7b611170177`
- **Independent cross-check:** identical member (offset/size/type/owner) in `reports/investigations/jev-realgame-final/fresh-layout-openttd.json` (sha256 `325f53923ffee0800d9974f7d84fd895ce11f0f9bd3f0ffc977b8d27c11f8e4e`); same binary sha256: true, same build-id: true, same debug sha256: true
- **Identities (including inherited aliases):** Window@176+8, LinkGraphLegendWindow@176+8
- **Neighbouring fields considered and rejected:** `mouse_capture_widget`@168+4; `z_position`@184+8 (aggregate/array)
- **Rationale:** Pointer to the spawning window; prior window gold covered descriptor, class, screen number and horizontal position.
- **Independence:** physical identity absent from original70 structural gold and prior fresh50 structural identities (mechanically checked); semantic label not present in any prior gold; query text not a duplicate or paraphrase-match of any prior query.

### SV2-OP-16 — Company.avail_railtypes (openttd)

- **Query:** Which rail types is this company currently allowed to use?
- **Member:** class `Company` (DWARF declaration: `class Company`, class size 8608), field `avail_railtypes`, **offset 7792**, **size 8**, type `RailTypes`
- **Owning class of the member:** `Company` at owning offset 7792 (declared directly in this class)
- **Binary identity:** sha256 `8f1686353f2b1325a1bcf78a9db0d4be3a1fcce3151cf242a87ce3e063fa9bd5`, build-id `d878fe2573ea43be2209d5ea5afef0b476f39d70`, debug file sha256 `9f7cbd3075c4ad5c388a11ff8ba17a2c661195e06f7297616f8c0fe0312db5be`
- **Layout authority:** `reports/investigations/jev-realgame-final/layout-openttd.json` (sha256 `3b85b9add5a47858d35959d582c49f6ce1b49707011f905f86abafd4227ba5a2`), schema `hex-jev-realgame-struct-layout/v1`, extracted 2026-09-30T08:28:43.078Z, method `GDB Python compiler/DWARF Type.fields, byte offsets, actual sizeof, declared owner, and recursive base adjustments`, extractor sha256 `c554bd4412c4fdd8697ad9f5b151d80e82f0ad920f6a67648810b7b611170177`
- **Independent cross-check:** class present only in the primary extract; identity is bound through the shared binary sha256/build-id/debug sha256 pair verified identical across parent and fresh extracts.
- **Identities (including inherited aliases):** Company@7792+8
- **Neighbouring fields considered and rejected:** `index`@7788+1; `avail_roadtypes`@7800+8
- **Rationale:** Company-owned bitset declared after the shared properties base; original company gold lived entirely inside the inherited properties region.
- **Independence:** physical identity absent from original70 structural gold and prior fresh50 structural identities (mechanically checked); semantic label not present in any prior gold; query text not a duplicate or paraphrase-match of any prior query.

### SV2-OP-17 — ClientNetworkGameSocketHandler.status (openttd)

- **Query:** What is the current connection state of this multiplayer client session?
- **Member:** class `ClientNetworkGameSocketHandler` (DWARF declaration: `class ClientNetworkGameSocketHandler`, class size 152), field `status`, **offset 148**, **size 4**, type `ClientNetworkGameSocketHandler::ServerStatus`
- **Owning class of the member:** `ClientNetworkGameSocketHandler` at owning offset 148 (declared directly in this class)
- **Binary identity:** sha256 `8f1686353f2b1325a1bcf78a9db0d4be3a1fcce3151cf242a87ce3e063fa9bd5`, build-id `d878fe2573ea43be2209d5ea5afef0b476f39d70`, debug file sha256 `9f7cbd3075c4ad5c388a11ff8ba17a2c661195e06f7297616f8c0fe0312db5be`
- **Layout authority:** `reports/investigations/jev-realgame-final/layout-openttd.json` (sha256 `3b85b9add5a47858d35959d582c49f6ce1b49707011f905f86abafd4227ba5a2`), schema `hex-jev-realgame-struct-layout/v1`, extracted 2026-09-30T08:28:43.078Z, method `GDB Python compiler/DWARF Type.fields, byte offsets, actual sizeof, declared owner, and recursive base adjustments`, extractor sha256 `c554bd4412c4fdd8697ad9f5b151d80e82f0ad920f6a67648810b7b611170177`
- **Independent cross-check:** class present only in the primary extract; identity is bound through the shared binary sha256/build-id/debug sha256 pair verified identical across parent and fresh extracts.
- **Identities (including inherited aliases):** ClientNetworkGameSocketHandler@148+4
- **Neighbouring fields considered and rejected:** `token`@144+1
- **Rationale:** Connection/session state on the multiplayer client handler; a subsystem (networking) that no original or prior case touches.
- **Independence:** physical identity absent from original70 structural gold and prior fresh50 structural identities (mechanically checked); semantic label not present in any prior gold; query text not a duplicate or paraphrase-match of any prior query.

### SV2-OP-18 — GRFConfig.palette (openttd)

- **Query:** Which colour scheme mode does this NewGRF request for its graphics?
- **Member:** class `GRFConfig` (DWARF declaration: `class GRFConfig`, class size 688), field `palette`, **offset 646**, **size 1**, type `unsigned char`
- **Owning class of the member:** `GRFConfig` at owning offset 646 (declared directly in this class)
- **Binary identity:** sha256 `8f1686353f2b1325a1bcf78a9db0d4be3a1fcce3151cf242a87ce3e063fa9bd5`, build-id `d878fe2573ea43be2209d5ea5afef0b476f39d70`, debug file sha256 `9f7cbd3075c4ad5c388a11ff8ba17a2c661195e06f7297616f8c0fe0312db5be`
- **Layout authority:** `reports/investigations/jev-realgame-final/layout-openttd.json` (sha256 `3b85b9add5a47858d35959d582c49f6ce1b49707011f905f86abafd4227ba5a2`), schema `hex-jev-realgame-struct-layout/v1`, extracted 2026-09-30T08:28:43.078Z, method `GDB Python compiler/DWARF Type.fields, byte offsets, actual sizeof, declared owner, and recursive base adjustments`, extractor sha256 `c554bd4412c4fdd8697ad9f5b151d80e82f0ad920f6a67648810b7b611170177`
- **Independent cross-check:** class present only in the primary extract; identity is bound through the shared binary sha256/build-id/debug sha256 pair verified identical across parent and fresh extracts.
- **Identities (including inherited aliases):** GRFConfig@646+1
- **Neighbouring fields considered and rejected:** `num_valid_params`@645+1; `param_info`@648+24 (aggregate/array)
- **Rationale:** Graphics-extension configuration byte; NewGRF configuration members are absent from both original and prior gold.
- **Independence:** physical identity absent from original70 structural gold and prior fresh50 structural identities (mechanically checked); semantic label not present in any prior gold; query text not a duplicate or paraphrase-match of any prior query.

### SV2-OP-19 — DiagonalTileIterator.base_x (openttd)

- **Query:** At which x coordinate did this diagonal scan of the map begin?
- **Member:** class `DiagonalTileIterator` (DWARF declaration: `class DiagonalTileIterator`, class size 40), field `base_x`, **offset 12**, **size 4**, type `unsigned int`
- **Owning class of the member:** `DiagonalTileIterator` at owning offset 12 (declared directly in this class)
- **Binary identity:** sha256 `8f1686353f2b1325a1bcf78a9db0d4be3a1fcce3151cf242a87ce3e063fa9bd5`, build-id `d878fe2573ea43be2209d5ea5afef0b476f39d70`, debug file sha256 `9f7cbd3075c4ad5c388a11ff8ba17a2c661195e06f7297616f8c0fe0312db5be`
- **Layout authority:** `reports/investigations/jev-realgame-final/layout-openttd.json` (sha256 `3b85b9add5a47858d35959d582c49f6ce1b49707011f905f86abafd4227ba5a2`), schema `hex-jev-realgame-struct-layout/v1`, extracted 2026-09-30T08:28:43.078Z, method `GDB Python compiler/DWARF Type.fields, byte offsets, actual sizeof, declared owner, and recursive base adjustments`, extractor sha256 `c554bd4412c4fdd8697ad9f5b151d80e82f0ad920f6a67648810b7b611170177`
- **Independent cross-check:** class present only in the primary extract; identity is bound through the shared binary sha256/build-id/debug sha256 pair verified identical across parent and fresh extracts.
- **Identities (including inherited aliases):** DiagonalTileIterator@12+4
- **Neighbouring fields considered and rejected:** `tile`@8+4 (aggregate/array); `base_y`@16+4
- **Rationale:** Map-iteration start coordinate; the iterator subsystem appears in neither original nor prior gold.
- **Independence:** physical identity absent from original70 structural gold and prior fresh50 structural identities (mechanically checked); semantic label not present in any prior gold; query text not a duplicate or paraphrase-match of any prior query.

### SV2-OP-20 — LinkGraphLegendWindow.overlay (openttd)

- **Query:** Which overlay does this link graph legend window use to draw its data?
- **Member:** class `LinkGraphLegendWindow` (DWARF declaration: `class LinkGraphLegendWindow`, class size 200), field `overlay`, **offset 192**, **size 8**, type `LinkGraphOverlay *`
- **Owning class of the member:** `LinkGraphLegendWindow` at owning offset 192 (declared directly in this class)
- **Binary identity:** sha256 `8f1686353f2b1325a1bcf78a9db0d4be3a1fcce3151cf242a87ce3e063fa9bd5`, build-id `d878fe2573ea43be2209d5ea5afef0b476f39d70`, debug file sha256 `9f7cbd3075c4ad5c388a11ff8ba17a2c661195e06f7297616f8c0fe0312db5be`
- **Layout authority:** `reports/investigations/jev-realgame-final/layout-openttd.json` (sha256 `3b85b9add5a47858d35959d582c49f6ce1b49707011f905f86abafd4227ba5a2`), schema `hex-jev-realgame-struct-layout/v1`, extracted 2026-09-30T08:28:43.078Z, method `GDB Python compiler/DWARF Type.fields, byte offsets, actual sizeof, declared owner, and recursive base adjustments`, extractor sha256 `c554bd4412c4fdd8697ad9f5b151d80e82f0ad920f6a67648810b7b611170177`
- **Independent cross-check:** class present only in the primary extract; identity is bound through the shared binary sha256/build-id/debug sha256 pair verified identical across parent and fresh extracts.
- **Identities (including inherited aliases):** LinkGraphLegendWindow@192+8
- **Neighbouring fields considered and rejected:** `z_position`@184+8 (aggregate/array)
- **Rationale:** Member declared on a concrete derived window (after the 192-byte Window base), proving derived-class namespace and base-offset handling.
- **Independence:** physical identity absent from original70 structural gold and prior fresh50 structural identities (mechanically checked); semantic label not present in any prior gold; query text not a duplicate or paraphrase-match of any prior query.

### SV2-MW-01 — MWMechanics::CreatureStats.mDrawState (openmw)

- **Query:** Which stance of weapon readiness is this actor's animation in right now?
- **Member:** class `MWMechanics::CreatureStats` (DWARF declaration: `class MWMechanics::CreatureStats`, class size 712), field `mDrawState`, **offset 0**, **size 4**, type `MWMechanics::DrawState`
- **Owning class of the member:** `MWMechanics::CreatureStats` at owning offset 0 (declared directly in this class)
- **Binary identity:** sha256 `a2dcff8a8851e28b3477bc0c5a1317f40e914ae42796255d1283bcce99ccb8db`, build-id `eef0625b6b9af7971e72c4fc8260258b50dcae43`, debug file sha256 `deed9ba59bad9cf0e3ba4446e9f77ece20887929ffd06be0410f4cae76b74b41`
- **Layout authority:** `reports/investigations/jev-realgame-final/layout-openmw.json` (sha256 `2d07d1240d93bcbaf5f278cb5c15b03d16d7e0e4593731bc1fbe86797ea64cb3`), schema `hex-jev-realgame-struct-layout/v1`, extracted 2026-09-30T08:31:31.289Z, method `GDB Python compiler/DWARF Type.fields, byte offsets, actual sizeof, declared owner, and recursive base adjustments`, extractor sha256 `c554bd4412c4fdd8697ad9f5b151d80e82f0ad920f6a67648810b7b611170177`
- **Independent cross-check:** identical member (offset/size/type/owner) in `reports/investigations/jev-realgame-final/fresh-layout-openmw.json` (sha256 `51d19c47bf4165df9182e2f7c234ca3df6689c82be7a417765562fbde1f5a181`); same binary sha256: true, same build-id: true, same debug sha256: true
- **Identities (including inherited aliases):** MWMechanics::CreatureStats@0+4, MWMechanics::NpcStats@0+4
- **Neighbouring fields considered and rejected:** `mAttributes`@4+96 (aggregate/array)
- **Rationale:** Leading member of the actor-stats object (offset 0, no vptr); prior actor gold covered death, knockdown, fall and conversation flags only.
- **Independence:** physical identity absent from original70 structural gold and prior fresh50 structural identities (mechanically checked); semantic label not present in any prior gold; query text not a duplicate or paraphrase-match of any prior query.

### SV2-MW-02 — MWMechanics::NpcStats.mReputation (openmw)

- **Query:** What reputation score does this character currently hold?
- **Member:** class `MWMechanics::NpcStats` (DWARF declaration: `class MWMechanics::NpcStats`, class size 1424), field `mReputation`, **offset 1148**, **size 4**, type `int`
- **Owning class of the member:** `MWMechanics::NpcStats` at owning offset 1148 (declared directly in this class)
- **Binary identity:** sha256 `a2dcff8a8851e28b3477bc0c5a1317f40e914ae42796255d1283bcce99ccb8db`, build-id `eef0625b6b9af7971e72c4fc8260258b50dcae43`, debug file sha256 `deed9ba59bad9cf0e3ba4446e9f77ece20887929ffd06be0410f4cae76b74b41`
- **Layout authority:** `reports/investigations/jev-realgame-final/fresh-layout-openmw.json` (sha256 `51d19c47bf4165df9182e2f7c234ca3df6689c82be7a417765562fbde1f5a181`), schema not embedded in this extract; paired extract schema `hex-jev-realgame-struct-layout/v1`, extract time recorded on the paired extract 2026-09-30T08:31:31.289Z, method `Independent parent rerun of exact-build GDB Type.fields; same audited release/debug build-ID`, parentLayoutSha256 `7c78dc069f52eeb0d584236a7171e01a9fafad2b18d92811470c22872a44319d`
- **Independent cross-check:** class present only in the primary extract; identity is bound through the shared binary sha256/build-id/debug sha256 pair verified identical across parent and fresh extracts.
- **Identities (including inherited aliases):** MWMechanics::NpcStats@1148+4
- **Neighbouring fields considered and rejected:** `mSkill`@716+432 (aggregate/array); `mCrimeId`@1152+4
- **Rationale:** NPC social-scope member distinct from disposition and bounty, both of which are already prior gold.
- **Independence:** physical identity absent from original70 structural gold and prior fresh50 structural identities (mechanically checked); semantic label not present in any prior gold; query text not a duplicate or paraphrase-match of any prior query.

### SV2-MW-03 — MWMechanics::AiSequence.mLastAiPackage (openmw)

- **Query:** What kind of AI task was this actor running most recently?
- **Member:** class `MWMechanics::AiSequence` (DWARF declaration: `class MWMechanics::AiSequence`, class size 56), field `mLastAiPackage`, **offset 44**, **size 4**, type `MWMechanics::AiPackageTypeId`
- **Owning class of the member:** `MWMechanics::AiSequence` at owning offset 44 (declared directly in this class)
- **Binary identity:** sha256 `a2dcff8a8851e28b3477bc0c5a1317f40e914ae42796255d1283bcce99ccb8db`, build-id `eef0625b6b9af7971e72c4fc8260258b50dcae43`, debug file sha256 `deed9ba59bad9cf0e3ba4446e9f77ece20887929ffd06be0410f4cae76b74b41`
- **Layout authority:** `reports/investigations/jev-realgame-final/fresh-layout-openmw.json` (sha256 `51d19c47bf4165df9182e2f7c234ca3df6689c82be7a417765562fbde1f5a181`), schema not embedded in this extract; paired extract schema `hex-jev-realgame-struct-layout/v1`, extract time recorded on the paired extract 2026-09-30T08:31:31.289Z, method `Independent parent rerun of exact-build GDB Type.fields; same audited release/debug build-ID`, parentLayoutSha256 `7c78dc069f52eeb0d584236a7171e01a9fafad2b18d92811470c22872a44319d`
- **Independent cross-check:** class present only in the primary extract; identity is bound through the shared binary sha256/build-id/debug sha256 pair verified identical across parent and fresh extracts.
- **Identities (including inherited aliases):** MWMechanics::AiSequence@44+4
- **Neighbouring fields considered and rejected:** `mNumPursuitPackages`@40+4; `mAiState`@48+8 (aggregate/array)
- **Rationale:** AI package type discriminator; prior AI gold covered only the combat-package counter, a different member and meaning.
- **Independence:** physical identity absent from original70 structural gold and prior fresh50 structural identities (mechanically checked); semantic label not present in any prior gold; query text not a duplicate or paraphrase-match of any prior query.

### SV2-MW-04 — MWMechanics::PathgridGraph.mCell (openmw)

- **Query:** Which world cell record was this path grid graph built for?
- **Member:** class `MWMechanics::PathgridGraph` (DWARF declaration: `class MWMechanics::PathgridGraph`, class size 104), field `mCell`, **offset 0**, **size 8**, type `const ESM::Cell *`
- **Owning class of the member:** `MWMechanics::PathgridGraph` at owning offset 0 (declared directly in this class)
- **Binary identity:** sha256 `a2dcff8a8851e28b3477bc0c5a1317f40e914ae42796255d1283bcce99ccb8db`, build-id `eef0625b6b9af7971e72c4fc8260258b50dcae43`, debug file sha256 `deed9ba59bad9cf0e3ba4446e9f77ece20887929ffd06be0410f4cae76b74b41`
- **Layout authority:** `reports/investigations/jev-realgame-final/layout-openmw.json` (sha256 `2d07d1240d93bcbaf5f278cb5c15b03d16d7e0e4593731bc1fbe86797ea64cb3`), schema `hex-jev-realgame-struct-layout/v1`, extracted 2026-09-30T08:31:31.289Z, method `GDB Python compiler/DWARF Type.fields, byte offsets, actual sizeof, declared owner, and recursive base adjustments`, extractor sha256 `c554bd4412c4fdd8697ad9f5b151d80e82f0ad920f6a67648810b7b611170177`
- **Independent cross-check:** class present only in the primary extract; identity is bound through the shared binary sha256/build-id/debug sha256 pair verified identical across parent and fresh extracts.
- **Identities (including inherited aliases):** MWMechanics::PathgridGraph@0+8
- **Neighbouring fields considered and rejected:** `mPathgrid`@8+8
- **Rationale:** Pointer at offset 0 of the pathfinding graph object; the pathgrid subsystem is untouched by original and prior gold.
- **Independence:** physical identity absent from original70 structural gold and prior fresh50 structural identities (mechanically checked); semantic label not present in any prior gold; query text not a duplicate or paraphrase-match of any prior query.

### SV2-MW-05 — MWPhysics::ActorFrameData.mStuckFrames (openmw)

- **Query:** For how many consecutive physics frames has this actor been unable to move?
- **Member:** class `MWPhysics::ActorFrameData` (DWARF declaration: `class MWPhysics::ActorFrameData`, class size 112), field `mStuckFrames`, **offset 100**, **size 4**, type `unsigned int`
- **Owning class of the member:** `MWPhysics::ActorFrameData` at owning offset 100 (declared directly in this class)
- **Binary identity:** sha256 `a2dcff8a8851e28b3477bc0c5a1317f40e914ae42796255d1283bcce99ccb8db`, build-id `eef0625b6b9af7971e72c4fc8260258b50dcae43`, debug file sha256 `deed9ba59bad9cf0e3ba4446e9f77ece20887929ffd06be0410f4cae76b74b41`
- **Layout authority:** `reports/investigations/jev-realgame-final/layout-openmw.json` (sha256 `2d07d1240d93bcbaf5f278cb5c15b03d16d7e0e4593731bc1fbe86797ea64cb3`), schema `hex-jev-realgame-struct-layout/v1`, extracted 2026-09-30T08:31:31.289Z, method `GDB Python compiler/DWARF Type.fields, byte offsets, actual sizeof, declared owner, and recursive base adjustments`, extractor sha256 `c554bd4412c4fdd8697ad9f5b151d80e82f0ad920f6a67648810b7b611170177`
- **Independent cross-check:** class present only in the primary extract; identity is bound through the shared binary sha256/build-id/debug sha256 pair verified identical across parent and fresh extracts.
- **Identities (including inherited aliases):** MWPhysics::ActorFrameData@100+4
- **Neighbouring fields considered and rejected:** `mOldHeight`@96+4; `mFlying`@104+1
- **Rationale:** Per-frame physics record counter; no prior gold exists in the physics subsystem.
- **Independence:** physical identity absent from original70 structural gold and prior fresh50 structural identities (mechanically checked); semantic label not present in any prior gold; query text not a duplicate or paraphrase-match of any prior query.

### SV2-MW-06 — MWRender::ActorsPaths.mEnabled (openmw)

- **Query:** Is the drawing of actor path overlays switched on?
- **Member:** class `MWRender::ActorsPaths` (DWARF declaration: `class MWRender::ActorsPaths`, class size 64), field `mEnabled`, **offset 56**, **size 1**, type `bool`
- **Owning class of the member:** `MWRender::ActorsPaths` at owning offset 56 (declared directly in this class)
- **Binary identity:** sha256 `a2dcff8a8851e28b3477bc0c5a1317f40e914ae42796255d1283bcce99ccb8db`, build-id `eef0625b6b9af7971e72c4fc8260258b50dcae43`, debug file sha256 `deed9ba59bad9cf0e3ba4446e9f77ece20887929ffd06be0410f4cae76b74b41`
- **Layout authority:** `reports/investigations/jev-realgame-final/layout-openmw.json` (sha256 `2d07d1240d93bcbaf5f278cb5c15b03d16d7e0e4593731bc1fbe86797ea64cb3`), schema `hex-jev-realgame-struct-layout/v1`, extracted 2026-09-30T08:31:31.289Z, method `GDB Python compiler/DWARF Type.fields, byte offsets, actual sizeof, declared owner, and recursive base adjustments`, extractor sha256 `c554bd4412c4fdd8697ad9f5b151d80e82f0ad920f6a67648810b7b611170177`
- **Independent cross-check:** class present only in the primary extract; identity is bound through the shared binary sha256/build-id/debug sha256 pair verified identical across parent and fresh extracts.
- **Identities (including inherited aliases):** MWRender::ActorsPaths@56+1
- **Neighbouring fields considered and rejected:** `mGroups`@8+48 (aggregate/array)
- **Rationale:** Render-overlay enable flag; width-1 coverage in the rendering subsystem with no prior counterpart.
- **Independence:** physical identity absent from original70 structural gold and prior fresh50 structural identities (mechanically checked); semantic label not present in any prior gold; query text not a duplicate or paraphrase-match of any prior query.

### SV2-MW-07 — MWWorld::Ptr.mCell (openmw)

- **Query:** Which cell store holds the cell that contains this world object?
- **Member:** class `MWWorld::Ptr` (DWARF declaration: `class MWWorld::Ptr`, class size 24), field `mCell`, **offset 8**, **size 8**, type `MWWorld::PtrBase<std::remove_const_t>::CellStoreType *`
- **Owning class of the member:** `MWWorld::PtrBase<std::remove_const_t>` at owning offset 8 (inherited base; absolute offset = base location + owning offset, proven by DWARF inheritance records)
- **Binary identity:** sha256 `a2dcff8a8851e28b3477bc0c5a1317f40e914ae42796255d1283bcce99ccb8db`, build-id `eef0625b6b9af7971e72c4fc8260258b50dcae43`, debug file sha256 `deed9ba59bad9cf0e3ba4446e9f77ece20887929ffd06be0410f4cae76b74b41`
- **Layout authority:** `reports/investigations/jev-realgame-final/layout-openmw.json` (sha256 `2d07d1240d93bcbaf5f278cb5c15b03d16d7e0e4593731bc1fbe86797ea64cb3`), schema `hex-jev-realgame-struct-layout/v1`, extracted 2026-09-30T08:31:31.289Z, method `GDB Python compiler/DWARF Type.fields, byte offsets, actual sizeof, declared owner, and recursive base adjustments`, extractor sha256 `c554bd4412c4fdd8697ad9f5b151d80e82f0ad920f6a67648810b7b611170177`
- **Independent cross-check:** class present only in the primary extract; identity is bound through the shared binary sha256/build-id/debug sha256 pair verified identical across parent and fresh extracts.
- **Identities (including inherited aliases):** MWWorld::Ptr@8+8
- **Neighbouring fields considered and rejected:** `mRef`@0+8 (already original/prior gold); `mContainerStore`@16+8
- **Rationale:** Second pointer of the object handle, declared on the injected base class PtrBase at offset 0; the original gold for this class targeted the first pointer only.
- **Independence:** physical identity absent from original70 structural gold and prior fresh50 structural identities (mechanically checked); semantic label not present in any prior gold; query text not a duplicate or paraphrase-match of any prior query.

### SV2-MW-08 — MWWorld::CellStore.mRechargingItemsUpToDate (openmw)

- **Query:** Is the list of items recharging inside this cell still reliable?
- **Member:** class `MWWorld::CellStore` (DWARF declaration: `class MWWorld::CellStore`, class size 736), field `mRechargingItemsUpToDate`, **offset 728**, **size 1**, type `bool`
- **Owning class of the member:** `MWWorld::CellStore` at owning offset 728 (declared directly in this class)
- **Binary identity:** sha256 `a2dcff8a8851e28b3477bc0c5a1317f40e914ae42796255d1283bcce99ccb8db`, build-id `eef0625b6b9af7971e72c4fc8260258b50dcae43`, debug file sha256 `deed9ba59bad9cf0e3ba4446e9f77ece20887929ffd06be0410f4cae76b74b41`
- **Layout authority:** `reports/investigations/jev-realgame-final/fresh-layout-openmw.json` (sha256 `51d19c47bf4165df9182e2f7c234ca3df6689c82be7a417765562fbde1f5a181`), schema not embedded in this extract; paired extract schema `hex-jev-realgame-struct-layout/v1`, extract time recorded on the paired extract 2026-09-30T08:31:31.289Z, method `Independent parent rerun of exact-build GDB Type.fields; same audited release/debug build-ID`, parentLayoutSha256 `7c78dc069f52eeb0d584236a7171e01a9fafad2b18d92811470c22872a44319d`
- **Independent cross-check:** class present only in the primary extract; identity is bound through the shared binary sha256/build-id/debug sha256 pair verified identical across parent and fresh extracts.
- **Identities (including inherited aliases):** MWWorld::CellStore@728+1
- **Neighbouring fields considered and rejected:** `mRechargingItems`@704+24 (aggregate/array)
- **Rationale:** Validity flag at the tail of the cell store; prior cell-store gold covered load state and water level only.
- **Independence:** physical identity absent from original70 structural gold and prior fresh50 structural identities (mechanically checked); semantic label not present in any prior gold; query text not a duplicate or paraphrase-match of any prior query.

### SV2-MW-09 — MWWorld::TimeStamp.mDay (openmw)

- **Query:** Which day number does this timestamp point to?
- **Member:** class `MWWorld::TimeStamp` (DWARF declaration: `class MWWorld::TimeStamp`, class size 8), field `mDay`, **offset 4**, **size 4**, type `int`
- **Owning class of the member:** `MWWorld::TimeStamp` at owning offset 4 (declared directly in this class)
- **Binary identity:** sha256 `a2dcff8a8851e28b3477bc0c5a1317f40e914ae42796255d1283bcce99ccb8db`, build-id `eef0625b6b9af7971e72c4fc8260258b50dcae43`, debug file sha256 `deed9ba59bad9cf0e3ba4446e9f77ece20887929ffd06be0410f4cae76b74b41`
- **Layout authority:** `reports/investigations/jev-realgame-final/fresh-layout-openmw.json` (sha256 `51d19c47bf4165df9182e2f7c234ca3df6689c82be7a417765562fbde1f5a181`), schema not embedded in this extract; paired extract schema `hex-jev-realgame-struct-layout/v1`, extract time recorded on the paired extract 2026-09-30T08:31:31.289Z, method `Independent parent rerun of exact-build GDB Type.fields; same audited release/debug build-ID`, parentLayoutSha256 `7c78dc069f52eeb0d584236a7171e01a9fafad2b18d92811470c22872a44319d`
- **Independent cross-check:** class present only in the primary extract; identity is bound through the shared binary sha256/build-id/debug sha256 pair verified identical across parent and fresh extracts.
- **Identities (including inherited aliases):** MWWorld::TimeStamp@4+4
- **Neighbouring fields considered and rejected:** `mHour`@0+4 (already original/prior gold)
- **Rationale:** Second scalar of the timestamp pair; prior gold used the hour member only, so this is a distinct physical member of the same tiny class.
- **Independence:** physical identity absent from original70 structural gold and prior fresh50 structural identities (mechanically checked); semantic label not present in any prior gold; query text not a duplicate or paraphrase-match of any prior query.

### SV2-MW-10 — ESM::Cell.mRefNumCounter (openmw)

- **Query:** Which running number is used to mint fresh unique references inside this cell record?
- **Member:** class `ESM::Cell` (DWARF declaration: `class ESM::Cell`, class size 240), field `mRefNumCounter`, **offset 184**, **size 4**, type `int`
- **Owning class of the member:** `ESM::Cell` at owning offset 184 (declared directly in this class)
- **Binary identity:** sha256 `a2dcff8a8851e28b3477bc0c5a1317f40e914ae42796255d1283bcce99ccb8db`, build-id `eef0625b6b9af7971e72c4fc8260258b50dcae43`, debug file sha256 `deed9ba59bad9cf0e3ba4446e9f77ece20887929ffd06be0410f4cae76b74b41`
- **Layout authority:** `reports/investigations/jev-realgame-final/fresh-layout-openmw.json` (sha256 `51d19c47bf4165df9182e2f7c234ca3df6689c82be7a417765562fbde1f5a181`), schema not embedded in this extract; paired extract schema `hex-jev-realgame-struct-layout/v1`, extract time recorded on the paired extract 2026-09-30T08:31:31.289Z, method `Independent parent rerun of exact-build GDB Type.fields; same audited release/debug build-ID`, parentLayoutSha256 `7c78dc069f52eeb0d584236a7171e01a9fafad2b18d92811470c22872a44319d`
- **Independent cross-check:** class present only in the primary extract; identity is bound through the shared binary sha256/build-id/debug sha256 pair verified identical across parent and fresh extracts.
- **Identities (including inherited aliases):** ESM::Cell@184+4
- **Neighbouring fields considered and rejected:** `mMapColor`@180+4 (already original/prior gold); `mLeasedRefs`@192+24 (aggregate/array)
- **Rationale:** Reference-number allocator in the saved-game cell record; prior cell gold covered only the map colour.
- **Independence:** physical identity absent from original70 structural gold and prior fresh50 structural identities (mechanically checked); semantic label not present in any prior gold; query text not a duplicate or paraphrase-match of any prior query.

### SV2-MW-11 — ESM::JournalEntry.mType (openmw)

- **Query:** What category of journal entry does this record represent?
- **Member:** class `ESM::JournalEntry` (DWARF declaration: `class ESM::JournalEntry`, class size 152), field `mType`, **offset 0**, **size 4**, type `int`
- **Owning class of the member:** `ESM::JournalEntry` at owning offset 0 (declared directly in this class)
- **Binary identity:** sha256 `a2dcff8a8851e28b3477bc0c5a1317f40e914ae42796255d1283bcce99ccb8db`, build-id `eef0625b6b9af7971e72c4fc8260258b50dcae43`, debug file sha256 `deed9ba59bad9cf0e3ba4446e9f77ece20887929ffd06be0410f4cae76b74b41`
- **Layout authority:** `reports/investigations/jev-realgame-final/fresh-layout-openmw.json` (sha256 `51d19c47bf4165df9182e2f7c234ca3df6689c82be7a417765562fbde1f5a181`), schema not embedded in this extract; paired extract schema `hex-jev-realgame-struct-layout/v1`, extract time recorded on the paired extract 2026-09-30T08:31:31.289Z, method `Independent parent rerun of exact-build GDB Type.fields; same audited release/debug build-ID`, parentLayoutSha256 `7c78dc069f52eeb0d584236a7171e01a9fafad2b18d92811470c22872a44319d`
- **Independent cross-check:** class present only in the primary extract; identity is bound through the shared binary sha256/build-id/debug sha256 pair verified identical across parent and fresh extracts.
- **Identities (including inherited aliases):** ESM::JournalEntry@0+4
- **Neighbouring fields considered and rejected:** `mTopic`@8+32 (aggregate/array)
- **Rationale:** Leading discriminator of the journal record; prior journal gold covered only the day-of-month component.
- **Independence:** physical identity absent from original70 structural gold and prior fresh50 structural identities (mechanically checked); semantic label not present in any prior gold; query text not a duplicate or paraphrase-match of any prior query.

### SV2-MW-12 — ESM::ControlsState.mWeaponDrawingDisabled (openmw)

- **Query:** Has this game state been set so the player cannot draw a weapon?
- **Member:** class `ESM::ControlsState` (DWARF declaration: `class ESM::ControlsState`, class size 7), field `mWeaponDrawingDisabled`, **offset 5**, **size 1**, type `bool`
- **Owning class of the member:** `ESM::ControlsState` at owning offset 5 (declared directly in this class)
- **Binary identity:** sha256 `a2dcff8a8851e28b3477bc0c5a1317f40e914ae42796255d1283bcce99ccb8db`, build-id `eef0625b6b9af7971e72c4fc8260258b50dcae43`, debug file sha256 `deed9ba59bad9cf0e3ba4446e9f77ece20887929ffd06be0410f4cae76b74b41`
- **Layout authority:** `reports/investigations/jev-realgame-final/fresh-layout-openmw.json` (sha256 `51d19c47bf4165df9182e2f7c234ca3df6689c82be7a417765562fbde1f5a181`), schema not embedded in this extract; paired extract schema `hex-jev-realgame-struct-layout/v1`, extract time recorded on the paired extract 2026-09-30T08:31:31.289Z, method `Independent parent rerun of exact-build GDB Type.fields; same audited release/debug build-ID`, parentLayoutSha256 `7c78dc069f52eeb0d584236a7171e01a9fafad2b18d92811470c22872a44319d`
- **Independent cross-check:** class present only in the primary extract; identity is bound through the shared binary sha256/build-id/debug sha256 pair verified identical across parent and fresh extracts.
- **Identities (including inherited aliases):** ESM::ControlsState@5+1
- **Neighbouring fields considered and rejected:** `mVanityModeDisabled`@4+1; `mSpellDrawingDisabled`@6+1
- **Rationale:** Fifth of seven one-byte control switches; prior gold used only the jumping switch, so this is a distinct member of the same packed struct.
- **Independence:** physical identity absent from original70 structural gold and prior fresh50 structural identities (mechanically checked); semantic label not present in any prior gold; query text not a duplicate or paraphrase-match of any prior query.

### SV2-MW-13 — MWGui::WaitDialog.mSleeping (openmw)

- **Query:** Is the player shown as asleep while this dialog counts down the hours?
- **Member:** class `MWGui::WaitDialog` (DWARF declaration: `class MWGui::WaitDialog`, class size 432), field `mSleeping`, **offset 256**, **size 1**, type `bool`
- **Owning class of the member:** `MWGui::WaitDialog` at owning offset 256 (declared directly in this class)
- **Binary identity:** sha256 `a2dcff8a8851e28b3477bc0c5a1317f40e914ae42796255d1283bcce99ccb8db`, build-id `eef0625b6b9af7971e72c4fc8260258b50dcae43`, debug file sha256 `deed9ba59bad9cf0e3ba4446e9f77ece20887929ffd06be0410f4cae76b74b41`
- **Layout authority:** `reports/investigations/jev-realgame-final/fresh-layout-openmw.json` (sha256 `51d19c47bf4165df9182e2f7c234ca3df6689c82be7a417765562fbde1f5a181`), schema not embedded in this extract; paired extract schema `hex-jev-realgame-struct-layout/v1`, extract time recorded on the paired extract 2026-09-30T08:31:31.289Z, method `Independent parent rerun of exact-build GDB Type.fields; same audited release/debug build-ID`, parentLayoutSha256 `7c78dc069f52eeb0d584236a7171e01a9fafad2b18d92811470c22872a44319d`
- **Independent cross-check:** class present only in the primary extract; identity is bound through the shared binary sha256/build-id/debug sha256 pair verified identical across parent and fresh extracts.
- **Identities (including inherited aliases):** MWGui::WaitDialog@256+1
- **Neighbouring fields considered and rejected:** `mTimeAdvancer`@160+96 (aggregate/array); `mHours`@260+4 (already original/prior gold)
- **Rationale:** Dialog phase flag placed just before the previously used hours member; distinct meaning (visual state) from the chosen-hours gold.
- **Independence:** physical identity absent from original70 structural gold and prior fresh50 structural identities (mechanically checked); semantic label not present in any prior gold; query text not a duplicate or paraphrase-match of any prior query.

### SV2-MW-14 — MWGui::MessageBoxManager.mMessageBoxSpeed (openmw)

- **Query:** What speed setting controls how quickly message boxes pop up on screen?
- **Member:** class `MWGui::MessageBoxManager` (DWARF declaration: `class MWGui::MessageBoxManager`, class size 80), field `mMessageBoxSpeed`, **offset 64**, **size 4**, type `float`
- **Owning class of the member:** `MWGui::MessageBoxManager` at owning offset 64 (declared directly in this class)
- **Binary identity:** sha256 `a2dcff8a8851e28b3477bc0c5a1317f40e914ae42796255d1283bcce99ccb8db`, build-id `eef0625b6b9af7971e72c4fc8260258b50dcae43`, debug file sha256 `deed9ba59bad9cf0e3ba4446e9f77ece20887929ffd06be0410f4cae76b74b41`
- **Layout authority:** `reports/investigations/jev-realgame-final/fresh-layout-openmw.json` (sha256 `51d19c47bf4165df9182e2f7c234ca3df6689c82be7a417765562fbde1f5a181`), schema not embedded in this extract; paired extract schema `hex-jev-realgame-struct-layout/v1`, extract time recorded on the paired extract 2026-09-30T08:31:31.289Z, method `Independent parent rerun of exact-build GDB Type.fields; same audited release/debug build-ID`, parentLayoutSha256 `7c78dc069f52eeb0d584236a7171e01a9fafad2b18d92811470c22872a44319d`
- **Independent cross-check:** class present only in the primary extract; identity is bound through the shared binary sha256/build-id/debug sha256 pair verified identical across parent and fresh extracts.
- **Identities (including inherited aliases):** MWGui::MessageBoxManager@64+4
- **Neighbouring fields considered and rejected:** `mStaticMessageBox`@56+8; `mLastButtonPressed`@68+4
- **Rationale:** Float presentation setting; prior message-box gold covered only the visibility flag.
- **Independence:** physical identity absent from original70 structural gold and prior fresh50 structural identities (mechanically checked); semantic label not present in any prior gold; query text not a duplicate or paraphrase-match of any prior query.

### SV2-MW-15 — MWGui::HUD.mCrosshair (openmw)

- **Query:** Which HUD widget draws the aiming crosshair?
- **Member:** class `MWGui::HUD` (DWARF declaration: `class MWGui::HUD`, class size 792), field `mCrosshair`, **offset 576**, **size 8**, type `MyGUI::ImageBox *`
- **Owning class of the member:** `MWGui::HUD` at owning offset 576 (declared directly in this class)
- **Binary identity:** sha256 `a2dcff8a8851e28b3477bc0c5a1317f40e914ae42796255d1283bcce99ccb8db`, build-id `eef0625b6b9af7971e72c4fc8260258b50dcae43`, debug file sha256 `deed9ba59bad9cf0e3ba4446e9f77ece20887929ffd06be0410f4cae76b74b41`
- **Layout authority:** `reports/investigations/jev-realgame-final/fresh-layout-openmw.json` (sha256 `51d19c47bf4165df9182e2f7c234ca3df6689c82be7a417765562fbde1f5a181`), schema not embedded in this extract; paired extract schema `hex-jev-realgame-struct-layout/v1`, extract time recorded on the paired extract 2026-09-30T08:31:31.289Z, method `Independent parent rerun of exact-build GDB Type.fields; same audited release/debug build-ID`, parentLayoutSha256 `7c78dc069f52eeb0d584236a7171e01a9fafad2b18d92811470c22872a44319d`
- **Independent cross-check:** class present only in the primary extract; identity is bound through the shared binary sha256/build-id/debug sha256 pair verified identical across parent and fresh extracts.
- **Identities (including inherited aliases):** MWGui::HUD@576+8
- **Neighbouring fields considered and rejected:** `mMinimap`@568+8; `mCellNameBox`@584+8
- **Rationale:** Pointer member in the middle of the HUD widget table; prior HUD gold covered only the map-visibility flag at the tail. Health/magicka/stamina widget pointers were deliberately avoided.
- **Independence:** physical identity absent from original70 structural gold and prior fresh50 structural identities (mechanically checked); semantic label not present in any prior gold; query text not a duplicate or paraphrase-match of any prior query.

### SV2-MW-16 — MWInput::ControllerManager.mGyroAvailable (openmw)

- **Query:** Can the device's motion sensors be used to steer the camera here?
- **Member:** class `MWInput::ControllerManager` (DWARF declaration: `class MWInput::ControllerManager`, class size 48), field `mGyroAvailable`, **offset 33**, **size 1**, type `bool`
- **Owning class of the member:** `MWInput::ControllerManager` at owning offset 33 (declared directly in this class)
- **Binary identity:** sha256 `a2dcff8a8851e28b3477bc0c5a1317f40e914ae42796255d1283bcce99ccb8db`, build-id `eef0625b6b9af7971e72c4fc8260258b50dcae43`, debug file sha256 `deed9ba59bad9cf0e3ba4446e9f77ece20887929ffd06be0410f4cae76b74b41`
- **Layout authority:** `reports/investigations/jev-realgame-final/fresh-layout-openmw.json` (sha256 `51d19c47bf4165df9182e2f7c234ca3df6689c82be7a417765562fbde1f5a181`), schema not embedded in this extract; paired extract schema `hex-jev-realgame-struct-layout/v1`, extract time recorded on the paired extract 2026-09-30T08:31:31.289Z, method `Independent parent rerun of exact-build GDB Type.fields; same audited release/debug build-ID`, parentLayoutSha256 `7c78dc069f52eeb0d584236a7171e01a9fafad2b18d92811470c22872a44319d`
- **Independent cross-check:** class present only in the primary extract; identity is bound through the shared binary sha256/build-id/debug sha256 pair verified identical across parent and fresh extracts.
- **Identities (including inherited aliases):** MWInput::ControllerManager@33+1
- **Neighbouring fields considered and rejected:** `mJoystickEnabled`@32+1 (already original/prior gold); `mGamepadCursorSpeed`@36+4
- **Rationale:** Capability flag adjacent to, but distinct from, the joystick-enable byte used by prior gold.
- **Independence:** physical identity absent from original70 structural gold and prior fresh50 structural identities (mechanically checked); semantic label not present in any prior gold; query text not a duplicate or paraphrase-match of any prior query.

### SV2-MW-17 — Nif::bhkBlendController.frequency (openmw)

- **Query:** How many blend cycles per second does this animation controller run at?
- **Member:** class `Nif::bhkBlendController` (DWARF declaration: `class Nif::bhkBlendController`, class size 96), field `frequency`, **offset 68**, **size 4**, type `float`
- **Owning class of the member:** `Nif::Controller` at owning offset 68 (inherited base; absolute offset = base location + owning offset, proven by DWARF inheritance records)
- **Binary identity:** sha256 `a2dcff8a8851e28b3477bc0c5a1317f40e914ae42796255d1283bcce99ccb8db`, build-id `eef0625b6b9af7971e72c4fc8260258b50dcae43`, debug file sha256 `deed9ba59bad9cf0e3ba4446e9f77ece20887929ffd06be0410f4cae76b74b41`
- **Layout authority:** `reports/investigations/jev-realgame-final/layout-openmw.json` (sha256 `2d07d1240d93bcbaf5f278cb5c15b03d16d7e0e4593731bc1fbe86797ea64cb3`), schema `hex-jev-realgame-struct-layout/v1`, extracted 2026-09-30T08:31:31.289Z, method `GDB Python compiler/DWARF Type.fields, byte offsets, actual sizeof, declared owner, and recursive base adjustments`, extractor sha256 `c554bd4412c4fdd8697ad9f5b151d80e82f0ad920f6a67648810b7b611170177`
- **Independent cross-check:** class present only in the primary extract; identity is bound through the shared binary sha256/build-id/debug sha256 pair verified identical across parent and fresh extracts.
- **Identities (including inherited aliases):** Nif::bhkBlendController@68+4
- **Neighbouring fields considered and rejected:** `flags`@64+4; `phase`@72+4
- **Rationale:** Declared on the inherited Nif::Controller base at offset 0 (record base offset proven in DWARF); mesh-animation subsystem has no prior gold.
- **Independence:** physical identity absent from original70 structural gold and prior fresh50 structural identities (mechanically checked); semantic label not present in any prior gold; query text not a duplicate or paraphrase-match of any prior query.

### SV2-MW-18 — SDLUtil::SDLCursorManager.mInitialized (openmw)

- **Query:** Has the software cursor system finished its initial setup?
- **Member:** class `SDLUtil::SDLCursorManager` (DWARF declaration: `class SDLUtil::SDLCursorManager`, class size 96), field `mInitialized`, **offset 89**, **size 1**, type `bool`
- **Owning class of the member:** `SDLUtil::SDLCursorManager` at owning offset 89 (declared directly in this class)
- **Binary identity:** sha256 `a2dcff8a8851e28b3477bc0c5a1317f40e914ae42796255d1283bcce99ccb8db`, build-id `eef0625b6b9af7971e72c4fc8260258b50dcae43`, debug file sha256 `deed9ba59bad9cf0e3ba4446e9f77ece20887929ffd06be0410f4cae76b74b41`
- **Layout authority:** `reports/investigations/jev-realgame-final/layout-openmw.json` (sha256 `2d07d1240d93bcbaf5f278cb5c15b03d16d7e0e4593731bc1fbe86797ea64cb3`), schema `hex-jev-realgame-struct-layout/v1`, extracted 2026-09-30T08:31:31.289Z, method `GDB Python compiler/DWARF Type.fields, byte offsets, actual sizeof, declared owner, and recursive base adjustments`, extractor sha256 `c554bd4412c4fdd8697ad9f5b151d80e82f0ad920f6a67648810b7b611170177`
- **Independent cross-check:** class present only in the primary extract; identity is bound through the shared binary sha256/build-id/debug sha256 pair verified identical across parent and fresh extracts.
- **Identities (including inherited aliases):** SDLUtil::SDLCursorManager@89+1
- **Neighbouring fields considered and rejected:** `mEnabled`@88+1
- **Rationale:** Second byte of the cursor-manager state pair; no prior gold exists in this class.
- **Independence:** physical identity absent from original70 structural gold and prior fresh50 structural identities (mechanically checked); semantic label not present in any prior gold; query text not a duplicate or paraphrase-match of any prior query.

### SV2-MW-19 — SceneUtil::RigGeometryHolder.mIsBodyPart (openmw)

- **Query:** Does the engine classify this skinned mesh as part of a creature's body?
- **Member:** class `SceneUtil::RigGeometryHolder` (DWARF declaration: `class SceneUtil::RigGeometryHolder`, class size 384), field `mIsBodyPart`, **offset 380**, **size 1**, type `bool`
- **Owning class of the member:** `SceneUtil::RigGeometryHolder` at owning offset 380 (declared directly in this class)
- **Binary identity:** sha256 `a2dcff8a8851e28b3477bc0c5a1317f40e914ae42796255d1283bcce99ccb8db`, build-id `eef0625b6b9af7971e72c4fc8260258b50dcae43`, debug file sha256 `deed9ba59bad9cf0e3ba4446e9f77ece20887929ffd06be0410f4cae76b74b41`
- **Layout authority:** `reports/investigations/jev-realgame-final/layout-openmw.json` (sha256 `2d07d1240d93bcbaf5f278cb5c15b03d16d7e0e4593731bc1fbe86797ea64cb3`), schema `hex-jev-realgame-struct-layout/v1`, extracted 2026-09-30T08:31:31.289Z, method `GDB Python compiler/DWARF Type.fields, byte offsets, actual sizeof, declared owner, and recursive base adjustments`, extractor sha256 `c554bd4412c4fdd8697ad9f5b151d80e82f0ad920f6a67648810b7b611170177`
- **Independent cross-check:** class present only in the primary extract; identity is bound through the shared binary sha256/build-id/debug sha256 pair verified identical across parent and fresh extracts.
- **Identities (including inherited aliases):** SceneUtil::RigGeometryHolder@380+1
- **Neighbouring fields considered and rejected:** `mLastFrameNumber`@376+4
- **Rationale:** Trailing flag of the rigged-geometry holder near the 384-byte class end; skeleton/mesh subsystem is absent from all prior gold.
- **Independence:** physical identity absent from original70 structural gold and prior fresh50 structural identities (mechanically checked); semantic label not present in any prior gold; query text not a duplicate or paraphrase-match of any prior query.

### SV2-MW-20 — Compiler::Output.mLocals (openmw)

- **Query:** Which table of local variables does this compiled output refer to?
- **Member:** class `Compiler::Output` (DWARF declaration: `class Compiler::Output`, class size 104), field `mLocals`, **offset 96**, **size 8**, type `Compiler::Locals &`
- **Owning class of the member:** `Compiler::Output` at owning offset 96 (declared directly in this class)
- **Binary identity:** sha256 `a2dcff8a8851e28b3477bc0c5a1317f40e914ae42796255d1283bcce99ccb8db`, build-id `eef0625b6b9af7971e72c4fc8260258b50dcae43`, debug file sha256 `deed9ba59bad9cf0e3ba4446e9f77ece20887929ffd06be0410f4cae76b74b41`
- **Layout authority:** `reports/investigations/jev-realgame-final/layout-openmw.json` (sha256 `2d07d1240d93bcbaf5f278cb5c15b03d16d7e0e4593731bc1fbe86797ea64cb3`), schema `hex-jev-realgame-struct-layout/v1`, extracted 2026-09-30T08:31:31.289Z, method `GDB Python compiler/DWARF Type.fields, byte offsets, actual sizeof, declared owner, and recursive base adjustments`, extractor sha256 `c554bd4412c4fdd8697ad9f5b151d80e82f0ad920f6a67648810b7b611170177`
- **Independent cross-check:** class present only in the primary extract; identity is bound through the shared binary sha256/build-id/debug sha256 pair verified identical across parent and fresh extracts.
- **Identities (including inherited aliases):** Compiler::Output@96+8
- **Neighbouring fields considered and rejected:** `mCode`@72+24 (aggregate/array)
- **Rationale:** Reference-width member of the script compiler output, giving compiler-subsystem and reference-type coverage with no prior counterpart.
- **Independence:** physical identity absent from original70 structural gold and prior fresh50 structural identities (mechanically checked); semantic label not present in any prior gold; query text not a duplicate or paraphrase-match of any prior query.

## Control / abstain cases (10)

Five per binary. None is answerable from the exact-build layout authority or from any datum these binaries track; correct behaviour is abstention.

### SV2-CTL-01 — control (openttd)

- **Query:** How many millimetres of rain have fallen on this station today?
- **Expected:** abstain (no gold identity).

### SV2-CTL-02 — control (openttd)

- **Query:** What is the licence plate number of this road vehicle?
- **Expected:** abstain (no gold identity).

### SV2-CTL-03 — control (openttd)

- **Query:** How much noise, in decibels, does this aircraft produce during take-off?
- **Expected:** abstain (no gold identity).

### SV2-CTL-04 — control (openttd)

- **Query:** Which real-world city has a street layout most similar to this town?
- **Expected:** abstain (no gold identity).

### SV2-CTL-05 — control (openttd)

- **Query:** How many days of paid holiday does this company's president receive each year?
- **Expected:** abstain (no gold identity).

### SV2-CTL-06 — control (openmw)

- **Query:** How many pages does the book this character is reading contain?
- **Expected:** abstain (no gold identity).

### SV2-CTL-07 — control (openmw)

- **Query:** What is this character's favourite colour?
- **Expected:** abstain (no gold identity).

### SV2-CTL-08 — control (openmw)

- **Query:** How many languages can this character speak fluently?
- **Expected:** abstain (no gold identity).

### SV2-CTL-09 — control (openmw)

- **Query:** How many fish are currently swimming in this lake?
- **Expected:** abstain (no gold identity).

### SV2-CTL-10 — control (openmw)

- **Query:** How long would it take to boil water at this location's altitude?
- **Expected:** abstain (no gold identity).

## Mechanical validation summary

- Verified members matched against authority: 40/40 offset, size and type exact; 0 aggregates, 0 arrays, 0 vptrs, all widths in {1,2,4,8}.
- Width histogram (verified): {"1":12,"2":5,"4":13,"8":10}.
- Distinct owning classes: 36.
- Physical identities emitted (including inherited aliases): 56; overlaps with original70 structural gold (142 identities) and prior fresh50 structural identities (71 identities): **0**.
- Prior semantic labels reused: **0**. Forbidden query patterns (Class.field / member_0x / offsets / hex / snake_case): **0**. Duplicate queries within this holdout: **0**. Exact collisions with prior query text: **0**.
- Distribution: {"total":50,"verified":40,"control":10,"openttdVerified":20,"openmwVerified":20,"openttdControl":5,"openmwControl":5}.

## Limitations

1. The exact-build OpenMW extracts contain **no 2-byte members at all** (verified mechanically across both OpenMW layout files), so OpenMW verified cases cover widths 1, 4 and 8 only; 2-byte coverage comes from the OpenTTD half. This is a property of the provided authority, not a selection preference.
2. Classes reported `unresolved` by the extractor (`ActorStats`, unqualified `CreatureStats`, `osg::Texture2D`, `std::vector<Terrain::TextureLayer, ...>`) were not usable, which is why no case may reference them; this also matches the original gold, whose ActorStats labels carry no exact identity.
3. Semantic interpretation in each *query* and *rationale* is the query author's natural-language framing; only offset, size, type, class and owning-class facts come from DWARF. The `semanticLabel` field is report-only and must never reach production candidate descriptions.
4. Some classes appear in only one of the two extracts for a binary; for those, identity binding relies on the byte-identical binary sha256 / build-id / debug sha256 pair that was verified across parent and fresh extracts, plus the shared extractor identity.
5. Original70 carried a few annotations whose offsets disagreed with the exact build (`annotationOffsetMismatch`); this holdout ignores those annotations entirely and reads only exact authority, so no mismatch is inherited.
6. No health, fatigue/stamina or magicka/energy pool case is present, per instruction and per the oracle authority's rejected `CreatureStats.mSpells` alternative.
7. This package is prospective: it was frozen before any evaluator ran against it, and it contains no result, metric, or candidate information.
