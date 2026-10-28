"""Build the beginner project guide. Requires reportlab; no application secrets or DB access."""
from pathlib import Path
import json
from xml.sax.saxutils import escape
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.colors import HexColor, white
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import Paragraph, Table, TableStyle

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'output/pdf/memorae-project-guide.pdf'
DATA = ROOT / 'docs/project-guide/guide.json'
W, H = 960, 640
NAVY, TEAL, GOLD, INK, MUTED, PAPER = map(HexColor, ['#152D42','#007F82','#E8B54B','#243746','#607282','#F7F5F0'])
fonts = Path('C:/Windows/Fonts')
for name, filename in [('Body','arial.ttf'),('Bold','arialbd.ttf'),('Mono','consola.ttf')]:
    pdfmetrics.registerFont(TTFont(name, str(fonts / filename)))
pdfmetrics.registerFontFamily('Body',normal='Body',bold='Bold',italic='Body',boldItalic='Bold')

def build():
    pages = json.loads(DATA.read_text(encoding='utf-8'))
    OUT.parent.mkdir(parents=True, exist_ok=True)
    c = canvas.Canvas(str(OUT), pagesize=(W,H), pageCompression=1)
    c.setTitle('Memorae - Your project explained')
    c.setAuthor('Memorae project / Codex')
    c.setSubject('Beginner guide to architecture, database, completed work and next steps through M1-08')
    def rect(x,top,w,h,color,r=0):
        c.setFillColor(color)
        if r: c.roundRect(x,H-top-h,w,h,r,stroke=0,fill=1)
        else: c.rect(x,H-top-h,w,h,stroke=0,fill=1)
    def text(s,x,top,w,size=14,color=INK,bold=False,leading=None):
        style=ParagraphStyle('text',fontName='Bold' if bold else 'Body',fontSize=size,
            leading=leading or size*1.38,textColor=color,spaceAfter=0)
        p=Paragraph(s,style)
        _,height=p.wrap(w,1000)
        p.drawOn(c,x,H-top-height)
        return top+height
    def blocks(items,x,top,w):
        for item in items:
            top=text(item,x,top,w)+16
        if top>552: raise ValueError(f'Content overflow on page {number}: {top}')
    def callout(s):
        rect(48,553,864,49,HexColor('#E4F0EF'),7)
        bottom=text(s,64,563,832,13,color=TEAL)
        if bottom>598: raise ValueError(f'Callout overflow on page {number}')
    for number,page in enumerate(pages,1):
        rect(0,0,W,H,PAPER)
        c.bookmarkPage(f'p{number}')
        c.addOutlineEntry(page['title'],f'p{number}',0)
        if page['kind']=='cover':
            rect(0,0,W,H,NAVY); rect(48,62,64,7,GOLD)
            text('MEMORAE  /  PROJECT BRIEFING',48,96,850,14,white,bold=True)
            text('Your project,<br/>explained.',48,155,670,56,white,bold=True,leading=62)
            text('From a WhatsApp message to a reliable personal assistant',52,318,780,23,HexColor('#B6DDDC'))
            text('A plain-language presentation and reference guide<br/>Architecture, database, completed work, examples and next steps',52,391,780,17,white)
            rect(48,510,864,68,HexColor('#244358'),8)
            text('STATUS SNAPSHOT  |  28 OCTOBER 2026',65,522,800,12,GOLD,bold=True)
            text('Local foundation through M1-08  |  Code baseline: f55fcfa<br/>The live assistant is not launched. Real model accuracy and reminder delivery remain unverified.',65,542,800,13,white)
        else:
            rect(48,35,32,5,TEAL)
            text(page.get('section','MEMORAE GUIDE').upper(),92,27,780,11,MUTED,bold=True)
            end=text(page['title'],48,65,864,29,NAVY,bold=True,leading=34)
            if end>137: raise ValueError('Title too large')
            text(page.get('subtitle',''),48,113 if end<105 else 139,864,14,MUTED)
            top=171
            if page['kind']=='columns':
                for x,key in [(48,'left'),(498,'right')]:
                    panel=page[key]
                    y=text(panel['heading'],x,top,414,18,TEAL,bold=True)+25
                    blocks(panel['body'],x,y,414)
            elif page['kind']=='table':
                widths=page.get('widths',[190,310,364])
                style=ParagraphStyle('cell',fontName='Body',fontSize=page.get('size',13),leading=page.get('size',13)*1.32,textColor=INK)
                head=ParagraphStyle('head',parent=style,fontName='Bold',textColor=white)
                rows=[[Paragraph(escape(str(cell)),head if i==0 else style) for cell in row] for i,row in enumerate(page['rows'])]
                table=Table(rows,colWidths=widths,hAlign='LEFT')
                table.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,0),NAVY),('VALIGN',(0,0),(-1,-1),'TOP'),
                    ('ROWBACKGROUNDS',(0,1),(-1,-1),[white,HexColor('#EDF1F1')]),
                    ('LEFTPADDING',(0,0),(-1,-1),11),('RIGHTPADDING',(0,0),(-1,-1),11),
                    ('TOPPADDING',(0,0),(-1,-1),9),('BOTTOMPADDING',(0,0),(-1,-1),9)]))
                _,h=table.wrap(864,1000)
                if top+h>540: raise ValueError(f'Table overflow page {number}: {h}')
                table.drawOn(c,48,H-top-h)
            elif page['kind']=='flow':
                nodes=page['nodes']; bw=(864-(len(nodes)-1)*24)/len(nodes)
                for i,node in enumerate(nodes):
                    x=48+i*(bw+24)
                    rect(x,178,bw,108,NAVY if i%2==0 else TEAL,8)
                    text(str(i+1).zfill(2),x+12,190,bw-24,12,GOLD,bold=True)
                    text(node,x+12,216,bw-24,16,white,bold=True)
                    if i<len(nodes)-1:
                        c.setStrokeColor(TEAL); c.setLineWidth(2); c.line(x+bw+3,H-230,x+bw+20,H-230)
                        c.line(x+bw+15,H-225,x+bw+20,H-230); c.line(x+bw+15,H-235,x+bw+20,H-230)
                blocks(page['body'],48,315,864)
            elif page['kind']=='architecture':
                nodes=[(48,190,180,86,'WhatsApp + Meta','External service'),(282,190,180,86,'API','Reception desk'),
                    (516,190,180,86,'PostgreSQL','Shared filing system'),(750,190,162,86,'Worker','Back office'),
                    (516,357,180,76,'Model adapter','Interpreter, gated'),(750,357,162,76,'Send adapter','Courier, gated')]
                for x,y,w,h,title,sub in nodes:
                    rect(x,y,w,h,NAVY if y==190 else HexColor('#DDE7E9'),8)
                    text(title,x+12,y+14,w-24,16,white if y==190 else NAVY,True)
                    text(sub,x+12,y+46,w-24,11,white if y==190 else MUTED)
                c.setStrokeColor(TEAL); c.setLineWidth(2)
                for x1,x2 in [(228,282),(462,516),(696,750)]:
                    c.line(x1+5,H-232,x2-5,H-232); c.line(x2-11,H-227,x2-5,H-232); c.line(x2-11,H-237,x2-5,H-232)
                c.line(830,H-281,830,H-349); c.line(830,H-315,606,H-315); c.line(606,H-315,606,H-349)
                text('The API and worker are two running programs from one codebase.<br/>They coordinate through the database. External calls are kept outside short database transactions.',48,466,864,16)
            elif page['kind']=='relations':
                rows=[(48,190,'users','Who owns the information?'),(352,190,'action_plans','What should happen?'),(656,190,'lists / reminders','What was created?'),
                    (48,343,'ingress_events','What arrived?'),(352,343,'work_outbox','What still needs doing?'),(656,343,'receipts / replies','What happened? What to say?')]
                for x,y,title,sub in rows:
                    rect(x,y,256,104,NAVY if y==190 else TEAL,8)
                    text(title,x+14,y+20,228,17,white,True); text(sub,x+14,y+62,228,12,white)
                text('Conceptual map, not every foreign key. IDs connect rows; ownership constraints check that linked records belong to the same user.',48,478,864,16)
            elif page['kind']=='contents':
                for i,(label,start) in enumerate(page['items']):
                    y=177+i*49
                    text(label,62,y,730,19,NAVY)
                    text(str(start).zfill(2),834,y,60,19,TEAL,True)
                    c.linkRect('',f'p{start}',(48,H-y-33,912,H-y+2),relative=0,thickness=0)
            if page.get('callout'): callout(page['callout'])
        c.setFillColor(MUTED if page['kind']!='cover' else HexColor('#AFC0CA'))
        c.setFont('Body',9)
        c.drawString(48,17,'MEMORAE  |  Local implementation guide  |  2026-10-28')
        c.drawRightString(912,17,f'{number:02d} / {len(pages):02d}')
        c.showPage()
    c.save()
    print(f'Created {OUT} ({len(pages)} pages)')

if __name__=='__main__': build()
