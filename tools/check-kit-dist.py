#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""check-kit-dist.py - 发版闸门：dist 里的配置工具包必须与源码同步。

用法：
    python tools/check-kit-dist.py <fresh-kit-dir> <dist-dir> <version>

<fresh-kit-dir> 是 CI 里用当前源码重新生成的 kit 输出目录（含 config/ 与三件产物），
只用来做「拍平后的目录」对照，不写 dist、不参与发布。

校验：
  1. dist/mihomo-deploy.tar.gz 解出的 config/ 与 fresh-kit/config/ 逐文件、逐字节一致；
  2. dist/mihomo-deploy.zip 解出的 config/ 同样逐文件、逐字节一致；
  3. dist/generator.sh 与 fresh-kit/generator.sh 逐字节一致；
  4. tar/zip 内 config/state.js 的 APP_VERSION 都等于 <version>（允许带/不带前导 v）。
任何一项不一致直接 exit 1 —— CI 在提交 dist 前调用，红灯就不许继续发。
"""

import hashlib
import io
import os
import re
import sys
import tarfile
import zipfile


EXT_TEXT = (".js", ".html", ".css", ".json", ".sh", ".txt", ".md")


def check_lf(files, label):
    """config/ 里文本文件只允许 LF：CRLF 会让本地与 CI 打出的 kit 字节不同。"""
    bad = []
    for name, raw in files.items():
        if not name.lower().endswith(EXT_TEXT):
            continue
        try:
            raw.decode("utf-8")
        except UnicodeDecodeError:
            continue
        if b"\r" in raw:
            bad.append("%s: %s（含 CRLF）" % (label, name))
    return bad


def read_tree(root):
    """flattened config 树 -> {相对路径: bytes}（忽略目录条目）。"""
    out = {}
    for dirpath, _, names in os.walk(root):
        for name in names:
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            with open(full, "rb") as f:
                out[rel] = f.read()
    return out


def _strip_config(name):
    name = name.lstrip("./")
    return name[len("config/"):] if name.startswith("config/") else None


def extract_tar_config(tar_path):
    out = {}
    with tarfile.open(tar_path, "r:gz") as t:
        for m in t.getmembers():
            if not m.isfile():
                continue
            rel = _strip_config(m.name)
            if rel is not None:
                out[rel] = t.extractfile(m).read()
    return out


def extract_zip_config(zip_path):
    out = {}
    with zipfile.ZipFile(zip_path) as z:
        for name in z.namelist():
            rel = _strip_config(name)
            if rel is not None and not name.endswith("/"):
                out[rel] = z.read(name)
    return out


def version_of(files, label):
    raw = files.get("state.js")
    if raw is None:
        raise SystemExit("✘ %s 里没有 config/state.js" % label)
    m = re.search(r"APP_VERSION\s*=\s*'v?([0-9][^']*)'", raw.decode("utf-8", "replace"))
    if not m:
        raise SystemExit("✘ %s 的 state.js 里读不到 APP_VERSION" % label)
    return m.group(1)


def norm_version(v):
    return v[1:] if v.startswith("v") else v


def diff_trees(fresh, dist, label):
    bad = []
    for name in sorted(set(fresh) | set(dist)):
        if name not in dist:
            bad.append("%s: %s（dist 缺）" % (label, name))
        elif name not in fresh:
            bad.append("%s: %s（dist 多出）" % (label, name))
        elif fresh[name] != dist[name]:
            bad.append("%s: %s（内容不一致）" % (label, name))
    return bad


def main():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except Exception:
            pass
    if len(sys.argv) != 4:
        print("用法: python tools/check-kit-dist.py <fresh-kit-dir> <dist-dir> <version>")
        return 2
    fresh_dir, dist_dir, version = sys.argv[1], sys.argv[2], norm_version(sys.argv[3])
    fresh = read_tree(os.path.join(fresh_dir, "config"))

    tar_path = os.path.join(dist_dir, "mihomo-deploy.tar.gz")
    zip_path = os.path.join(dist_dir, "mihomo-deploy.zip")
    gen_path = os.path.join(dist_dir, "generator.sh")
    for p in (tar_path, zip_path, gen_path):
        if not os.path.isfile(p):
            print("✘ dist 里缺 %s" % os.path.basename(p))
            return 1
    fresh_gen_path = os.path.join(fresh_dir, "generator.sh")
    if not os.path.isfile(fresh_gen_path):
        print("✘ fresh kit 里缺 generator.sh")
        return 1

    tar_cfg = extract_tar_config(tar_path)
    zip_cfg = extract_zip_config(zip_path)
    bad = []
    bad += diff_trees(fresh, tar_cfg, "tar.gz")
    bad += diff_trees(fresh, zip_cfg, "zip")
    bad += check_lf(fresh, "fresh")
    bad += check_lf(tar_cfg, "tar.gz")
    bad += check_lf(zip_cfg, "zip")

    if open(fresh_gen_path, "rb").read() != open(gen_path, "rb").read():
        bad.append("generator.sh（与源码不一致）")

    try:
        fv = version_of(fresh, "fresh kit")
        tv = version_of(tar_cfg, "tar.gz")
        zv = version_of(zip_cfg, "zip")
    except SystemExit as exc:
        bad.append(str(exc))

    if bad:
        print("✘ kit 与源码不同源（%d 项）" % len(bad))
        for item in bad[:24]:
            print("  " + item)
        if len(bad) > 24:
            print("  …")
        return 1

    if fv != version or tv != version or zv != version:
        print("✘ state.js 版本不对：fresh=%s tar=%s zip=%s 期望=%s" % (fv, tv, zv, version))
        return 1

    print("✔ kit 与 generator/app 拍平目录一致（%d 个文件，tar.gz）" % len(fresh))
    print("✔ kit 与 generator/app 拍平目录一致（%d 个文件，zip）" % len(fresh))
    print("✔ generator.sh 与源码一致")
    print("✔ config/state.js APP_VERSION = v%s（fresh = tar = zip）" % version)
    return 0


if __name__ == "__main__":
    sys.exit(main())
