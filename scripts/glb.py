import struct, json, io, numpy as np
from PIL import Image
def load(path):
    b=open(path,'rb').read(); cl,_=struct.unpack('<I4s',b[12:20]); js=json.loads(b[20:20+cl]); off=20+cl; bl,_=struct.unpack('<I4s',b[off:off+8]); return js,b[off+8:off+8+bl]
def acc(js,binb,i):
    a=js['accessors'][i]; bv=js['bufferViews'][a['bufferView']]; o=bv.get('byteOffset',0)+a.get('byteOffset',0)
    n={'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4}[a['type']]; dt={5126:'<f4',5125:'<u4',5123:'<u2'}[a['componentType']]; st=bv.get('byteStride'); isz=np.dtype(dt).itemsize*n
    if st and st!=isz: x=np.frombuffer(binb,dtype=np.uint8,count=st*a['count'],offset=o).reshape(a['count'],st)[:,:isz].copy().view(dt)
    else: x=np.frombuffer(binb,dtype=dt,count=a['count']*n,offset=o)
    return x.reshape(a['count'],n) if n>1 else x
def tex(js,binb,k=0):
    bv=js['bufferViews'][js['images'][k]['bufferView']]; return np.asarray(Image.open(io.BytesIO(binb[bv.get('byteOffset',0):bv.get('byteOffset',0)+bv['byteLength']])).convert("RGB"))
def nodes(js,binb):
    out={}
    for nd in js['nodes']:
        if 'mesh' not in nd: continue
        pr=js['meshes'][nd['mesh']]['primitives'][0]
        V=acc(js,binb,pr['attributes']['POSITION']).astype(np.float64); UV=acc(js,binb,pr['attributes']['TEXCOORD_0']).astype(np.float64); F=acc(js,binb,pr['indices']).reshape(-1,3).astype(np.int64)
        out[nd['name']]=dict(V=V,UV=UV,F=F,t=np.array(nd.get('translation',[0,0,0]),float))
    return out
def colors(T,UV):
    H,W,_=T.shape; return T[np.clip(((1-UV[:,1])*(H-1)).astype(int),0,H-1),np.clip((UV[:,0]*(W-1)).astype(int),0,W-1)]
