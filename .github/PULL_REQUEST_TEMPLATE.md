## 这个 PR 做了什么

<!-- 一两句话说明目的，不要只写「优化」 -->

## 类型

- [ ] `fix` 修复
- [ ] `feat` 新功能
- [ ] `docs` 文档
- [ ] `style` 排版 / 文案（不影响行为）
- [ ] `refactor` 重构（不改变行为）
- [ ] `chore` 构建 / 依赖 / 发布

## 影响面

<!-- 勾选会被影响的部分，方便判断回归范围 -->

- [ ] 安装 / 升级 / 卸载
- [ ] 核心 / 面板 / 配置工具部署
- [ ] 80 端口转发
- [ ] 配置生成器（界面或生成的 YAML）
- [ ] LuCI 页面
- [ ] 仅文档

## 已验证

- [ ] `cd generator && bun test tests/unit`
- [ ] `python tests/test_package.py`（Windows 先设 `SUITE_DESKTOP`）
- [ ] `sh -n install.sh`、`sh -n package/usr/sbin/mtun-xd`
- [ ] 改生成器时：`node tools/check-yaml-tokens.mjs`、`node tools/check-copy-integrity.mjs`
- [ ] 真机验证（写明固件与版本）：

## 注意

- [ ] 没有修改 `APP_VERSION`（版本号由维护者发版时统一改）
- [ ] 没有提交真实节点、密码、私钥或构建产物
- [ ] 没有覆盖用户已有 `config.yaml` 的行为变化
- [ ] 涉及安装/升级/卸载的改动，已说明回滚方式
