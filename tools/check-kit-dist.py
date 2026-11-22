#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""check-kit-dist.py - 发版闸门：dist 里的配置工具包必须与源码同步。

用法：
    python tools/check-kit-dist.py <fresh-kit-dir> <dist-dir> <version>

<fresh-kit-dir> 是 CI 里用当前源码重新生成的 kit 输出目录（含 config/ 与三件产物），
只用来做「拍平后的目录」对照，不写 dist、不参与发布。

校验：
  1. dist/mihomo-deploy.tar.gz 解出的 config/ 与 fresh-kit/config/ 逐文件、逐字节一致；
  2. 两边 config/state.js 的 APP_VERSION 都等于 <version>（允许带/不带前导 v）。
任何一项不一致直接 exit 1 —— Release 工作流在提交 dist 前调用，红灯就不许继续发。
"""

import io
import os
import re
import sys
import tarfile
import tempfile


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


def extract_kit_config(tar_path):
    out = {}
    with tarfile.open(tar_path, "r:gz") as t:
        for m in t.getmembers():
            if not m.isfile():
                continue
            name = m.name.lstrip("./")
            if not name.startswith("config/"):
                continue
            out[name[len("config/"):]] = t.extractfile(m).read()
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


def main():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors='replace')
        except Exception:
            pass
    if len(sys.argv) != 4:
        print("用法: python tools/check-kit-dist.py <fresh-kit-dir> <dist-dir> <version>")
        return 2
    fresh_dir, dist_dir, version = sys.argv[1], sys.argv[2], norm_version(sys.argv[3])

    tar_path = os.path.join(dist_dir, "mihomo-deploy.tar.gz")
    if not os.path.isfile(tar_path):
        print("✘ dist 里没有 mihomo-deploy.tar.gz")
        return 1

    fresh = read_tree(os.path.join(fresh_dir, "config"))
    dist = extract_kit_config(tar_path)

    bad = []
    for name in sorted(set(fresh) | set(dist)):
        if name not in dist:
            bad.append(name + "（dist 缺）")
        elif name not in fresh:
            bad.append(name + "（dist 多出）")
        elif fresh[name] != dist[name]:
            bad.append(name + "（内容不一致）")

    try:
        fv = version_of(fresh, "fresh kit")
        dv = version_of(dist, "dist kit")
    except SystemExit as exc:
        bad.append(str(exc))

    if bad:
        print("✘ kit 与源码不同源（%d 项）" % len(bad))
        for item in bad[:20]:
            print("  " + item)
        if len(bad) > 20:
            print("  …")
        return 1

    if fv != version or dv != version:
        print("✘ state.js 版本不对：fresh=%s dist=%s 期望=%s" % (fv, dv, version))
        return 1

    print("✔ kit 与 generator/app 拍平目录一致（%d 个文件）" % len(fresh))
    print("✔ config/state.js APP_VERSION = v%s（fresh = dist）" % version)
    return 0


if __name__ == "__main__":
    sys.exit(main())
