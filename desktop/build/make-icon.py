# Ícone do app do Muvuca para Mac, no estilo do iPlayer: quadrado arredondado com gradiente vertical e o M
# branco de traço arredondado. Rodar aqui em desktop/build: python3 make-icon.py (precisa do Pillow)
import math, sys
from PIL import Image, ImageDraw, ImageFilter
out = sys.argv[1] if len(sys.argv) > 1 else 'icon-1024.png'
SS=4; N=1024*SS
k=824/150*SS; o=100*SS
P=lambda x,y:(o+x*k,o+y*k)
img=Image.new("RGBA",(N,N),(0,0,0,0))
sh=Image.new("RGBA",(N,N),(0,0,0,0)); d=ImageDraw.Draw(sh)
d.rounded_rectangle([o,o+12*SS,o+824*SS,o+836*SS],radius=185*SS,fill=(0,0,0,90))
sh=sh.filter(ImageFilter.GaussianBlur(14*SS)); img.alpha_composite(sh)
body=Image.new("RGBA",(N,N)); bd=ImageDraw.Draw(body)
top=(124,136,255); bot=(64,62,200)   # azul do Muvuca, claro em cima e escuro embaixo
for y in range(o,o+824*SS):
    t=(y-o)/(824*SS); bd.line([(0,y),(N,y)],fill=tuple(int(a+(b-a)*t) for a,b in zip(top,bot))+(255,))
mask=Image.new("L",(N,N),0); ImageDraw.Draw(mask).rounded_rectangle([o,o,o+824*SS,o+824*SS],radius=185*SS,fill=255)
img.paste(body,(0,0),mask)
d=ImageDraw.Draw(img)
def dot(p,r,col):
    x,y=p; d.ellipse([x-r,y-r,x+r,y+r],fill=col)
def stroke(pts,w,col):
    r=w*k/2; pts=[P(*p) for p in pts]
    for (x1,y1),(x2,y2) in zip(pts,pts[1:]):
        L=math.hypot(x2-x1,y2-y1); nx,ny=-(y2-y1)/L*r,(x2-x1)/L*r
        d.polygon([(x1+nx,y1+ny),(x2+nx,y2+ny),(x2-nx,y2-ny),(x1-nx,y1-ny)],fill=col)
    for p in pts: dot(p,r,col)
white=(255,255,255,255)
stroke([(45,103),(45,49),(75,84),(105,49),(105,103)],14,white)
final=img.resize((1024,1024),Image.LANCZOS)
final.save(out)
# O .icns do app do Mac (o ícone do Windows, icon.png, continua o antigo)
final.save(out.replace('icon-1024.png','icon.icns'))
