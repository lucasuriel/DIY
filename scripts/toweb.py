"""GLB -> glTF JSON (geometry base64 inline) + separate JPEGs, for hosts that don't serve .glb"""
import sys, json, struct, base64, io, os
from PIL import Image
src, outdir, stem, texsize = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
b=open(src,'rb').read(); cl,_=struct.unpack('<I4s',b[12:20]); js=json.loads(b[20:20+cl])
off=20+cl; bl,_=struct.unpack('<I4s',b[off:off+8]); binb=b[off+8:off+8+bl]
img_views={im['bufferView'] for im in js.get('images',[]) if 'bufferView' in im}
for i,im in enumerate(js.get('images',[])):
    bv=js['bufferViews'][im['bufferView']]; o=bv.get('byteOffset',0)
    img=Image.open(io.BytesIO(binb[o:o+bv['byteLength']])).convert("RGB")
    if img.size[0]>texsize: img=img.resize((texsize,texsize), Image.LANCZOS)
    name=f"{stem}-t{i}.jpg"; img.save(os.path.join(outdir,name),"JPEG",quality=84,optimize=True)
    js['images'][i]={'uri':name,'mimeType':'image/jpeg'}
newbin=bytearray(); remap={}; views=[]
for i,bv in enumerate(js['bufferViews']):
    if i in img_views: continue
    o=bv.get('byteOffset',0); chunk=binb[o:o+bv['byteLength']]
    while len(newbin)%4: newbin.append(0)
    nb=dict(bv); nb['byteOffset']=len(newbin); newbin.extend(chunk); remap[i]=len(views); views.append(nb)
js['bufferViews']=views
for a in js.get('accessors',[]):
    if 'bufferView' in a: a['bufferView']=remap[a['bufferView']]
js['buffers']=[{'byteLength':len(newbin),'uri':'data:application/octet-stream;base64,'+base64.b64encode(bytes(newbin)).decode()}]
p=os.path.join(outdir,f"{stem}.json"); open(p,'w').write(json.dumps(js,separators=(',',':')))
print(f"  {stem}: json {os.path.getsize(p)/1e6:.1f}MB")
