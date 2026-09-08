const READ_SCOPES = Object.freeze(["auto", "selection", "function", "neighborhood", "binary", "project", "runtime"]);

export function analysisToolContract(toolRegistry, toolName) {
  if (typeof toolName !== "string" || !toolName) {
    throw new Error(`invalid-analysis-tool-id:${toolIdentityLabel(toolName)}`);
  }
  const tool = toolRegistry?.get?.(toolName);
  if (!tool) {
    throw new Error(`unknown-analysis-tool:${toolName}`);
  }

  const scopeSupport = Object.freeze([...(tool.scopeSupport || [])]);
  return Object.freeze({
    name: String(tool.name),
    scopeSupport,
    mutability: String(tool.mutability || "read-only"),
    needsApproval: Boolean(tool.needsApproval),
    inputSchema: tool.inputSchema,
  });
}

export function auditCapabilityToolContracts({ capabilities = [], toolRegistry } = {}) {
  const rows = [];
  const errors = [];

  for (const cap of capabilities) {
    if (cap.agentTool === undefined) continue;
    if (typeof cap.agentTool !== "string" || !cap.agentTool) {
      // Explicitly present malformed tool identities must fail the contract
      // audit instead of disappearing through truthiness or String() coercion
      // at this machine-enforcement boundary (#6160).
      const error = `invalid-agent-tool-id:${toolIdentityLabel(cap.agentTool)}`;
      errors.push(error);
      rows.push({
        capabilityId: cap.id,
        agentTool: cap.agentTool,
        toolPresent: false,
        scopeSupport: null,
        mutability: null,
        needsApproval: null,
        errors: [error],
      });
      continue;
    }
    const tool = toolRegistry?.get?.(cap.agentTool);
    const rowErrors = [];
    const toolPresent = Boolean(tool);

    if (!toolPresent) {
      rowErrors.push(`missing-tool:${cap.agentTool}`);
    } else {
      if (tool.mutability !== "read-only") {
        rowErrors.push(`analysis-tool-not-read-only:${cap.agentTool}`);
      }
      if (tool.needsApproval) {
        rowErrors.push(`analysis-tool-needs-approval:${cap.agentTool}`);
      }

      const seenScopes = new Set();
      for (const s of tool.scopeSupport || []) {
        if (!READ_SCOPES.includes(s)) {
          rowErrors.push(`invalid-tool-scope:${cap.agentTool}:${s}`);
        }
        if (seenScopes.has(s)) {
          rowErrors.push(`duplicate-tool-scope:${cap.agentTool}:${s}`);
        }
        seenScopes.add(s);
      }
    }

    errors.push(...rowErrors);
    rows.push({
      capabilityId: cap.id,
      agentTool: cap.agentTool,
      toolPresent,
      scopeSupport: tool?.scopeSupport ? [...tool.scopeSupport] : null,
      mutability: tool?.mutability ?? null,
      needsApproval: tool ? Boolean(tool.needsApproval) : null,
      errors: rowErrors,
    });
  }

  return {
    ok: errors.length === 0,
    rows,
    errors,
  };
}

function toolIdentityLabel(value) {
  if (value === null) return "null";
  const type = typeof value;
  if (type === "object") {
    // Never inspect caller-owned objects while formatting a machine-boundary
    // error. Array.isArray does not enumerate or coerce values; a revoked
    // proxy is treated as an opaque object rather than escaping its TypeError.
    try { return Array.isArray(value) ? "array" : "object"; } catch { return "object"; }
  }
  if (type === "function") return "function";
  // Primitive conversion cannot dispatch caller-owned hooks, and preserves
  // the useful existing labels for primitive invalid identities.
  return `${type}:${String(value)}`;
}
