// In-memory mutations: never modify production files or another worker's tree.
import { registerHooks } from 'node:module';

const mutations = {
  'nested-close': ['js/decompile-base.js', " && (l.indent ?? 0) === functionIndent", ''],
  'label-floor': ['js/decompile-base.js', 'const floor = open >= 0 ? open + 1 : 1;', 'const floor = 1;'],
  'naive-declarations': ['js/decompiler/semantic-core.js', 'const type = semanticLocalDeclarationType(local, ctx);', "const type = semanticLocalDeclarationType(local, ctx) || 'uint64';"],
};
const mutation = mutations[process.env.HEX_RECOMPILABILITY_MUTATION];
if (!mutation) throw new Error('unknown recompilability mutation');
let applied = false;
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!url.endsWith('/' + mutation[0])) return result;
    const source = String(result.source);
    if (source.split(mutation[1]).length !== 2) throw new Error('mutation anchor is not unique');
    applied = true;
    return { ...result, source: source.replace(mutation[1], mutation[2]) };
  },
});
process.on('exit', () => {
  if (!applied) { console.error('mutation was not applied'); process.exitCode = 2; }
});
