"""Build the hcengine Python extension next to this script (any platform).

    python build.py

Uses setuptools, so on Windows it finds MSVC (Visual Studio Build Tools) on
its own. build.sh does the same with c++ -march=native on Linux/macOS.
"""
import os, sys
import pybind11
from setuptools import Extension
from setuptools.dist import Distribution

here = os.path.dirname(os.path.abspath(__file__))
os.chdir(here)
msvc = sys.platform == 'win32'
ext = Extension('hcengine', ['cpp/engine.cpp', 'cpp/hcpy.cpp'], include_dirs=[pybind11.get_include()], language='c++',
                extra_compile_args=['/O2', '/std:c++17', '/EHsc'] if msvc else ['-O3', '-march=native', '-std=c++17'])
dist = Distribution({'name': 'hcengine', 'ext_modules': [ext]})
cmd = dist.get_command_obj('build_ext')
cmd.inplace = True
cmd.build_temp = os.path.join(here, 'build')
dist.run_command('build_ext')
print('built', cmd.get_ext_filename('hcengine'))
