#!/usr/bin/env python3
# Copyright (c) 2026. Helper for AgentKit CLI.
"""AssumeRole 助手：用基础密钥换取临时凭证，输出可 eval 的 export 语句。

用法（凭证只在本机、由你 export，不经过任何第三方）：

    export VOLC_ACCESSKEY=<基础AK>
    export VOLC_SECRETKEY=<基础SK>
    export VOLC_ROLE_TRN='trn:iam::<ACCOUNT_ID>:role/<ROLE_NAME>'
    export VOLC_REGION=cn-beijing          # 可选，默认 cn-beijing
    export VOLC_DURATION=3600              # 可选，临时凭证有效期（秒）

    eval "$(python scripts/sts_assume.py)"   # 把临时三件套注入当前终端
    agentkit runtime list --region cn-beijing

脚本会用 AgentKit CLI 认可的变量名（VOLC_ACCESSKEY / VOLC_SECRETKEY /
VOLC_SESSIONTOKEN）打印 export 语句，供 eval 消费。凭证不落盘。
"""
from __future__ import annotations

import os
import sys

from volcengine.Credentials import Credentials
from volcengine.sts.StsService import StsService


def _fail(msg: str) -> None:
    # 写到 stderr，避免污染 eval 消费的 stdout
    print(f"# ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


def main() -> None:
    ak = os.getenv("VOLC_ACCESSKEY") or os.getenv("VOLCENGINE_ACCESS_KEY")
    sk = os.getenv("VOLC_SECRETKEY") or os.getenv("VOLCENGINE_SECRET_KEY")
    role_trn = os.getenv("VOLC_ROLE_TRN")
    region = os.getenv("VOLC_REGION") or os.getenv("VOLCENGINE_REGION") or "cn-beijing"
    session_name = os.getenv("VOLC_ROLE_SESSION_NAME", "agentkit-cli")
    try:
        duration = int(os.getenv("VOLC_DURATION", "3600"))
    except ValueError:
        _fail("VOLC_DURATION 必须是整数（秒）")

    if not ak or not sk:
        _fail("缺少 VOLC_ACCESSKEY / VOLC_SECRETKEY")
    if not role_trn:
        _fail("缺少 VOLC_ROLE_TRN（形如 trn:iam::<account>:role/<name>）")

    svc = StsService()
    # StsService 是单例，凭证需显式注入
    svc.set_ak(ak)
    svc.set_sk(sk)

    params = {
        "RoleTrn": role_trn,
        "RoleSessionName": session_name,
        "DurationSeconds": duration,
    }

    try:
        resp = svc.assume_role(params)
    except Exception as exc:  # noqa: BLE001 — 网络/鉴权错误统一上报
        _fail(f"AssumeRole 调用失败: {exc}")

    result = (resp or {}).get("Result") or {}
    creds = result.get("Credentials") or {}
    tmp_ak = creds.get("AccessKeyId")
    tmp_sk = creds.get("SecretAccessKey")
    tmp_token = creds.get("SessionToken")
    expired = creds.get("ExpiredTime", "?")

    if not (tmp_ak and tmp_sk and tmp_token):
        _fail(f"响应中未找到临时凭证，原始返回: {resp}")

    # 输出到 stdout：仅 export 语句，供 `eval` 消费
    print(f"export VOLC_ACCESSKEY={tmp_ak}")
    print(f"export VOLC_SECRETKEY={tmp_sk}")
    print(f"export VOLC_SESSIONTOKEN={tmp_token}")
    print(f"export VOLCENGINE_REGION={region}")
    # 提示信息走 stderr，不影响 eval
    print(f"# 临时凭证已生成，过期时间: {expired}", file=sys.stderr)


if __name__ == "__main__":
    main()
