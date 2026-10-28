# 示例 2：Python REST API（FastAPI）

## 直接粘这句给 DSH

```
用 FastAPI 写一个 REST 服务：用户注册/登录（JWT）、任务列表 CRUD、
SQLite 持久化、Pydantic 模型、至少给出 pytest 冒烟测试。
```

## 流水线会怎么跑（预期行为）

1. **拆模块**：`auth`（注册/登录/JWT 中间件）、`tasks`（CRUD + 数据层）、`tests`（pytest 冒烟）。
2. **L2** 写完整文件（`main.py`、`auth/*.py`、`tasks/*.py`、`tests/test_*.py`）。
3. **L3 派上用场的地方**：纯函数/小工具——`hash_password`、`make_token_payload`、`pagination` 分页计算、`validate_email`。
4. **质量门**：验收断言用 Python 真跑（`pipeline_review` 会执行断言），例如：
   `def make_token_payload(u): ...` → `assert make_token_payload({'id':1})['sub'] == '1'`
5. **里程碑**：`auth 可用` → `tasks 可用` → `tests 全绿`。

## 小技巧

- Python 项目的断言最容易「真跑」，建议每个 L3 子任务都带一句 `函数(参数)==期望`，门会更严、返工更少。
- 依赖少的项目可以要求「先 L2 写骨架并跑通 import，再 L3 填实现」。
