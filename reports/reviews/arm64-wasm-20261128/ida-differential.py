#!/usr/bin/env python3
"""Differential test: compile IDA 9.1 output and Hex output for the same
function, run both on the same scalar inputs, compare results.

Usage: ida-differential.py <hex-report-dir> <out.json> [case-filter]
Only functions whose IDA signature has 0-4 scalar integer params and a
scalar integer return are tested. A pair counts only when BOTH sides compile
and link standalone (no callees). Results: agree / disagree / hang / skip.
"""
import json, os, re, subprocess, sys, tempfile, binascii

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..', '..', '..', 'benchmarks', 'public', 'codefuse-arm64'))
IDA_DEFS = r'''
#include <stdint.h>
typedef long long __int64; typedef unsigned long long _QWORD; typedef unsigned int _DWORD;
typedef unsigned short _WORD; typedef unsigned char _BYTE; typedef int _BOOL4; typedef char _BOOL1;
typedef unsigned long long _UNKNOWN; typedef char __int8; typedef short __int16; typedef int __int32;
#define __fastcall
#define __cdecl
#define __noreturn
#define LODWORD(x) (*((unsigned int*)&(x)))
#define HIDWORD(x) (*((unsigned int*)&(x)+1))
#define __PAIR64__(h,l) ((((unsigned long long)(unsigned int)(h))<<32)|(unsigned int)(l))
#define __ROR4__(v,c) (((unsigned int)(v)>>((c)&31))|((unsigned int)(v)<<((32-((c)&31))&31)))
#define __ROL4__(v,c) (((unsigned int)(v)<<((c)&31))|((unsigned int)(v)>>((32-((c)&31))&31)))
#define __ROR8__(v,c) (((unsigned long long)(v)>>((c)&63))|((unsigned long long)(v)<<((64-((c)&63))&63)))
#define __ROL8__(v,c) (((unsigned long long)(v)<<((c)&63))|((unsigned long long)(v)>>((64-((c)&63))&63)))
#define abs32(x) ((x)<0?-(x):(x))
'''
INT_T = r'(?:unsigned\s+)?(?:__int64|_QWORD|_DWORD|int|unsigned int|unsigned __int64|__int8|__int16|char|_BYTE|_WORD|short|_BOOL4|bool|long)'
VECS = [0, 1, -1, 2, 3, 5, 7, 10, -7, 42, 100, 255, 1000, -1000, 0x7fffffff, -0x80000000, 12345, 0x10001]

def ret_bits(t):
    t = t.strip()
    if '__int64' in t or '_QWORD' in t or t == 'long': return 64
    if t in ('char', '_BYTE', '__int8', 'bool', '_BOOL1'): return 8
    if t in ('_WORD', '__int16', 'short'): return 16
    return 32

def ida_funcs(path):
    text = open(path, encoding='utf-8', errors='replace').read()
    parts = re.split(r'/\* Function: (\S+) @ (0x[0-9A-Fa-f]+) \*/\n', text)
    out = {}
    for i in range(1, len(parts) - 2, 3):
        name, addr, body = parts[i], int(parts[i + 1], 16), parts[i + 2].strip()
        out[addr] = (name, body)
    return out

def parse_sig(body):
    m = re.match(r'^((?:unsigned\s+)?[\w ]+?)\s+(?:__fastcall\s+|__cdecl\s+)?(\w+)\(([^)]*)\)\s*\n\{', body)
    if not m: return None
    rt, fname, params = m.group(1).strip(), m.group(2), m.group(3).strip()
    if rt == 'void' or '*' in rt or 'float' in rt or 'double' in rt: return None
    if not re.fullmatch(INT_T, rt): return None
    ps = [] if params in ('', 'void') else [p.strip() for p in params.split(',')]
    if len(ps) > 4: return None
    for p in ps:
        if '*' in p or 'float' in p or 'double' in p or '[' in p: return None
        if not re.fullmatch(INT_T + r'\s+\w+', p): return None
    return rt, fname, len(ps)

def compile_obj(src, sym, newsym, tmp, tag):
    c = os.path.join(tmp, tag + '.c'); o = os.path.join(tmp, tag + '.o')
    open(c, 'w').write(src)
    r = subprocess.run(['gcc', '-w', '-O0', '-fwrapv', '-c', c, '-o', o, f'-D{sym}={newsym}'], capture_output=True)
    return o if r.returncode == 0 else None

def run_pair(hex_src, ida_body, sig, tmp):
    rt, fname, arity = sig
    hex_name = re.search(r'^(?!#)[A-Za-z_][\w \*]*?\b(\w+)\([^;\n]*\)\s*\n\{', hex_src, re.M)
    if not hex_name: return 'skip', 'hex-sig'
    hsym = hex_name.group(1)
    ho = compile_obj(hex_src, hsym, 'HEXFN', tmp, 'h')
    io = compile_obj(IDA_DEFS + ida_body, fname, 'IDAFN', tmp, 'i')
    if not ho: return 'skip', 'hex-compile'
    if not io: return 'skip', 'ida-compile'
    bits = ret_bits(rt)
    mask = (1 << bits) - 1
    args = ', '.join(['long long'] * arity) or 'void'
    vecs = []
    for a in VECS:
        v = [a, (a * 3 + 1), (-a + 5), (a ^ 0x55)][:arity]
        vecs.append(v)
    calls = '\n'.join(
        '  { long long a[4] = {%s}; run_one(%d, a); }' % (', '.join(str(x) for x in (v + [0] * 4)[:4]), i)
        for i, v in enumerate(vecs))
    callexpr = ', '.join(f'a[{k}]' for k in range(arity))
    harness = f'''
#include <stdio.h>
#include <unistd.h>
#include <signal.h>
#include <sys/wait.h>
typedef unsigned long long (*F)({args});
unsigned long long HEXFN(); unsigned long long IDAFN();
static void run_one(int idx, long long *a) {{
  for (int side = 0; side < 2; ++side) {{
    fflush(stdout);
    pid_t p = fork();
    if (p == 0) {{ alarm(1); F f = side ? (F)IDAFN : (F)HEXFN;
      unsigned long long r = f({callexpr}); printf("%d %d %llu\\n", idx, side, r & {mask}ULL); fflush(stdout); _exit(0); }}
    int st = 0; waitpid(p, &st, 0);
    if (!WIFEXITED(st)) printf("%d %d %s\\n", idx, side, WIFSIGNALED(st) && WTERMSIG(st) == SIGALRM ? "HANG" : "CRASH");
  }}
}}
int main(void) {{
{calls}
  return 0;
}}
'''
    hc = os.path.join(tmp, 'm.c'); exe = os.path.join(tmp, 'm')
    open(hc, 'w').write(harness)
    r = subprocess.run(['gcc', '-w', '-O0', hc, ho, io, '-o', exe], capture_output=True)
    if r.returncode != 0: return 'skip', 'link'
    r = subprocess.run([exe], capture_output=True, text=True, timeout=60)
    res = {}
    for line in r.stdout.split('\n'):
        p = line.split()
        if len(p) == 3: res[(int(p[0]), int(p[1]))] = p[2]
    bad = []
    hang = False
    for i in range(len(vecs)):
        h, d = res.get((i, 0)), res.get((i, 1))
        if d in ('HANG', 'CRASH') or h in ('HANG', 'CRASH'):
            if d != h: hang = True
            continue
        if h != d: bad.append({'args': vecs[i], 'hex': h, 'ida': d})
    if bad: return 'disagree', bad[:3]
    if hang: return 'hang-mismatch', None
    return 'agree', None

def main():
    rep, out = sys.argv[1], sys.argv[2]
    filt = sys.argv[3] if len(sys.argv) > 3 else ''
    man = json.load(open(os.path.join(ROOT, 'manifest.json')))
    results = []
    for case in man['cases']:
        cid = case['id']
        if filt and filt not in cid: continue
        f = os.path.join(rep, binascii.hexlify(cid.encode()).decode() + '.json')
        if not os.path.exists(f): continue
        hexd = json.load(open(f))
        ida = ida_funcs(os.path.join(ROOT, case['reference']['path']))
        for fn in hexd.get('functions', []):
            addr = int(str(fn['address']), 0)
            if addr not in ida or not fn.get('pseudocode'): continue
            name, body = ida[addr]
            if name.startswith(('sub_', '_', '.', 'main', 'start', 'frame_dummy', 'register', 'deregister')): continue
            sig = parse_sig(body)
            if not sig: continue
            with tempfile.TemporaryDirectory() as tmp:
                try:
                    st, detail = run_pair(fn['pseudocode'], body, sig, tmp)
                except subprocess.TimeoutExpired:
                    st, detail = 'skip', 'timeout'
            results.append({'case': cid, 'name': name, 'addr': hex(addr), 'state': st, 'hexState': fn.get('state'), 'detail': detail})
    json.dump(results, open(out, 'w'), indent=1)
    from collections import Counter
    print(Counter(r['state'] for r in results))
    print(Counter(r['detail'] for r in results if r['state'] == 'skip'))

if __name__ == '__main__':
    main()
