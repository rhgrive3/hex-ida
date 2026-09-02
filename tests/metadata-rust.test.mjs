import assert from 'node:assert/strict';
import {
  RustMetadataProvider,
  demangleRustV0,
  demangleRustLegacy,
  demangleRustSymbol,
  findRustcVersion,
  isRustLayoutStable,
} from '../js/metadata/rust.js';

console.log('Testing Rust Metadata Provider...');

// 1. Positive: Rust v0 Demangling (RFC 2603)
{
  // Crate root: _RC4core
  const r1 = demangleRustV0('_RC4core');
  assert.equal(r1.parsed, true);
  assert.equal(r1.demangled, 'core');
  assert.equal(r1.crate, 'core');
  assert.equal(r1.generation, 'v0');

  // Path with namespaces: _RNvNtC4core3fmt3num
  const r2 = demangleRustV0('_RNvNtC4core3fmt3num');
  assert.equal(r2.parsed, true);
  assert.equal(r2.demangled, 'core::fmt::num');

  // Impl path: _RNvM4core3str
  const r3 = demangleRustV0('_RNvM4core3str');
  assert.equal(r3.parsed, true);
  assert.equal(r3.demangled, '<core::str>');
}

// 2. Positive: Rust Legacy Demangling
{
  // Typical legacy symbol: _ZN4core3fmt3num17h1234567890abcdefE
  const r1 = demangleRustLegacy('_ZN4core3fmt3num17h1234567890abcdefE');
  assert.equal(r1.parsed, true);
  assert.equal(r1.demangled, 'core::fmt::num');
  assert.equal(r1.hash, '1234567890abcdef');
  assert.equal(r1.crate, 'core');

  // Legacy symbol with $ escapes: _ZN3std2io12$LT$impl$GT$17h1122334455667788E
  const r2 = demangleRustLegacy('_ZN3std2io12$LT$impl$GT$17h1122334455667788E');
  assert.equal(r2.parsed, true);
  assert.equal(r2.demangled, 'std::io::<impl>');
}

// 3. Demangle generic entrypoint
{
  const v0 = demangleRustSymbol('_RC6my_app');
  assert.equal(v0.demangled, 'my_app');

  const legacy = demangleRustSymbol('_ZN6my_app4main17haabbccddeeff0011E');
  assert.equal(legacy.demangled, 'my_app::main');

  const nonRust = demangleRustSymbol('malloc');
  assert.equal(nonRust.parsed, false);
  assert.equal(nonRust.demangled, 'malloc');
}

// 4. Rustc version discovery
{
  const comment = new TextEncoder().encode('\x00rustc version 1.80.0 (051478957 2024-07-21)\x00');
  const ver = findRustcVersion(comment);
  assert.ok(ver.includes('1.80.0'));
}

// 5. Rust Type Layout Safety Gate (CRITICAL RULE)
{
  // repr(Rust) is explicitly UNSTABLE across compiler versions
  const rustStruct = { name: 'Player', repr: 'Rust', fields: [{ name: 'x', type: 'i32' }] };
  assert.equal(isRustLayoutStable(rustStruct), false, 'repr(Rust) structs must never be claimed layout-stable');

  // repr(C) is stable
  const cStruct = { name: 'CPlayer', repr: 'C', fields: [{ name: 'x', type: 'i32' }] };
  assert.equal(isRustLayoutStable(cStruct), true, 'repr(C) structs are layout-stable');

  // Primitives are stable
  const primitive = { name: 'i32', isPrimitive: true };
  assert.equal(isRustLayoutStable(primitive), true);

  // DWARF-backed types are stable
  const dwarfType = { name: 'DebugPlayer', dwarfVerified: true };
  assert.equal(isRustLayoutStable(dwarfType), true);
}

// 6. Negative & Fail-Closed: Malformed v0 symbols
{
  const malformed1 = demangleRustV0('_R99999999999999999999999');
  assert.equal(malformed1.parsed, false);
  assert.equal(malformed1.demangled, '_R99999999999999999999999');

  const malformed2 = demangleRustV0('_RNv');
  assert.equal(malformed2.parsed, false);

  const malformedLegacy = demangleRustLegacy('_ZN99999999');
  assert.equal(malformedLegacy.parsed, false);
}

// 7. RustMetadataProvider probe and symbol generation
{
  const provider = new RustMetadataProvider({
    symbols: [
      { name: '_ZN6my_app4main17haabbccddeeff0011E', address: '0x1000', size: 32 },
      { name: '_RNvNtC4core3fmt3num', address: '0x2000', size: 64 },
      // Exercise the documented symbol/addr aliases on the vtable path too.
      { symbol: '_ZN6my_app13MyTraitvtable17h1122334455667788E', addr: '0x3000', size: 16 },
    ],
    commentBuffer: new TextEncoder().encode('rustc version 1.78.0'),
    binaryIdentity: 'sha256:rust-app',
  });

  const probe = provider.probe();
  assert.equal(probe.authoritative, true);
  assert.equal(probe.completeness.complete, true);
  assert.equal(probe.counts.symbols, 3);
  assert.equal(probe.counts.vtables, 1);

  const syms = provider.symbols();
  assert.equal(syms.records.length, 3);
  assert.equal(syms.records[0].name, 'my_app::main');
  assert.equal(syms.records[1].name, 'core::fmt::num');

  const vts = provider.vtables();
  assert.equal(vts.records.length, 1);
  assert.equal(vts.records[0].name, 'my_app::MyTraitvtable');
  assert.equal(vts.records[0].address, '0x3000');
  assert.equal(vts.records[0].entityId, 'vtable@0x3000');
}

// 8. Falsy address zero is still exact identity evidence.
{
  const provider = new RustMetadataProvider({
    symbols: [{ name: '_ZN6my_app4main17haabbccddeeff0011E', address: 0 }],
    binaryIdentity: 'sha256:zero-address',
  });
  const probe = provider.probe();
  assert.equal(probe.completeness.complete, true);
  const record = provider.symbols().records[0];
  assert.equal(record.address, '0');
  assert.equal(record.entityId, 'sym@0');
}

// 9. Structured addresses fail closed instead of being String-coerced into identity.
{
  const provider = new RustMetadataProvider({
    symbols: [{ name: '_ZN6my_app4main17haabbccddeeff0011E', address: { toString: () => '0x1000' } }],
    commentBuffer: new TextEncoder().encode('rustc version 1.78.0'),
    binaryIdentity: 'sha256:malformed-address',
  });
  const probe = provider.probe();
  assert.equal(probe.authoritative, false);
  assert.equal(probe.completeness.invalidEntries, 1);
  assert.equal(provider.symbols().records.length, 0);
}

// 10. Stripped binary probe
{
  const strippedProvider = new RustMetadataProvider({
    symbols: [],
    commentBuffer: null,
    binaryIdentity: 'sha256:stripped-rust',
  });

  const probe = strippedProvider.probe();
  assert.equal(probe.authoritative, false);
  assert.equal(probe.completeness.present, false);
  assert.equal(probe.identity.verdict, 'identity-unavailable');
}

console.log('Rust Metadata Provider tests passed.');