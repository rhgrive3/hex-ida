from pathlib import Path
p=Path('js/analysis/investigation-service.js')
s=p.read_text()
old="""    const [strings, program, shapes, metadata] = await Promise.all([stringsP, programP, shapesP, metadataP]);
    abortIfNeeded(options.signal);
    const binding = captureAnalysisBinding(this.app, { program, shapes, fields:metadata?.fields ?? this.app.fields });
"""
new="""    const [strings, program, shapes] = await Promise.all([stringsP, programP, shapesP]);
    const metadata = await metadataP;
    abortIfNeeded(options.signal);
    const binding = captureAnalysisBinding(this.app, { program, shapes, fields:metadata?.fields ?? this.app.fields });
"""
if s.count(old)!=1: raise SystemExit('prepareGoal Promise.all target missing')
p.write_text(s.replace(old,new,1))
