import hcengine as hc
SQ=lambda i: 'abcdefgh'[i%8]+str(8-i//8)
def mv(c):
    if c<0: return 'pass'
    s=SQ(c&63)+SQ((c>>6)&63)
    return s+(' qrbn'[c>>12] if c>>12 else '')
def show(g):
    b=g.board(); rows=[]
    for r in range(8):
        row=''
        for c in range(8):
            p=b[r*8+c]
            row+= '. ' if p=='.' else ((p[1].upper() if p[0]=='w' else p[1])+('*' if p[2]=='1' else ' '))
        rows.append(f'{8-r} {row}')
    rows.append('  a b c d e f g h')
    return '\n'.join(rows)
