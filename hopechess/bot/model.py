"""Policy/value network shared by 1v1 and 2v2 (feature plane 22 flags 2v2).

Input  [B, 24, 8, 8] absolute-orientation planes (see cpp/hcpy.cpp encode()).
Output policy logits [B, 2, 4672] (white moves, black moves; index from*73+plane)
       value [B] in [-1, 1] from White's point of view.
"""
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

NPLANES, NPOL = 24, 64 * 73


class Block(nn.Module):
    def __init__(self, c):
        super().__init__()
        self.c1 = nn.Conv2d(c, c, 3, padding=1, bias=False)
        self.b1 = nn.BatchNorm2d(c)
        self.c2 = nn.Conv2d(c, c, 3, padding=1, bias=False)
        self.b2 = nn.BatchNorm2d(c)
        # squeeze-excitation gives the trunk cheap global context
        self.se1 = nn.Linear(c, c // 4)
        self.se2 = nn.Linear(c // 4, 2 * c)

    def forward(self, x):
        y = F.relu(self.b1(self.c1(x)))
        y = self.b2(self.c2(y))
        s = y.mean((2, 3))
        w, b = self.se2(F.relu(self.se1(s))).chunk(2, 1)
        y = y * torch.sigmoid(w)[..., None, None] + b[..., None, None]
        return F.relu(x + y)


class Net(nn.Module):
    def __init__(self, blocks=6, channels=64):
        super().__init__()
        self.cfg = dict(blocks=blocks, channels=channels)
        self.stem = nn.Sequential(nn.Conv2d(NPLANES, channels, 3, padding=1, bias=False), nn.BatchNorm2d(channels), nn.ReLU())
        self.trunk = nn.Sequential(*[Block(channels) for _ in range(blocks)])
        self.pconv = nn.Sequential(nn.Conv2d(channels, channels, 3, padding=1, bias=False), nn.BatchNorm2d(channels), nn.ReLU())
        self.pout = nn.Conv2d(channels, 146, 1)
        self.vconv = nn.Sequential(nn.Conv2d(channels, 32, 1, bias=False), nn.BatchNorm2d(32), nn.ReLU())
        self.vfc = nn.Sequential(nn.Linear(32 * 64, 256), nn.ReLU(), nn.Linear(256, 1))

    def trunk_out(self, x):
        return self.trunk(self.stem(x))

    def value_from(self, h):
        return torch.tanh(self.vfc(self.vconv(h).flatten(1))).squeeze(1)

    def policy_from(self, h):
        p = self.pout(self.pconv(h))                      # [B,146,8,8]
        return p.view(-1, 2, 73, 64).transpose(2, 3).reshape(-1, 2, NPOL)

    def forward(self, x):
        h = self.trunk_out(x)
        return self.policy_from(h), self.value_from(h)

    def value(self, x):
        return self.value_from(self.trunk_out(x))


# ---------------------------------------------------------------- compact input
def expand(c):
    """uint8 compact encoding [B,80] (cpp encodeCompact) -> float planes [B,24,8,8]."""
    c = c.long()
    B = c.shape[0]
    sq = c[:, :64]
    piece = sq & 15
    rest = (sq >= 16).float()
    oh = F.one_hot(piece, 13)[..., 1:].float()                       # [B,64,12]
    white = ((piece >= 1) & (piece <= 6)).float()
    black = (piece >= 7).float()
    planes = [oh.transpose(1, 2), (rest * white)[:, None], (rest * black)[:, None]]
    bits = c[:, 64]
    cast = torch.stack([((bits >> k) & 1).float() for k in range(4)], 1)[..., None].expand(B, 4, 64)
    ep = torch.zeros(B, 2, 64, device=c.device)
    e = c[:, 68:72]
    valid = e != 255
    col = (e >> 6).clamp(max=1)
    to = e & 63
    ep.view(B, 128).scatter_add_(1, col * 64 + to, valid.float())
    scal = torch.stack([c[:, 65].float() / 100, c[:, 66].float() / 2, c[:, 67].float(), torch.ones(B, device=c.device)], 1)
    planes += [cast, ep.clamp(max=1), scal[..., None].expand(B, 4, 64)]
    return torch.cat(planes, 1).view(B, NPLANES, 8, 8)


# ---------------------------------------------------------------- color flip
def _policy_flip_table():
    dirs = [(-1, 0), (-1, 1), (0, 1), (1, 1), (1, 0), (1, -1), (0, -1), (-1, -1)]
    kn = [(-2, -1), (-2, 1), (-1, -2), (-1, 2), (1, -2), (1, 2), (2, -1), (2, 1)]
    t = np.zeros(NPOL, dtype=np.int64)
    for frm in range(64):
        r, c = divmod(frm, 8)
        f2 = (7 - r) * 8 + c
        for pl in range(73):
            if pl < 56:
                d, dist = divmod(pl, 7)
                dr, dc = dirs[d]
                np_ = dirs.index((-dr, dc)) * 7 + dist
            elif pl < 64:
                dr, dc = kn[pl - 56]
                np_ = 56 + kn.index((-dr, dc))
            else:
                np_ = pl
            t[frm * 73 + pl] = f2 * 73 + np_
    return t


POLICY_FLIP = _policy_flip_table()
PLANE_PERM = list(range(6, 12)) + list(range(0, 6)) + [13, 12, 16, 17, 14, 15, 19, 18, 20, 21, 22, 23]


def flip_features(x):
    """Mirror ranks and swap colors (works on numpy or torch, [..., 24, 8, 8])."""
    if isinstance(x, np.ndarray):
        return x[..., PLANE_PERM, ::-1, :].copy()
    return x[..., PLANE_PERM, :, :].flip(-2)


def save(net, path, **extra):
    torch.save(dict(cfg=net.cfg, state=net.state_dict(), **extra), path)


def load(path, device='cpu'):
    ck = torch.load(path, map_location=device, weights_only=False)
    net = Net(**ck['cfg'])
    net.load_state_dict(ck['state'])
    return net.to(device).eval(), ck
