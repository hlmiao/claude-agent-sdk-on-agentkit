/**
 * 示例 Claude Agent SDK (TypeScript) — AgentKit Runtime 兼容容器服务
 *
 * 遵守 AgentKit Runtime / AWS AgentCore 服务契约（源码查实）:
 *   - 监听 0.0.0.0:8000
 *   - POST /invocations : body 必须是 JSON（非 JSON 返回 400）；返回 JSON 或 SSE
 *   - GET  /ping        : 返回 {"status":"Healthy"}
 *
 * R2 身份透传：网关验签后把用户身份放进 HTTP Header（如 user_id），
 * 本服务在 /invocations 里显式读取该 Header 并注入到 Agent 上下文，
 * 使 SDK 服务能识别调用者身份。这正是 集成需求中「容器内服务消费身份」的落点。
 */
import express, { Request, Response } from "express";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { spawn } from "child_process";

const HOST = "0.0.0.0";
// 与 AgentKit Python 模板保持一致：容器统一监听 8000。允许用环境变量覆盖。
const PORT = Number(process.env.PORT ?? process.env.AGENT_PORT ?? 8000);

const app = express();
app.use(express.json());

// 进程级安全网：Claude Agent SDK 会 spawn Claude Code CLI 子进程。
// 若 CLI 异常（如无有效凭证/出海失败）触发未捕获异常或 Promise 拒绝，
// 默认会让整个 Node 进程退出（表现为网关侧 function_process_exited）。
// 这里兜住它们，只记录日志、保持进程存活，使 /ping 与 echo 路径不受影响。
process.on("uncaughtException", (err: unknown) => {
  console.error(
    JSON.stringify({ level: "error", msg: "uncaughtException (kept alive)", detail: String(err) })
  );
});
process.on("unhandledRejection", (reason: unknown) => {
  console.error(
    JSON.stringify({ level: "error", msg: "unhandledRejection (kept alive)", detail: String(reason) })
  );
});

/** 从入站请求中提取被网关透传的用户身份（R2）。 */
function extractIdentity(req: Request): { userId: string | null; sessionId: string | null } {
  // 网关/CLI 可能以不同大小写透传，Express 已统一为小写 header 名。
  const userId =
    (req.header("user_id") ??
      req.header("x-user-id") ??
      req.header("x-amzn-bedrock-agentcore-runtime-user-id") ??
      null);
  const sessionId = req.header("session_id") ?? req.header("x-session-id") ?? null;
  return { userId, sessionId };
}

// 构建版本标记：用于确认线上跑的是哪一版代码（排查部署是否真正生效）。
const BUILD_VERSION = "v6-nonroot";

/** 健康检查：Runtime 靠它探活。 */
app.get("/ping", (_req: Request, res: Response) => {
  res.status(200).json({ status: "Healthy", build: BUILD_VERSION });
});

/**
 * 出网可达性探针（L4 前置证伪）：从容器内部发起到模型网关的最小请求，
 * 用于判断 cn-beijing veFaaS 能否出海连到东京 LiteLLM proxy。
 * 打 proxy 的 /v1/models（GET，不消耗 token）。带超时，避免挂死。
 */
app.get("/net-probe", async (_req: Request, res: Response) => {
  const base = (process.env.ANTHROPIC_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const token = (process.env.ANTHROPIC_AUTH_TOKEN ?? "").trim();
  if (!base) {
    return res.status(200).json({ probe: "skipped", reason: "ANTHROPIC_BASE_URL unset" });
  }
  const url = `${base}/v1/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  const startedAt = Date.now();
  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: controller.signal,
    });
    const text = await resp.text();
    return res.status(200).json({
      probe: "done",
      reachable: true,
      target: url,
      http_status: resp.status,
      elapsed_ms: Date.now() - startedAt,
      body_preview: text.slice(0, 300),
    });
  } catch (err) {
    // 网络不通 / DNS 失败 / 超时都落到这里 —— 证明 veFaaS 出海受限。
    return res.status(200).json({
      probe: "done",
      reachable: false,
      target: url,
      elapsed_ms: Date.now() - startedAt,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    });
  } finally {
    clearTimeout(timer);
  }
});

/**
 * CLI 隔离诊断端点（L4 盲区破局）：用 child_process.spawn 显式在子进程里跑
 * `claude -p <prompt>`，父进程捕获 stdout/stderr/退出码/信号后原样回传。
 * 与 query() 同进程运行不同：子进程即便被 OOM killer 杀（SIGKILL）或段错误，
 * 也不会带走本服务，反而能拿到真实死因，用于区分 OOM / 只读FS / 协议不兼容等。
 */
app.post("/invoke-debug", async (req: Request, res: Response) => {
  const payload = req.body ?? {};
  const prompt: string = payload.prompt ?? payload.message ?? payload.input ?? "hi";
  const model = (process.env.ANTHROPIC_MODEL ?? "").trim();
  const args = ["-p", prompt, "--permission-mode", "bypassPermissions"];
  if (model) args.push("--model", model);

  const startedAt = Date.now();
  // 显式给子进程一套可写的 HOME/临时目录，规避 serverless 只读根文件系统问题。
  const child = spawn("claude", args, {
    env: {
      ...process.env,
      HOME: process.env.HOME ?? "/tmp",
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? "/tmp/.claude",
      TMPDIR: process.env.TMPDIR ?? "/tmp",
    },
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));

  // 兜底超时，避免子进程挂住导致本请求永不返回。
  const timeoutMs = Number(process.env.AGENT_QUERY_TIMEOUT_MS ?? 25000);
  const killer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);

  child.on("error", (err: Error) => {
    // spawn 本身失败（如 claude 不在 PATH / ENOENT）落到这里。
    clearTimeout(killer);
    return res.status(200).json({
      debug: "spawn_error",
      error: `${err.name}: ${err.message}`,
      note: "claude CLI 可能不在 PATH，或无法执行",
    });
  });

  child.on("close", (code: number | null, signal: string | null) => {
    clearTimeout(killer);
    return res.status(200).json({
      debug: "done",
      exit_code: code,
      signal, // 若为 "SIGKILL" 高度怀疑 OOM/资源限制
      elapsed_ms: Date.now() - startedAt,
      stdout_preview: stdout.slice(0, 500),
      stderr_preview: stderr.slice(0, 1500), // CLI 真实报错都在这
      model_used: model || "(default)",
    });
  });
});

/** 调用入口：网关把请求原样转发进来。 */
app.post("/invocations", async (req: Request, res: Response) => {
  // 契约：body 必须是合法 JSON。express.json() 解析失败时 body 为空对象，
  // 这里额外校验 content-type，保持与 AgentCore 行为一致。
  if (!req.is("application/json")) {
    return res.status(400).json({ error: "Request body must be valid JSON." });
  }
  const { userId, sessionId } = extractIdentity(req);
  const payload = req.body ?? {};
  const prompt: string =
    payload.prompt ?? payload.message ?? payload.input ?? "";

  // 将透传身份写入日志，便于审计「鉴权主体 ↔ 透传 user-id」。
  console.log(
    JSON.stringify({
      level: "info",
      msg: "invocation received",
      user_id: userId,
      session_id: sessionId,
      has_prompt: Boolean(prompt),
    })
  );

  if (!prompt) {
    return res
      .status(400)
      .json({ error: "Missing 'prompt' (or 'message'/'input') in JSON body." });
  }

  // 把调用者身份注入到给 Agent 的 system 上下文，让 Agent「认识」调用者。
  const identityContext = userId
    ? `You are serving an authenticated user. The caller's verified identity is user_id="${userId}"${
        sessionId ? `, session_id="${sessionId}"` : ""
      }. When asked who the user is, answer with this identity.`
    : `The caller is anonymous (no verified identity header present).`;

  // 是否真正调用模型，由显式开关 AGENT_ENABLE_MODEL 控制（默认关闭）。
  // 关闭时不触碰 query()，直接回显身份——契约(L2)与身份透传(L3)的验证
  // 完全不依赖模型可达性，也不 spawn Claude Code CLI，杜绝出海崩溃。
  // 验证 L4（真实模型）时再显式打开，并配好 ANTHROPIC_AUTH_TOKEN。
  const modelEnabled = /^(1|true|yes|on)$/i.test((process.env.AGENT_ENABLE_MODEL ?? "").trim());
  const modelGateway = (process.env.ANTHROPIC_BASE_URL ?? "").trim();
  if (!modelEnabled) {
    console.log(
      JSON.stringify({
        level: "info",
        msg: "model call disabled (AGENT_ENABLE_MODEL not set), returning echo mode",
        user_id: userId,
        session_id: sessionId,
      })
    );
    return res.status(200).json({
      mode: "echo",
      note: "Model call disabled (AGENT_ENABLE_MODEL off); skipping query(). Contract & identity passthrough verified.",
      echo: { prompt, user_id: userId, session_id: sessionId },
      identity: { user_id: userId, session_id: sessionId },
      model_gateway: modelGateway || "unset",
    });
  }

  // 已配置模型网关：给 query() 加超时（AbortController 是 Options 的合法字段），
  // 出海挂住时主动中断并降级，而不是被平台超时 SIGTERM。
  const abortController = new AbortController();
  const timeoutMs = Number(process.env.AGENT_QUERY_TIMEOUT_MS ?? 20000);
  const timer = setTimeout(() => abortController.abort(), timeoutMs);
  try {
    // Claude Agent SDK：底层驱动 Claude Code CLI 执行任务。
    // 官方签名为单对象入参 query({ prompt, options })，返回异步可迭代的 Query。
    const response = query({
      prompt,
      options: {
        systemPrompt: identityContext,
        // 非交互式一次性执行，容器内无人工审批
        permissionMode: "bypassPermissions",
        // SDK 要求：使用 bypassPermissions 时必须显式确认跳过权限检查
        allowDangerouslySkipPermissions: true,
        // 超时可中断，避免出海挂死
        abortController,
      },
    });

    // 汇聚 SDK 的流式消息为一段最终文本：
    // - type==="result" 时 SDK 已给出最终结果（首选）
    // - 兜底累加 type==="assistant" 的文本块
    let finalText = "";
    for await (const message of response) {
      if (message.type === "result") {
        finalText = (message as { result?: string }).result ?? finalText;
      } else if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text") finalText += block.text;
        }
      }
    }

    return res.status(200).json({
      mode: "agent",
      output: finalText,
      identity: { user_id: userId, session_id: sessionId },
      model_gateway: modelGateway,
    });
  } catch (err) {
    // 模型网关不可达 / 超时中断时降级：仍然回显已透传的身份与 prompt，
    // 证明 L1-L3（纳管+契约+身份透传）成立，并显式标注模型层问题，
    // 便于区分「容器契约问题」与「模型出口问题」。
    const detail = err instanceof Error ? err.message : String(err);
    console.error(
      JSON.stringify({
        level: "error",
        msg: "agent invocation failed, falling back to echo",
        detail,
        anthropic_base_url: modelGateway,
      })
    );
    return res.status(200).json({
      mode: "echo-fallback",
      note: "Agent/model call failed (gateway unreachable or timeout). Contract & identity passthrough still verified.",
      echo: { prompt, user_id: userId, session_id: sessionId },
      model_gateway: modelGateway,
      error_detail: detail,
    });
  } finally {
    clearTimeout(timer);
  }
});

app.listen(PORT, HOST, () => {
  console.log(`Claude Agent SDK (TS) listening on http://${HOST}:${PORT}`);
  console.log(`  POST /invocations  GET /ping`);
});
