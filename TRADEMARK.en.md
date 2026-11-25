# MTUN-XD Project Statement

[简体中文](TRADEMARK.md) | **English**

This document is the separate statement for MTUN-XD (墨枢云境) regarding **release channels** and **brand identity**. Together with `README.md` and `LICENSE`, it forms the project's public commitments.

> This English version is provided for convenience. If there is any discrepancy, the Chinese original [TRADEMARK.md](TRADEMARK.md) prevails.

---

## 1. Official Release Channels and Security Statement

Official releases are distributed only through the following channels:

| Channel | Address |
| --- | --- |
| GitHub repository | `https://github.com/OpenWrt-MTUN-XD/OpenWrt-MTUN-XD` |
| GitHub Releases | `https://github.com/OpenWrt-MTUN-XD/OpenWrt-MTUN-XD/releases` |
| CF mirror (official) | `https://mtun-xd.wxcircle.top/` |

The project's installation scripts include package digest verification (for suite packages; the core and dashboard are obtained from their respective upstream channels):

- Download installation files only from the official channels above.
- Verify the official SHA-256 after download. If the digest is missing or verification fails, installation is **refused**
  (if you trust the source, you may explicitly set `MTUN_XD_ALLOW_UNVERIFIED=1` to skip verification, at your own risk).

Any "same edition", "custom edition", "enhanced edition", or derivative installation package distributed through other websites, third-party repositories, or unofficial channels is not an official release of this project. Its origin, security, and future maintenance cannot be guaranteed by this project. Users should verify the source and assess the risks themselves.

---

## 2. Project Name, Brand Identity, and Intellectual Property

`MTUN-XD`, `墨枢云境`, and `墨樞雲境` are names and brand identifiers used by this project. The project logo is also an exclusive visual identifier of this project.

Without prior written authorization from the project maintainers, no third party may use the names, identifiers, or logo above for product promotion, version releases, distribution, or any other conduct that may create a false impression of official association, authorization, or origin.

Use, modification, and redistribution of this project's source code are subject to the open-source licenses listed in `LICENSE` and `generator/LICENSE`:

| Scope | Includes | License |
| --- | --- | --- |
| Suite | `package/`, `control/`, `deploy/`, `install.sh`, `build.py`, `src/`, `docs/`, `tests/` | MIT |
| Configuration generator | `generator/` (with its own `generator/LICENSE`) | GPL-3.0 |

**A code license is not a brand license.** Any modification, secondary development, or derivative version based on this project's code must not be released or distributed under this project's name, brand identifiers, or official identity without authorization.

The project maintainers reserve the right to pursue legal remedies for unauthorized brand use and conduct that may confuse users.

---

## 3. Upstream Components

The Mihomo core and the MetaCubeXD dashboard are maintained by their respective upstream projects and are not distributed with this project's packages. Their licenses and brand ownership are governed by their respective projects.
