// Syntax-only canonicalization. Never repair control/data flow or infer source names.
export function normalizePseudocode(code){
 if(typeof code!=='string')return null;
 return code.replace(/\b__fastcall\b|\b__cdecl\b|\b__noreturn\b/g,' ')
   .replace(/\b__int64\b/g,'long long').replace(/\b__int32\b/g,'int')
   .replace(/\b_BOOL8\b/g,'long long').replace(/[ \t]+/g,' ').replace(/ *\n */g,'\n').trim();
}
export const normalizeSyntax=normalizePseudocode;
