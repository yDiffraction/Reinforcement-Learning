"""Build a self-contained Kaggle notebook that unpacks the bot code, compiles
the C++ engine and runs train.py on the Kaggle GPU.

    python3 kaggle/make_notebook.py --slug hopechess-rl --title "Hopechess RL" \
        --args "--hours 2 --parallel 128" [--source timsindelar/hopechess-rl --init-file latest.pt]
then:  kaggle kernels push -p kaggle/build/<slug> --accelerator NvidiaTeslaT4
"""
import argparse, base64, io, json, os, tarfile

HERE = os.path.dirname(os.path.abspath(__file__))
BOT = os.path.dirname(HERE)
FILES = ['build.sh', 'cpp/engine.hpp', 'cpp/engine.cpp', 'cpp/hcpy.cpp', 'model.py', 'search.py',
         'agents.py', 'netagent.py', 'train.py', 'arena.py', 'evaluate.py']


def pack():
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode='w:gz') as t:
        for f in FILES:
            t.add(os.path.join(BOT, f), arcname=f)
    return base64.b64encode(buf.getvalue()).decode()


def cell(src, kind='code'):
    c = dict(cell_type=kind, metadata={}, source=src.splitlines(True))
    if kind == 'code':
        c.update(execution_count=None, outputs=[])
    return c


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--slug', default='hopechess-rl')
    ap.add_argument('--title', default='Hopechess RL')
    ap.add_argument('--user', default='timsindelar')
    ap.add_argument('--args', default='--hours 1')
    ap.add_argument('--source', action='append', default=[], help='kernel whose output to mount (owner/slug)')
    ap.add_argument('--init-file', default=None, help='checkpoint filename inside the mounted source output')
    ap.add_argument('--cmd', default=None, help='custom command instead of train.py; @slug/file resolves to a mounted kernel output file')
    o = ap.parse_args()
    blob = pack()
    init = ''
    if o.init_file:
        src = o.source[0].split('/')[1]
        init = f"""
import glob
cands = glob.glob('/kaggle/input/**/{o.init_file}', recursive=True)
print('init candidates', cands)
INIT = ('--init ' + cands[0]) if cands else ''
"""
    else:
        init = "INIT = ''\n"
    cells = [
        cell(f"# {o.title}\nSelf-play reinforcement learning for Hopechess (simultaneous-move chess), 1v1 and 2v2.\n"
             "Code: hopechess/bot in ydiffraction/reinforcement-learning (packed below).", 'markdown'),
        cell("import base64, io, tarfile, os, subprocess, sys\n"
             f"BLOB = '{blob}'\n"
             "os.makedirs('/kaggle/working/bot', exist_ok=True)\n"
             "tarfile.open(fileobj=io.BytesIO(base64.b64decode(BLOB)), mode='r:gz').extractall('/kaggle/working/bot')\n"
             "os.chdir('/kaggle/working/bot')\n"
             "r = subprocess.run('pip install -q pybind11', shell=True)\n"
             "print(subprocess.run('bash build.sh', shell=True, capture_output=True, text=True))\n"
             "print(subprocess.run('nvidia-smi; nproc; free -g', shell=True, capture_output=True, text=True).stdout)\n"),
        cell(init),
        cell(("cmd = f'python3 -u train.py --out /kaggle/working/run {INIT} " + o.args + "'\n") if not o.cmd else
             ("import glob, re\n"
              f"cmd = {o.cmd!r}\n"
              "def _res(m):\n"
              "    slug, f = m.group(1), m.group(2)\n"
              "    c = [p for p in glob.glob('/kaggle/input/**/' + f, recursive=True) if '/' + slug + '/' in p]\n"
              "    print('resolve', m.group(0), c)\n"
              "    return c[0]\n"
              "cmd = re.sub(r'@([\\w-]+)/([\\w./-]+)', _res, cmd)\n"
              "os.makedirs('/kaggle/working/run', exist_ok=True)\n")
             + "print(cmd)\n"
             "p = subprocess.Popen(cmd, shell=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)\n"
             "with open('/kaggle/working/train.log', 'w') as log:\n"
             "    for line in p.stdout:\n"
             "        print(line, end='', flush=True); log.write(line); log.flush()\n"
             "print('exit', p.wait())\n"),
        cell("import shutil\nshutil.rmtree('/kaggle/working/bot', ignore_errors=True)\n"
             "print(os.listdir('/kaggle/working/run'))\n"),
    ]
    nb = dict(cells=cells, metadata=dict(kernelspec=dict(display_name='Python 3', language='python', name='python3'),
                                          language_info=dict(name='python')), nbformat=4, nbformat_minor=4)
    out = os.path.join(HERE, 'build', o.slug)
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, f'{o.slug}.ipynb'), 'w') as f:
        json.dump(nb, f)
    meta = dict(id=f'{o.user}/{o.slug}', title=o.title, code_file=f'{o.slug}.ipynb', language='python',
                kernel_type='notebook', is_private=True, enable_gpu=True, enable_tpu=False, enable_internet=True,
                dataset_sources=[], competition_sources=[], kernel_sources=o.source, model_sources=[])
    with open(os.path.join(out, 'kernel-metadata.json'), 'w') as f:
        json.dump(meta, f, indent=2)
    print('wrote', out, f'({len(blob) // 1024} KB code blob)')


if __name__ == '__main__':
    main()
