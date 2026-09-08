// Regression for #6169: parseInteger()'s accepted string grammar admitted a
// sign on prefixed hex (`+0x10` / `-0x10`) but the conversion used
// `BigInt(text)`, which throws a SyntaxError for signed prefixed-hex strings.
// The regex-advertised inputs therefore failed as `invalid-argument` while the
// same values in every other representation (0x10, '16', 16n) were accepted —
// tool availability depended on the model's chosen textual spelling. The sign
// is now split off and applied to the converted unsigned literal.
import assert from 'node:assert/strict';
import { createAgentTools } from '../js/agent/tools.js';

const tools = createAgentTools({ analyze: async () => null }, { maxFunctions: 8 });

{
  // Public surface: a signed prefixed-hex address is the same integer as its
  // unsigned spelling and must not be rejected.
  const plain = await tools.get_function('0x10');
  const signed = await tools.get_function('+0x10');
  assert.equal(signed.address, plain.address, 'a +0x-prefixed address resolves to the same value');
}

{
  // A signed parseInteger boundary (find_thresholds' value filter, which also
  // admits negative thresholds) accepts the ±0x-prefixed spellings its grammar
  // advertises; on main both variants threw invalid-argument.
  const positive = await tools.find_thresholds('0x1000', { value: '+0x10' });
  assert.equal(positive.address, 4096n, 'a +0x-prefixed filter value parses (0x1000 function address)');
  const negative = await tools.find_thresholds('0x1000', { value: '-0x10' });
  assert.equal(negative.address, 4096n, 'a -0x-prefixed filter value parses (0x1000 function address)');
}

{
  // Non-negative parse boundaries still reject negative results and garbage.
  await assert.rejects(() => tools.get_function('-16'), /non-negative/);
  await assert.rejects(() => tools.get_function('0x'), /must be a non-negative integer|invalid-argument/);
  await assert.rejects(() => tools.get_function('++0x10'), /must be a non-negative integer|invalid-argument/);
  await assert.rejects(() => tools.get_function('0x1g'), /must be a non-negative integer|invalid-argument/);
}
