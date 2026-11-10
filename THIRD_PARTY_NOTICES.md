# 第三方声明

本仓库采用 [MIT](LICENSE)。截至 02 工单，开发检查工具为独立实现，未改写或移植第三方源代码。下列项目的设计参考不等于代码授权或产品背书；致谢链接见 [README](README.md)。

后续借用代码时在本文件逐项增加：项目及上游 URL、上游路径、借用提交的完整 SHA、本仓库文件、许可证全文（MIT 代码须保留完整 MIT）、原版权行、修改说明。改写文件开头同时注明上游路径和提交号。先固定提交逐字重读并审阅隐私，再移植；不导入私人仓库历史或真实账号基线。

MAA 代码和资源、游戏数据、一图流和企鹅物流数据不随包分发。用时读取需在相应输出注明来源，具体边界见 [规格](docs/spec.md)。

开发依赖 TypeScript、Node 类型声明的许可证保留在各自安装包中；版本与完整性哈希见 lockfile。它们不属于产品共享工具实现。

## dsh-maa-cli 的识别回调解析

- 上游：[nhyo/dsh-maa-cli](https://github.com/nhyo/dsh-maa-cli)，固定提交 `cdeaa8fac12bdc1db5b4ea5c33fca358dc6cf43b`。
- 来源文件：`src/operators/depot.js`、`src/operators/operator-box.js`；逐字核对日期 2026-11-11。
- 改写文件：`skills/maa-core/scripts/account-snapshot.ts`。保留回调字段与数值校验思路；改为统一快照、显式未知值、每域最近状态、GUI 本地缓存输入、互斥及原子保存和白名单摘要。未借用运行扫描、UI 或外部数据。
- 原版权及 MIT 全文如下：

```text
MIT License

Copyright (c) 2026 nhyo

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

MAA 的 GUI 缓存字段与回调事实仅作只读接口核对，源文件指纹见 [account 来源核对](docs/account-sources.md)；本仓库不复制其 AGPL 实现。

原生单目录安装时，[maa-core/LICENSE](skills/maa-core/LICENSE) 随共享脚本携带完整 MIT 许可和上述原版权行，避免仅引用仓库根文件而丢失许可。

## 基建技能查询

`skills/maa-core/scripts/base-query.ts` 参考维护者自有原型，剥离个人路径、名册、生产规则及依赖后重写；原型 SHA256、范围和隐私核对见 [base 来源记录](docs/base-sources.md)。未引入原项目历史或第三方排班代码。

游戏表运行时读取 [Kengxxiao/ArknightsGameData](https://github.com/Kengxxiao/ArknightsGameData/tree/6f63c14e27b847ef74b53b00fe51fc322b3cd7ff) 的固定提交，数据权利归原权利人，本仓库不再分发。交叉核对运行时读取 [KayChung17/arknights-base-skill](https://github.com/KayChung17/arknights-base-skill/blob/368ea6d83d14409a3e7354df4359960adba6b36b/skills/ark-base-schedule/assets/operator-skills.json) 的 `operator-skills.json`，固定提交 `368ea6d83d14409a3e7354df4359960adba6b36b`；不采用其算法或衍生加成，不复制其数据文件。该仓库 [MIT 许可](https://github.com/KayChung17/arknights-base-skill/blob/368ea6d83d14409a3e7354df4359960adba6b36b/LICENSE) 全文如下，注明引用来源不表示上游背书：

```text
MIT License

Copyright (c) 2026 KayChung17

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
