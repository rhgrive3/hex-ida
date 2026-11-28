# Hex UI Audit — Current Reference Pointer

> **Historical pre-product-shell audit:** [`archive/ui/ui-audit-pre-diff-route.md`](archive/ui/ui-audit-pre-diff-route.md)  
> **Owning route registry:** `js/ui/registry.js`  
> **Canonical UI contract:** [`ui-information-architecture.md`](ui-information-architecture.md)

The archived audit preserves the legacy 54-entry screen inventory and initial
migration rationale. Use the live code and canonical architecture document for
all current UI decisions:

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
