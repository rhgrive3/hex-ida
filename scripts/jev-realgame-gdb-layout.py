import gdb,json,os
classes=json.load(open(os.environ['HEX_ORACLE_CLASSES']))
result={}
def name(t):
 return str(t.strip_typedefs())
def fields(t,base=0,trail=None,depth=0):
 trail=trail or []
 if depth>16:return []
 out=[]
 try:fs=t.strip_typedefs().fields()
 except Exception:return out
 for f in fs:
  try:bitpos=int(f.bitpos);size=int(f.type.sizeof)
  except Exception:continue
  if bitpos<0 or bitpos%8 or f.bitsize:continue
  offset=base+bitpos//8
  if f.is_base_class:
   out+=fields(f.type,offset,trail+[{'className':name(f.type),'offset':offset,'size':size}],depth+1)
  elif f.name:
   out.append({'path':f.name,'topLevel':f.name,'offset':offset,'size':size,'type':name(f.type),'owningClassName':name(t),'owningOffset':bitpos//8,'inheritance':trail,'isAggregate':f.type.strip_typedefs().code in [gdb.TYPE_CODE_STRUCT,gdb.TYPE_CODE_UNION]})
 return out
for cls in classes:
 try:
  t=gdb.lookup_type(cls).strip_typedefs();result[cls]={'status':'resolved','className':name(t),'declaration':'class '+name(t),'size':int(t.sizeof),'members':fields(t),'bases':[{'className':name(f.type),'offset':int(f.bitpos)//8,'size':int(f.type.sizeof)} for f in t.fields() if f.is_base_class]}
 except Exception as ex:result[cls]={'status':'unresolved','error':str(ex)}
p=os.environ['HEX_ORACLE_OUTPUT'];pending=p+'.pending';json.dump(result,open(pending,'w'),indent=2);os.replace(pending,p)
print('independent GDB metadata classes',len(result))
