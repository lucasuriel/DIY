"""Clean one Meshy GLB: keep chosen islands, drop a ground plate, normalise size, shrink textures."""
import sys, json, struct, io, numpy as np
sys.path.insert(0, sys.argv[1]); from glb import load, acc as _acc
from PIL import Image
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components

src, dst, opts = sys.argv[2], sys.argv[3], json.loads(sys.argv[4])
js, binb = load(src); pr = js['meshes'][0]['primitives'][0]
V = _acc(js,binb,pr['attributes']['POSITION']).astype(np.float32)
N = _acc(js,binb,pr['attributes']['NORMAL']).astype(np.float32)
UV = _acc(js,binb,pr['attributes']['TEXCOORD_0']).astype(np.float32)
F = _acc(js,binb,pr['indices']).reshape(-1,3).astype(np.int64)

if opts.get("islands") is not None or opts.get("min_island"):
    _, inv = np.unique(np.round(V,5),axis=0,return_inverse=True); inv=inv.ravel(); Fw=inv[F]; n=int(inv.max())+1
    a=np.concatenate([Fw[:,0],Fw[:,1],Fw[:,2]]); b=np.concatenate([Fw[:,1],Fw[:,2],Fw[:,0]])
    k,lab=connected_components(coo_matrix((np.ones(len(a),np.int8),(a,b)),shape=(n,n)),directed=False)
    fl=lab[Fw[:,0]]; s=np.bincount(fl)
    if opts.get("islands") is not None:
        order=[i for i in np.argsort(-s) if s[i]>40000]
        order=[order[j] for j in np.argsort([V[np.unique(F[fl==i])][:,0].mean() for i in order])]
        keep=np.isin(fl,[order[i] for i in opts["islands"]])
    else:
        keep=np.isin(fl,np.where(s>=len(F)*opts["min_island"])[0])
    F=F[keep]; print("  islands kept, tris", len(F))

u,iv = np.unique(F.ravel(), return_inverse=True)
V,N,UV,F = V[u],N[u],UV[u],iv.reshape(-1,3)

if opts.get("drop_below") is not None:      # cut off a ground plate / display stand
    c=V[F].mean(1); F=F[c[:,1] > V[:,1].min()+opts["drop_below"]*(V[:,1].max()-V[:,1].min())]
    u,iv=np.unique(F.ravel(),return_inverse=True); V,N,UV,F = V[u],N[u],UV[u],iv.reshape(-1,3)
    print("  plate dropped, tris", len(F))

mn,mx = V.min(0), V.max(0)
V = (V - np.array([(mn[0]+mx[0])/2, mn[1], (mn[2]+mx[2])/2])) / (mx-mn).max()   # base at y=0, max dim = 1
print(f"  normalised size {np.round(V.max(0)-V.min(0),3)}")

def pad(b,fill=b'\x00'): return b+fill*((-len(b))%4)
bin_=bytearray(); bvs=[]; accs=[]
def add(data,target=None):
    bvs.append(dict(buffer=0,byteOffset=len(bin_),byteLength=len(data),**({'target':target} if target else {}))); bin_.extend(pad(bytes(data))); return len(bvs)-1
ids=[]
for arr,typ,isp in [(V.astype('<f4'),'VEC3',True),(N.astype('<f4'),'VEC3',False),(UV.astype('<f4'),'VEC2',False)]:
    d=dict(bufferView=add(arr.tobytes(),34962),componentType=5126,count=len(arr),type=typ)
    if isp: d['min']=V.min(0).tolist(); d['max']=V.max(0).tolist()
    accs.append(d); ids.append(len(accs)-1)
accs.append(dict(bufferView=add(F.astype('<u4').ravel().tobytes(),34963),componentType=5125,count=F.size,type='SCALAR'))
size=opts.get("tex",2048); imgs=[]
for i,im in enumerate(js['images']):
    bv=js['bufferViews'][im['bufferView']]; o=bv.get('byteOffset',0)
    img=Image.open(io.BytesIO(binb[o:o+bv['byteLength']])).convert("RGB").resize((size,size),Image.LANCZOS)
    bio=io.BytesIO(); img.save(bio,"JPEG",quality=88 if i==2 else 82,optimize=True)
    imgs.append(dict(mimeType="image/jpeg",bufferView=add(bio.getvalue())))
mat=json.loads(json.dumps(js['materials'][0])); mat['doubleSided']=True
mat['pbrMetallicRoughness']['baseColorTexture']['index']=0
mat['pbrMetallicRoughness']['metallicRoughnessTexture']['index']=1
mat['normalTexture']['index']=2
out=dict(asset=dict(version="2.0",generator="DIY pipeline"),scene=0,scenes=[dict(nodes=[0])],
  nodes=[dict(name=opts.get("name","machine"),mesh=0)],
  meshes=[dict(name=opts.get("name","machine"),primitives=[dict(attributes=dict(POSITION=ids[0],NORMAL=ids[1],TEXCOORD_0=ids[2]),indices=len(accs)-1,material=0,mode=4)])],
  materials=[mat],textures=[dict(sampler=0,source=i) for i in range(3)],images=imgs,
  samplers=[dict(magFilter=9729,minFilter=9987,wrapS=10497,wrapT=10497)],accessors=accs,bufferViews=bvs,buffers=[dict(byteLength=len(bin_))])
jb=pad(json.dumps(out,separators=(',',':')).encode(),b' '); bb=pad(bytes(bin_))
open(dst,'wb').write(struct.pack('<4sII',b'glTF',2,12+8+len(jb)+8+len(bb))+struct.pack('<I4s',len(jb),b'JSON')+jb+struct.pack('<I4s',len(bb),b'BIN\x00')+bb)
print(f"  -> {dst.split('/')[-1]}  tris {len(F):,}")
