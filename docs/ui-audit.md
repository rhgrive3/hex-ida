# Hex UI Audit — Current Reference Pointer

> **Owning route registry:** `js/ui/registry.js`  
> **Canonical UI contract:** [`ui-information-architecture.md`](ui-information-architecture.md)

The legacy 54-entry screen migration mapping is maintained directly in
`LEGACY_MIGRATION` inside `js/ui/registry.js`. For current UI architecture and
decisions, refer to [`ui-information-architecture.md`](ui-information-architecture.md)
and the live code:

- **Canonical routes:** **11** routes/workspaces defined in `js/ui/registry.js`
  (`/investigate`, `/code/:address?`, `/explorer/:scope?`, `/results`, `/diff`,
  `/function/:address/:tab?`, `/finding/:id`, `/settings`, `/help`, `/learn`,
  `/advanced`).
- **Primary navigation:** **4** persistent entries (`PRIMARY_NAV`: Investigate,
  Code, Explorer, Results), with `/code` as the default landing route.
- **Contextual workbench integration:** `js/ui/v6-workbench-bridge.js` attaches
  contextual popovers and modals (Type Edit, Slice Panel, Export Interop,
  Manual Recovery) and Clean View formatting without adding top-level
  navigation tabs.
- **Verification:** `npm run ui:test` (`tests/ui/routes.mjs`, `tests/ux.mjs`,
  `tests/ui/next-views.mjs`, `tests/ui/integration-hardening.mjs`, etc.) and
  `npm run ui:browser` enforce route, layout, mobile, and accessibility
  invariants.
